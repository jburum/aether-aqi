import { randomUUID } from "node:crypto";

import { V1RuleError } from "./errors.ts";
import { parseUtcInstant } from "./phase2.ts";
import type { Queryable } from "./types.ts";

/**
 * Phase 4 monitoring. The ledger counts outbound calls. Budget and feed health
 * are pure functions of those rows and of store timestamps. PurpleAir is not
 * called. Points are a projection, not a purchase.
 */

export const HOUR_MS = 3_600_000;
/** NOAA cycles are 00, 06, 12, and 18 UTC. */
export const NOAA_CADENCE_MS = 6 * HOUR_MS;
/** AirNow current observations, and the PurpleAir dropout window. */
export const AIRNOW_CADENCE_MS = HOUR_MS;
export const AIRNOW_HOURLY_LIMIT = 500;
/** 80% of the hourly AirNow limit. */
export const AIRNOW_WARN_AT = 400;
export const PROJECTION_WINDOW_MS = 24 * HOUR_MS;
export const PROJECTION_MONTH_MS = 30 * 24 * HOUR_MS;

export const NOAA_ENDPOINT_KINDS = [
  "hrrr_smoke_ascii",
  "aqf_ascii",
  "hrrr_stability_grib",
  "noaa_other",
] as const;

export const ENDPOINT_KINDS = [
  ...NOAA_ENDPOINT_KINDS,
  "airnow_current",
  "purpleair_sensors",
  "purpleair_history",
] as const;

export type EndpointKind = (typeof ENDPOINT_KINDS)[number];
export type UpstreamSource = "noaa" | "airnow" | "purpleair";

/**
 * PurpleAir's points rule: add each requested field's point value, then
 * multiply by the rows returned (sensors, or history averages). The fields
 * below are 1 point on that table. A name that is not listed is refused.
 */
export const PURPLEAIR_FIELD_POINTS: Readonly<Record<string, number>> = {
  sensor_index: 1,
  latitude: 1,
  longitude: 1,
  altitude: 1,
  location_type: 1,
  last_seen: 1,
  humidity: 1,
  temperature: 1,
  pressure: 1,
  "pm1.0_cf_1": 1,
  "pm2.5_atm": 1,
  "pm2.5_cf_1": 1,
  "pm10.0_cf_1": 1,
};

const KIND_SOURCE: Record<EndpointKind, UpstreamSource> = {
  hrrr_smoke_ascii: "noaa",
  aqf_ascii: "noaa",
  hrrr_stability_grib: "noaa",
  noaa_other: "noaa",
  airnow_current: "airnow",
  purpleair_sensors: "purpleair",
  purpleair_history: "purpleair",
};

export function noaaEndpointKind(url: string): (typeof NOAA_ENDPOINT_KINDS)[number] {
  const parsed = new URL(url);
  const path = parsed.pathname;
  if (path.includes("filter_hrrr_2d.pl")) return "hrrr_stability_grib";
  if (path.includes("/dods/hrrr/") || parsed.search.includes("masden8m")) return "hrrr_smoke_ascii";
  if (path.includes("/dods/aqm/") || parsed.search.includes("pm25sfc")) return "aqf_ascii";
  return "noaa_other";
}

/** Repeated fields count once. Rows are the sensors or history averages returned. */
export function purpleAirPoints(fields: readonly string[], rows: number): number {
  if (!Number.isInteger(rows) || rows < 1 || rows > 1_000_000) {
    throw new V1RuleError(
      "purpleair_points",
      "PurpleAir row count must be a positive integer. Points are not guessed.",
    );
  }
  const unique: string[] = [];
  for (const field of fields) {
    if (!unique.includes(field)) unique.push(field);
  }
  if (unique.length === 0) {
    throw new V1RuleError(
      "purpleair_points",
      "PurpleAir points need at least one documented field.",
    );
  }
  let sum = 0;
  for (const field of unique) {
    const cost = PURPLEAIR_FIELD_POINTS[field];
    if (cost === undefined) {
      throw new V1RuleError(
        "purpleair_points",
        "PurpleAir field is not in the points table. The cost was not guessed.",
      );
    }
    sum += cost;
  }
  const points = sum * rows;
  if (points > 2_000_000_000) {
    throw new V1RuleError("purpleair_points", "PurpleAir points do not fit the ledger integer.");
  }
  return points;
}

export interface LedgerCall {
  source: UpstreamSource;
  endpointKind: EndpointKind;
  calledAt: Date;
  outcome: "ok" | "error";
  errorCode?: string | null;
  /** PurpleAir only. The points formula runs on these. They are not stored. */
  fields?: readonly string[];
  /** PurpleAir only. Sensors, or history averages. Not stored. */
  rows?: number;
}

