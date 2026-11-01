import {
  finishUpstreamCall,
  logLedgerFailure,
  reserveAirNowCall,
} from "./monitoring.ts";
import { AIRNOW_ATTRIBUTION } from "./rules.ts";
import type { Queryable } from "./types.ts";

/** Current observation by latitude and longitude. The key is a query parameter, never logged. */
export const AIRNOW_CURRENT_URL = "https://www.airnowapi.org/aq/observation/latLong/current/";

export const AIRNOW_USER_AGENT = "aether-aqi/v1 (+https://bbcvc.dev)";

/** Offsets AirNow puts in `LocalTimeZone`. Unknown abbreviations are not guessed. */
const AIRNOW_OFFSET_HOURS: Record<string, number> = {
  EST: -5,
  EDT: -4,
  CST: -6,
  CDT: -5,
  MST: -7,
  MDT: -6,
  PST: -8,
  PDT: -7,
  AKST: -9,
  AKDT: -8,
  HST: -10,
  AST: -4,
  ADT: -3,
  CHST: 10,
  SST: -11,
  GMT: 0,
  UTC: 0,
};

export interface AirNowReading {
  observedAt: string;
  aqi: number;
  raw: string;
  parameter: string;
}

export type AirNowClientResult =
  { ok: true; reading: AirNowReading } | { ok: false; code: string; message: string };

