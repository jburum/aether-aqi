/** Minimal SQL surface used by the v1 store. Matches `Sql.query` in `@/lib/db`. */
export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

export const FORECAST_SOURCES = ["noaa_smoke", "noaa_aqf", "regional"] as const;
export type ForecastSource = (typeof FORECAST_SOURCES)[number];

export const HORIZONS = [
  "day_1_2_valley",
  "day_3_7_noaa_aqf",
  "day_3_7_regional_low_confidence",
] as const;
export type Horizon = (typeof HORIZONS)[number];

export const SPATIAL_SCALES = ["valley", "regional"] as const;
export type SpatialScale = (typeof SPATIAL_SCALES)[number];

export const CONFIDENCE_LEVELS = ["valley", "model", "low"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export interface SavedPlace {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  valley: string | null;
  alertAt: number | null;
  position: number;
  createdAt: string;
}

export interface IssuedForecast {
  id: string;
  placeId: string;
  source: ForecastSource;
  issuedAt: string;
  validFor: string;
  horizon: Horizon;
  spatialScale: SpatialScale;
  confidence: Confidence;
  correctedAqi: number;
  pollutant: string | null;
}

/**
 * Pollutant kept on an official AirNow row.
 * PM10 and every other ParameterName are stored as null.
 */
export type AirNowParameter = "PM2.5" | "O3";

/** Official AirNow reading as stored. There is no corrected field on this type. */
export interface OfficialReading {
  id: string;
  placeId: string;
  observedAt: string;
  officialAqi: number;
  officialRaw: string;
  preliminary: true;
  attribution: string;
  source: "airnow";
  /** Null when AirNow did not name PM2.5 or ozone. */
  parameter: AirNowParameter | null;
}

export interface OfficialBeside {
  id: string;
  aqi: number;
  raw: string;
  preliminary: true;
  attribution: string;
  source: "airnow";
  observedAt: string;
}

export interface ForecastBesideObserved {
  place: { id: string; name: string };
  forecast: IssuedForecast;
  official: OfficialBeside | null;
}
