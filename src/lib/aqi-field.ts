/**
 * Continuous AQI color field from sparse samples (IDW → canvas → MapLibre raster).
 * Tuned so yellow/orange/red trouble spots punch through at continental zoom.
 */
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
 * Aggressive display ramp: good = dark quiet green; moderate = bright yellow;
 * USG = hot orange; unhealthy+ = pure red / magenta.
 */
export function aqiToRgb(aqi: number): [number, number, number] {
  const v = Math.max(0, Math.min(500, aqi));
  // Bright saturated anchors (not the muted theme greens)
  const good: [number, number, number] = [22, 72, 48];
  const moderate: [number, number, number] = [255, 214, 0]; // electric yellow
  const usg: [number, number, number] = [255, 120, 0]; // hot orange
  const unhealthy: [number, number, number] = [255, 40, 40]; // alert red
  const very: [number, number, number] = [200, 40, 255];
  const haz: [number, number, number] = [120, 0, 20];

  if (v <= 50) return lerpRgb(good, [40, 100, 60], v / 50);
  if (v <= 80) return lerpRgb([40, 100, 60], moderate, (v - 50) / 30);
  if (v <= 100) return lerpRgb(moderate, [255, 180, 0], (v - 80) / 20);
  if (v <= 130) return lerpRgb([255, 180, 0], usg, (v - 100) / 30);
  if (v <= 150) return lerpRgb(usg, [255, 80, 20], (v - 130) / 20);
  if (v <= 180) return lerpRgb([255, 80, 20], unhealthy, (v - 150) / 30);
  if (v <= 250) return lerpRgb(unhealthy, very, (v - 180) / 70);
  return lerpRgb(very, haz, Math.min(1, (v - 250) / 150));
}

/** Opacity ramps hard into yellow/red so trouble isn't translucent wash. */
function aqiToAlpha(aqi: number): number {
  if (aqi <= 50) return 70;
  if (aqi <= 80) return 110;
  if (aqi <= 100) return 160;
  if (aqi <= 130) return 195;
  if (aqi <= 150) return 215;
  if (aqi <= 200) return 235;
  return 245;
}

/**
 * IDW + hotspot boost: if any nearby sample is elevated, pull the field
 * toward that max so red zones don't average into green.
 */
function sampleField(
  lon: number,
  lat: number,
  samples: Sample[],
  power: number,
  cosLat: number,
  influenceDeg: number,
): number {
  let num = 0;
  let den = 0;
  let maxNear = 0;
  let maxW = 0;
  const infl2 = influenceDeg * influenceDeg;

  for (const s of samples) {
    const dlon = (lon - s.lon) * cosLat;
    const dlat = lat - s.lat;
    const d2 = dlon * dlon + dlat * dlat;
    if (d2 < 1e-16) return s.aqi;

    const w = 1 / Math.pow(d2, power / 2);
    num += w * s.aqi;
    den += w;

    if (d2 <= infl2 && s.aqi > maxNear) {
      maxNear = s.aqi;
      // closer high samples dominate more
      maxW = Math.exp(-Math.sqrt(d2) / (influenceDeg * 0.45));
    }
  }

  const base = den > 0 ? num / den : 0;

  // Boost toward local max when it's a real trouble spot
  if (maxNear >= 90 && maxW > 0.05) {
    const severity = Math.min(1, (maxNear - 80) / 100); // 0 at 80 → 1 at 180
    const mix = Math.min(0.85, maxW * (0.55 + 0.45 * severity));
    return base * (1 - mix) + maxNear * mix;
  }
  return base;
}

export function fieldCanvasSize(bounds: FieldBounds): {
  width: number;
  height: number;
  power: number;
  blur: number;
  influence: number;
} {
  let { west, east, south, north } = bounds;
  if (east < west) east += 360;
  const lonSpan = Math.max(0.01, east - west);
  const latSpan = Math.max(0.01, north - south);
  const span = Math.max(lonSpan, latSpan);

  if (span > 50) {
    return { width: 512, height: 340, power: 1.8, blur: 1, influence: 14 };
  }
  if (span > 20) {
    return { width: 420, height: 290, power: 1.9, blur: 1, influence: 8 };
  }
  if (span > 8) {
    return { width: 380, height: 260, power: 2.0, blur: 1, influence: 4 };
  }
  return { width: 340, height: 240, power: 2.15, blur: 1, influence: 2.5 };
}

export function renderAqiFieldDataUrl(
  samples: GridSample[],
  bounds: FieldBounds,
  width?: number,
  height?: number,
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
      const aqi = sampleField(
        lon,
        lat,
        pts,
        auto.power,
        cosLat,
        auto.influence,
      );
      const i = (y * w + x) * 4;
      const [r, g, b] = aqiToRgb(aqi);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = aqiToAlpha(aqi);
    }
  }

  // Single light blur only — multi-pass was killing reds into olive
  const blurred = boxBlur(data, w, h, auto.blur);
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
