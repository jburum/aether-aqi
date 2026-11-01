import { V1RuleError } from "./errors.ts";

/**
 * Nearest cell on the axes `hrrrSmokeAsciiUrl` and `aqfAsciiUrl` already index.
 *
 * HRRR-Smoke is the `hrrr_sfc` dimensions, 1059 south–north by 1799 west–east.
 * Cell centers run from 21.138123°N, 225.904526°E through 52.615654°N, 299.082809°E.
 * AQM is the NAQFC CONUS dimensions, 265 by 442. Cell centers run from
 * 21.821°N, 226.541°E through 53.501°N, 292.691°E.
 * Spacing is `(end - origin) / (count - 1)` degrees. This is the GrADS linear
 * axis those OpenDAP indexes used (`grads_mapping` linear), not the Lambert
 * i,j of the GRIB file. `hrrrSmokeCellCenter` is the center the smoke read
 * projects onto template 3.30. This module does not call out.
 */

export const HRRR_SMOKE_LAT_ORIGIN = 21.138123;
export const HRRR_SMOKE_LAT_END = 52.615654;
export const HRRR_SMOKE_LAT_COUNT = 1059;
export const HRRR_SMOKE_LON_ORIGIN = 225.904526;
export const HRRR_SMOKE_LON_END = 299.082809;
export const HRRR_SMOKE_LON_COUNT = 1799;

export const AQM_LAT_ORIGIN = 21.821;
export const AQM_LAT_END = 53.501;
export const AQM_LAT_COUNT = 265;
export const AQM_LON_ORIGIN = 226.541;
export const AQM_LON_END = 292.691;
export const AQM_LON_COUNT = 442;

export const HRRR_SMOKE_LAT_SPACING =
  (HRRR_SMOKE_LAT_END - HRRR_SMOKE_LAT_ORIGIN) / (HRRR_SMOKE_LAT_COUNT - 1);
export const HRRR_SMOKE_LON_SPACING =
  (HRRR_SMOKE_LON_END - HRRR_SMOKE_LON_ORIGIN) / (HRRR_SMOKE_LON_COUNT - 1);
export const AQM_LAT_SPACING = (AQM_LAT_END - AQM_LAT_ORIGIN) / (AQM_LAT_COUNT - 1);
export const AQM_LON_SPACING = (AQM_LON_END - AQM_LON_ORIGIN) / (AQM_LON_COUNT - 1);

export interface ModelCell {
  latIndex: number;
  lonIndex: number;
}

export interface ModelCells {
  hrrr: ModelCell;
  aqm: ModelCell;
}

interface Axis {
  origin: number;
  spacing: number;
  count: number;
  name: "HRRR-Smoke" | "AQM";
  direction: "latitude" | "longitude";
}

const HRRR_LAT: Axis = {
  origin: HRRR_SMOKE_LAT_ORIGIN,
  spacing: HRRR_SMOKE_LAT_SPACING,
  count: HRRR_SMOKE_LAT_COUNT,
  name: "HRRR-Smoke",
  direction: "latitude",
};
const HRRR_LON: Axis = {
  origin: HRRR_SMOKE_LON_ORIGIN,
  spacing: HRRR_SMOKE_LON_SPACING,
  count: HRRR_SMOKE_LON_COUNT,
  name: "HRRR-Smoke",
  direction: "longitude",
};
const AQM_LAT: Axis = {
  origin: AQM_LAT_ORIGIN,
  spacing: AQM_LAT_SPACING,
  count: AQM_LAT_COUNT,
  name: "AQM",
  direction: "latitude",
};
const AQM_LON: Axis = {
  origin: AQM_LON_ORIGIN,
  spacing: AQM_LON_SPACING,
  count: AQM_LON_COUNT,
  name: "AQM",
  direction: "longitude",
};

/** Negative longitudes shift by 360 so they sit on the degrees-east axis. */
export function toDegreesEast(longitude: number): number {
  return longitude < 0 ? longitude + 360 : longitude;
}

/**
 * Greater index wins an exact halfway split (north or east).
 * Returns null when the nearest center is off the axis.
 */
function nearestIndex(value: number, axis: Axis): number | null {
  const index = Math.round((value - axis.origin) / axis.spacing);
  if (index < 0 || index >= axis.count) return null;
  // Math.round(-0.5) is -0. The greater index on that split is 0.
  return index === 0 ? 0 : index;
}

function cell(latitude: number, lonEast: number, latAxis: Axis, lonAxis: Axis): ModelCell {
  const latIndex = nearestIndex(latitude, latAxis);
  const lonIndex = nearestIndex(lonEast, lonAxis);
  if (latIndex == null || lonIndex == null) {
    const missed = latIndex == null ? latAxis.direction : lonAxis.direction;
    throw new V1RuleError(
      "outside_model_coverage",
      `Outside the ${latAxis.name} grid (${missed}).`,
    );
  }
  return { latIndex, lonIndex };
}

/**
 * HRRR-Smoke and AQM nearest cells for one place.
 * A point off either axis throws `outside_model_coverage` and does not pick a cell.
 */
export function resolveModelCells(latitude: number, longitude: number): ModelCells {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new V1RuleError("invalid_point", "A place needs a latitude and longitude.");
  }
  const lonEast = toDegreesEast(longitude);
  return {
    hrrr: cell(latitude, lonEast, HRRR_LAT, HRRR_LON),
    aqm: cell(latitude, lonEast, AQM_LAT, AQM_LON),
  };
}

/**
 * Center of one HRRR-Smoke cell on the GrADS axis.
 * Longitude is signed. The Lambert i,j of the GRIB file is a different index.
 */
export function hrrrSmokeCellCenter(cell: ModelCell): { latitude: number; longitude: number } {
  if (
    !Number.isInteger(cell.latIndex) ||
    !Number.isInteger(cell.lonIndex) ||
    cell.latIndex < 0 ||
    cell.latIndex >= HRRR_SMOKE_LAT_COUNT ||
    cell.lonIndex < 0 ||
    cell.lonIndex >= HRRR_SMOKE_LON_COUNT
  ) {
    throw new V1RuleError("outside_model_coverage", "Outside the HRRR-Smoke grid.");
  }
  const latitude = HRRR_SMOKE_LAT_ORIGIN + cell.latIndex * HRRR_SMOKE_LAT_SPACING;
  const lonEast = HRRR_SMOKE_LON_ORIGIN + cell.lonIndex * HRRR_SMOKE_LON_SPACING;
  return { latitude, longitude: lonEast > 180 ? lonEast - 360 : lonEast };
}
