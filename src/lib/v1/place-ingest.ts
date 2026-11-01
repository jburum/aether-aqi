import { fetchAirNowObservation, officialInputFromAirNow, type AirNowReading } from "./airnow.ts";
import { V1RuleError } from "./errors.ts";
import { readLambertPoint } from "./grib.ts";
import { resolveModelCells, type ModelCell, type ModelCells } from "./grid.ts";
import {
  AQM_HOUR_END,
  AQM_HOUR_START,
  AQM_PM25,
  fetchAqmPm25Messages,
  fetchHrrrSmokeField,
  forecastBodiesFromHours,
  noaaCycleParts,
  unavailableForecastHours,
  type ModelHour,
} from "./noaa.ts";
import type { ValidForecast } from "./rules.ts";
import {
  keepForecastIssue,
  keepOfficialReading,
  listSavedPlaces,
  type KeptWrite,
} from "./store.ts";
import type { Queryable } from "./types.ts";

/**
 * Manual ingest for one NOAA cycle. Smoke is lead 0 through 48 hours
 * from the public HRRR bucket. AQM surface PM2.5 is lead 49 through 72.
 * Hours after that, through the forecast horizon, have no source.
 * AirNow is the official number when `AIRNOW_API_KEY` is set and the hour is under 500.
 * There is no scheduler. A repeat of the same place, source, issue, and
 * valid hour does not throw and does not overwrite the first corrected value.
 * Official AirNow keeps the first integer the same way.
 */

export interface IngestCounts {
  stored: number;
  skipped: number;
  conflicts: number;
}

const SMOKE_HOUR_END = 48;

export interface PlaceIngestResult {
  placeId: string;
  hrrr: ModelCell;
  aqm: ModelCell;
  /** Nearest Lambert cell on the first smoke message. Null when every lead was missing. */
  lambert: { i: number; j: number; value: number } | null;
  /** `stored` is a new row. `skipped` is the same corrected value. `conflicts` keeps the first. */
  stored: number;
  skipped: number;
  conflicts: number;
  /** AQF fetch or parse code. Null when that reply was read. */
  aqfError: string | null;
  /**
   * Lead hours after the AQM file through the forecast horizon.
   * No row is written for these. They are not filled from hour 72.
   */
  unavailableHours: number[];
  /** Stored official integer. A repeat leaves it in place. Null when AirNow was not taken. */
  officialAqi: number | null;
  /** One AirNow row, counted the same way as the forecast. Zeros when the call did not run. */
  official: IngestCounts;
  airnowError: string | null;
}

/** Latest 00, 06, 12, or 18 UTC cycle at or before `now`. */
export function latestNoaaCycle(now: Date): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new V1RuleError("invalid_time", "NOAA cycle must be a UTC timestamp.");
  }
  const cycleHour = Math.floor(now.getUTCHours() / 6) * 6;
  const cycle = new Date(now.getTime());
  cycle.setUTCHours(cycleHour, 0, 0, 0);
  return cycle.toISOString();
}

function canonicalCycle(cycleUtc: string): string {
  noaaCycleParts(cycleUtc);
  return new Date(cycleUtc).toISOString();
}

/** Empty body and omitted `cycleUtc` use the latest cycle. */
export async function readIngestCycle(request: Request, now: Date): Promise<string> {
  const text = await request.text();
  if (!text.trim()) return latestNoaaCycle(now);
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new V1RuleError("invalid_json", "JSON body is invalid.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new V1RuleError("invalid_body", "Ingest body must be an object.");
  }
  const cycleUtc = (body as { cycleUtc?: unknown }).cycleUtc;
  if (cycleUtc == null) return latestNoaaCycle(now);
  if (typeof cycleUtc !== "string") {
    throw new V1RuleError("invalid_time", "cycleUtc must be a UTC timestamp.");
  }
  return canonicalCycle(cycleUtc);
}

/** µg/m³ to truncated tenths. A fill sentinel (about 1e20) is a missing cell, not AQI 0. */
function aqmTenths(ugPerM3: number): number | null {
  if (!Number.isFinite(ugPerM3) || ugPerM3 < 0) {
    throw new V1RuleError("noaa_aqf_parse", "AQM PM2.5 is not a finite number.");
  }
  const scaled = ugPerM3 * 10;
  if (scaled > 1_000_000) return null;
  const nearest = Math.round(scaled);
  const tenths = Math.abs(scaled - nearest) < 1e-4 ? nearest : Math.trunc(scaled);
  if (!Number.isSafeInteger(tenths)) return null;
  return tenths;
}

