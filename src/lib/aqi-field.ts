/**
 * Smooth continuous AQI field for MapLibre (weather-map style).
 *
 * Pipeline:
 *  1. Viewport samples from API (+ watchlist pins injected)
 *  2. Inverse-distance weighting → dense float AQI buffer
 *  3. Heavy multi-pass separable blur on the scalar field
 *  4. Soft accent curve (preserve yellow/red without spatial wedges)
 *  5. Colorize EPA bands → PNG raster
 *
 * No radial plumes / nearest-neighbor / hard max — those create pie wedges.
 */
import type { GridSample } from "@/lib/aqi-grid";

export type FieldBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

type Sample = { lon: number; lat: number; aqi: number };

function lerpRgb(
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

/** Continuous EPA-ish palette (smooth band transitions). */
export function aqiToRgb(aqi: number): [number, number, number] {
  const v = Math.max(0, Math.min(500, aqi));
  const good: [number, number, number] = [34, 120, 72];
  const midGreen: [number, number, number] = [90, 165, 55];
  const yellow: [number, number, number] = [255, 214, 0];
  const orange: [number, number, number] = [255, 140, 0];
  const red: [number, number, number] = [255, 48, 48];
  const purple: [number, number, number] = [175, 40, 220];
  const maroon: [number, number, number] = [100, 10, 20];

  if (v <= 50) return lerpRgb(good, midGreen, v / 50);
  if (v <= 100) return lerpRgb(midGreen, yellow, (v - 50) / 50);
  if (v <= 150) return lerpRgb(yellow, orange, (v - 100) / 50);
  if (v <= 200) return lerpRgb(orange, red, (v - 150) / 50);
  if (v <= 300) return lerpRgb(red, purple, (v - 200) / 100);
  return lerpRgb(purple, maroon, Math.min(1, (v - 300) / 200));
}

function aqiToAlpha(aqi: number): number {
  // Even coverage so zones read as continuous wash, not sparse blobs
  if (aqi <= 50) return 115;
  if (aqi <= 100) return 160;
  if (aqi <= 150) return 200;
  if (aqi <= 200) return 220;
  return 235;
}

/**
 * Soft accent: lift moderate+ slightly so yellow/red stay visible after blur,
 * without introducing spatial discontinuities (monotone curve only).
 */
function accentuate(aqi: number): number {
  if (aqi <= 45) return aqi;
  if (aqi <= 100) {
    // Stretch 45–100 toward yellow range
    const t = (aqi - 45) / 55;
    return 45 + t * t * 55 + t * (1 - t) * 12;
  }
  if (aqi <= 150) {
    const t = (aqi - 100) / 50;
    return 100 + t * 50 + t * (1 - t) * 8;
  }
  // Mild lift on unhealthy+ so reds don't wash out
  return aqi + Math.min(20, (aqi - 150) * 0.08);
}

function fieldParams(bounds: FieldBounds): {
  width: number;
  height: number;
  blurPasses: number;
  blurRadius: number;
  idwPower: number;
} {
  let { west, east, south, north } = bounds;
  if (east < west) east += 360;
  const span = Math.max(east - west, north - south);
  // Higher res + more blur = clean continuous color zones
  if (span > 50) {
    return { width: 720, height: 480, blurPasses: 8, blurRadius: 5, idwPower: 1.6 };
  }
  if (span > 20) {
    return { width: 600, height: 400, blurPasses: 7, blurRadius: 4, idwPower: 1.75 };
  }
  if (span > 8) {
    return { width: 520, height: 360, blurPasses: 6, blurRadius: 3, idwPower: 1.9 };
  }
  return { width: 440, height: 320, blurPasses: 5, blurRadius: 3, idwPower: 2.1 };
}

/** Separable box blur on a float field (approximates Gaussian with many passes). */
function blurFloat(
  src: Float32Array,
  w: number,
  h: number,
  radius: number,
  passes: number,
): Float32Array {
  let a = Float32Array.from(src);
  let b = new Float32Array(src.length);
  const r = Math.max(1, radius);

  for (let p = 0; p < passes; p++) {
    // Horizontal
    for (let y = 0; y < h; y++) {
      const row = y * w;
      // Sliding window for speed
      let sum = 0;
      let n = 0;
      for (let x = 0; x < Math.min(w, r + 1); x++) {
        sum += a[row + x];
        n++;
      }
      for (let x = 0; x < w; x++) {
        b[row + x] = sum / n;
        const add = x + r + 1;
        const rem = x - r;
        if (add < w) {
          sum += a[row + add];
          n++;
        }
        if (rem >= 0) {
          sum -= a[row + rem];
          n--;
        }
      }
    }
    // Vertical
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let y = 0; y < Math.min(h, r + 1); y++) {
        sum += b[y * w + x];
        n++;
      }
      for (let y = 0; y < h; y++) {
        a[y * w + x] = sum / n;
        const add = y + r + 1;
        const rem = y - r;
        if (add < h) {
          sum += b[add * w + x];
          n++;
        }
        if (rem >= 0) {
          sum -= b[rem * w + x];
          n--;
        }
      }
    }
  }
  return a;
}

