/**
 * Continuous AQI field for the map:
 * 1) Sample Open-Meteo on a viewport grid
 * 2) Bilinear (or IDW) interpolate to a canvas
 * 3) Inject watchlist pin AQI so the field matches official cards
 * 4) EPA-band colors with strong yellow/orange/red for elevated AQI
 */
import type { GridSample } from "@/lib/aqi-grid";

export type FieldBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

type Sample = { lon: number; lat: number; aqi: number };

function lerp(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  const u = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * u),
    Math.round(a[1] + (b[1] - a[1]) * u),
    Math.round(a[2] + (b[2] - a[2]) * u),
  ];
}

/** EPA-accurate bands with vivid yellow → orange → red. */
export function aqiToRgb(aqi: number): [number, number, number] {
  const v = Math.max(0, Math.min(500, aqi));
  const good: [number, number, number] = [28, 100, 60];
  const yellow: [number, number, number] = [255, 210, 0];
  const orange: [number, number, number] = [255, 120, 0];
  const red: [number, number, number] = [255, 28, 28];
  const purple: [number, number, number] = [175, 35, 220];
  const maroon: [number, number, number] = [100, 8, 18];

  if (v <= 50) return lerp(good, [45, 130, 75], v / 50);
  if (v <= 100) return lerp([90, 160, 50], yellow, (v - 50) / 50);
  if (v <= 150) return lerp(yellow, orange, (v - 100) / 50);
  if (v <= 200) return lerp(orange, red, (v - 150) / 50);
  if (v <= 300) return lerp(red, purple, (v - 200) / 100);
  return lerp(purple, maroon, Math.min(1, (v - 300) / 200));
}

function aqiToAlpha(aqi: number): number {
  if (aqi <= 50) return 95;
  if (aqi <= 100) return 155;
  if (aqi <= 150) return 205;
  if (aqi <= 200) return 235;
  return 245;
}

function tryBilinearGrid(pts: Sample[]): {
  lons: number[];
  lats: number[];
  grid: (number | null)[][];
} | null {
  const lons = [...new Set(pts.map((p) => p.lon))].sort((a, b) => a - b);
  const lats = [...new Set(pts.map((p) => p.lat))].sort((a, b) => a - b);
  if (lons.length < 3 || lats.length < 3) return null;
  if (lons.length * lats.length > pts.length * 1.5) return null;

  const key = (lon: number, lat: number) => `${lon},${lat}`;
  const map = new Map(pts.map((p) => [key(p.lon, p.lat), p.aqi]));
  const grid: (number | null)[][] = lats.map((lat) =>
    lons.map((lon) => map.get(key(lon, lat)) ?? null),
  );
  let filled = 0;
  for (const row of grid) for (const v of row) if (v != null) filled++;
  if (filled < lons.length * lats.length * 0.7) return null;
  return { lons, lats, grid };
}

