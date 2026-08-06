/**
 * Zoom- and device-stable AQI field model.
 *
 * Contract:
 *   aqiAt(lon, lat) is a pure function of the sample set only.
 *   Rasterizing any viewport just evaluates aqiAt at pixel centers.
 *   Same samples + same geography ⇒ same color on desktop and mobile.
 *
 * Samples live on a fixed global lattice (see LATTICE_STEP_DEG). Viewport
 * size never changes lattice spacing. New areas only *merge* cells.
 */
import {
  LATTICE_STEP_DEG,
  sampleKey,
  type GridSample,
} from "@/lib/aqi-grid";
import {
  aqiToRgb,
  type FieldBounds,
} from "@/lib/aqi-field";

export type ModelSample = {
  lon: number;
  lat: number;
  aqi: number;
  /** true = watchlist pin (higher IDW weight, overrides lattice) */
  isPin?: boolean;
  fetchedAt: number;
};

const TTL_MS = 15 * 60 * 1000;
/** IDW power — fixed forever (zoom must not change this). */
const IDW_POWER = 2.4;
/** Pin weight multiplier so card AQI dominates local field. */
const PIN_WEIGHT = 8;
/** Raster resolution: fixed degrees per pixel (zoom-independent). */
const DEG_PER_PX = 0.12;

function aqiToAlpha(aqi: number): number {
  if (aqi <= 50) return 125;
  if (aqi <= 100) return 165;
  if (aqi <= 150) return 195;
  if (aqi <= 200) return 220;
  return 235;
}

/**
 * Singleton field model — one shared sample universe per browser tab.
 * Desktop and mobile sessions each have their own tab, but within a tab
 * (and across pan/zoom) the model is the single source of truth.
 */
class AqiFieldModel {
  private samples = new Map<string, ModelSample>();

  clear(): void {
    this.samples.clear();
  }

  /** Merge lattice/API samples (never delete fresh cells). */
  mergeGrid(samples: GridSample[]): number {
    const now = Date.now();
    let n = 0;
    for (const s of samples) {
      if (s.us_aqi == null || !Number.isFinite(s.us_aqi)) continue;
      const k = sampleKey(s.latitude, s.longitude);
      const prev = this.samples.get(k);
      // Don't overwrite a pin with a grid reading
      if (prev?.isPin) continue;
      this.samples.set(k, {
        lon: s.longitude,
        lat: s.latitude,
        aqi: s.us_aqi,
        isPin: false,
        fetchedAt: now,
      });
      n++;
    }
    this.evictStale(now);
    return n;
  }

  /** Inject watchlist pins — authoritative for their lat/lon. */
  setPins(pins: Array<{ latitude: number; longitude: number; us_aqi: number }>): void {
    const now = Date.now();
    // Drop old pins
    for (const [k, v] of this.samples) {
      if (v.isPin) this.samples.delete(k);
    }
    for (const p of pins) {
      if (!Number.isFinite(p.us_aqi)) continue;
      // Snap pin to nearest lattice cell for consistent keying, but store
      // exact pin lon/lat for IDW so the peak sits on the marker.
      const k = `pin:${p.latitude.toFixed(3)},${p.longitude.toFixed(3)}`;
      this.samples.set(k, {
        lon: p.longitude,
        lat: p.latitude,
        aqi: p.us_aqi,
        isPin: true,
        fetchedAt: now,
      });
      // Also override nearest lattice cell so bilinear-style regions match
      const lk = sampleKey(
        Math.round(p.latitude / LATTICE_STEP_DEG) * LATTICE_STEP_DEG,
        Math.round(p.longitude / LATTICE_STEP_DEG) * LATTICE_STEP_DEG,
      );
      this.samples.set(lk, {
        lon: Math.round(p.longitude / LATTICE_STEP_DEG) * LATTICE_STEP_DEG,
        lat: Math.round(p.latitude / LATTICE_STEP_DEG) * LATTICE_STEP_DEG,
        aqi: p.us_aqi,
        isPin: false,
        fetchedAt: now,
      });
    }
  }

