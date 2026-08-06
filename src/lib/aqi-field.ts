/**
 * Regional AQI field for MapLibre — accuracy first.
 *
 * What we got wrong before:
 *  - Sparse IDW + huge plumes + heavy accent invented red blobs that
 *    drifted away from real sample/pin locations when zoom changed.
 *  - "Data distance" alpha punched dark holes and hard edges.
 *
 * What we do now:
 *  1. Snap samples onto a regular lon/lat lattice (same cells every time)
 *  2. Inject watchlist pins into nearest cells (field matches pin AQI)
 *  3. Bilinear interpolate the lattice → continuous field
 *  4. One light geographic blur (fixed °, not zoom-dependent tiers)
 *  5. Soft pin halo (fixed °) so 154 stays red under the pin
 *  6. True EPA colors; only image-rim feather (no data-hole fade)
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

/** Official-ish EPA continuous palette (bands at 50 / 100 / 150 / 200…). */
export function aqiToRgb(aqi: number): [number, number, number] {
  const v = Math.max(0, Math.min(500, aqi));
  const good: [number, number, number] = [34, 140, 78];
  const goodHi: [number, number, number] = [90, 170, 60];
  const yellow: [number, number, number] = [255, 220, 0];
  const orange: [number, number, number] = [255, 140, 0];
  const red: [number, number, number] = [255, 40, 40];
  const purple: [number, number, number] = [175, 40, 220];
  const maroon: [number, number, number] = [100, 10, 20];

  if (v <= 50) return lerpRgb(good, goodHi, v / 50);
  if (v <= 100) return lerpRgb(goodHi, yellow, (v - 50) / 50);
  if (v <= 150) return lerpRgb(yellow, orange, (v - 100) / 50);
  if (v <= 200) return lerpRgb(orange, red, (v - 150) / 50);
  if (v <= 300) return lerpRgb(red, purple, (v - 200) / 100);
  return lerpRgb(purple, maroon, Math.min(1, (v - 300) / 200));
}

function aqiToAlpha(aqi: number): number {
  if (aqi <= 50) return 130;
  if (aqi <= 100) return 170;
  if (aqi <= 150) return 200;
  if (aqi <= 200) return 220;
  return 235;
}

export const FIELD_MAX_LAT_SPAN = 78;
export const FIELD_MAX_LON_SPAN = 155;

function normalizeLonPair(west: number, east: number): { w: number; e: number } {
  let w = west;
  let e = east;
  if (e < w) e += 360;
  return { w, e };
}

function packLon(w: number, e: number): { west: number; east: number } {
  while (w < -180) {
    w += 360;
    e += 360;
  }
  while (w > 180) {
    w -= 360;
    e -= 360;
  }
  return { west: w, east: e > 180 ? e - 360 : e };
}

/** API sample query bounds (may clamp). Never use as image coordinates alone. */
export function clampBoundsForApi(b: FieldBounds, pad = 0.12): FieldBounds {
  const { w: viewW, e: viewE } = normalizeLonPair(b.west, b.east);
  const lonSpan = Math.max(0.01, viewE - viewW);
  const latSpan = Math.max(0.01, b.north - b.south);
  const p =
    latSpan > 45 || lonSpan > 70
      ? Math.min(pad, 0.05)
      : latSpan > 28 || lonSpan > 45
        ? Math.min(pad, 0.1)
        : pad;

  let w = viewW - lonSpan * p;
  let e = viewE + lonSpan * p;
  let s = Math.max(-85, b.south - latSpan * p);
  let n = Math.min(85, b.north + latSpan * p);

  if (n - s > FIELD_MAX_LAT_SPAN) {
    const mid = (s + n) / 2;
    s = mid - FIELD_MAX_LAT_SPAN / 2;
    n = mid + FIELD_MAX_LAT_SPAN / 2;
  }
  if (e - w > FIELD_MAX_LON_SPAN) {
    const mid = (w + e) / 2;
    w = mid - FIELD_MAX_LON_SPAN / 2;
    e = mid + FIELD_MAX_LON_SPAN / 2;
  }
  const lon = packLon(w, e);
  return { west: lon.west, south: s, east: lon.east, north: n };
}

