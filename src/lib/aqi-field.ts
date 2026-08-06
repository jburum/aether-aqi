/**
 * Smooth continuous AQI field for MapLibre (weather-map style).
 *
 * Pipeline:
 *  1. Viewport samples from API (+ watchlist pins injected)
 *  2. Inverse-distance weighting → dense float AQI buffer
 *  3. Soft peak preservation: raise field toward elevated samples
 *     (smooth falloff only — no pie wedges / hard max sectors)
 *  4. Multi-pass blur on the scalar field (moderate — keep yellow/red)
 *  5. Strong accent curve + vivid EPA colorize → PNG
 *
 * Peak preservation is critical: pure IDW+heavy blur averages LA 64 into
 * surrounding green and the pin color no longer matches the field.
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

/**
 * EPA palette aligned to official bands:
 * 0–50 green, 51–100 yellow, 101–150 orange, 151+ red…
 * Good air (e.g. Newport 46) must stay green — no early yellow.
 */
export function aqiToRgb(aqi: number): [number, number, number] {
  const v = Math.max(0, Math.min(500, aqi));
  const good: [number, number, number] = [34, 140, 78];
  const goodHi: [number, number, number] = [70, 168, 72];
  const yellow: [number, number, number] = [255, 220, 0];
  const gold: [number, number, number] = [255, 185, 0];
  const orange: [number, number, number] = [255, 125, 0];
  const deepOrange: [number, number, number] = [255, 80, 20];
  const red: [number, number, number] = [255, 36, 36];
  const purple: [number, number, number] = [175, 40, 220];
  const maroon: [number, number, number] = [100, 10, 20];

  // Solid green through the "Good" band (0–50)
  if (v <= 50) return lerpRgb(good, goodHi, v / 50);
  // Moderate → yellow/gold
  if (v <= 75) return lerpRgb(goodHi, yellow, (v - 50) / 25);
  if (v <= 100) return lerpRgb(yellow, gold, (v - 75) / 25);
  // USG → orange
  if (v <= 125) return lerpRgb(gold, orange, (v - 100) / 25);
  if (v <= 150) return lerpRgb(orange, deepOrange, (v - 125) / 25);
  // Unhealthy → red
  if (v <= 200) return lerpRgb(deepOrange, red, (v - 150) / 50);
  if (v <= 300) return lerpRgb(red, purple, (v - 200) / 100);
  return lerpRgb(purple, maroon, Math.min(1, (v - 300) / 200));
}

function aqiToAlpha(aqi: number): number {
  if (aqi <= 50) return 135;
  if (aqi <= 70) return 175;
  if (aqi <= 100) return 200;
  if (aqi <= 150) return 225;
  if (aqi <= 200) return 240;
  return 250;
}

/**
 * Accent only moderate+ so yellow/red read clearly.
 * Never push good air (≤50) into yellow — that made Newport 46 look gold.
 */
function accentuate(aqi: number): number {
  if (aqi <= 50) return aqi; // keep Good band truthful
  if (aqi <= 100) {
    const t = (aqi - 50) / 50;
    // Mild lift inside moderate only
    return 50 + t * 50 + t * (1 - t) * 10;
  }
  if (aqi <= 150) {
    const t = (aqi - 100) / 50;
    return 100 + t * 50 + t * (1 - t) * 12;
  }
  return aqi + Math.min(28, 10 + (aqi - 150) * 0.1);
}

/**
 * Zoom-stable raster params: fixed °→px scale + geographic blur.
 * Same lat/lon with the same samples always paints the same color,
 * regardless of viewport size.
 */
function fieldParams(lonSpan: number, latSpan: number): {
  width: number;
  height: number;
  blurPasses: number;
  blurRadius: number;
  idwPower: number;
} {
  // Constant geographic resolution (not viewport-relative tiers)
  const PX_PER_DEG = 7;
  let width = Math.round(lonSpan * PX_PER_DEG);
  let height = Math.round(latSpan * PX_PER_DEG);
  width = Math.max(280, Math.min(960, width));
  height = Math.max(200, Math.min(640, height));
  // Blur ~0.7° in geographic space → stable zone edges when zoom changes
  const blurDeg = 0.7;
  const blurRadius = Math.max(
    1,
    Math.round(blurDeg * Math.min(width / lonSpan, height / latSpan)),
  );
  return {
    width,
    height,
    blurPasses: 3,
    blurRadius,
    idwPower: 2.2, // fixed — never changes with zoom
  };
}

