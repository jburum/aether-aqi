import { randomUUID } from "node:crypto";

import { V1RuleError } from "./errors.ts";
import { planSensorGap, type SensorSample } from "./purpleair.ts";
import { buildPushPayload, type PushPayload, type PushSender } from "./push.ts";
import {
  AIRNOW_ATTRIBUTION,
  MAX_SAVED_PLACES,
  parseForecastInput,
  parseOfficialInput,
  parsePlaceInput,
} from "./rules.ts";
import type {
  Confidence,
  ForecastBesideObserved,
  ForecastSource,
  Horizon,
  IssuedForecast,
  OfficialBeside,
  OfficialReading,
  Queryable,
  SavedPlace,
  SpatialScale,
} from "./types.ts";

interface PlaceRow {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  valley: string | null;
  alert_at: number | null;
  position: number;
  created_at: string | Date;
}

interface ForecastRow {
  id: string;
  place_id: string;
  source: ForecastSource;
  issued_at: string | Date;
  valid_for: string | Date;
  horizon: Horizon;
  spatial_scale: SpatialScale;
  confidence: Confidence;
  corrected_aqi: number;
  pollutant: string | null;
}

interface OfficialRow {
  id: string;
  place_id: string;
  observed_at: string | Date;
  official_aqi: number;
  official_raw: string;
  preliminary: boolean;
  attribution: string;
  source: "airnow";
}

interface BesideRow {
  forecast_id: string;
  place_id: string;
  place_name: string;
  forecast_source: ForecastSource;
  issued_at: string | Date;
  valid_for: string | Date;
  horizon: Horizon;
  spatial_scale: SpatialScale;
  confidence: Confidence;
  corrected_aqi: number;
  pollutant: string | null;
  observation_id: string | null;
  official_aqi: number | null;
  official_raw: string | null;
  official_preliminary: boolean | null;
  official_attribution: string | null;
  observed_at: string | Date | null;
  official_source: "airnow" | null;
}

interface DeviceRow {
  id: string;
  token: string;
  platform: string;
  created_at: string | Date;
}

export interface PushDeliveryRecord {
  id: string;
  deviceId: string;
  placeId: string;
  forecastId: string;
  status: "sent" | "failed";
  sender: "test";
  providerId: string | null;
  payload: PushPayload;
}

function iso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new V1RuleError("invalid_time", "Stored timestamp is unreadable.");
  }
  return parsed.toISOString();
}

function asPlace(row: PlaceRow): SavedPlace {
  return {
    id: row.id,
    name: row.name,
    latitude: row.latitude,
    longitude: row.longitude,
    valley: row.valley,
    alertAt: row.alert_at,
    position: row.position,
    createdAt: iso(row.created_at),
  };
}

function asForecast(row: ForecastRow): IssuedForecast {
  return {
    id: row.id,
    placeId: row.place_id,
    source: row.source,
    issuedAt: iso(row.issued_at),
    validFor: iso(row.valid_for),
    horizon: row.horizon,
    spatialScale: row.spatial_scale,
    confidence: row.confidence,
    correctedAqi: row.corrected_aqi,
    pollutant: row.pollutant,
  };
}

function asOfficial(row: OfficialRow): OfficialReading {
  if (row.preliminary !== true || row.source !== "airnow") {
    throw new V1RuleError(
      "official_not_preliminary",
      "Stored official readings must stay preliminary AirNow rows.",
    );
  }
  return {
    id: row.id,
    placeId: row.place_id,
    observedAt: iso(row.observed_at),
    officialAqi: row.official_aqi,
    officialRaw: row.official_raw,
    preliminary: true,
    attribution: row.attribution,
    source: "airnow",
  };
}

function asBeside(row: BesideRow): ForecastBesideObserved {
  const official: OfficialBeside | null =
    row.observation_id == null
      ? null
      : {
          id: row.observation_id,
          aqi: row.official_aqi as number,
          raw: row.official_raw as string,
          preliminary: true,
          attribution: row.official_attribution as string,
          source: "airnow",
          observedAt: iso(row.observed_at as string | Date),
        };
  if (official && (row.official_preliminary !== true || row.official_source !== "airnow")) {
    throw new V1RuleError(
      "official_not_preliminary",
      "The official side of a forecast pair must be a preliminary AirNow reading.",
    );
  }
  return {
    place: { id: row.place_id, name: row.place_name },
    forecast: {
      id: row.forecast_id,
      placeId: row.place_id,
      source: row.forecast_source,
      issuedAt: iso(row.issued_at),
      validFor: iso(row.valid_for),
      horizon: row.horizon,
      spatialScale: row.spatial_scale,
      confidence: row.confidence,
      correctedAqi: row.corrected_aqi,
      pollutant: row.pollutant,
    },
    official,
  };
}

async function assertPlace(sql: Queryable, userId: string, placeId: string): Promise<void> {
  const found = await sql.query<{ id: string }>(
    "select id from saved_place where id = $1 and user_id = $2",
    [placeId, userId],
  );
  if (!found[0]) {
    throw new V1RuleError("place_not_found", "Saved place not found.", 404);
  }
}