/** The only place an AirNow key is read. Blank counts as unset. */
export function airNowKey(): string | null {
  const value = process.env.AIRNOW_API_KEY;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function officialInputFromAirNow(
  placeId: string,
  reading: AirNowReading,
): {
  placeId: string;
  observedAt: string;
  officialAqi: number;
  officialRaw: string;
  preliminary: true;
  attribution: string;
  source: "airnow";
} {
  return {
    placeId,
    observedAt: reading.observedAt,
    officialAqi: reading.aqi,
    officialRaw: reading.raw,
    preliminary: true,
    attribution: AIRNOW_ATTRIBUTION,
    source: "airnow",
  };
}

type AirNowFailure = { ok: false; code: string; message: string };

function fail(code: string, message: string): AirNowFailure {
  return { ok: false, code, message };
}

function integerAqi(value: unknown): { aqi: number; raw: string } | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 500) {
    return null;
  }
  return { aqi: value, raw: String(value) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function observedAtFromLocal(
  item: Record<string, unknown>,
): { ok: true; observedAt: string } | AirNowFailure {
  const date = typeof item.DateObserved === "string" ? item.DateObserved.trim() : "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const hour = item.HourObserved;
  const zone =
    typeof item.LocalTimeZone === "string" ? item.LocalTimeZone.trim().toUpperCase() : "";
  if (!match || typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    return fail("airnow_parse", "AirNow date and hour are missing.");
  }
  const offset = AIRNOW_OFFSET_HOURS[zone];
  if (offset === undefined) {
    return fail(
      "airnow_timezone_unknown",
      "AirNow timezone is not in the offset table. The hour was not guessed.",
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const asUtc = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
  if (
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day
  ) {
    return fail("airnow_parse", "AirNow date is not a real calendar day.");
  }
  const observedAt = new Date(asUtc.getTime() - offset * 3_600_000).toISOString();
  return { ok: true, observedAt };
}

/**
 * Pick the latest hour, then the highest integer AQI at that hour.
 * Non-integers are skipped so a float is never rounded into the official table.
 * `correctedAqi` on the payload is ignored. Category numbers are not the AQI.
 */
export function parseAirNowCurrent(text: string): AirNowClientResult {
  if (/purpleair|api\.purpleair/i.test(text)) {
    return fail(
      "purpleair_spend_not_approved",
      "PurpleAir is out. Spend is not approved, and this parser does not read it.",
    );
  }
  if (/open-?meteo/i.test(text)) {
    return fail(
      "open_meteo_not_for_launch",
      "Open-Meteo is not a launch source. Official readings are EPA AirNow.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return fail("airnow_parse", "AirNow response is not JSON.");
  }
  if (!Array.isArray(parsed)) {
    return fail("airnow_parse", "AirNow current observation must be a JSON array.");
  }
  if (parsed.length === 0) {
    return fail("airnow_no_observation", "AirNow returned no observation for this hour.");
  }
  const rows: AirNowReading[] = [];
  let sawNonInteger = false;
  for (const item of parsed) {
    if (!isRecord(item)) return fail("airnow_parse", "AirNow observation must be an object.");
    const token = integerAqi(item.AQI);
    if (!token) {
      sawNonInteger = true;
      continue;
    }
    const observed = observedAtFromLocal(item);
    if (!observed.ok) return observed;
    const parameter = typeof item.ParameterName === "string" ? item.ParameterName : "";
    rows.push({
      observedAt: observed.observedAt,
      aqi: token.aqi,
      raw: token.raw,
      parameter,
    });
  }
  if (rows.length === 0) {
    return sawNonInteger
      ? fail(
          "airnow_aqi_not_integer",
          "AirNow AQI was not an integer. It was not rounded or stored.",
        )
      : fail("airnow_no_observation", "AirNow returned no observation for this hour.");
  }
  const latest = rows.reduce(
    (best, row) => (row.observedAt > best ? row.observedAt : best),
    rows[0]?.observedAt ?? "",
  );
  const atLatest = rows.filter((row) => row.observedAt === latest);
  let winner = atLatest[0];
  if (!winner) {
    return fail("airnow_no_observation", "AirNow returned no observation for this hour.");
  }
  for (const row of atLatest.slice(1)) {
    if (row.aqi > winner.aqi) winner = row;
    else if (row.aqi === winner.aqi && row.parameter === "PM2.5" && winner.parameter !== "PM2.5") {
      winner = row;
    }
  }
  return { ok: true, reading: winner };
}

async function settleAirNowCall(
  ledger: Queryable | undefined,
  reservationId: string | null,
  outcome: "ok" | "error",
): Promise<void> {
  if (!ledger || reservationId == null) return;
  try {
    await finishUpstreamCall(
      ledger,
      reservationId,
      outcome,
      outcome === "error" ? "airnow_fetch_failed" : null,
    );
  } catch (err) {
    logLedgerFailure(err);
  }
}

/**
 * Calls AirNow only when `AIRNOW_API_KEY` is set. A missing key returns
 * `airnow_api_key_missing` and does not call `fetchImpl` or write a ledger row.
 * When `ledger` is set, a slot in the open hour is reserved before the request.
 * Request 501 returns `airnow_hourly_limit` and does not call out.
 * A ledger write that throws is logged and does not leave this function.
 * The key is not stored.
 */
export async function fetchAirNowObservation(
  point: { latitude: number; longitude: number },
  fetchImpl: typeof fetch,
  ledger?: Queryable,
): Promise<AirNowClientResult> {
  const key = airNowKey();
  if (!key) {
    return fail(
      "airnow_api_key_missing",
      "AIRNOW_API_KEY is unset. The AirNow client did not call out and did not store an official reading.",
    );
  }
  if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) {
    return fail("airnow_point", "AirNow needs a latitude and longitude.");
  }
  const url = new URL(AIRNOW_CURRENT_URL);
  if (url.protocol !== "https:" || url.hostname !== "www.airnowapi.org") {
    return fail("airnow_host_not_allowed", "AirNow ingest uses www.airnowapi.org only.");
  }
  url.searchParams.set("format", "application/json");
  url.searchParams.set("latitude", String(point.latitude));
  url.searchParams.set("longitude", String(point.longitude));
  url.searchParams.set("distance", "25");
  url.searchParams.set("API_KEY", key);
  const calledAt = new Date();
  let reservationId: string | null = null;
  if (ledger) {
    try {
      reservationId = await reserveAirNowCall(ledger, calledAt);
    } catch (err) {
      logLedgerFailure(err);
      return fail(
        "airnow_ledger_failed",
        "The AirNow ledger write failed. The client did not call out.",
      );
    }
    if (reservationId == null) {
      return fail(
        "airnow_hourly_limit",
        "AirNow is at 500 requests this hour. The client did not call out.",
      );
    }
  }
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: { accept: "application/json", "user-agent": AIRNOW_USER_AGENT },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    await settleAirNowCall(ledger, reservationId, "error");
    return fail("airnow_fetch_failed", "The AirNow client could not complete the request.");
  }
  if (!response.ok) {
    await settleAirNowCall(ledger, reservationId, "error");
    return fail("airnow_fetch_failed", `AirNow responded ${response.status}.`);
  }
  let body: string;
  try {
    body = await response.text();
  } catch {
    await settleAirNowCall(ledger, reservationId, "error");
    return fail("airnow_fetch_failed", "The AirNow client could not complete the request.");
  }
  await settleAirNowCall(ledger, reservationId, "ok");
  return parseAirNowCurrent(body);
}
