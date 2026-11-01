import { createHash, randomUUID } from "node:crypto";

import { readAlerts, type AlertDecision, type AlertKind } from "./alerts.ts";
import { requireOpenPlace, requireProAlerts } from "./entitlements.ts";
import { V1RuleError } from "./errors.ts";
import { parseTimeZone, parseUtcInstant } from "./phase2.ts";
import {
  assertPayloadSeparated,
  buildPushPayload,
  type PushPayload,
  type PushSender,
} from "./push.ts";
import { requireId } from "./rules.ts";
import type {
  Confidence,
  ForecastSource,
  Horizon,
  OfficialBeside,
  Queryable,
  SpatialScale,
} from "./types.ts";

/**
 * One Pro push per new alert episode for one saved place.
 * The episode row is claimed before the send, so overlapping calls cannot both deliver it.
 * A claim still open after CLAIM_STALE_MS is taken back and sent with the same idempotency key.
 * Quiet hours are a follow-up: this does not hold a push for the local night.
 * There is no scheduler and no APNs client. The sender must be the test sender.
 */

/** Database-clock age after which an open claim can be taken back. */
export const CLAIM_STALE_MS = 120_000;

export interface AlertPushAttempt {
  id: string;
  kind: AlertKind;
  episodeStart: string;
  status: "sent" | "failed";
  providerId: string | null;
  payload: PushPayload;
}

export interface AlertPushResult {
  placeId: string;
  userId: string;
  asOf: string;
  sent: AlertPushAttempt[];
  failed: AlertPushAttempt[];
  /**
   * Episodes this call did not send.
   * The row was already sent, or another caller holds a fresh claim.
   */
  skipped: number;
}

/** Test seam. `stopAfterClaim` leaves the episode claimed and does not send. */
export interface AlertPushControl {
  stopAfterClaim?: boolean;
}

interface PlaceRow {
  id: string;
  user_id: string;
  name: string;
}

interface PeakRow {
  id: string;
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
  official_aqi: number;
  official_raw: string;
  preliminary: boolean;
  attribution: string;
  source: string;
  observed_at: string | Date;
}

interface AttemptRow {
  id: string;
}

interface ClaimRow {
  id: string;
  idempotency_key: string;
  claim_token: string;
}

interface OpenClaim {
  id: string;
  idempotencyKey: string;
  claimToken: string;
}

function iso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new V1RuleError("invalid_time", "Stored timestamp is unreadable.");
  }
  return parsed.toISOString();
}