/**
 * Inverse-distance weighting over all samples.
 * Power ~1.5–2 gives broad smooth regions; higher power = tighter local peaks.
 * Uses geographic distance with cos(lat) correction.
 */
function sampleIdw(
  lon: number,
  lat: number,
  pts: Sample[],
  cosLat: number,
  power: number,
): number {
  let num = 0;
  let den = 0;
  // Soft influence floor so distant samples still contribute (no Voronoi facets)
  const eps = 1e-8;
  for (const s of pts) {
    const dlon = (lon - s.lon) * cosLat;
    const dlat = lat - s.lat;
    const d2 = dlon * dlon + dlat * dlat;
    if (d2 < eps) return s.aqi;
    // w = 1 / d^p  with d = sqrt(d2) → w = d2^(-p/2)
    const w = Math.pow(d2, -power / 2);
    num += w * s.aqi;
    den += w;
  }
  return den > 0 ? num / den : 0;
}

function mergeSamples(
  samples: GridSample[],
  pinSamples: GridSample[],
): Sample[] {
  const base: Sample[] = samples
    .filter((s) => s.us_aqi != null && Number.isFinite(s.us_aqi as number))
    .map((s) => ({
      lon: s.longitude,
      lat: s.latitude,
      aqi: s.us_aqi as number,
    }));

  const pins: Sample[] = pinSamples
    .filter((s) => s.us_aqi != null && Number.isFinite(s.us_aqi as number))
    .map((s) => ({
      lon: s.longitude,
      lat: s.latitude,
      aqi: s.us_aqi as number,
    }));

  // Pins override nearest grid cell so field matches card numbers
  const pts = [...base];
  for (const p of pins) {
    const idx = pts.findIndex(
      (g) => Math.hypot(g.lon - p.lon, g.lat - p.lat) < 0.6,
    );
    if (idx >= 0) pts[idx] = p;
    else pts.push(p);
  }
  return pts;
}

/**
 * Render continuous AQI field as a PNG data URL for MapLibre image source.
 */
export function renderAqiFieldDataUrl(
  samples: GridSample[],
  bounds: FieldBounds,
  pinSamples: GridSample[] = [],
): string | null {
  const pts = mergeSamples(samples, pinSamples);
  if (pts.length < 2) return null;

  let { west, south, east, north } = bounds;
  if (east < west) east += 360;
  const lonSpan = Math.max(0.01, east - west);
  const latSpan = Math.max(0.01, north - south);
  const midLat = (south + north) / 2;
  const cosLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));

  const { width: w, height: h, blurPasses, blurRadius, idwPower } =
    fieldParams(bounds);

  // 1) Dense IDW scalar field
  const field = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const lat = north - ((y + 0.5) / h) * latSpan;
    for (let x = 0; x < w; x++) {
      let lon = west + ((x + 0.5) / w) * lonSpan;
      if (lon > 180) lon -= 360;
      field[y * w + x] = sampleIdw(lon, lat, pts, cosLat, idwPower);
    }
  }

  // 2) Heavy blur → clean continuous zones (weather-map look)
  const smooth = blurFloat(field, w, h, blurRadius, blurPasses);

  // 3) Colorize
  const canvas =
    typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (!canvas) return null;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const img = ctx.createImageData(w, h);
  const data = img.data;
  for (let i = 0; i < w * h; i++) {
    const aqi = accentuate(smooth[i]);
    const [r, g, b] = aqiToRgb(aqi);
    const o = i * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = aqiToAlpha(aqi);
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
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
