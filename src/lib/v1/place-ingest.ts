import { fetchAirNowObservation, officialInputFromAirNow, type AirNowReading } from "./airnow.ts";
import { V1RuleError } from "./errors.ts";
import { resolveModelCells, type ModelCell, type ModelCells } from "./grid.ts";
import {
  aqfAsciiUrl,
  fetchNoaaAscii,
  forecastBodiesFromExtracts,
  hrrrSmokeAsciiUrl,
  noaaCycleParts,
} from "./noaa.ts";
import type { ValidForecast } from "./rules.ts";
import { issueForecast, listSavedPlaces, recordOfficial } from "./store.ts";
import type { Queryable } from "./types.ts";

/**
 * Manual ingest for one NOAA cycle. Smoke is lead 0 through 48 hours.
 * The air quality forecast is lead 49 through 168. AirNow is the official
 * number when `AIRNOW_API_KEY` is set and the hour is under 500.
 * There is no scheduler. A repeat of the same place, source, issue, and
 * valid hour does not change the stored forecast. An official row is never
 * updated.
 */

const SMOKE_HOUR_END = 48;
const AQF_HOUR_START = 49;
const AQF_HOUR_END = 168;

export interface PlaceIngestResult {
  placeId: string;
  hrrr: ModelCell;
  aqm: ModelCell;
  forecastsStored: number;
  forecastsUnchanged: number;
  officialAqi: number | null;
  officialStatus: "stored" | "unchanged" | "skipped";
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

function isForecastDuplicate(err: unknown): boolean {
  if (err instanceof V1RuleError) return false;
  const message = err instanceof Error ? err.message : String(err);
  return /duplicate key|forecast_issue_unique/i.test(message);
}

async function storeForecasts(
  sql: Queryable,
  userId: string,
  bodies: readonly ValidForecast[],
): Promise<{ forecastsStored: number; forecastsUnchanged: number }> {
  let forecastsStored = 0;
  let forecastsUnchanged = 0;
  for (const body of bodies) {
    const existing = await sql.query<{ id: string }>(
      `select id from forecast_issued
        where place_id = $1 and user_id = $2 and source = $3
          and issued_at = $4 and valid_for = $5`,
      [body.placeId, userId, body.source, body.issuedAt, body.validFor],
    );
    if (existing[0]) {
      forecastsUnchanged += 1;
      continue;
    }
    try {
      await issueForecast(sql, userId, body);
      forecastsStored += 1;
    } catch (err) {
      if (!isForecastDuplicate(err)) throw err;
      forecastsUnchanged += 1;
    }
  }
  return { forecastsStored, forecastsUnchanged };
}

async function storeOfficial(
  sql: Queryable,
  userId: string,
  placeId: string,
  reading: AirNowReading,
): Promise<{ officialAqi: number; officialStatus: "stored" | "unchanged" }> {
  try {
    const stored = await recordOfficial(sql, userId, officialInputFromAirNow(placeId, reading));
    return { officialAqi: stored.officialAqi, officialStatus: "stored" };
  } catch (err) {
    if (!(err instanceof V1RuleError) || err.code !== "official_already_recorded") throw err;
    const rows = await sql.query<{ official_aqi: number }>(
      `select official_aqi from official_reading
        where place_id = $1 and user_id = $2 and observed_at = $3`,
      [placeId, userId, reading.observedAt],
    );
    const kept = rows[0];
    if (!kept) {
      throw new V1RuleError(
        "official_already_recorded",
        "An official AirNow reading is already stored for this place and time. It is left unchanged.",
        409,
      );
    }
    return { officialAqi: Number(kept.official_aqi), officialStatus: "unchanged" };
  }
}

/**
 * One saved place and one cycle. Grid rejection happens before any request.
 * NOAA calls and the AirNow call, when it leaves, are written to the phase-4 ledger.
 * Over the AirNow hour, or a missing key, skips AirNow and does not call it.
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
  const smokeAscii = await fetchNoaaAscii(
    hrrrSmokeAsciiUrl({
      cycleUtc,
      latIndex: cells.hrrr.latIndex,
      lonIndex: cells.hrrr.lonIndex,
      hourStart: 0,
      hourEnd: SMOKE_HOUR_END,
    }),
    input.fetchImpl,
    sql,
  );
  const aqfAscii = await fetchNoaaAscii(
    aqfAsciiUrl({
      cycleUtc,
      latIndex: cells.aqm.latIndex,
      lonIndex: cells.aqm.lonIndex,
      hourStart: AQF_HOUR_START,
      hourEnd: AQF_HOUR_END,
    }),
    input.fetchImpl,
    sql,
  );
  const forecasts = await storeForecasts(
    sql,
    userId,
    forecastBodiesFromExtracts({
      placeId: input.placeId,
      issuedAt: cycleUtc,
      smokeAscii,
      aqfAscii,
    }),
  );
  const airnow = await fetchAirNowObservation(
    { latitude: Number(place.latitude), longitude: Number(place.longitude) },
    input.fetchImpl,
    sql,
  );
  if (!airnow.ok) {
    return {
      placeId: input.placeId,
      hrrr: cells.hrrr,
      aqm: cells.aqm,
      ...forecasts,
      officialAqi: null,
      officialStatus: "skipped",
      airnowError: airnow.code,
    };
  }
  const official = await storeOfficial(sql, userId, input.placeId, airnow.reading);
  return {
    placeId: input.placeId,
    hrrr: cells.hrrr,
    aqm: cells.aqm,
    ...forecasts,
    officialAqi: official.officialAqi,
    officialStatus: official.officialStatus,
    airnowError: null,
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