/** Image bounds: a bit larger than the view so rim feather is at the edge. */
export function padBoundsForPaint(view: FieldBounds, padFrac = 0.18): FieldBounds {
  const { w: viewW, e: viewE } = normalizeLonPair(view.west, view.east);
  const lonSpan = Math.max(0.01, viewE - viewW);
  const latSpan = Math.max(0.01, view.north - view.south);
  const p =
    latSpan > 50 || lonSpan > 80
      ? Math.min(padFrac, 0.08)
      : latSpan > 30 || lonSpan > 50
        ? Math.min(padFrac, 0.12)
        : padFrac;

  let w = viewW - lonSpan * p;
  let e = viewE + lonSpan * p;
  let s = Math.max(-85, view.south - latSpan * p);
  let n = Math.min(85, view.north + latSpan * p);

  // Always contain the view
  w = Math.min(w, viewW);
  e = Math.max(e, viewE);
  s = Math.min(s, view.south);
  n = Math.max(n, view.north);

  const lon = packLon(w, e);
  return { west: lon.west, south: s, east: lon.east, north: n };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Build a regular lon/lat lattice from scattered samples.
 * Empty cells filled by neighbor average (few passes) so bilinear works.
 */
function buildLattice(pts: Sample[]): {
  lons: number[];
  lats: number[];
  grid: (number | null)[][];
} | null {
  if (pts.length < 2) return null;

  // Prefer true regular grid spacing when samples come from our lattice API
  const lons = [...new Set(pts.map((p) => round2(p.lon)))].sort((a, b) => a - b);
  const lats = [...new Set(pts.map((p) => round2(p.lat)))].sort((a, b) => a - b);
  if (lons.length < 2 || lats.length < 2) return null;

  const key = (lon: number, lat: number) => `${round2(lon)},${round2(lat)}`;
  const map = new Map<string, number>();
  for (const p of pts) {
    const k = key(p.lon, p.lat);
    const prev = map.get(k);
    // Keep higher AQI if two samples land in same cell (pin overrides mild grid)
    if (prev == null || p.aqi > prev) map.set(k, p.aqi);
  }

  const grid: (number | null)[][] = lats.map((lat) =>
    lons.map((lon) => map.get(`${lon},${lat}`) ?? null),
  );

  // Fill small gaps so bilinear has 4 corners
  for (let pass = 0; pass < 4; pass++) {
    for (let j = 0; j < lats.length; j++) {
      for (let i = 0; i < lons.length; i++) {
        if (grid[j][i] != null) continue;
        const neigh: number[] = [];
        if (i > 0 && grid[j][i - 1] != null) neigh.push(grid[j][i - 1]!);
        if (i < lons.length - 1 && grid[j][i + 1] != null)
          neigh.push(grid[j][i + 1]!);
        if (j > 0 && grid[j - 1][i] != null) neigh.push(grid[j - 1][i]!);
        if (j < lats.length - 1 && grid[j + 1][i] != null)
          neigh.push(grid[j + 1][i]!);
        if (neigh.length >= 2) {
          grid[j][i] = neigh.reduce((a, b) => a + b, 0) / neigh.length;
        }
      }
    }
  }
  return { lons, lats, grid };
}

function bilinear(
  lon: number,
  lat: number,
  lons: number[],
  lats: number[],
  grid: (number | null)[][],
): number | null {
  if (lons.length < 2 || lats.length < 2) return null;

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
  // Smoothstep for softer cell transitions
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = q00 * (1 - sx) + q10 * sx;
  const b = q01 * (1 - sx) + q11 * sx;
  return a * (1 - sy) + b * sy;
}

/** Fallback when lattice is incomplete: classic IDW, moderate power. */
function sampleIdw(
  lon: number,
  lat: number,
  pts: Sample[],
  cosLat: number,
): number {
  let num = 0;
  let den = 0;
  const power = 2.2;
  const eps = 1e-10;
  for (const s of pts) {
    const dlon = (lon - s.lon) * cosLat;
    const dlat = lat - s.lat;
    const d2 = dlon * dlon + dlat * dlat;
    if (d2 < eps) return s.aqi;
    const w = Math.pow(d2, -power / 2);
    num += w * s.aqi;
    den += w;
  }
  return den > 0 ? num / den : 0;
}

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
    for (let y = 0; y < h; y++) {
      const row = y * w;
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
 * Soft-set field toward pin AQI in a fixed geographic radius.
 * Runs AFTER blur so the hotspot stays under the pin at every zoom.
 */
function applyPinHalos(
  field: Float32Array,
  w: number,
  h: number,
  west: number,
  lonSpan: number,
  latSpan: number,
  north: number,
  pins: Sample[],
  cosLat: number,
): void {
  for (const p of pins) {
    // Compact fixed radius (degrees) — does not grow with zoom-out
    const R = p.aqi >= 150 ? 2.8 : p.aqi >= 100 ? 2.5 : p.aqi >= 55 ? 2.2 : 2.0;
    const boost = 0.92;

    const px = ((p.lon < west ? p.lon + 360 : p.lon) - west) / lonSpan;
    const py = (north - p.lat) / latSpan;
    const x0 = Math.max(0, Math.floor((px - (R / lonSpan) * 1.2) * w));
    const x1 = Math.min(w - 1, Math.ceil((px + (R / lonSpan) * 1.2) * w));
    const y0 = Math.max(0, Math.floor((py - (R / latSpan) * 1.2) * h));
    const y1 = Math.min(h - 1, Math.ceil((py + (R / latSpan) * 1.2) * h));

    for (let y = y0; y <= y1; y++) {
      const lat = north - ((y + 0.5) / h) * latSpan;
      for (let x = x0; x <= x1; x++) {
        let lon = west + ((x + 0.5) / w) * lonSpan;
        if (lon > 180) lon -= 360;
        const dlon = (lon - p.lon) * cosLat;
        const dlat = lat - p.lat;
        const d = Math.sqrt(dlon * dlon + dlat * dlat);
        if (d >= R) continue;
        const t = 1 - d / R;
        const fall = t * t * (3 - 2 * t);
        const mix = fall * boost;
        const i = y * w + x;
        field[i] = field[i] * (1 - mix) + p.aqi * mix;
      }
    }
  }
}

function mergeSamples(
  samples: GridSample[],
  pinSamples: GridSample[],
): { pts: Sample[]; pins: Sample[] } {
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

  // Pins replace nearest grid cell so lattice + bilinear match the card
  const pts = [...base];
  for (const p of pins) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i].lon - p.lon, pts[i].lat - p.lat);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0 && bestD < 1.5) pts[best] = { ...p };
    else pts.push(p);
  }
  return { pts, pins };
}

