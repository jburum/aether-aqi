/** Build a lat/lon sample grid for regional AQI coloring. */

export type GridPoint = { latitude: number; longitude: number };

/**
 * Evenly spaced points inside a geographic bounding box.
 * Caps density so we stay within Open-Meteo multi-location limits.
 */
export function buildAqiGrid(
  west: number,
  south: number,
  east: number,
  north: number,
  opts?: { maxPoints?: number; cols?: number; rows?: number },
): GridPoint[] {
  const maxPoints = opts?.maxPoints ?? 100;
  // Normalize antimeridian-ish spans
  let w = west;
  let e = east;
  if (e < w) e += 360;

  const latSpan = Math.max(0.01, north - south);
  const lonSpan = Math.max(0.01, e - w);

  // Denser regular grid → smoother continuous zones under IDW
  let cols = opts?.cols ?? (lonSpan > 50 ? 9 : lonSpan > 25 ? 10 : lonSpan > 10 ? 11 : 12);
  let rows = opts?.rows ?? (latSpan > 30 ? 7 : latSpan > 15 ? 8 : latSpan > 6 ? 9 : 10);
  while (cols * rows > maxPoints) {
    if (cols >= rows) cols -= 1;
    else rows -= 1;
  }
  cols = Math.max(3, cols);
  rows = Math.max(3, rows);

  const points: GridPoint[] = [];
  for (let r = 0; r < rows; r++) {
    const latitude = south + ((r + 0.5) / rows) * latSpan;
    for (let c = 0; c < cols; c++) {
      let longitude = w + ((c + 0.5) / cols) * lonSpan;
      // wrap to [-180, 180]
      if (longitude > 180) longitude -= 360;
      if (longitude < -180) longitude += 360;
      points.push({
        latitude: roundCoord(latitude),
        longitude: roundCoord(longitude),
      });
    }
  }
  return points;
}

/** Round for cache keys / stable multi-location requests. */
export function roundCoord(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export type GridSample = GridPoint & { us_aqi: number | null };

export type AqiGridFeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: { aqi: number; w: number };
    geometry: { type: "Point"; coordinates: [number, number] };
  }>;
};

export function gridToGeoJSON(samples: GridSample[]): AqiGridFeatureCollection {
  return {
    type: "FeatureCollection",
    features: samples
      .filter((s) => s.us_aqi != null && Number.isFinite(s.us_aqi))
      .map((s) => ({
        type: "Feature" as const,
        properties: {
          aqi: s.us_aqi as number,
          w: Math.min(1, Math.max(0, (s.us_aqi as number) / 200)),
        },
        geometry: {
          type: "Point" as const,
          coordinates: [s.longitude, s.latitude] as [number, number],
        },
      })),
  };
}
