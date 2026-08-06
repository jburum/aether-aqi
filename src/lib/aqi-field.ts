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
 * Vivid EPA palette — yellow/orange/red start earlier and stay saturated
 * so moderate (e.g. LA 64) reads yellow, not green-tinted.
 */
export function aqiToRgb(aqi: number): [number, number, number] {
  const v = Math.max(0, Math.min(500, aqi));
  const good: [number, number, number] = [28, 115, 68];
  const lightGreen: [number, number, number] = [120, 175, 50];
  // Enter yellow early so ~55–70 is clearly yellow
  const yellow: [number, number, number] = [255, 220, 0];
  const gold: [number, number, number] = [255, 185, 0];
  const orange: [number, number, number] = [255, 125, 0];
  const deepOrange: [number, number, number] = [255, 80, 20];
  const red: [number, number, number] = [255, 36, 36];
  const purple: [number, number, number] = [175, 40, 220];
  const maroon: [number, number, number] = [100, 10, 20];

  if (v <= 40) return lerpRgb(good, lightGreen, v / 40);
  // 40–55: green → yellow (so 50+ already yellowing)
  if (v <= 55) return lerpRgb(lightGreen, yellow, (v - 40) / 15);
  if (v <= 80) return lerpRgb(yellow, gold, (v - 55) / 25);
  if (v <= 100) return lerpRgb(gold, orange, (v - 80) / 20);
  if (v <= 130) return lerpRgb(orange, deepOrange, (v - 100) / 30);
  if (v <= 150) return lerpRgb(deepOrange, red, (v - 130) / 20);
  if (v <= 200) return lerpRgb(red, [255, 20, 60], (v - 150) / 50);
  if (v <= 300) return lerpRgb([255, 20, 60], purple, (v - 200) / 100);
  return lerpRgb(purple, maroon, Math.min(1, (v - 300) / 200));
}

function aqiToAlpha(aqi: number): number {
  // Stronger opacity on moderate+ so yellow/red dominate the basemap
  if (aqi <= 45) return 120;
  if (aqi <= 70) return 175;
  if (aqi <= 100) return 200;
  if (aqi <= 150) return 225;
  if (aqi <= 200) return 240;
  return 250;
}

/**
 * Strong accent: pull moderate into clear yellow and unhealthy into red
 * after blur still leaves values a bit soft.
 */
function accentuate(aqi: number): number {
  if (aqi <= 35) return aqi;
  if (aqi <= 55) {
    // Jump toward yellow threshold
    const t = (aqi - 35) / 20;
    return 35 + t * 30 + t * t * 8; // ~35 → ~73 at 55
  }
  if (aqi <= 100) {
    const t = (aqi - 55) / 45;
    // Push mid-moderate firmly into gold/orange-readable range
    return 73 + t * 45 + t * (1 - t) * 18;
  }
  if (aqi <= 150) {
    const t = (aqi - 100) / 50;
    return 118 + t * 55 + t * (1 - t) * 14; // ~118 → ~187
  }
  // Unhealthy+ get a firm red lift
  return aqi + Math.min(35, 12 + (aqi - 150) * 0.12);
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
  // Lighter blur than before so local yellow/red islands survive
  if (span > 50) {
    return { width: 720, height: 480, blurPasses: 4, blurRadius: 3, idwPower: 2.0 };
  }
  if (span > 20) {
    return { width: 600, height: 400, blurPasses: 4, blurRadius: 3, idwPower: 2.2 };
  }
  if (span > 8) {
    return { width: 520, height: 360, blurPasses: 3, blurRadius: 2, idwPower: 2.4 };
  }
  return { width: 440, height: 320, blurPasses: 3, blurRadius: 2, idwPower: 2.6 };
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
 * Soft peak preservation: for each elevated sample, raise nearby pixels
 * toward that sample's AQI with a smooth radial falloff.
 * Only lifts (never carves sectors) — after a light blur this becomes
 * clean yellow/red weather-map islands that match pin colors.
 */
function preservePeaks(
  field: Float32Array,
  w: number,
  h: number,
  west: number,
  lonSpan: number,
  latSpan: number,
  north: number,
  peaks: Sample[],
  cosLat: number,
): void {
  if (!peaks.length) return;

  for (const p of peaks) {
    // Geographic radius (degrees): moderate gets a real island; red gets larger
    // LA 64 → ~3.5°, 130 → ~6°, 154 → ~7°
    const R =
      p.aqi >= 150
        ? 7.5
        : p.aqi >= 100
          ? 6.0
          : p.aqi >= 70
            ? 4.5
            : 3.5;
    const boost =
      p.aqi >= 150 ? 0.95 : p.aqi >= 100 ? 0.9 : p.aqi >= 70 ? 0.88 : 0.85;

    // Pixel bounds for this peak (skip far pixels)
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
        // Smoothstep falloff (C1 continuous — no hard edges)
        const t = 1 - d / R;
        const fall = t * t * (3 - 2 * t);
        const mix = fall * boost;
        const i = y * w + x;
        const cur = field[i];
        // Only lift toward peak — preserves clean blend into green surroundings
        const lifted = cur * (1 - mix) + p.aqi * mix;
        if (lifted > cur) field[i] = lifted;
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

  // 2) Soft peak preservation — pins always; grid samples that are moderate+
  //    so regional yellow/red islands match pin numbers (e.g. LA 64 → yellow).
  const peakCandidates: Sample[] = [];
  const seen = new Set<string>();
  const addPeak = (p: Sample, minAqi: number) => {
    if (p.aqi < minAqi) return;
    const k = `${p.lon.toFixed(2)},${p.lat.toFixed(2)}`;
    if (seen.has(k)) return;
    seen.add(k);
    peakCandidates.push(p);
  };
  // Pins: preserve even light moderate (55+) so list places always match field
  for (const p of pins) addPeak(p, 55);
  // Grid: only elevated samples (avoid polka-dotting every mild reading)
  for (const p of pts) addPeak(p, 65);

  preservePeaks(
    field,
    w,
    h,
    west,
    lonSpan,
    latSpan,
    north,
    peakCandidates,
    cosLat,
  );

  // 3) Moderate blur → soft zone edges without dissolving peaks into green
  const smooth = blurFloat(field, w, h, blurRadius, blurPasses);

  // 4) Colorize
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
