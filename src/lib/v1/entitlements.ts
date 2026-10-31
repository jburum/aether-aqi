import { NotEntitledError, V1RuleError } from "./errors.ts";
import { DAY12_MS, FREE_SAVED_PLACES } from "./rules.ts";
import {
  PRO_PRODUCTS,
  type ProProduct,
  type StoreKitVerifier,
  type StoredEntitlementState,
  type VerifiedTransaction,
} from "./storekit.ts";
import type {
  Confidence,
  ForecastSource,
  Horizon,
  Queryable,
  SpatialScale,
} from "./types.ts";

/**
 * Pro entitlement for one user.
 * No row means Free. The insert trigger uses the same Pro rule
 * (`saved_place_user_is_pro` in migrations/0004_v1_entitlement.sql).
 */

/** Prices are fixed. They are not read from the environment. */
export const PRO_PRICE_USD = {
  monthly: "1.99",
  yearly: "12.99",
} as const;

export type ProPriceUsd = (typeof PRO_PRICE_USD)[ProProduct];

export interface StoredEntitlement {
  product: ProProduct;
  source: "storekit";
  expiresAt: string;
  state: StoredEntitlementState;
}

/** What the app should branch on. `tier` is effective, not the stored purchase. */
export interface EntitlementResponse {
  tier: "free" | "pro";
  product: ProProduct | null;
  priceUsd: ProPriceUsd | null;
  source: "storekit" | null;
  expiresAt: string | null;
  state: "free" | StoredEntitlementState;
  pro: boolean;
}

export interface PlaceAccess {
  pro: boolean;
  /** Every saved place, first to last. A downgrade leaves this list intact. */
  placeIds: string[];
  /** Free is the first id only. Pro is every id, still capped at 5. */
  openPlaceIds: string[];
}

interface HourRow {
  source: ForecastSource;
  issued_at: string | Date;
  valid_for: string | Date;
  horizon: Horizon;
  spatial_scale: SpatialScale;
  confidence: Confidence;
  corrected_aqi: number;
  pollutant: string | null;
}

export interface AirHour {
  source: ForecastSource;
  issuedAt: string;
  validFor: string;
  horizon: Horizon;
  spatialScale: SpatialScale;
  confidence: Confidence;
  correctedAqi: number;
  pollutant: string | null;
}

export interface CurrentOfficial {
  observedAt: string;
  officialAqi: number;
  officialRaw: string;
  preliminary: true;
  attribution: string;
  source: "airnow";
}

export interface CurrentAirResponse {
  placeId: string;
  asOf: string;
  corrected: AirHour | null;
  official: CurrentOfficial | null;
}

export interface TimelineResponse {
  placeId: string;
  asOf: string;
  /** Inclusive end of the next 48 hours. Same length as `DAY12_MS`. */
  through: string;
  hours: AirHour[];
}

interface EntitlementRow {
  product: string;
  source: string;
  expires_at: string | Date;
  state: string;
}

interface OfficialAirRow {
  observed_at: string | Date;
  official_aqi: number;
  official_raw: string;
  preliminary: boolean;
  attribution: string;
  source: string;
}

const HOUR_MS = 3_600_000;

const FREE_ENTITLEMENT: EntitlementResponse = {
  tier: "free",
  product: null,
  priceUsd: null,
  source: null,
  expiresAt: null,
  state: "free",
  pro: false,
};

function iso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new V1RuleError("invalid_time", "Stored timestamp is unreadable.");
  }
  return parsed.toISOString();
}

function isProduct(value: string): value is ProProduct {
  return (PRO_PRODUCTS as readonly string[]).includes(value);
}

function isStoredState(value: string): value is StoredEntitlementState {
  return value === "active" || value === "grace" || value === "expired" || value === "revoked";
}

/**
 * Grace stays Pro after expiresAt. Active stays Pro only while expiresAt is
 * still ahead. A stale `active` row whose clock has passed is reported as
 * expired and is not rewritten. Revoked is never Pro, even with a future expiry.
 */