function bilinear(
  lon: number,
  lat: number,
  lons: number[],
  lats: number[],
  grid: (number | null)[][],
): number | null {
  let i = 0;
  while (i < lons.length - 1 && lon > lons[i + 1]) i++;
  let j = 0;
  while (j < lats.length - 1 && lat > lats[j + 1]) j++;
  i = Math.max(0, Math.min(lons.length - 2, i));
  j = Math.max(0, Math.min(lats.length - 2, j));

  const lon0 = lons[i];
  const lon1 = lons[i + 1];
  const lat0 = lats[j];
  const lat1 = lats[j + 1];
  const q00 = grid[j][i];
  const q10 = grid[j][i + 1];
  const q01 = grid[j + 1][i];
  const q11 = grid[j + 1][i + 1];
  if (q00 == null || q10 == null || q01 == null || q11 == null) {
    const vals = [q00, q10, q01, q11].filter((v): v is number => v != null);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  const tx = lon1 === lon0 ? 0 : (lon - lon0) / (lon1 - lon0);
  const ty = lat1 === lat0 ? 0 : (lat - lat0) / (lat1 - lat0);
  const a = q00 * (1 - tx) + q10 * tx;
  const b = q01 * (1 - tx) + q11 * tx;
  return a * (1 - ty) + b * ty;
}

function idw(
  lon: number,
  lat: number,
  samples: Sample[],
  power: number,
  cosLat: number,
): number {
  let num = 0;
  let den = 0;
  for (const s of samples) {
    const dlon = (lon - s.lon) * cosLat;
    const dlat = lat - s.lat;
    const d2 = dlon * dlon + dlat * dlat;
    if (d2 < 1e-16) return s.aqi;
    const w = 1 / Math.pow(d2, power / 2);
    num += w * s.aqi;
    den += w;
  }
  return den > 0 ? num / den : 0;
}

/** Pull field toward elevated samples (≥100) so pin smoke stays orange/red. */
function hotspotBoost(
  lon: number,
  lat: number,
  base: number,
  samples: Sample[],
  cosLat: number,
  radiusDeg: number,
): number {
  let maxNear = 0;
  let weight = 0;
  const r2 = radiusDeg * radiusDeg;
  for (const s of samples) {
    if (s.aqi < 100) continue;
    const dlon = (lon - s.lon) * cosLat;
    const dlat = lat - s.lat;
    const d2 = dlon * dlon + dlat * dlat;
    if (d2 > r2) continue;
    const fall = Math.exp(-Math.sqrt(d2) / (radiusDeg * 0.35));
    if (s.aqi * fall > maxNear * weight) {
      maxNear = s.aqi;
      weight = fall;
    }
  }
  if (maxNear < 100 || weight < 0.08) return base;
  const mix = Math.min(0.75, 0.4 + weight * 0.4 + (maxNear - 100) / 250);
  return base * (1 - mix) + maxNear * mix;
}

function fieldCanvasSize(bounds: FieldBounds): {
  width: number;
  height: number;
  power: number;
  influence: number;
} {
  let { west, east, south, north } = bounds;
  if (east < west) east += 360;
  const span = Math.max(east - west, north - south);
  if (span > 50) return { width: 512, height: 340, power: 1.8, influence: 11 };
  if (span > 20) return { width: 420, height: 290, power: 1.95, influence: 6 };
  return { width: 360, height: 250, power: 2.1, influence: 3 };
}

export function renderAqiFieldDataUrl(
  samples: GridSample[],
  bounds: FieldBounds,
  /** Watchlist pins — field forced to match these AQI values nearby */
  pinSamples: GridSample[] = [],
): string | null {
  const basePts: Sample[] = samples
    .filter((s) => s.us_aqi != null && Number.isFinite(s.us_aqi as number))
    .map((s) => ({
      lon: s.longitude,
      lat: s.latitude,
      aqi: s.us_aqi as number,
    }));

  const pinPts: Sample[] = pinSamples
    .filter((s) => s.us_aqi != null && Number.isFinite(s.us_aqi as number))
    .map((s) => ({
      lon: s.longitude,
      lat: s.latitude,
      aqi: s.us_aqi as number,
    }));

  // Merge pins into sample set (override nearby grid cells)
  const pts = [...basePts];
  for (const p of pinPts) {
    const idx = pts.findIndex(
      (g) => Math.hypot(g.lon - p.lon, g.lat - p.lat) < 0.4,
    );
    if (idx >= 0) pts[idx] = p;
    else pts.push(p);
  }
  if (pts.length < 3) return null;

  let { west, south, east, north } = bounds;
  if (east < west) east += 360;
  const lonSpan = Math.max(0.01, east - west);
  const latSpan = Math.max(0.01, north - south);
  const midLat = (south + north) / 2;
  const cosLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));

  const auto = fieldCanvasSize(bounds);
  const w = auto.width;
  const h = auto.height;
  const grid = tryBilinearGrid(basePts);
  const hotSamples = pinPts.length ? pinPts : pts.filter((p) => p.aqi >= 100);

  const canvas =
    typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (!canvas) return null;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const img = ctx.createImageData(w, h);
  const data = img.data;

  for (let y = 0; y < h; y++) {
    const lat = north - ((y + 0.5) / h) * latSpan;
    for (let x = 0; x < w; x++) {
      let lon = west + ((x + 0.5) / w) * lonSpan;
      if (lon > 180) lon -= 360;

      let aqi =
        (grid && bilinear(lon, lat, grid.lons, grid.lats, grid.grid)) ??
        idw(lon, lat, pts, auto.power, cosLat);

      aqi = hotspotBoost(lon, lat, aqi, hotSamples, cosLat, auto.influence);

      const i = (y * w + x) * 4;
      const [r, g, b] = aqiToRgb(aqi);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = aqiToAlpha(aqi);
    }
  }

  // Light blur only
  const blurred = boxBlur(data, w, h, 1);
  img.data.set(blurred);
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

function boxBlur(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  if (radius <= 0) return src;
  const out = new Uint8ClampedArray(src.length);
  const r = radius;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let rSum = 0,
        gSum = 0,
        bSum = 0,
        aSum = 0,
        n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const i = (yy * width + xx) * 4;
          rSum += src[i];
          gSum += src[i + 1];
          bSum += src[i + 2];
          aSum += src[i + 3];
          n += 1;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = Math.round(rSum / n);
      out[o + 1] = Math.round(gSum / n);
      out[o + 2] = Math.round(bSum / n);
      out[o + 3] = Math.round(aSum / n);
    }
  }
  return out;
}

export function boundsToImageCoordinates(b: FieldBounds): [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
] {
  const { west, south, east, north } = b;
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
}
