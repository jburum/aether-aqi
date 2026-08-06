/**
 * Build a continuous AQI color field from sparse samples (IDW → canvas).
 * Used as a MapLibre image/raster layer so the wash blends across geography.
 */
import { AQI_HEX } from "@/lib/aqi";
import type { GridSample } from "@/lib/aqi-grid";

export type FieldBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

type Sample = { lon: number; lat: number; aqi: number };

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Smooth AQI → RGB using EPA band anchors. */
export function aqiToRgb(aqi: number): [number, number, number] {
  const stops: Array<[number, string]> = [
    [0, AQI_HEX.good],
    [50, AQI_HEX.good],
    [51, AQI_HEX.moderate],
    [100, AQI_HEX.moderate],
    [101, AQI_HEX.usg],
    [150, AQI_HEX.usg],
    [151, AQI_HEX.unhealthy],
    [200, AQI_HEX.unhealthy],
    [201, AQI_HEX.very],
    [300, AQI_HEX.very],
    [301, AQI_HEX.hazardous],
    [500, AQI_HEX.hazardous],
  ];
  const v = Math.max(0, Math.min(500, aqi));
  let i = 0;
  while (i < stops.length - 1 && v > stops[i + 1][0]) i += 1;
  const [a0, c0] = stops[i];
  const [a1, c1] = stops[Math.min(i + 1, stops.length - 1)];
  const [r0, g0, b0] = hexToRgb(c0);
  const [r1, g1, b1] = hexToRgb(c1);
  if (a1 === a0) return [r0, g0, b0];
  const t = (v - a0) / (a1 - a0);
  return [
    Math.round(r0 + (r1 - r0) * t),
    Math.round(g0 + (g1 - g0) * t),
    Math.round(b0 + (b1 - b0) * t),
  ];
}

/** Inverse-distance weighting; power ~2 is smooth without overshoot. */
function idw(lon: number, lat: number, samples: Sample[], power = 2): number | null {
  let num = 0;
  let den = 0;
  let nearest = Infinity;
  let nearestAqi = 0;
  for (const s of samples) {
    const dlon = lon - s.lon;
    // crude lat-scaled degrees; fine for regional fields
    const dlat = lat - s.lat;
    const d2 = dlon * dlon + dlat * dlat;
    if (d2 < 1e-14) return s.aqi;
    if (d2 < nearest) {
      nearest = d2;
      nearestAqi = s.aqi;
    }
    const w = 1 / Math.pow(d2, power / 2);
    num += w * s.aqi;
    den += w;
  }
  if (den === 0) return null;
  // Soften extreme far-field when samples are sparse
  if (nearest > 25) return nearestAqi;
  return num / den;
}

/**
 * Rasterize samples into a PNG data URL covering the bounds.
 * @param width/height — internal resolution (higher = smoother, slower)
 */
export function renderAqiFieldDataUrl(
  samples: GridSample[],
  bounds: FieldBounds,
  width = 256,
  height = 192,
  alpha = 150,
): string | null {
  const pts: Sample[] = samples
    .filter((s) => s.us_aqi != null && Number.isFinite(s.us_aqi as number))
    .map((s) => ({
      lon: s.longitude,
      lat: s.latitude,
      aqi: s.us_aqi as number,
    }));
  if (pts.length < 3) return null;

  let { west, south, east, north } = bounds;
  if (east < west) east += 360;
  const lonSpan = Math.max(0.01, east - west);
  const latSpan = Math.max(0.01, north - south);

  const canvas =
    typeof document !== "undefined"
      ? document.createElement("canvas")
      : null;
  if (!canvas) return null;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const img = ctx.createImageData(width, height);
  const data = img.data;

  for (let y = 0; y < height; y++) {
    const lat = north - ((y + 0.5) / height) * latSpan;
    for (let x = 0; x < width; x++) {
      let lon = west + ((x + 0.5) / width) * lonSpan;
      if (lon > 180) lon -= 360;
      const aqi = idw(lon, lat, pts, 2.2);
      const i = (y * width + x) * 4;
      if (aqi == null) {
        data[i + 3] = 0;
        continue;
      }
      const [r, g, b] = aqiToRgb(aqi);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = alpha;
    }
  }

  // Light blur pass for extra smoothness (box blur 1px)
  const blurred = boxBlurAlpha(data, width, height, 1);
  img.data.set(blurred);
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

function boxBlurAlpha(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  r: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const out32 = out;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let rSum = 0,
        gSum = 0,
        bSum = 0,
        aSum = 0,
        n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const i = (yy * w + xx) * 4;
          const a = src[i + 3];
          if (a === 0) continue;
          rSum += src[i] * a;
          gSum += src[i + 1] * a;
          bSum += src[i + 2] * a;
          aSum += a;
          n += 1;
        }
      }
      const o = (y * w + x) * 4;
      if (aSum === 0) {
        out32[o + 3] = 0;
        continue;
      }
      out32[o] = Math.round(rSum / aSum);
      out32[o + 1] = Math.round(gSum / aSum);
      out32[o + 2] = Math.round(bSum / aSum);
      out32[o + 3] = Math.round(aSum / Math.max(1, n));
    }
  }
  return out;
}

/** NW, NE, SE, SW corners for MapLibre image source (lng/lat). */
export function boundsToImageCoordinates(b: FieldBounds): [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
] {
  let { west, south, east, north } = b;
  // MapLibre image coords don't love antimeridian; keep simple
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
}