function rethrowStore(err: unknown): never {
  if (err instanceof V1RuleError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("saved places cap is 5")) {
    throw new V1RuleError("place_cap", "Saved places are capped at 5.", 409);
  }
  throw err instanceof Error ? err : new Error(message);
}

export async function addSavedPlace(
  sql: Queryable,
  userId: string,
  body: unknown,
): Promise<SavedPlace> {
  const input = parsePlaceInput(body);
  const id = randomUUID();
  try {
    // One statement: saved_place_add locks this user, then counts and inserts
    // before that lock is released. A pool query() cannot hold a lock across
    // separate round trips.
    const inserted = await sql.query<PlaceRow>(
      `select id, name, latitude, longitude, valley, alert_at, position, created_at
         from saved_place_add($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        userId,
        input.name,
        input.latitude,
        input.longitude,
        input.valley,
        input.alertAt,
        MAX_SAVED_PLACES,
      ],
    );
    const row = inserted[0];
    if (!row) throw new V1RuleError("place_not_found", "Saved place was not stored.", 500);
    return asPlace(row);
  } catch (err) {
    rethrowStore(err);
  }
}

export async function listSavedPlaces(sql: Queryable, userId: string): Promise<SavedPlace[]> {
  const rows = await sql.query<PlaceRow>(
    `select id, name, latitude, longitude, valley, alert_at, position, created_at
     from saved_place where user_id = $1 order by position, created_at`,
    [userId],
  );
  return rows.map(asPlace);
}

export async function removeSavedPlace(
  sql: Queryable,
  userId: string,
  placeId: string,
): Promise<void> {
  const rows = await sql.query<{ id: string }>(
    "delete from saved_place where id = $1 and user_id = $2 returning id",
    [placeId, userId],
  );
  if (!rows[0]) throw new V1RuleError("place_not_found", "Saved place not found.", 404);
}

export async function issueForecast(
  sql: Queryable,
  userId: string,
  body: unknown,
): Promise<IssuedForecast> {
  const input = parseForecastInput(body);
  await assertPlace(sql, userId, input.placeId);
  const id = randomUUID();
  const inserted = await sql.query<ForecastRow>(
    `insert into forecast_issued
       (id, place_id, user_id, source, issued_at, valid_for, horizon, spatial_scale,
        confidence, corrected_aqi, pollutant)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning id, place_id, source, issued_at, valid_for, horizon, spatial_scale,
               confidence, corrected_aqi, pollutant`,
    [
      id,
      input.placeId,
      userId,
      input.source,
      input.issuedAt,
      input.validFor,
      input.horizon,
      input.spatialScale,
      input.confidence,
      input.correctedAqi,
      input.pollutant,
    ],
  );
  const row = inserted[0];
  if (!row) throw new V1RuleError("forecast_not_found", "Forecast was not stored.", 500);
  return asForecast(row);
}

export async function recordOfficial(
  sql: Queryable,
  userId: string,
  body: unknown,
): Promise<OfficialReading> {
  const input = parseOfficialInput(body);
  await assertPlace(sql, userId, input.placeId);
  const existing = await sql.query<{ official_aqi: number }>(
    `select official_aqi from official_reading
     where place_id = $1 and user_id = $2 and observed_at = $3`,
    [input.placeId, userId, input.observedAt],
  );
  if (existing[0]) {
    throw new V1RuleError(
      "official_already_recorded",
      "An official AirNow reading is already stored for this place and time. It is left unchanged.",
      409,
    );
  }
  const id = randomUUID();
  const inserted = await sql.query<OfficialRow>(
    `insert into official_reading
       (id, place_id, user_id, source, observed_at, official_aqi, official_raw, preliminary, attribution)
     values ($1, $2, $3, 'airnow', $4, $5, $6, true, $7)
     returning id, place_id, observed_at, official_aqi, official_raw, preliminary, attribution, source`,
    [
      id,
      input.placeId,
      userId,
      input.observedAt,
      input.officialAqi,
      input.officialRaw,
      AIRNOW_ATTRIBUTION,
    ],
  );
  const row = inserted[0];
  if (!row) throw new V1RuleError("official_not_found", "Official reading was not stored.", 500);
  return asOfficial(row);
}

export async function listBeside(
  sql: Queryable,
  userId: string,
  placeId?: string,
): Promise<ForecastBesideObserved[]> {
  const params: unknown[] = [userId];
  let placeClause = "";
  if (placeId) {
    params.push(placeId);
    placeClause = " and place_id = $2";
  }
  const rows = await sql.query<BesideRow>(
    `select forecast_id, place_id, place_name, forecast_source, issued_at, valid_for, horizon,
            spatial_scale, confidence, corrected_aqi, pollutant, observation_id, official_aqi,
            official_raw, official_preliminary, official_attribution, observed_at, official_source
     from forecast_beside_observed
     where user_id = $1${placeClause}
     order by valid_for, issued_at`,
    params,
  );
  return rows.map(asBeside);
}

/**
 * Sensor dropout writes a NOAA valley forecast. An official AirNow body, when
 * one is passed, is stored on official_reading and is not copied onto the forecast.
 * Outdoor PurpleAir rows are refused before any insert.
 */
export async function applySensorGap(
  sql: Queryable,
  userId: string,
  samples: readonly SensorSample[],
  valleyForecast: unknown,
  officialBody?: unknown,
): Promise<{
  action: "fall_back_to_noaa_valley";
  forecast: IssuedForecast;
  officialAqi: number | null;
}> {
  const plan = planSensorGap(samples);
  if (plan.action === "purpleair_blocked") {
    throw new V1RuleError(
      "purpleair_spend_not_approved",
      "PurpleAir is out this week. Spend is not approved, and this path does not buy points or store sensor readings.",
    );
  }
  const official = officialBody === undefined ? null : parseOfficialInput(officialBody);
  const forecast = await issueForecast(sql, userId, valleyForecast);
  if (!official) {
    return { action: "fall_back_to_noaa_valley", forecast, officialAqi: null };
  }
  const stored = await recordOfficial(sql, userId, official);
  return { action: "fall_back_to_noaa_valley", forecast, officialAqi: stored.officialAqi };
}

export async function registerTestDevice(
  sql: Queryable,
  userId: string,
  token: string,
): Promise<{ id: string; platform: "test"; token: string; createdAt: string }> {
  const existing = await sql.query<DeviceRow>(
    `select id, token, platform, created_at from push_device
     where user_id = $1 and token = $2`,
    [userId, token],
  );
  if (existing[0]) {
    return {
      id: existing[0].id,
      platform: "test",
      token: existing[0].token,
      createdAt: iso(existing[0].created_at),
    };
  }
  const id = randomUUID();
  const inserted = await sql.query<DeviceRow>(
    `insert into push_device (id, user_id, token, platform)
     values ($1, $2, $3, 'test')
     returning id, token, platform, created_at`,
    [id, userId, token],
  );
  const row = inserted[0];
  if (!row) throw new V1RuleError("device_not_found", "Test device was not stored.", 500);
  return { id: row.id, platform: "test", token: row.token, createdAt: iso(row.created_at) };
}

export async function deliverForecastPush(
  sql: Queryable,
  userId: string,
  forecastId: string,
  sender: PushSender,
): Promise<PushDeliveryRecord[]> {
  if (sender.name !== "test") {
    throw new V1RuleError(
      "push_sender_is_test_only",
      "Week-1 delivery uses the test sender. There is no APNs key and no paid push vendor.",
    );
  }
  const beside = await sql.query<BesideRow>(
    `select forecast_id, place_id, place_name, forecast_source, issued_at, valid_for, horizon,
            spatial_scale, confidence, corrected_aqi, pollutant, observation_id, official_aqi,
            official_raw, official_preliminary, official_attribution, observed_at, official_source
     from forecast_beside_observed
     where forecast_id = $1 and user_id = $2`,
    [forecastId, userId],
  );
  const row = beside[0];
  if (!row) throw new V1RuleError("forecast_not_found", "Forecast not found.", 404);
  const pair = asBeside(row);
  const payload = buildPushPayload({
    placeId: pair.place.id,
    placeName: pair.place.name,
    issuedAt: pair.forecast.issuedAt,
    validFor: pair.forecast.validFor,
    forecast: {
      id: pair.forecast.id,
      source: pair.forecast.source,
      correctedAqi: pair.forecast.correctedAqi,
      horizon: pair.forecast.horizon,
      spatialScale: pair.forecast.spatialScale,
      confidence: pair.forecast.confidence,
    },
    official: pair.official,
  });
  const devices = await sql.query<DeviceRow>(
    `select id, token, platform, created_at from push_device
     where user_id = $1 and platform = 'test' order by created_at`,
    [userId],
  );
  if (devices.length === 0) {
    throw new V1RuleError(
      "no_test_device",
      "Register a test device before delivering. Week 1 does not call APNs.",
      409,
    );
  }
  const deliveries: PushDeliveryRecord[] = [];
  for (const device of devices) {
    const result = await sender.send(payload);
    const id = randomUUID();
    const status = result.ok ? "sent" : "failed";
    const providerId = result.ok ? result.providerId : null;
    await sql.query(
      `insert into push_delivery
         (id, user_id, device_id, place_id, forecast_id, payload, status, sender, provider_id)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, 'test', $8)`,
      [
        id,
        userId,
        device.id,
        pair.place.id,
        pair.forecast.id,
        JSON.stringify(payload),
        status,
        providerId,
      ],
    );
    deliveries.push({
      id,
      deviceId: device.id,
      placeId: pair.place.id,
      forecastId: pair.forecast.id,
      status,
      sender: "test",
      providerId,
      payload,
    });
  }
  return deliveries;
}
