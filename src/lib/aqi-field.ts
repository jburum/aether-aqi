/**
 * AQI field helpers: bounds math + EPA palette.
 * The stable geographic model lives in aqi-field-model.ts.
 */
export type FieldBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

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

/** EPA continuous palette — truthful bands at 50 / 100 / 150 / 200. */
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

/** Clamp for API requests only. */
export function clampBoundsForApi(b: FieldBounds, pad = 0.08): FieldBounds {
  const { w: viewW, e: viewE } = normalizeLonPair(b.west, b.east);
  const lonSpan = Math.max(0.01, viewE - viewW);
  const latSpan = Math.max(0.01, b.north - b.south);
  const p = latSpan > 40 || lonSpan > 60 ? Math.min(pad, 0.04) : pad;

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

/** Image bounds slightly larger than view for rim feather. */
export function padBoundsForPaint(view: FieldBounds, padFrac = 0.12): FieldBounds {
  const { w: viewW, e: viewE } = normalizeLonPair(view.west, view.east);
  const lonSpan = Math.max(0.01, viewE - viewW);
  const latSpan = Math.max(0.01, view.north - view.south);
  const p =
    latSpan > 50 || lonSpan > 80
      ? Math.min(padFrac, 0.06)
      : latSpan > 30
        ? Math.min(padFrac, 0.1)
        : padFrac;

  let w = Math.min(viewW, viewW - lonSpan * p);
  let e = Math.max(viewE, viewE + lonSpan * p);
  let s = Math.min(view.south, Math.max(-85, view.south - latSpan * p));
  let n = Math.max(view.north, Math.min(85, view.north + latSpan * p));
  // Contain view
  w = Math.min(w, viewW);
  e = Math.max(e, viewE);
  s = Math.min(s, view.south);
  n = Math.max(n, view.north);

  const lon = packLon(w, e);
  return { west: lon.west, south: s, east: lon.east, north: n };
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

/** True if outer fully covers inner. */
export function boundsContain(
  outer: FieldBounds,
  inner: FieldBounds,
  marginFrac = 0,
): boolean {
  let ow = outer.west;
  let oe = outer.east;
  let iw = inner.west;
  let ie = inner.east;
  if (oe < ow) oe += 360;
  if (ie < iw) ie += 360;
  if (iw < ow - 180) {
    iw += 360;
    ie += 360;
  }
  const mx = (oe - ow) * marginFrac;
  const my = (outer.north - outer.south) * marginFrac;
  return (
    iw >= ow + mx - 1e-6 &&
    ie <= oe - mx + 1e-6 &&
    inner.south >= outer.south + my - 1e-6 &&
    inner.north <= outer.north - my + 1e-6
  );
}
