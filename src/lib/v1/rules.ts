import { V1RuleError } from "./errors.ts";
import {
  CONFIDENCE_LEVELS,
  FORECAST_SOURCES,
  HORIZONS,
  SPATIAL_SCALES,
  type Confidence,
  type ForecastSource,
  type Horizon,
  type SpatialScale,
} from "./types.ts";

/** Credit stored with every official AirNow row. The number itself is not edited. */
export const AIRNOW_ATTRIBUTION =
  "Observations courtesy of the U.S. EPA AirNow program (airnow.gov). Preliminary and subject to change.";

/** Server-side saved places for v1. The website localStorage list stays at 15. */
export const MAX_SAVED_PLACES = 5;

const HOUR_MS = 3_600_000;
const DAY12_MS = 48 * HOUR_MS;
const DAY7_MS = 168 * HOUR_MS;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export interface ValidForecast {
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

export interface ValidOfficial {
  placeId: string;
  observedAt: string;
  officialAqi: number;
  officialRaw: string;
  preliminary: true;
  attribution: string;
  source: "airnow";
}

export interface ValidPlace {
  name: string;
  latitude: number;
  longitude: number;
  valley: string | null;
  alertAt: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSource(source: string): string {
  return source
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/** PurpleAir would spend points. Open-Meteo is not a launch source. */
export function rejectBannedSource(source: string): void {
  const normalized = normalizeSource(source);
  if (normalized.includes("purple")) {
    throw new V1RuleError(
      "purpleair_spend_not_approved",
      "PurpleAir is out this week. Spend is not approved, and this path does not buy points.",
    );
  }
  if (normalized.includes("meteo") || normalized === "cams" || normalized.startsWith("cams_")) {
    throw new V1RuleError(
      "open_meteo_not_for_launch",
      "Open-Meteo is not a launch source. Days 1-2 use the NOAA smoke model. Days 3-7 use NOAA's air quality forecast, or a regional low-confidence label.",
    );
  }
}

function requireUtc(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_UTC.test(value)) {
    throw new V1RuleError("invalid_time", `${field} must be a UTC timestamp.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new V1RuleError("invalid_time", `${field} must be a UTC timestamp.`);
  }
  return parsed.toISOString();
}

function requireAqi(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 500) {
    throw new V1RuleError("invalid_aqi", `${field} must be an integer from 0 to 500.`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new V1RuleError("invalid_field", `${field} is not a launch value.`);
  }
  return value as T;
}

/**
 * Days 1-2 are the NOAA smoke model at valley scale.
 * Days 3-7 are NOAA's air quality forecast, or regional and low-confidence.
 */
export function assertForecastWindow(input: ValidForecast): void {
  const leadMs = new Date(input.validFor).getTime() - new Date(input.issuedAt).getTime();
  if (leadMs < 0 || leadMs > DAY7_MS) {
    throw new V1RuleError(
      "outside_launch_window",
      "Launch forecasts cover days 1 through 7 from the issue time.",
    );
  }
  const day12 = leadMs <= DAY12_MS;
  if (day12) {
    if (
      input.source !== "noaa_smoke" ||
      input.spatialScale !== "valley" ||
      input.confidence !== "valley" ||
      input.horizon !== "day_1_2_valley"
    ) {
      throw new V1RuleError(
        "day_1_2_valley_only",
        "Days 1-2 use the NOAA smoke model at valley scale.",
      );
    }
    return;
  }
  if (input.source === "noaa_aqf") {
    if (
      input.spatialScale !== "regional" ||
      input.confidence !== "model" ||
      input.horizon !== "day_3_7_noaa_aqf"
    ) {
      throw new V1RuleError(
        "day_3_7_noaa_aqf",
        "Days 3-7 from NOAA's air quality forecast are regional model guidance.",
      );
    }
    return;
  }
  if (input.source === "regional") {
    if (
      input.spatialScale !== "regional" ||
      input.confidence !== "low" ||
      input.horizon !== "day_3_7_regional_low_confidence"
    ) {
      throw new V1RuleError(
        "day_3_7_regional_low_confidence",
        "A days 3-7 forecast without NOAA's air quality forecast is labeled regional and low-confidence.",
      );
    }
    return;
  }
  throw new V1RuleError(
    "day_3_7_source",
    "Days 3-7 come from NOAA's air quality forecast, or are labeled regional and low-confidence. The smoke model covers days 1-2.",
  );
}

const FORECAST_KEYS = new Set([
  "placeId",
  "source",
  "issuedAt",
  "validFor",
  "horizon",
  "spatialScale",
  "confidence",
  "correctedAqi",
  "pollutant",
]);

export function parseForecastInput(body: unknown): ValidForecast {
  if (!isRecord(body)) {
    throw new V1RuleError("invalid_body", "Forecast body must be an object.");
  }
  for (const key of Object.keys(body)) {
    if (FORECAST_KEYS.has(key)) continue;
    if (key === "officialAqi" || key === "officialRaw" || key === "official" || key === "aqi") {
      throw new V1RuleError(
        "official_on_forecast",
        "Official AirNow numbers are stored on official_reading, separate from the corrected forecast.",
      );
    }
    if (
      key === "pmCf1" ||
      key === "pm25" ||
      key === "purpleair" ||
      key === "relativeHumidity" ||
      key === "location"
    ) {
      throw new V1RuleError(
        "purpleair_spend_not_approved",
        "PurpleAir fields are not accepted. Spend is not approved, and this path does not buy points.",
      );
    }
    throw new V1RuleError("invalid_field", `Unexpected forecast field ${key}.`);
  }
  if (typeof body.source !== "string") {
    throw new V1RuleError("invalid_field", "source is required.");
  }
  rejectBannedSource(body.source);
  const source = oneOf(body.source, FORECAST_SOURCES, "source");
  const parsed: ValidForecast = {
    placeId: requireId(body.placeId, "placeId"),
    source,
    issuedAt: requireUtc(body.issuedAt, "issuedAt"),
    validFor: requireUtc(body.validFor, "validFor"),
    horizon: oneOf(body.horizon, HORIZONS, "horizon"),
    spatialScale: oneOf(body.spatialScale, SPATIAL_SCALES, "spatialScale"),
    confidence: oneOf(body.confidence, CONFIDENCE_LEVELS, "confidence"),
    correctedAqi: requireAqi(body.correctedAqi, "correctedAqi"),
    pollutant: parsePollutant(body.pollutant),
  };
  assertForecastWindow(parsed);
  return parsed;
}

function parsePollutant(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9. ]{1,40}$/.test(value)) {
    throw new V1RuleError("invalid_pollutant", "Pollutant must be a short label.");
  }
  return value;
}

export function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
    throw new V1RuleError("invalid_id", `${field} is invalid.`);
  }
  return value;
}

const OFFICIAL_KEYS = new Set([
  "placeId",
  "observedAt",
  "officialAqi",
  "officialRaw",
  "preliminary",
  "attribution",
  "source",
]);

export function parseOfficialInput(body: unknown): ValidOfficial {
  if (!isRecord(body)) {
    throw new V1RuleError("invalid_body", "Official reading body must be an object.");
  }
  for (const key of Object.keys(body)) {
    if (OFFICIAL_KEYS.has(key)) continue;
    if (key === "correctedAqi" || key === "forecast" || key === "forecastAqi") {
      throw new V1RuleError(
        "corrected_on_official",
        "The corrected forecast is stored on forecast_issued, separate from the official AirNow number.",
      );
    }
    if (key === "pmCf1" || key === "pm25" || key === "purpleair" || key === "relativeHumidity") {
      throw new V1RuleError(
        "purpleair_spend_not_approved",
        "PurpleAir fields are not accepted on an official reading.",
      );
    }
    throw new V1RuleError("invalid_field", `Unexpected official field ${key}.`);
  }
  if (body.source != null) {
    if (typeof body.source !== "string") {
      throw new V1RuleError("invalid_field", "source is invalid.");
    }
    rejectBannedSource(body.source);
    if (body.source !== "airnow") {
      throw new V1RuleError(
        "official_source",
        "Official readings in week 1 are EPA AirNow, stored unaltered.",
      );
    }
  }
  if (body.preliminary != null && body.preliminary !== true) {
    throw new V1RuleError(
      "official_not_preliminary",
      "Official AirNow readings are marked preliminary.",
    );
  }
  if (body.attribution != null && body.attribution !== AIRNOW_ATTRIBUTION) {
    throw new V1RuleError(
      "official_attribution",
      "Official AirNow readings keep the AirNow credit.",
    );
  }
  const officialAqi = requireAqi(body.officialAqi, "officialAqi");
  if (typeof body.officialRaw !== "string" || body.officialRaw !== String(officialAqi)) {
    throw new V1RuleError(
      "official_altered",
      "The official AirNow number is stored as the exact integer token, unaltered.",
    );
  }
  return {
    placeId: requireId(body.placeId, "placeId"),
    observedAt: requireUtc(body.observedAt, "observedAt"),
    officialAqi,
    officialRaw: body.officialRaw,
    preliminary: true,
    attribution: AIRNOW_ATTRIBUTION,
    source: "airnow",
  };
}

const PLACE_KEYS = new Set(["name", "latitude", "longitude", "valley", "alertAt"]);

export function parsePlaceInput(body: unknown): ValidPlace {
  if (!isRecord(body)) {
    throw new V1RuleError("invalid_body", "Place body must be an object.");
  }
  for (const key of Object.keys(body)) {
    if (!PLACE_KEYS.has(key)) {
      throw new V1RuleError("invalid_field", `Unexpected place field ${key}.`);
    }
  }
  if (typeof body.name !== "string") {
    throw new V1RuleError("invalid_field", "name is required.");
  }
  const name = body.name.trim();
  if (name.length < 1 || name.length > 120) {
    throw new V1RuleError("invalid_field", "name must be 1 to 120 characters.");
  }
  if (typeof body.latitude !== "number" || !Number.isFinite(body.latitude)) {
    throw new V1RuleError("invalid_field", "latitude is required.");
  }
  if (typeof body.longitude !== "number" || !Number.isFinite(body.longitude)) {
    throw new V1RuleError("invalid_field", "longitude is required.");
  }
  if (body.latitude < -90 || body.latitude > 90 || body.longitude < -180 || body.longitude > 180) {
    throw new V1RuleError("invalid_field", "Coordinates are out of range.");
  }
  let valley: string | null = null;
  if (body.valley != null) {
    if (typeof body.valley !== "string") {
      throw new V1RuleError("invalid_field", "valley must be a string.");
    }
    const trimmed = body.valley.trim();
    if (trimmed.length > 80) {
      throw new V1RuleError("invalid_field", "valley must be 80 characters or fewer.");
    }
    valley = trimmed.length > 0 ? trimmed : null;
  }
  let alertAt: number | null = null;
  if (body.alertAt != null) {
    alertAt = requireAqi(body.alertAt, "alertAt");
  }
  return { name, latitude: body.latitude, longitude: body.longitude, valley, alertAt };
}

export function parseDeviceToken(body: unknown): string {
  if (!isRecord(body)) {
    throw new V1RuleError("invalid_body", "Device body must be an object.");
  }
  if (body.platform != null && body.platform !== "test") {
    throw new V1RuleError(
      "push_sender_is_test_only",
      "Week-1 push registers a test device. There is no APNs key and no paid push vendor.",
    );
  }
  if (typeof body.token !== "string" || !/^[A-Za-z0-9._:-]{8,200}$/.test(body.token)) {
    throw new V1RuleError("invalid_token", "Device token must be an opaque test token.");
  }
  return body.token;
}