export function effectiveEntitlement(
  row: StoredEntitlement | null,
  now: Date,
): EntitlementResponse {
  if (!row) return { ...FREE_ENTITLEMENT };
  const expiredByClock = Date.parse(row.expiresAt) <= now.getTime();
  let state = row.state;
  if (state === "active" && expiredByClock) state = "expired";
  const pro = state === "grace" || state === "active";
  return {
    tier: pro ? "pro" : "free",
    product: row.product,
    priceUsd: PRO_PRICE_USD[row.product],
    source: row.source,
    expiresAt: row.expiresAt,
    state,
    pro,
  };
}

function asStored(row: EntitlementRow): StoredEntitlement {
  if (!isProduct(row.product) || row.source !== "storekit" || !isStoredState(row.state)) {
    throw new V1RuleError("invalid_field", "Stored entitlement is unreadable.", 400);
  }
  return {
    product: row.product,
    source: "storekit",
    expiresAt: iso(row.expires_at),
    state: row.state,
  };
}

export async function readEntitlement(
  sql: Queryable,
  userId: string,
  now: Date,
): Promise<EntitlementResponse> {
  const rows = await sql.query<EntitlementRow>(
    `select product, source, expires_at, state
       from entitlement
      where user_id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return { ...FREE_ENTITLEMENT };
  return effectiveEntitlement(asStored(row), now);
}

async function saveEntitlement(
  sql: Queryable,
  userId: string,
  verified: VerifiedTransaction,
): Promise<void> {
  if (verified.source !== "storekit" || !isProduct(verified.product)) {
    throw new V1RuleError("storekit_invalid", "Signed transaction could not be verified.", 400);
  }
  await sql.query(
    `insert into entitlement (user_id, tier, product, source, expires_at, state)
     values ($1, 'pro', $2, 'storekit', $3, $4)
     on conflict (user_id) do update set
       tier = 'pro',
       product = excluded.product,
       source = excluded.source,
       expires_at = excluded.expires_at,
       state = excluded.state,
       updated_at = now()`,
    [userId, verified.product, verified.expiresAt, verified.state],
  );
}

/**
 * Verifies a signed transaction with the caller's verifier and stores one row.
 * The request path does not call this. Tests pass the fixture verifier.
 * A verifier failure stays a rule error, so a later route cannot turn it into a 500.
 */
export async function applySignedTransaction(
  sql: Queryable,
  userId: string,
  signedTransaction: string,
  verifier: StoreKitVerifier,
  now: Date,
): Promise<EntitlementResponse> {
  let verified: VerifiedTransaction;
  try {
    verified = verifier.verify(signedTransaction, now);
  } catch (err) {
    if (err instanceof V1RuleError) throw err;
    throw new V1RuleError("storekit_invalid", "Signed transaction could not be verified.", 400);
  }
  await saveEntitlement(sql, userId, verified);
  return readEntitlement(sql, userId, now);
}

export async function loadPlaceAccess(
  sql: Queryable,
  userId: string,
  now: Date,
): Promise<PlaceAccess> {
  const entitlement = await readEntitlement(sql, userId, now);
  const rows = await sql.query<{ id: string }>(
    `select id from saved_place
      where user_id = $1
      order by position asc, created_at asc, id asc`,
    [userId],
  );
  const placeIds = rows.map((row) => row.id);
  const openPlaceIds = entitlement.pro ? placeIds : placeIds.slice(0, FREE_SAVED_PLACES);
  return { pro: entitlement.pro, placeIds, openPlaceIds };
}

/** 404 when the place is not theirs. 403 when it is stored but past the free slot. */
export function assertPlaceOpen(access: PlaceAccess, placeId: string): void {
  if (!access.placeIds.includes(placeId)) {
    throw new V1RuleError("place_not_found", "Saved place not found.", 404);
  }
  if (!access.openPlaceIds.includes(placeId)) {
    throw new NotEntitledError(
      "saved_places",
      "Saved places beyond the first require Pro.",
    );
  }
}

export async function requireOpenPlace(
  sql: Queryable,
  userId: string,
  placeId: string,
  now: Date,
): Promise<PlaceAccess> {
  const access = await loadPlaceAccess(sql, userId, now);
  assertPlaceOpen(access, placeId);
  return access;
}

export async function requireProAlerts(
  sql: Queryable,
  userId: string,
  now: Date,
): Promise<void> {
  const entitlement = await readEntitlement(sql, userId, now);
  if (!entitlement.pro) {
    throw new NotEntitledError(
      "alerts",
      "Smoke, inversion, and ozone alerts require Pro.",
    );
  }
}

async function requireOwnedPlace(sql: Queryable, userId: string, placeId: string): Promise<void> {
  const found = await sql.query<{ id: string }>(
    "select id from saved_place where id = $1 and user_id = $2",
    [placeId, userId],
  );
  if (!found[0]) throw new V1RuleError("place_not_found", "Saved place not found.", 404);
}

function asHour(row: HourRow): AirHour {
  return {
    source: row.source,
    issuedAt: iso(row.issued_at),
    validFor: iso(row.valid_for),
    horizon: row.horizon,
    spatialScale: row.spatial_scale,
    confidence: row.confidence,
    correctedAqi: Number(row.corrected_aqi),
    pollutant: row.pollutant,
  };
}

/** Latest issue for each valid hour. The same ordering as the phase-2 reads. */
async function loadHours(sql: Queryable, userId: string, placeId: string): Promise<AirHour[]> {
  const rows = await sql.query<HourRow>(
    `select distinct on (valid_for)
            source, issued_at, valid_for, horizon, spatial_scale, confidence,
            corrected_aqi, pollutant
       from forecast_issued
      where place_id = $1 and user_id = $2
      order by valid_for asc, issued_at desc, created_at desc, id desc`,
    [placeId, userId],
  );
  return rows.map(asHour);
}

/**
 * The hero for one place: the corrected hour that contains `asOf`, and the
 * latest official AirNow reading at or before `asOf`. Either side may be null.
 */
export async function readCurrentAir(
  sql: Queryable,
  userId: string,
  placeId: string,
  asOf: string,
): Promise<CurrentAirResponse> {
  await requireOwnedPlace(sql, userId, placeId);
  const asOfMs = Date.parse(asOf);
  const hours = await loadHours(sql, userId, placeId);
  const corrected =
    hours.find((hour) => {
      const start = Date.parse(hour.validFor);
      return start <= asOfMs && asOfMs - start < HOUR_MS;
    }) ?? null;
  const officialRows = await sql.query<OfficialAirRow>(
    `select observed_at, official_aqi, official_raw, preliminary, attribution, source
       from official_reading
      where place_id = $1 and user_id = $2 and observed_at <= $3
      order by observed_at desc, created_at desc, id desc
      limit 1`,
    [placeId, userId, asOf],
  );
  const officialRow = officialRows[0];
  if (officialRow && (officialRow.preliminary !== true || officialRow.source !== "airnow")) {
    throw new V1RuleError(
      "official_not_preliminary",
      "Stored official readings must stay preliminary AirNow rows.",
    );
  }
  const official: CurrentOfficial | null = officialRow
    ? {
        observedAt: iso(officialRow.observed_at),
        officialAqi: Number(officialRow.official_aqi),
        officialRaw: officialRow.official_raw,
        preliminary: true,
        attribution: officialRow.attribution,
        source: "airnow",
      }
    : null;
  return { placeId, asOf, corrected, official };
}

/** Corrected hours in `[asOf, asOf + 48 hours]`, including the exact end. */
export async function readTimeline(
  sql: Queryable,
  userId: string,
  placeId: string,
  asOf: string,
): Promise<TimelineResponse> {
  await requireOwnedPlace(sql, userId, placeId);
  const asOfMs = Date.parse(asOf);
  const throughMs = asOfMs + DAY12_MS;
  const hours = (await loadHours(sql, userId, placeId)).filter((hour) => {
    const at = Date.parse(hour.validFor);
    return at >= asOfMs && at <= throughMs;
  });
  return {
    placeId,
    asOf,
    through: new Date(throughMs).toISOString(),
    hours,
  };
}
