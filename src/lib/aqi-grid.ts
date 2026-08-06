/** Build a fixed-lattice lat/lon sample grid for regional AQI coloring. */

export type GridPoint = { latitude: number; longitude: number };

/**
 * Snap-aligned lattice points inside a geographic bounding box.
 * Same lat/lon cells whenever a region is sampled → stable colors when panning.
 * Caps density so we stay within Open-Meteo multi-location limits.
 */
export function buildAqiGrid(
  west: number,
  south: number,
  east: number,
  north: number,
  opts?: { maxPoints?: number; step?: number },
): GridPoint[] {
  const maxPoints = opts?.maxPoints ?? 100;
  let w = west;
  let e = east;
  if (e < w) e += 360;

  const latSpan = Math.max(0.01, north - south);
  const lonSpan = Math.max(0.01, e - w);

  // Fixed step from span so lattice positions stay on global grid lines
  let step =
    opts?.step ??
    (lonSpan > 80 || latSpan > 50
      ? 4
      : lonSpan > 40 || latSpan > 25
        ? 2.5
        : lonSpan > 15 || latSpan > 10
          ? 1.5
          : 1);

  // Grow step until under maxPoints
  for (let guard = 0; guard < 12; guard++) {
    const cols = Math.max(1, Math.floor(lonSpan / step) + 1);
    const rows = Math.max(1, Math.floor(latSpan / step) + 1);
    if (cols * rows <= maxPoints) break;
    step *= 1.35;
  }
  // Snap step to a nice increment so keys align across requests
  step = niceStep(step);

  const points: GridPoint[] = [];
  // Align to global lattice: multiples of step
  const lat0 = Math.ceil(south / step) * step;
  const lon0 = Math.ceil(w / step) * step;

  for (let lat = lat0; lat <= north + 1e-9; lat += step) {
    for (let lon = lon0; lon <= e + 1e-9; lon += step) {
      let longitude = lon;
      if (longitude > 180) longitude -= 360;
      if (longitude < -180) longitude += 360;
      points.push({
        latitude: roundCoord(lat),
        longitude: roundCoord(longitude),
      });
      if (points.length >= maxPoints) return points;
    }
  }

  // Guarantee a minimum scatter if bbox tiny
  if (points.length < 4) {
    const cols = 3;
    const rows = 3;
    for (let r = 0; r < rows; r++) {
      const latitude = south + ((r + 0.5) / rows) * latSpan;
      for (let c = 0; c < cols; c++) {
        let longitude = w + ((c + 0.5) / cols) * lonSpan;
        if (longitude > 180) longitude -= 360;
        points.push({
          latitude: roundCoord(latitude),
          longitude: roundCoord(longitude),
        });
      }
    }
  }
  return points;
}

/** Prefer steps that land on clean decimals for stable cache keys. */
function niceStep(step: number): number {
  const candidates = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  for (const c of candidates) {
    if (c >= step * 0.9) return c;
  }
  return Math.ceil(step);
}

/** Round for cache keys / stable multi-location requests. */
export function roundCoord(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Stable cache key for a lattice sample. */
export function sampleKey(lat: number, lon: number): string {
  return `${roundCoord(lat)},${roundCoord(lon)}`;
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