/** Same pollutant key as `pollutantKey` in alerts.ts. */
function pollutantKey(source: string, pollutant: string | null): string {
  const label = (pollutant ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (label === "pm25" || (label === "" && source === "noaa_smoke")) return "pm25";
  if (label === "o3" || label === "ozone") return "o3";
  return label;
}

function episodePollutant(kind: AlertKind): "pm25" | "o3" {
  return kind === "ozone" ? "o3" : "pm25";
}

function failText(error: string): string {
  const text = error.trim() || "push send failed";
  return text.length <= 500 ? text : text.slice(0, 500);
}

async function loadPlace(sql: Queryable, placeId: string): Promise<PlaceRow | null> {
  const rows = await sql.query<PlaceRow>(
    `select id, user_id, name from saved_place where id = $1`,
    [placeId],
  );
  return rows[0] ?? null;
}

/**
 * Latest corrected hour inside the episode.
 * A null published peak means AirNow owns the episode. The official number
 * is not a candidate here. The stored corrected AQI is.
 */
async function loadPeakForecast(
  sql: Queryable,
  userId: string,
  placeId: string,
  alert: AlertDecision,
): Promise<PeakRow> {
  if (!alert.start || !alert.end) {
    throw new V1RuleError("invalid_time", "A fired alert episode needs a start and an end.");
  }
  const rows = await sql.query<PeakRow>(
    `select id, source, issued_at, valid_for, horizon, spatial_scale, confidence,
            corrected_aqi, pollutant
       from forecast_issued
      where place_id = $1 and user_id = $2
        and valid_for >= $3 and valid_for < $4
      order by valid_for asc, issued_at desc, created_at desc, id desc`,
    [placeId, userId, alert.start, alert.end],
  );
  const wanted = episodePollutant(alert.kind);
  const latest = new Map<string, PeakRow>();
  for (const row of rows) {
    const key = `${iso(row.valid_for)}\0${pollutantKey(row.source, row.pollutant)}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  const candidates = [...latest.values()].filter(
    (row) => pollutantKey(row.source, row.pollutant) === wanted,
  );
  const ranked =
    alert.peakAqi == null
      ? candidates.sort((a, b) => {
          const byAqi = Number(b.corrected_aqi) - Number(a.corrected_aqi);
          if (byAqi !== 0) return byAqi;
          return Date.parse(iso(a.valid_for)) - Date.parse(iso(b.valid_for));
        })
      : candidates
          .filter((row) => Number(row.corrected_aqi) === alert.peakAqi)
          .sort((a, b) => Date.parse(iso(a.valid_for)) - Date.parse(iso(b.valid_for)));
  const peak = ranked[0];
  if (!peak) {
    throw new V1RuleError(
      "alert_forecast_missing",
      "The alert episode has no stored corrected forecast hour to quote.",
    );
  }
  return peak;
}

async function loadOfficial(
  sql: Queryable,
  userId: string,
  placeId: string,
  asOf: string,
): Promise<OfficialBeside | null> {
  const rows = await sql.query<OfficialRow>(
    `select id, official_aqi, official_raw, preliminary, attribution, source, observed_at
       from official_reading
      where place_id = $1 and user_id = $2 and observed_at <= $3
      order by observed_at desc, created_at desc, id desc
      limit 1`,
    [placeId, userId, asOf],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.preliminary !== true || row.source !== "airnow") {
    throw new V1RuleError(
      "official_not_preliminary",
      "Stored official readings must stay preliminary AirNow rows.",
    );
  }
  return {
    id: row.id,
    aqi: Number(row.official_aqi),
    raw: row.official_raw,
    preliminary: true,
    attribution: row.attribution,
    source: "airnow",
    observedAt: iso(row.observed_at),
  };
}

/** sha256 hex of the episode. Stored once. A retry or a reclaim keeps this value. */
function episodeIdempotencyKey(
  userId: string,
  placeId: string,
  kind: AlertKind,
  episodeStart: string,
): string {
  return createHash("sha256")
    .update(`aether-aqi.alert-episode\0${userId}\0${placeId}\0${kind}\0${episodeStart}`)
    .digest("hex");
}

function openClaim(row: ClaimRow | undefined): OpenClaim | null {
  if (!row?.id || !row.idempotency_key || !row.claim_token) return null;
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    claimToken: row.claim_token,
  };
}

/** Fast path for a finished send. The claim below is what stops a second send. */
async function alreadySent(
  sql: Queryable,
  userId: string,
  placeId: string,
  kind: AlertKind,
  episodeStart: string,
): Promise<boolean> {
  const rows = await sql.query<{ status: string }>(
    `select status from alert_push
      where user_id = $1 and place_id = $2 and kind = $3 and episode_start = $4`,
    [userId, placeId, kind, episodeStart],
  );
  return rows[0]?.status === "sent";
}

/**
 * Claim the episode before anyone sends.
 * The insert wins only when the row is new. A finished failure is retried at once.
 * An open claim is retried only after CLAIM_STALE_MS. The idempotency key stays
 * the one written on the first insert, so a reclaim cannot double-deliver.
 */
async function claimEpisode(
  sql: Queryable,
  input: {
    userId: string;
    placeId: string;
    kind: AlertKind;
    episodeStart: string;
    forecastId: string;
    payload: PushPayload;
  },
): Promise<OpenClaim | null> {
  const inserted = await sql.query<ClaimRow>(
    `insert into alert_push
       (id, user_id, place_id, kind, episode_start, forecast_id, payload, status,
        sender, provider_id, error_text, idempotency_key, claimed_at, claim_token)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, 'claimed', 'test', null, null, $8, now(), $9)
     on conflict (user_id, place_id, kind, episode_start) do nothing
     returning id, idempotency_key, claim_token`,
    [
      randomUUID(),
      input.userId,
      input.placeId,
      input.kind,
      input.episodeStart,
      input.forecastId,
      JSON.stringify(input.payload),
      episodeIdempotencyKey(input.userId, input.placeId, input.kind, input.episodeStart),
      randomUUID(),
    ],
  );
  const created = openClaim(inserted[0]);
  if (created) return created;

  const retried = await sql.query<ClaimRow>(
    `update alert_push
        set forecast_id = $5,
            payload = $6::jsonb,
            status = 'claimed',
            claimed_at = now(),
            claim_token = $7,
            provider_id = null,
            error_text = null,
            updated_at = now()
      where user_id = $1
        and place_id = $2
        and kind = $3
        and episode_start = $4
        and (
          status = 'failed'
          or (
            status = 'claimed'
            and claimed_at <= now() - ($8::int * interval '1 millisecond')
          )
        )
      returning id, idempotency_key, claim_token`,
    [
      input.userId,
      input.placeId,
      input.kind,
      input.episodeStart,
      input.forecastId,
      JSON.stringify(input.payload),
      randomUUID(),
      CLAIM_STALE_MS,
    ],
  );
  return openClaim(retried[0]);
}

function sendClaimed(
  sender: PushSender,
  payload: PushPayload,
  idempotencyKey: string,
): ReturnType<PushSender["send"]> {
  const send = sender.send as (
    this: PushSender,
    payload: PushPayload,
    idempotencyKey: string,
  ) => ReturnType<PushSender["send"]>;
  return send.call(sender, payload, idempotencyKey);
}

async function markSent(
  sql: Queryable,
  id: string,
  providerId: string,
  claimToken: string,
): Promise<void> {
  const rows = await sql.query<AttemptRow>(
    `update alert_push
        set status = 'sent',
            provider_id = $2,
            error_text = null,
            claimed_at = null,
            claim_token = null,
            updated_at = now()
      where id = $1
        and status = 'claimed'
        and claim_token = $3
      returning id`,
    [id, providerId, claimToken],
  );
  if (!rows[0]?.id) {
    throw new V1RuleError("alert_push_already_sent", "This alert episode was already sent.", 409);
  }
}

/** Write the send error so a later run can claim the same row again. */
async function releaseClaim(
  sql: Queryable,
  id: string,
  claimToken: string,
  errorText: string,
): Promise<void> {
  const rows = await sql.query<AttemptRow>(
    `update alert_push
        set status = 'failed',
            provider_id = null,
            error_text = $2,
            claimed_at = null,
            claim_token = null,
            updated_at = now()
      where id = $1
        and status = 'claimed'
        and claim_token = $3
      returning id`,
    [id, errorText, claimToken],
  );
  if (!rows[0]?.id) {
    throw new V1RuleError("alert_push_already_sent", "This alert episode was already sent.", 409);
  }
}

/**
 * Read the place's alert episodes and send one test push for each new one.
 * `now` is the Pro clock. It defaults to the call time, not `asOf`.
 * Free and a locked place throw `NotEntitledError` and write nothing.
 * A send runs only after this call inserts the episode or takes a failed or stale claim.
 * `control.stopAfterClaim` leaves that claim open and does not send.
 */
export async function pushAlertEpisodes(
  sql: Queryable,
  placeId: string,
  asOf: string,
  timeZone: string,
  sender: PushSender,
  now: Date = new Date(),
  control?: AlertPushControl,
): Promise<AlertPushResult> {
  const asOfIso = parseUtcInstant(asOf, "asOf");
  const zone = parseTimeZone(timeZone);
  const id = requireId(placeId, "placeId");
  if (sender.name !== "test") {
    throw new V1RuleError(
      "push_sender_is_test_only",
      "Alert delivery uses the test sender. There is no APNs key and no paid push vendor.",
    );
  }
  const place = await loadPlace(sql, id);
  if (!place) throw new V1RuleError("place_not_found", "Saved place not found.", 404);
  await requireOpenPlace(sql, place.user_id, place.id, now);
  await requireProAlerts(sql, place.user_id, now);

  const body = await readAlerts(sql, place.user_id, place.id, asOfIso, zone);
  const official = await loadOfficial(sql, place.user_id, place.id, asOfIso);
  const sent: AlertPushAttempt[] = [];
  const failed: AlertPushAttempt[] = [];
  let skipped = 0;

  for (const alert of body.alerts) {
    if (!alert.fired || !alert.start) continue;
    if (await alreadySent(sql, place.user_id, place.id, alert.kind, alert.start)) {
      skipped += 1;
      continue;
    }
    const peak = await loadPeakForecast(sql, place.user_id, place.id, alert);
    const payload = buildPushPayload({
      placeId: place.id,
      placeName: place.name,
      issuedAt: iso(peak.issued_at),
      validFor: iso(peak.valid_for),
      forecast: {
        id: peak.id,
        source: peak.source,
        correctedAqi: Number(peak.corrected_aqi),
        horizon: peak.horizon,
        spatialScale: peak.spatial_scale,
        confidence: peak.confidence,
      },
      official,
    });
    assertPayloadSeparated(payload);
    const claim = await claimEpisode(sql, {
      userId: place.user_id,
      placeId: place.id,
      kind: alert.kind,
      episodeStart: alert.start,
      forecastId: peak.id,
      payload,
    });
    if (!claim) {
      skipped += 1;
      continue;
    }
    if (control?.stopAfterClaim) {
      throw new V1RuleError(
        "alert_push_claim_open",
        "The alert episode claim was left open before send.",
        409,
      );
    }
    let result: Awaited<ReturnType<PushSender["send"]>>;
    try {
      result = await sendClaimed(sender, payload, claim.idempotencyKey);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "";
      await releaseClaim(sql, claim.id, claim.claimToken, failText(message));
      throw error;
    }
    if (result.ok) await markSent(sql, claim.id, result.providerId, claim.claimToken);
    else await releaseClaim(sql, claim.id, claim.claimToken, failText(result.error));
    const attempt: AlertPushAttempt = {
      id: claim.id,
      kind: alert.kind,
      episodeStart: alert.start,
      status: result.ok ? "sent" : "failed",
      providerId: result.ok ? result.providerId : null,
      payload,
    };
    if (result.ok) sent.push(attempt);
    else failed.push(attempt);
  }

  return {
    placeId: place.id,
    userId: place.user_id,
    asOf: asOfIso,
    sent,
    failed,
    skipped,
  };
}