  private evictStale(now: number): void {
    for (const [k, v] of this.samples) {
      if (!v.isPin && now - v.fetchedAt > TTL_MS) this.samples.delete(k);
    }
  }

  count(): number {
    let n = 0;
    for (const v of this.samples.values()) {
      if (!v.isPin) n++;
    }
    return n;
  }

  allSamples(): ModelSample[] {
    return [...this.samples.values()];
  }

  /**
   * Pure geographic AQI — depends only on samples, never on viewport/zoom.
   * Shepard IDW with fixed power; pins weighted higher.
   */
  aqiAt(lon: number, lat: number): number {
    const pts = this.allSamples();
    if (pts.length === 0) return 0;
    if (pts.length === 1) return pts[0].aqi;

    const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    let num = 0;
    let den = 0;
    const eps = 1e-12;

    for (const s of pts) {
      const dlon = (lon - s.lon) * cosLat;
      const dlat = lat - s.lat;
      const d2 = dlon * dlon + dlat * dlat;
      if (d2 < eps) return s.aqi;
      const w = (s.isPin ? PIN_WEIGHT : 1) * Math.pow(d2, -IDW_POWER / 2);
      num += w * s.aqi;
      den += w;
    }
    return den > 0 ? num / den : 0;
  }

  /**
   * Rasterize the pure field for a geographic box.
   * Pixel size is fixed in degrees so resolution scales with span,
   * but aqiAt values are independent of that resolution.
   */
  renderDataUrl(bounds: FieldBounds): string | null {
    if (typeof document === "undefined") return null;
    if (this.samples.size < 2) return null;

    let { west, south, east, north } = bounds;
    if (east < west) east += 360;
    const lonSpan = Math.max(0.01, east - west);
    const latSpan = Math.max(0.01, north - south);

    let width = Math.round(lonSpan / DEG_PER_PX);
    let height = Math.round(latSpan / DEG_PER_PX);
    width = Math.max(240, Math.min(900, width));
    height = Math.max(180, Math.min(700, height));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Light 1-pass box blur on scalar field for smooth color transitions
    // without moving peaks (symmetric kernel).
    const field = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      const lat = north - ((y + 0.5) / height) * latSpan;
      for (let x = 0; x < width; x++) {
        let lon = west + ((x + 0.5) / width) * lonSpan;
        if (lon > 180) lon -= 360;
        field[y * width + x] = this.aqiAt(lon, lat);
      }
    }

    // Symmetric blur: 1px radius, 2 passes — smooth blends, peaks stay put
    const smooth = boxBlur(field, width, height, 1, 2);

    const img = ctx.createImageData(width, height);
    const data = img.data;
    const feather = 0.08;
    for (let y = 0; y < height; y++) {
      const ey = Math.min(y + 0.5, height - 0.5 - y) / height;
      for (let x = 0; x < width; x++) {
        const aqi = smooth[y * width + x];
        const [r, g, b] = aqiToRgb(aqi);
        const ex = Math.min(x + 0.5, width - 0.5 - x) / width;
        const edge = Math.min(ex, ey);
        let mul = 1;
        if (edge < feather) {
          const t = edge / feather;
          mul = t * t * (3 - 2 * t);
        }
        const o = (y * width + x) * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = Math.round(aqiToAlpha(aqi) * mul);
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL("image/png");
  }
}

function boxBlur(
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
        if (x + r + 1 < w) {
          sum += a[row + x + r + 1];
          n++;
        }
        if (x - r >= 0) {
          sum -= a[row + x - r];
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
        if (y + r + 1 < h) {
          sum += b[(y + r + 1) * w + x];
          n++;
        }
        if (y - r >= 0) {
          sum -= b[(y - r) * w + x];
          n--;
        }
      }
    }
  }
  return a;
}

/** Shared model instance for the map page. */
export const aqiFieldModel = new AqiFieldModel();
