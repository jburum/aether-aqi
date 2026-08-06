/** Fixed global lattice for regional AQI — same cells on every device and zoom. */

export type GridPoint = { latitude: number; longitude: number };

/**
 * Global lattice step (degrees). MUST be constant — never depend on viewport size.
 * Desktop and mobile must request the same lon/lat cells for the same geography.
 */
export const LATTICE_STEP_DEG = 2;

/** Align a coordinate to the global lattice. */
export function snapToLattice(n: number, step = LATTICE_STEP_DEG): number {
  return roundCoord(Math.round(n / step) * step);
}

/**
 * Lattice points inside a bbox on the global grid (step = LATTICE_STEP_DEG).
 * Caps count for Open-Meteo; when capped, still stays on the same lattice
 * (skips every k-th line) rather than changing step — keeps keys stable.
 */
export function buildAqiGrid(
  west: number,
  south: number,
  east: number,
  north: number,
  opts?: { maxPoints?: number; step?: number },
): GridPoint[] {
  const maxPoints = opts?.maxPoints ?? 120;
  const step = opts?.step ?? LATTICE_STEP_DEG;

  let w = west;
  let e = east;
  if (e < w) e += 360;

  const lat0 = Math.ceil(south / step) * step;
  const lon0 = Math.ceil(w / step) * step;

  // Collect full lattice first
  const raw: GridPoint[] = [];
  for (let lat = lat0; lat <= north + 1e-9; lat += step) {
    for (let lon = lon0; lon <= e + 1e-9; lon += step) {
      let longitude = lon;
      if (longitude > 180) longitude -= 360;
      if (longitude < -180) longitude += 360;
      raw.push({
        latitude: roundCoord(lat),
        longitude: roundCoord(longitude),
      });
    }
  }

  if (raw.length === 0) {
    // Tiny bbox: still emit lattice neighbors around center
    const clat = snapToLattice((south + north) / 2, step);
    const clon = snapToLattice((w + e) / 2, step);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        raw.push({
          latitude: roundCoord(clat + di * step),
          longitude: roundCoord(clon + dj * step),
        });
      }
    }
  }

  if (raw.length <= maxPoints) return raw;

  // Thin by stride but stay on the same lattice (never change step)
  const stride = Math.ceil(Math.sqrt(raw.length / maxPoints));
  const thinned: GridPoint[] = [];
  const latLines = [...new Set(raw.map((p) => p.latitude))].sort((a, b) => a - b);
  const lonLines = [...new Set(raw.map((p) => p.longitude))].sort((a, b) => a - b);
  for (let i = 0; i < latLines.length; i += stride) {
    for (let j = 0; j < lonLines.length; j += stride) {
      thinned.push({ latitude: latLines[i], longitude: lonLines[j] });
      if (thinned.length >= maxPoints) return thinned;
    }
  }
  return thinned;
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

/** Bounding box from watchlist locations + fixed pad (device-independent). */
export function boundsFromLocations(
  locs: Array<{ latitude: number; longitude: number }>,
  padDeg = 12,
): { west: number; south: number; east: number; north: number } | null {
  if (!locs.length) return null;
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const l of locs) {
    south = Math.min(south, l.latitude);
    north = Math.max(north, l.latitude);
    west = Math.min(west, l.longitude);
    east = Math.max(east, l.longitude);
  }
  // Minimum span so a single pin still gets a real field
  const latPad = Math.max(padDeg, (north - south) * 0.35 + 6);
  const lonPad = Math.max(padDeg, (east - west) * 0.35 + 6);
  south = Math.max(-85, south - latPad);
  north = Math.min(85, north + latPad);
  west = west - lonPad;
  east = east + lonPad;
  if (east - west > 150) {
    const mid = (west + east) / 2;
    west = mid - 75;
    east = mid + 75;
  }
  if (north - south > 75) {
    const mid = (south + north) / 2;
    south = mid - 37.5;
    north = mid + 37.5;
  }
  return { west, south, east, north };
}
