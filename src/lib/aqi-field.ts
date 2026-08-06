/**
 * Continuous AQI color field from sparse samples (IDW → canvas → MapLibre raster).
 * Designed to stay smooth at continental zoom (no nearest-neighbor Voronoi blocks).
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
  const n = parseInt(
    h.length === 3 ? h.split("").map((c) => c + c).join("") : h,
    16,
  );
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Continuous AQI → RGB (smooth across EPA band boundaries so the field
 * doesn't look posterized into hard blocks).
 */
export function aqiToRgb(aqi: number): [number, number, number] {
  // Anchor colors at band midpoints / edges for smooth lerp
  const stops: Array<[number, string]> = [
    [0, AQI_HEX.good],
    [50, AQI_HEX.good],
    [75, AQI_HEX.moderate],
    [100, AQI_HEX.moderate],
    [125, AQI_HEX.usg],
    [150, AQI_HEX.usg],
    [175, AQI_HEX.unhealthy],
    [200, AQI_HEX.unhealthy],
    [250, AQI_HEX.very],
    [300, AQI_HEX.very],
    [400, AQI_HEX.hazardous],
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

/**
 * IDW with lat-corrected distance. Lower power → smoother continental field.
 * No hard nearest-neighbor cutoff (that caused the checkerboard at US zoom).
 */
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

/** Choose canvas size from geographic span (more pixels when zoomed out). */
export function fieldCanvasSize(bounds: FieldBounds): {
  width: number;
  height: number;
  power: number;
  blur: number;
} {
  let { west, east, south, north } = bounds;
  if (east < west) east += 360;
  const lonSpan = Math.max(0.01, east - west);
  const latSpan = Math.max(0.01, north - south);
  const span = Math.max(lonSpan, latSpan);

  if (span > 50) {
    // Full North America-ish
    return { width: 480, height: 320, power: 1.35, blur: 3 };
  }
  if (span > 20) {
    return { width: 400, height: 280, power: 1.5, blur: 2 };
  }
  if (span > 8) {
    return { width: 360, height: 240, power: 1.7, blur: 2 };
  }
  return { width: 320, height: 220, power: 1.9, blur: 1 };
}

/**
 * Rasterize samples into a PNG data URL covering the bounds.
 */
export function renderAqiFieldDataUrl(
  samples: GridSample[],
  bounds: FieldBounds,
  width?: number,
  height?: number,
  alpha = 155,
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
  const midLat = (south + north) / 2;
  const cosLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));

  const auto = fieldCanvasSize(bounds);
  const w = width ?? auto.width;
  const h = height ?? auto.height;
  const power = auto.power;
  const blurR = auto.blur;

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
      const aqi = idw(lon, lat, pts, power, cosLat);
      const i = (y * w + x) * 4;
      const [r, g, b] = aqiToRgb(aqi);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = alpha;
    }
  }

  // Multi-pass blur for continental smoothness
  let buf: Uint8ClampedArray = data;
  for (let p = 0; p < Math.max(1, blurR); p++) {
    buf = boxBlur(buf, w, h, Math.min(2, blurR));
  }
  img.data.set(buf);
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

/** NW, NE, SE, SW corners for MapLibre image source (lng/lat). */
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