/** Sample query limits (image still paints full viewport via IDW). */
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

/**
 * Bounds for the /api/aqi-grid request only (may be clamped for API limits).
 * Never use this as MapLibre image coordinates.
 */
export function clampBoundsForApi(b: FieldBounds, pad = 0.12): FieldBounds {
  const { w: viewW, e: viewE } = normalizeLonPair(b.west, b.east);
  const lonSpan = Math.max(0.01, viewE - viewW);
  const latSpan = Math.max(0.01, b.north - b.south);
  const effectivePad =
    latSpan > 45 || lonSpan > 70
      ? Math.min(pad, 0.05)
      : latSpan > 28 || lonSpan > 45
        ? Math.min(pad, 0.1)
        : pad;

  let w = viewW - lonSpan * effectivePad;
  let e = viewE + lonSpan * effectivePad;
  let s = Math.max(-85, b.south - latSpan * effectivePad);
  let n = Math.min(85, b.north + latSpan * effectivePad);

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

/**
 * Image paint bounds: slightly larger than the viewport so soft feathered
 * edges sit at/beyond the screen edge — no hard cutoff line mid-map.
 * Does NOT clamp to API limits (samples are fetched separately).
 */
export function padBoundsForPaint(view: FieldBounds, padFrac = 0.22): FieldBounds {
  const { w: viewW, e: viewE } = normalizeLonPair(view.west, view.east);
  const lonSpan = Math.max(0.01, viewE - viewW);
  const latSpan = Math.max(0.01, view.north - view.south);
  // Keep pad modest on huge views so the canvas stays reasonable
  const p =
    latSpan > 50 || lonSpan > 80
      ? Math.min(padFrac, 0.1)
      : latSpan > 30 || lonSpan > 50
        ? Math.min(padFrac, 0.15)
        : padFrac;

  let w = viewW - lonSpan * p;
  let e = viewE + lonSpan * p;
  let s = Math.max(-85, view.south - latSpan * p);
  let n = Math.min(85, view.north + latSpan * p);

  // Soft size cap for raster only (not API) — still larger than typical view
  const maxLat = 95;
  const maxLon = 170;
  if (n - s > maxLat) {
    const mid = (view.south + view.north) / 2;
    s = Math.max(-85, mid - maxLat / 2);
    n = Math.min(85, mid + maxLat / 2);
    // Prefer containing the view
    if (s > view.south) s = view.south;
    if (n < view.north) n = view.north;
  }
  if (e - w > maxLon) {
    const mid = (viewW + viewE) / 2;
    w = mid - maxLon / 2;
    e = mid + maxLon / 2;
    if (w > viewW) w = viewW;
    if (e < viewE) e = viewE;
  }

  const lon = packLon(w, e);
  return { west: lon.west, south: s, east: lon.east, north: n };
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

function sampleIdw(
  lon: number,
  lat: number,
  pts: Sample[],
  cosLat: number,
  power: number,
): number {
  let num = 0;
  let den = 0;
  const eps = 1e-8;
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

/**
 * Soft sample authority: pull field toward sample AQI with smooth falloff.
 * - Elevated samples: lift (yellow/red islands)
 * - Good pins (e.g. Newport 46): also pull *down* so green pins aren't
 *   buried under yellow IDW from distant moderate neighbors
 * `bidirectional` true = pins (trusted); false = grid peaks (lift only)
 */
function applySampleInfluence(
  field: Float32Array,
  w: number,
  h: number,
  west: number,
  lonSpan: number,
  latSpan: number,
  north: number,
  samples: Sample[],
  cosLat: number,
  bidirectional: boolean,
): void {
  if (!samples.length) return;

  for (const p of samples) {
    const R =
      p.aqi >= 150
        ? 7.5
        : p.aqi >= 100
          ? 6.0
          : p.aqi >= 70
            ? 4.5
            : p.aqi >= 51
              ? 3.5
              : 4.0; // good pins still get a clear local green island
    const boost =
      p.aqi >= 150
        ? 0.95
        : p.aqi >= 100
          ? 0.9
          : p.aqi >= 70
            ? 0.88
            : p.aqi >= 51
              ? 0.85
              : 0.92; // strong local match for good pins

    const px = ((p.lon < west ? p.lon + 360 : p.lon) - west) / lonSpan;
    const py = (north - p.lat) / latSpan;
    const padX = (R / lonSpan) * 1.15;
    const padY = (R / latSpan) * 1.15;
    const x0 = Math.max(0, Math.floor((px - padX) * w));
    const x1 = Math.min(w - 1, Math.ceil((px + padX) * w));
    const y0 = Math.max(0, Math.floor((py - padY) * h));
    const y1 = Math.min(h - 1, Math.ceil((py + padY) * h));

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
        const cur = field[i];
        const blended = cur * (1 - mix) + p.aqi * mix;
        if (bidirectional) {
          field[i] = blended; // pins: match pin color both ways
        } else if (blended > cur) {
          field[i] = blended; // grid: only lift elevated
        }
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

  const pts = [...base];
  for (const p of pins) {
    const idx = pts.findIndex(
      (g) => Math.hypot(g.lon - p.lon, g.lat - p.lat) < 0.6,
    );
    if (idx >= 0) pts[idx] = p;
    else pts.push(p);
  }
  return { pts, pins };
}

/**
 * Render continuous AQI field as a PNG data URL for MapLibre image source.
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

  const { width: w, height: h, blurPasses, blurRadius, idwPower } =
    fieldParams(lonSpan, latSpan);

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

  // 2) Pin authority (all pins, both directions) so Newport 46 → green island
  //    and LA 64 / NW 154 match yellow/red. Then grid lift for elevated cells.
  applySampleInfluence(
    field,
    w,
    h,
    west,
    lonSpan,
    latSpan,
    north,
    pins,
    cosLat,
    true,
  );

  const elevatedGrid: Sample[] = [];
  const seen = new Set(pins.map((p) => `${p.lon.toFixed(2)},${p.lat.toFixed(2)}`));
  for (const p of pts) {
    if (p.aqi < 65) continue;
    const k = `${p.lon.toFixed(2)},${p.lat.toFixed(2)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    elevatedGrid.push(p);
  }
  applySampleInfluence(
    field,
    w,
    h,
    west,
    lonSpan,
    latSpan,
    north,
    elevatedGrid,
    cosLat,
    false,
  );

  // 3) Moderate blur → soft zone edges without dissolving peaks into green
  const smooth = blurFloat(field, w, h, blurRadius, blurPasses);

  // Precompute max influence radius for data-edge fade (degrees)
  // Beyond this, field soft-fades into the basemap instead of a hard cut.
  let dataRadius = 10;
  if (pts.length >= 4) {
    // Wider views → longer fade so sparse far-north cells dissolve gently
    dataRadius = Math.max(8, Math.min(28, Math.hypot(lonSpan, latSpan) * 0.22));
  }
  const dataFadeStart = dataRadius * 0.45;
  const dataFadeEnd = dataRadius * 1.35;

  // Edge feather as fraction of raster (outer rim → transparent)
  const edgeFeather = 0.14;

  // 4) Colorize + soft edge / data-boundary fade into basemap
  const canvas =
    typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (!canvas) return null;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const img = ctx.createImageData(w, h);
  const data = img.data;
  for (let y = 0; y < h; y++) {
    const lat = north - ((y + 0.5) / h) * latSpan;
    // Normalized distance to nearest image edge [0=edge, 0.5=center]
    const ey = Math.min(y + 0.5, h - 0.5 - y) / h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const aqi = accentuate(smooth[i]);
      const [r, g, b] = aqiToRgb(aqi);

      let lon = west + ((x + 0.5) / w) * lonSpan;
      if (lon > 180) lon -= 360;

      // --- Image-edge feather (smoothstep) ---
      const ex = Math.min(x + 0.5, w - 0.5 - x) / w;
      const edgeDist = Math.min(ex, ey);
      let edgeMul = 1;
      if (edgeDist < edgeFeather) {
        const t = edgeDist / edgeFeather;
        edgeMul = t * t * (3 - 2 * t);
      }

      // --- Data-edge feather: fade where samples are far away ---
      let minD = Infinity;
      for (const s of pts) {
        const dlon = (lon - s.lon) * cosLat;
        const dlat = lat - s.lat;
        const d = Math.sqrt(dlon * dlon + dlat * dlat);
        if (d < minD) minD = d;
      }
      let dataMul = 1;
      if (minD >= dataFadeEnd) dataMul = 0;
      else if (minD > dataFadeStart) {
        const t = 1 - (minD - dataFadeStart) / (dataFadeEnd - dataFadeStart);
        dataMul = t * t * (3 - 2 * t);
      }

      const o = i * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = Math.round(aqiToAlpha(aqi) * edgeMul * dataMul);
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