/**
 * Render continuous AQI field as a PNG data URL for MapLibre image source.
 * `bounds` must be the same box passed to boundsToImageCoordinates.
 */
export function renderAqiFieldDataUrl(
  samples: GridSample[],
  bounds: FieldBounds,
  pinSamples: GridSample[] = [],
): string | null {
  const { pts, pins } = mergeSamples(samples, pinSamples);
  if (pts.length < 2) return null;

  let { west, south, east, north } = bounds;
  if (east < west) east += 360;
  const lonSpan = Math.max(0.01, east - west);
  const latSpan = Math.max(0.01, north - south);
  const midLat = (south + north) / 2;
  const cosLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));

  // Fixed °→px so the same geography paints the same at every zoom
  const PX_PER_DEG = 8;
  let w = Math.round(lonSpan * PX_PER_DEG);
  let h = Math.round(latSpan * PX_PER_DEG);
  w = Math.max(320, Math.min(960, w));
  h = Math.max(240, Math.min(720, h));

  const lattice = buildLattice(pts);

  // 1) Lattice bilinear (preferred) or IDW fallback
  const field = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const lat = north - ((y + 0.5) / h) * latSpan;
    for (let x = 0; x < w; x++) {
      let lon = west + ((x + 0.5) / w) * lonSpan;
      if (lon > 180) lon -= 360;
      let aqi: number | null = null;
      if (lattice) {
        aqi = bilinear(lon, lat, lattice.lons, lattice.lats, lattice.grid);
      }
      if (aqi == null) aqi = sampleIdw(lon, lat, pts, cosLat);
      field[y * w + x] = aqi;
    }
  }

  // 2) Light geographic blur (~0.5°) — soft zones, does not invent peaks
  const blurDeg = 0.5;
  const blurRadius = Math.max(
    1,
    Math.round(blurDeg * Math.min(w / lonSpan, h / latSpan)),
  );
  const smooth = blurFloat(field, w, h, blurRadius, 2);

  // 3) Pin halos AFTER blur — 154 stays red under the 154 pin
  applyPinHalos(smooth, w, h, west, lonSpan, latSpan, north, pins, cosLat);

  // 4) Colorize; only feather the image rim (no data-distance holes)
  const canvas =
    typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (!canvas) return null;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const edgeFeather = 0.1;
  const img = ctx.createImageData(w, h);
  const data = img.data;
  for (let y = 0; y < h; y++) {
    const ey = Math.min(y + 0.5, h - 0.5 - y) / h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const aqi = smooth[i];
      const [r, g, b] = aqiToRgb(aqi);
      const ex = Math.min(x + 0.5, w - 0.5 - x) / w;
      const edgeDist = Math.min(ex, ey);
      let edgeMul = 1;
      if (edgeDist < edgeFeather) {
        const t = edgeDist / edgeFeather;
        edgeMul = t * t * (3 - 2 * t);
      }
      const o = i * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = Math.round(aqiToAlpha(aqi) * edgeMul);
    }
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