/** kg/m³ to truncated tenths of a µg/m³. A fill sentinel (about 1e20) is a missing cell. */
function smokeTenths(kgPerM3: number): number | null {
  if (!Number.isFinite(kgPerM3) || kgPerM3 < 0) {
    throw new V1RuleError("noaa_smoke_parse", "HRRR smoke concentration is not a finite number.");
  }
  const scaled = kgPerM3 * 1e10;
  if (scaled > 1_000_000) return null;
  const nearest = Math.round(scaled);
  const tenths = Math.abs(scaled - nearest) < 1e-4 ? nearest : Math.trunc(scaled);
  if (!Number.isSafeInteger(tenths)) return null;
  return tenths;
}

function cellsForPlace(name: string, latitude: number, longitude: number): ModelCells {
  try {
    return resolveModelCells(Number(latitude), Number(longitude));
  } catch (err) {
    if (err instanceof V1RuleError && err.code === "outside_model_coverage") {
      throw new V1RuleError(
        "outside_model_coverage",
        `${name}: ${err.message} No upstream call was made.`,
        400,
      );
    }
    throw err;
  }
}

function emptyCounts(): IngestCounts {
  return { stored: 0, skipped: 0, conflicts: 0 };
}

function countWrite(counts: IngestCounts, outcome: KeptWrite): void {
  if (outcome === "stored") counts.stored += 1;
  else if (outcome === "skipped") counts.skipped += 1;
  else counts.conflicts += 1;
}

function oneWrite(outcome: KeptWrite): IngestCounts {
  const counts = emptyCounts();
  countWrite(counts, outcome);
  return counts;
}

async function storeForecasts(
  sql: Queryable,
  userId: string,
  bodies: readonly ValidForecast[],
): Promise<IngestCounts> {
  const counts = emptyCounts();
  for (const body of bodies) {
    const kept = await keepForecastIssue(sql, userId, body);
    countWrite(counts, kept.outcome);
  }
  return counts;
}

async function storeOfficial(
  sql: Queryable,
  userId: string,
  placeId: string,
  reading: AirNowReading,
): Promise<{ officialAqi: number; official: IngestCounts }> {
  const kept = await keepOfficialReading(sql, userId, officialInputFromAirNow(placeId, reading));
  return { officialAqi: kept.officialAqi, official: oneWrite(kept.outcome) };
}

/**
 * One saved place and one cycle. Grid rejection happens before any request.
 * Smoke is the Lambert cell nearest the saved latitude and longitude.
 * NOAA calls and the AirNow call, when it leaves, are written to the phase-4 ledger.
 * Over the AirNow hour, or a missing key, skips AirNow and does not call it.
 * A failed AQM reply still stores the smoke hours already decoded, sets `aqfError`, and still calls AirNow.
 * Hours 73 through the forecast horizon are listed on `unavailableHours` and are not stored.
 */