/**
 * Writes one ledger row when `sql` is set. A missing store skips the write.
 * The row has no URL, key, user, or place. PurpleAir points come from the
 * field table. NOAA and AirNow store a null point count.
 */
export async function recordUpstreamCall(
  sql: Queryable | undefined,
  input: LedgerCall,
): Promise<void> {
  if (!sql) return;
  if (KIND_SOURCE[input.endpointKind] !== input.source) {
    throw new V1RuleError("upstream_call", "Endpoint kind does not match the upstream source.");
  }
  if (!(input.calledAt instanceof Date) || Number.isNaN(input.calledAt.getTime())) {
    throw new V1RuleError("invalid_time", "calledAt must be a UTC timestamp.");
  }
  let errorCode: string | null = null;
  if (input.outcome === "error") {
    errorCode = input.errorCode ?? "";
    if (!/^[a-z0-9_]{1,64}$/.test(errorCode)) {
      throw new V1RuleError("upstream_call", "Upstream error codes are short tokens.");
    }
  } else if (input.errorCode) {
    throw new V1RuleError("upstream_call", "An ok upstream call has no error code.");
  }
  let points: number | null = null;
  if (input.source === "purpleair") {
    points = purpleAirPoints(input.fields ?? [], input.rows ?? 0);
  } else if (input.fields != null || input.rows != null) {
    throw new V1RuleError("upstream_call", "Only PurpleAir calls carry a point count.");
  }
  await sql.query(
    `insert into upstream_call
       (id, source, endpoint_kind, called_at, outcome, error_code, points)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      input.source,
      input.endpointKind,
      input.calledAt.toISOString(),
      input.outcome,
      errorCode,
      points,
    ],
  );
}

/**
 * Claims one AirNow slot in the open hour, or returns null when the hour is
 * already at `AIRNOW_HOURLY_LIMIT`. The claim is one statement: the lock, the
 * database clock, the count, and the insert commit together. The clock is
 * read after the lock. This function does not take a caller timestamp.
 * A refused hour inserts nothing.
 * The row starts as `error` / `airnow_reserved` until `finishUpstreamCall`.
 */
export async function reserveAirNowCall(sql: Queryable): Promise<string | null> {
  const id = randomUUID();
  const rows = await sql.query<{ reserved_id: string | null }>(
    "select airnow_reserve($1, $2, $3) as reserved_id",
    [id, null, AIRNOW_HOURLY_LIMIT],
  );
  const reserved = rows[0]?.reserved_id;
  if (typeof reserved !== "string" || reserved.length === 0) return null;
  return reserved;
}

/** Writes the attempt's real outcome over the in-flight reservation. */
export async function finishUpstreamCall(
  sql: Queryable,
  id: string,
  outcome: "ok" | "error",
  errorCode: string | null,
): Promise<void> {
  if (outcome === "error") {
    if (errorCode == null || !/^[a-z0-9_]{1,64}$/.test(errorCode)) {
      throw new V1RuleError("upstream_call", "Upstream error codes are short tokens.");
    }
  } else if (errorCode) {
    throw new V1RuleError("upstream_call", "An ok upstream call has no error code.");
  }
  await sql.query("update upstream_call set outcome = $2, error_code = $3 where id = $1", [
    id,
    outcome,
    errorCode,
  ]);
}

/** Ledger failures are logged and swallowed. The driver text has no key and no URL. */
export function logLedgerFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : "ledger write failed";
  console.error("[monitoring] upstream ledger write failed:", message);
}

export interface AirNowBudget {
  requestsInLastHour: number;
  limitPerHour: typeof AIRNOW_HOURLY_LIMIT;
  warnAt: typeof AIRNOW_WARN_AT;
  status: "ok" | "warn" | "over";
}

function inWindow(calledAtMs: number, nowMs: number, windowMs: number): boolean {
  return calledAtMs > nowMs - windowMs && calledAtMs <= nowMs;
}

/**
 * Counts every outbound AirNow attempt in the open-closed hour ending at `nowMs`.
 * This reports the hour. `reserveAirNowCall` is what refuses request 501.
 */
export function airNowBudget(
  calls: readonly { calledAtMs: number }[],
  nowMs: number,
): AirNowBudget {
  let requestsInLastHour = 0;
  for (const call of calls) {
    if (inWindow(call.calledAtMs, nowMs, HOUR_MS)) requestsInLastHour += 1;
  }
  let status: AirNowBudget["status"] = "ok";
  if (requestsInLastHour >= AIRNOW_HOURLY_LIMIT) status = "over";
  else if (requestsInLastHour >= AIRNOW_WARN_AT) status = "warn";
  return {
    requestsInLastHour,
    limitPerHour: AIRNOW_HOURLY_LIMIT,
    warnAt: AIRNOW_WARN_AT,
    status,
  };
}

/**
 * Scales PurpleAir points in `(now - window, now]` up to a 30-day month.
 * `Math.ceil` so a fraction still counts as a point. Zero points stay zero.
 */
export function projectPurpleAirPointsPerMonth(
  calls: readonly { calledAtMs: number; points: number }[],
  nowMs: number,
  windowMs = PROJECTION_WINDOW_MS,
  monthMs = PROJECTION_MONTH_MS,
): number {
  if (!Number.isInteger(windowMs) || windowMs < 1 || !Number.isInteger(monthMs) || monthMs < 1) {
    throw new V1RuleError("purpleair_points", "PurpleAir projection window is invalid.");
  }
  let points = 0;
  for (const call of calls) {
    if (!inWindow(call.calledAtMs, nowMs, windowMs)) continue;
    if (!Number.isInteger(call.points) || call.points < 0) {
      throw new V1RuleError("purpleair_points", "PurpleAir points must be a non-negative integer.");
    }
    points += call.points;
  }
  if (points === 0) return 0;
  if (points > Number.MAX_SAFE_INTEGER / monthMs) {
    throw new V1RuleError(
      "purpleair_points",
      "PurpleAir projection is too large to count exactly.",
    );
  }
  return Math.ceil((points * monthMs) / windowMs);
}

export interface SourceHealth {
  lastSuccessAt: string | null;
  cadenceMs: number;
  ageMs: number | null;
  stale: boolean;
  dropout: boolean;
  fallback: ["airnow", "noaa"] | null;
}

/** Fresh while `age <= cadence`. One millisecond past the cadence is stale. */
export function sourceHealth(
  source: UpstreamSource,
  lastSuccessAt: string | null,
  nowMs: number,
): SourceHealth {
  const cadenceMs = source === "noaa" ? NOAA_CADENCE_MS : AIRNOW_CADENCE_MS;
  const ageMs = lastSuccessAt == null ? null : nowMs - Date.parse(lastSuccessAt);
  if (ageMs != null && Number.isNaN(ageMs)) {
    throw new V1RuleError("invalid_time", "Stored timestamp is unreadable.");
  }
  const stale = ageMs == null || ageMs > cadenceMs;
  const dropout = source === "purpleair" && stale;
  return {
    lastSuccessAt,
    cadenceMs,
    ageMs,
    stale,
    dropout,
    fallback: dropout ? ["airnow", "noaa"] : null,
  };
}

export interface PlaceMark {
  placeId: string;
  lastStoredAt: string | null;
}

export interface PlaceFreshness extends PlaceMark {
  ageMs: number | null;
  fresh: boolean;
}

/** One saved place. Fresh while the newest forecast row is within the NOAA cadence. */
export function forecastFreshness(places: readonly PlaceMark[], nowMs: number): PlaceFreshness[] {
  return places.map((place) => {
    const ageMs = place.lastStoredAt == null ? null : nowMs - Date.parse(place.lastStoredAt);
    if (ageMs != null && Number.isNaN(ageMs)) {
      throw new V1RuleError("invalid_time", "Stored timestamp is unreadable.");
    }
    return {
      placeId: place.placeId,
      lastStoredAt: place.lastStoredAt,
      ageMs,
      fresh: ageMs != null && ageMs <= NOAA_CADENCE_MS,
    };
  });
}

export interface StatusCall {
  source: UpstreamSource;
  calledAt: string;
  outcome: "ok" | "error";
  points: number | null;
}

export interface PublicPlaceFreshness {
  lastStoredAt: string | null;
  ageMs: number | null;
  fresh: boolean;
}

export interface MonitoringStatus {
  asOf: string;
  feeds: {
    noaa: SourceHealth;
    airnow: SourceHealth;
    purpleair: SourceHealth;
  };
  budget: {
    airnow: AirNowBudget;
    purpleair: {
      enabled: false;
      spending: false;
      pointsPerMonth: number;
      windowMs: number;
      monthMs: number;
      status: "off";
    };
  };
  forecastStore: {
    cadenceMs: number;
    placeCount: number;
    freshCount: number;
    staleCount: number;
    missingCount: number;
    places: PublicPlaceFreshness[];
  };
}

function comparePlaces(a: PlaceFreshness, b: PlaceFreshness): number {
  if (a.lastStoredAt == null && b.lastStoredAt != null) return -1;
  if (a.lastStoredAt != null && b.lastStoredAt == null) return 1;
  if (a.lastStoredAt != null && b.lastStoredAt != null && a.lastStoredAt !== b.lastStoredAt) {
    return a.lastStoredAt < b.lastStoredAt ? -1 : 1;
  }
  return a.placeId < b.placeId ? -1 : a.placeId > b.placeId ? 1 : 0;
}

/**
 * Feed health, the AirNow hour, and the PurpleAir month. Place ids stay on
 * the freshness input and are left out of the result.
 */
export function buildStatus(input: {
  asOf: string;
  ingests: { noaa: string | null; airnow: string | null; purpleair: string | null };
  places: readonly PlaceMark[];
  calls: readonly StatusCall[];
}): MonitoringStatus {
  const asOf = parseUtcInstant(input.asOf, "asOf");
  const nowMs = Date.parse(asOf);
  const places = forecastFreshness(input.places, nowMs).sort(comparePlaces);
  let freshCount = 0;
  let staleCount = 0;
  let missingCount = 0;
  for (const place of places) {
    if (place.lastStoredAt == null) missingCount += 1;
    else if (place.fresh) freshCount += 1;
    else staleCount += 1;
  }
  const airNowCalls = input.calls
    .filter((call) => call.source === "airnow")
    .map((call) => ({ calledAtMs: Date.parse(call.calledAt) }));
  const purpleCalls = input.calls
    .filter((call) => call.source === "purpleair")
    .map((call) => {
      if (call.points == null) {
        throw new V1RuleError("purpleair_points", "A PurpleAir ledger row is missing its points.");
      }
      return { calledAtMs: Date.parse(call.calledAt), points: call.points };
    });
  return {
    asOf,
    feeds: {
      noaa: sourceHealth("noaa", input.ingests.noaa, nowMs),
      airnow: sourceHealth("airnow", input.ingests.airnow, nowMs),
      purpleair: sourceHealth("purpleair", input.ingests.purpleair, nowMs),
    },
    budget: {
      airnow: airNowBudget(airNowCalls, nowMs),
      purpleair: {
        enabled: false,
        spending: false,
        pointsPerMonth: projectPurpleAirPointsPerMonth(purpleCalls, nowMs),
        windowMs: PROJECTION_WINDOW_MS,
        monthMs: PROJECTION_MONTH_MS,
        status: "off",
      },
    },
    forecastStore: {
      cadenceMs: NOAA_CADENCE_MS,
      placeCount: places.length,
      freshCount,
      staleCount,
      missingCount,
      places: places.map((place) => ({
        lastStoredAt: place.lastStoredAt,
        ageMs: place.ageMs,
        fresh: place.fresh,
      })),
    },
  };
}

interface StampRow {
  at: string | Date | null;
}

interface PlaceRow {
  place_id: string;
  last_stored_at: string | Date | null;
}

interface CallRow {
  source: UpstreamSource;
  called_at: string | Date;
  outcome: "ok" | "error";
  points: number | null;
}

function asIso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new V1RuleError("invalid_time", "Stored timestamp is unreadable.");
  }
  return parsed.toISOString();
}

function asStamp(value: string | Date | null): string | null {
  if (value == null) return null;
  return asIso(value);
}

/**
 * Reads the forecast store, official readings, stability rows, and the ledger.
 * PurpleAir has no ingest table, so its last success is null. The body has
 * no user, name, coordinate, key, or place id.
 */
export async function readMonitoringStatus(
  sql: Queryable,
  asOf: string,
): Promise<MonitoringStatus> {
  const checked = parseUtcInstant(asOf, "asOf");
  const nowMs = Date.parse(checked);
  const noaaRows = await sql.query<StampRow>(
    `select max(created_at) as at from (
       select created_at from forecast_issued
       union all
       select created_at from stability_issued
     ) ingested`,
  );
  const airNowRows = await sql.query<StampRow>(
    "select max(created_at) as at from official_reading",
  );
  const placeRows = await sql.query<PlaceRow>(
    `select p.id as place_id, max(f.created_at) as last_stored_at
       from saved_place p
       left join forecast_issued f
         on f.place_id = p.id
        and f.user_id = p.user_id
      group by p.id`,
  );
  const callRows = await sql.query<CallRow>(
    `select source, called_at, outcome, points
       from upstream_call
      where called_at > $1
        and called_at <= $2`,
    [new Date(nowMs - PROJECTION_WINDOW_MS).toISOString(), checked],
  );
  return buildStatus({
    asOf: checked,
    ingests: {
      noaa: asStamp(noaaRows[0]?.at ?? null),
      airnow: asStamp(airNowRows[0]?.at ?? null),
      purpleair: null,
    },
    places: placeRows.map((row) => ({
      placeId: row.place_id,
      lastStoredAt: asStamp(row.last_stored_at),
    })),
    calls: callRows.map((row) => ({
      source: row.source,
      calledAt: asIso(row.called_at),
      outcome: row.outcome,
      points: row.points,
    })),
  });
}