export async function ingestPlaceCycle(
  sql: Queryable,
  userId: string,
  input: { placeId: string; cycleUtc: string; fetchImpl: typeof fetch },
): Promise<PlaceIngestResult> {
  const cycleUtc = canonicalCycle(input.cycleUtc);
  const rows = await sql.query<{ name: string; latitude: number; longitude: number }>(
    "select name, latitude, longitude from saved_place where id = $1 and user_id = $2",
    [input.placeId, userId],
  );
  const place = rows[0];
  if (!place) throw new V1RuleError("place_not_found", "Saved place not found.", 404);
  const cells = cellsForPlace(place.name, place.latitude, place.longitude);
  const latitude = Number(place.latitude);
  const longitude = Number(place.longitude);
  const unavailableHours = unavailableForecastHours();
  const smoke: ModelHour[] = [];
  let lambert: PlaceIngestResult["lambert"] = null;
  for (let lead = 0; lead <= SMOKE_HOUR_END; lead += 1) {
    const message = await fetchHrrrSmokeField(cycleUtc, lead, input.fetchImpl, sql);
    if (!message) continue;
    const point = readLambertPoint(message, latitude, longitude);
    if (!point) continue;
    if (point.referenceTime !== cycleUtc || point.forecastHour !== lead) {
      throw new V1RuleError(
        "noaa_smoke_parse",
        "HRRR smoke field does not match the requested lead.",
      );
    }
    if (
      point.category !== 20 ||
      point.parameter !== 0 ||
      point.surfaceType !== 103 ||
      Math.abs(point.level - 8) > 1e-6
    ) {
      throw new V1RuleError("noaa_smoke_parse", "HRRR smoke field is not 8 m mass density.");
    }
    if (!lambert) lambert = { i: point.i, j: point.j, value: point.value };
    const tenths = smokeTenths(point.value);
    if (tenths == null) continue;
    smoke.push({ hour: lead, pm25Tenths: tenths, regionalLowAqi: null });
  }
  let aqf: ModelHour[] = [];
  let aqfError: string | null = null;
  try {
    const decoded: ModelHour[] = [];
    const messages = await fetchAqmPm25Messages(cycleUtc, input.fetchImpl, sql);
    for (const { lead, message } of messages) {
      if (lead < AQM_HOUR_START || lead > AQM_HOUR_END) {
        throw new V1RuleError("noaa_aqf_parse", "AQM message is outside hours 49 through 72.");
      }
      const point = readLambertPoint(message, latitude, longitude, "noaa_aqf_parse");
      if (!point) continue;
      const validMs = Date.parse(point.referenceTime) + point.forecastHour * 3_600_000;
      if (validMs !== Date.parse(cycleUtc) + lead * 3_600_000) {
        throw new V1RuleError("noaa_aqf_parse", "AQM valid time does not match the lead hour.");
      }
      if (
        point.category !== AQM_PM25.category ||
        point.parameter !== AQM_PM25.parameter ||
        point.surfaceType !== AQM_PM25.surfaceType ||
        Math.abs(point.level - AQM_PM25.level) > 1e-6
      ) {
        throw new V1RuleError("noaa_aqf_parse", "AQM field is not surface PM2.5.");
      }
      const tenths = aqmTenths(point.value);
      if (tenths == null) continue;
      decoded.push({ hour: lead, pm25Tenths: tenths, regionalLowAqi: null });
    }
    aqf = decoded;
  } catch (err) {
    aqfError = err instanceof V1RuleError ? err.code : "noaa_fetch_failed";
  }
  const forecasts = await storeForecasts(
    sql,
    userId,
    forecastBodiesFromHours({
      placeId: input.placeId,
      issuedAt: cycleUtc,
      smoke,
      aqf,
    }),
  );
  const airnow = await fetchAirNowObservation({ latitude, longitude }, input.fetchImpl, sql);
  if (!airnow.ok) {
    return {
      placeId: input.placeId,
      hrrr: cells.hrrr,
      aqm: cells.aqm,
      lambert,
      ...forecasts,
      officialAqi: null,
      official: emptyCounts(),
      aqfError,
      airnowError: airnow.code,
      unavailableHours,
    };
  }
  const official = await storeOfficial(sql, userId, input.placeId, airnow.reading);
  return {
    placeId: input.placeId,
    hrrr: cells.hrrr,
    aqm: cells.aqm,
    lambert,
    ...forecasts,
    officialAqi: official.officialAqi,
    official: official.official,
    aqfError,
    airnowError: null,
    unavailableHours,
  };
}

/**
 * Every saved place for this user. A place outside either grid rejects the
 * run before any request, so an earlier place is not fetched either.
 */
export async function ingestSavedPlaces(
  sql: Queryable,
  userId: string,
  input: { cycleUtc: string; fetchImpl: typeof fetch },
): Promise<PlaceIngestResult[]> {
  const cycleUtc = canonicalCycle(input.cycleUtc);
  const places = await listSavedPlaces(sql, userId);
  for (const place of places) {
    cellsForPlace(place.name, place.latitude, place.longitude);
  }
  const results: PlaceIngestResult[] = [];
  for (const place of places) {
    results.push(
      await ingestPlaceCycle(sql, userId, {
        placeId: place.id,
        cycleUtc,
        fetchImpl: input.fetchImpl,
      }),
    );
  }
  return results;
}
