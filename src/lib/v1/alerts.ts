import { randomUUID } from "node:crypto";

import { V1RuleError } from "./errors.ts";
import { parseUtcInstant } from "./phase2.ts";
import { DAY12_MS, DAY7_MS, classifyForecastLead, requireId } from "./rules.ts";
import type { Confidence, ForecastSource, Queryable } from "./types.ts";

/**
 * Phase 2 alert rules. Smoke, ozone, and winter inversions.
 * Days 1-2 can fire as an alert. Days 3-7 are a low-confidence heads up.
 * Three forecast hours start an episode. Three quiet hours end it.
 * One hour in the middle does not flap the alert on or off.
 */

const HOUR_MS = 3_600_000;

/** Corrected AQI that starts a smoke or ozone hour. USG, 101. */
export const ALERT_AQI_ON = 101;
/** Day 1-2 hour that AirNow can promote when the forecast is already moderate. */
export const ALERT_AQI_PROMOTE = 51;
/** High severity starts here. Heads-up episodes never use it. */
export const ALERT_AQI_HIGH = 151;
/** Consecutive forecast hours required to start an episode. */
export const ALERT_ON_HOURS = 3;
/** Consecutive quiet hours required to end one. */
export const ALERT_OFF_HOURS = 3;
/** T(80 m) − T(2 m), Kelvin. At or above this the layer is inverted. */
export const INVERSION_LAPSE_K = 1;
/** 10 m wind at or under this, in m/s, counts as stagnant. */
export const INVERSION_WIND_MS = 2;
/** Local months. November through February. */
export const WINTER_MONTHS: readonly number[] = [11, 12, 1, 2];
/** Local months. May through September. */
export const OZONE_MONTHS: readonly number[] = [5, 6, 7, 8, 9];

const TEMP_MIN_K = 180;
const TEMP_MAX_K = 330;

export const ALERT_KINDS = ["smoke", "inversion", "ozone"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_SEVERITIES = ["heads_up", "elevated", "high"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export type AlertSource = ForecastSource | "airnow" | "noaa_hrrr";

export interface AlertForecastHour {
  source: ForecastSource;
  issuedAt: string;
  validFor: string;
  confidence: Confidence;
  correctedAqi: number;
  pollutant: string | null;
}

export interface AlertOfficial {
  observedAt: string;
  officialAqi: number;
  /** `unknown` when the stored AirNow row has no pollutant. */
  parameter: "PM2.5" | "O3" | "unknown";
}

export interface StabilitySample {
  issuedAt: string;
  validFor: string;
  /** Kelvin. HRRR temperature at 2 m. */
  tmp2mK: number;
  /** Kelvin. HRRR temperature at 80 m. */
  tmp80mK: number;
  /** m/s. Speed from the 10 m wind components. */
  wind10mMs: number;
}

export interface AlertDecision {
  kind: AlertKind;
  fired: boolean;
  status: "active" | "upcoming" | "quiet";
  start: string | null;
  end: string | null;
  severity: AlertSeverity | null;
  source: AlertSource | null;
  confidence: Confidence | null;
  reason: string;
}

export interface AlertsResponse {
  placeId: string;
  asOf: string;
  timeZone: string;
  /** Inclusive end of the launch window. Same length as `DAY7_MS`. */
  through: string;
  alerts: AlertDecision[];
}

interface Driver {
  aqi: number;
  source: AlertSource;
  airNowCited: boolean;
  lapseK: number | null;
  wind10mMs: number | null;
}

interface HourPoint {
  validFor: string;
  normal: Driver | null;
  headsUp: Driver | null;
}

interface Episode {
  start: string;
  end: string;
  peakAqi: number;
  source: AlertSource;
  channel: "normal" | "heads_up";
  airNowCited: boolean;
  lapseK: number | null;
  wind10mMs: number | null;
}

interface Timed {
  issuedAt: string;
  validFor: string;
}

function pollutantKey(value: string | null): string {
  if (!value) return "";
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** PM2.5, or an unlabeled NOAA smoke hour. Ozone labels are not PM. */
function isPm(hour: AlertForecastHour): boolean {
  const key = pollutantKey(hour.pollutant);
  if (key === "pm25") return true;
  return hour.source === "noaa_smoke" && key === "";
}

function isOzonePollutant(hour: AlertForecastHour): boolean {
  const key = pollutantKey(hour.pollutant);
  return key === "o3" || key === "ozone";
}

function latestByValidFor<T extends Timed>(rows: readonly T[]): T[] {
  const map = new Map<string, T>();
  for (const row of rows) {
    const prev = map.get(row.validFor);
    if (!prev || Date.parse(row.issuedAt) >= Date.parse(prev.issuedAt)) {
      map.set(row.validFor, row);
    }
  }
  return [...map.values()];
}

function localMonth(iso: string, timeZone: string): number {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) {
    throw new V1RuleError("invalid_time", "Stored timestamp is unreadable.");
  }
  let month = "";
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric" });
    month = fmt.format(instant);
  } catch {
    throw new V1RuleError("invalid_time_zone", "timeZone must be an IANA zone.");
  }
  const value = Number(month);
  if (!Number.isInteger(value) || value < 1 || value > 12) {
    throw new V1RuleError("invalid_time", "Stored timestamp is unreadable in that time zone.");
  }
  return value;
}

function emptyPoint(validFor: string): HourPoint {
  return { validFor, normal: null, headsUp: null };
}

function inOfficialWindow(official: AlertOfficial, validFor: string): boolean {
  const valid = Date.parse(validFor);
  const observed = Date.parse(official.observedAt);
  if (!Number.isFinite(valid) || !Number.isFinite(observed)) return false;
  return valid >= observed - HOUR_MS && valid <= observed + 6 * HOUR_MS;
}

function citesOfficial(
  official: AlertOfficial | null,
  hour: AlertForecastHour,
  parameter: "PM2.5" | "O3",
): boolean {
  if (!official || official.parameter !== parameter) return false;
  if (official.officialAqi < ALERT_AQI_ON) return false;
  return inOfficialWindow(official, hour.validFor);
}

/**
 * A day 1-2 hour already at moderate can turn on when AirNow for that
 * pollutant is at or above 101. Days 3-7 are not promoted.
 */
function promotedByOfficial(
  official: AlertOfficial | null,
  hour: AlertForecastHour,
  parameter: "PM2.5" | "O3",
  lead: "day_1_2" | "day_3_7",
): boolean {
  if (lead !== "day_1_2") return false;
  if (!citesOfficial(official, hour, parameter)) return false;
  return hour.correctedAqi >= ALERT_AQI_PROMOTE;
}

function channelForLead(lead: "day_1_2" | "day_3_7"): "normal" | "headsUp" {
  return lead === "day_1_2" ? "normal" : "headsUp";
}

function pointFor(validFor: string, channel: "normal" | "headsUp", driver: Driver): HourPoint {
  return channel === "normal"
    ? { validFor, normal: driver, headsUp: null }
    : { validFor, normal: null, headsUp: driver };
}

function smokePoints(
  hours: readonly AlertForecastHour[],
  official: AlertOfficial | null,
): HourPoint[] {
  const points: HourPoint[] = [];
  for (const hour of latestByValidFor(hours)) {
    if (!isPm(hour)) continue;
    const lead = classifyForecastLead(hour.issuedAt, hour.validFor);
    if (lead === "outside") continue;
    const forecastOn = hour.correctedAqi >= ALERT_AQI_ON;
    const promoted = promotedByOfficial(official, hour, "PM2.5", lead);
    if (!forecastOn && !promoted) {
      points.push(emptyPoint(hour.validFor));
      continue;
    }
    const cited = citesOfficial(official, hour, "PM2.5");
    const aqi =
      promoted && official ? Math.max(hour.correctedAqi, official.officialAqi) : hour.correctedAqi;
    const driver: Driver = {
      aqi,
      source: forecastOn ? hour.source : "airnow",
      airNowCited: cited,
      lapseK: null,
      wind10mMs: null,
    };
    points.push(pointFor(hour.validFor, channelForLead(lead), driver));
  }
  return points;
}

function ozonePoints(
  hours: readonly AlertForecastHour[],
  official: AlertOfficial | null,
  timeZone: string,
): HourPoint[] {
  const points: HourPoint[] = [];
  for (const hour of latestByValidFor(hours)) {
    if (!isOzonePollutant(hour)) continue;
    const lead = classifyForecastLead(hour.issuedAt, hour.validFor);
    if (lead === "outside") continue;
    const summer = OZONE_MONTHS.includes(localMonth(hour.validFor, timeZone));
    const forecastOn = hour.correctedAqi >= ALERT_AQI_ON;
    const promoted = summer && promotedByOfficial(official, hour, "O3", lead);
    if (!summer || (!forecastOn && !promoted)) {
      points.push(emptyPoint(hour.validFor));
      continue;
    }
    const cited = citesOfficial(official, hour, "O3");
    const aqi =
      promoted && official ? Math.max(hour.correctedAqi, official.officialAqi) : hour.correctedAqi;
    const driver: Driver = {
      aqi,
      source: forecastOn ? hour.source : "airnow",
      airNowCited: cited,
      lapseK: null,
      wind10mMs: null,
    };
    points.push(pointFor(hour.validFor, channelForLead(lead), driver));
  }
  return points;
}

function inversionPoints(
  hours: readonly AlertForecastHour[],
  stability: readonly StabilitySample[],
  timeZone: string,
): HourPoint[] {
  const pm = new Map<string, AlertForecastHour>();
  for (const hour of latestByValidFor(hours)) {
    if (isPm(hour)) pm.set(hour.validFor, hour);
  }
  const points: HourPoint[] = [];
  for (const sample of latestByValidFor(stability)) {
    const forecast = pm.get(sample.validFor);
    const lapse = sample.tmp80mK - sample.tmp2mK;
    const winter = WINTER_MONTHS.includes(localMonth(sample.validFor, timeZone));
    const lead = forecast ? classifyForecastLead(forecast.issuedAt, forecast.validFor) : "outside";
    if (
      !forecast ||
      !winter ||
      lead === "outside" ||
      lapse < INVERSION_LAPSE_K ||
      sample.wind10mMs > INVERSION_WIND_MS ||
      forecast.correctedAqi < ALERT_AQI_ON
    ) {
      points.push(emptyPoint(sample.validFor));
      continue;
    }
    const driver: Driver = {
      aqi: forecast.correctedAqi,
      source: "noaa_hrrr",
      airNowCited: false,
      lapseK: lapse,
      wind10mMs: sample.wind10mMs,
    };
    points.push(pointFor(sample.validFor, channelForLead(lead), driver));
  }
  return points;
}

function dedupe(points: readonly HourPoint[]): HourPoint[] {
  const sorted = [...points].sort((a, b) => Date.parse(a.validFor) - Date.parse(b.validFor));
  const merged: HourPoint[] = [];
  for (const point of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.validFor === point.validFor) {
      prev.normal = point.normal ?? prev.normal;
      prev.headsUp = point.headsUp ?? prev.headsUp;
      continue;
    }
    merged.push({ ...point });
  }
  return merged;
}

interface OpenEpisode {
  start: string;
  peakAqi: number;
  source: AlertSource;
  airNowCited: boolean;
  lapseK: number | null;
  wind10mMs: number | null;
  lastMs: number;
}

function considerPeak(open: OpenEpisode, driver: Driver): void {
  if (driver.airNowCited) open.airNowCited = true;
  if (driver.aqi <= open.peakAqi) return;
  open.peakAqi = driver.aqi;
  open.source = driver.source;
  open.lapseK = driver.lapseK;
  open.wind10mMs = driver.wind10mMs;
}

function finish(open: OpenEpisode, end: string, channel: Episode["channel"]): Episode {
  return {
    start: open.start,
    end,
    peakAqi: open.peakAqi,
    source: open.source,
    channel,
    airNowCited: open.airNowCited,
    lapseK: open.lapseK,
    wind10mMs: open.wind10mMs,
  };
}

/** Quiet gaps of a whole hour count. Anything else ends the episode. */
function missingQuietHours(previousMs: number, nextMs: number): number {
  const delta = nextMs - previousMs;
  const steps = Math.round(delta / HOUR_MS);
  if (Math.abs(delta - steps * HOUR_MS) >= 1) return ALERT_OFF_HOURS;
  if (steps > 1) return steps - 1;
  return 0;
}

function runChannel(
  points: readonly HourPoint[],
  channel: "normal" | "headsUp",
  asOfMs: number,
  throughMs: number,
): Episode | null {
  const rows = dedupe(points);
  const episodes: Episode[] = [];
  const episodeChannel: Episode["channel"] = channel === "normal" ? "normal" : "heads_up";
  let offStreak = 0;
  let offStartMs = 0;
  let open: OpenEpisode | null = null;
  let recent: { validFor: string; driver: Driver }[] = [];
  let previousMs: number | null = null;

  const close = (endMs: number) => {
    if (!open) return;
    episodes.push(finish(open, new Date(endMs).toISOString(), episodeChannel));
    open = null;
    offStreak = 0;
    recent = [];
  };

  const noteQuiet = (atMs: number, hours: number) => {
    if (!open) {
      recent = [];
      offStreak = 0;
      return;
    }
    if (offStreak === 0) offStartMs = atMs;
    offStreak += hours;
    if (offStreak >= ALERT_OFF_HOURS) close(offStartMs);
  };

  for (const point of rows) {
    const ms = Date.parse(point.validFor);
    if (!Number.isFinite(ms)) continue;
    if (previousMs != null) {
      const missing = missingQuietHours(previousMs, ms);
      if (missing > 0) noteQuiet(previousMs + HOUR_MS, missing);
    }
    previousMs = ms;
    const driver = channel === "normal" ? point.normal : point.headsUp;
    if (!driver) {
      noteQuiet(ms, 1);
      if (open) open.lastMs = ms;
      continue;
    }
    offStreak = 0;
    if (!open) {
      recent.push({ validFor: point.validFor, driver });
      if (recent.length < ALERT_ON_HOURS) continue;
      const first = recent[0];
      if (!first) continue;
      open = {
        start: first.validFor,
        peakAqi: -1,
        source: first.driver.source,
        airNowCited: false,
        lapseK: null,
        wind10mMs: null,
        lastMs: ms,
      };
      for (const item of recent) considerPeak(open, item.driver);
      continue;
    }
    open.lastMs = ms;
    considerPeak(open, driver);
  }
  if (open) close(open.lastMs + HOUR_MS);

  const relevant = episodes.filter((episode) => {
    const start = Date.parse(episode.start);
    const end = Date.parse(episode.end);
    return end > asOfMs && start <= throughMs;
  });
  const active = relevant.find((episode) => Date.parse(episode.start) <= asOfMs);
  if (active) return active;
  relevant.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return relevant[0] ?? null;
}

function prefer(normal: Episode | null, headsUp: Episode | null, asOfMs: number): Episode | null {
  if (!normal) return headsUp;
  if (!headsUp) return normal;
  const normalActive = Date.parse(normal.start) <= asOfMs;
  const headsActive = Date.parse(headsUp.start) <= asOfMs;
  if (normalActive !== headsActive) return normalActive ? normal : headsUp;
  if (normalActive && headsActive) return normal;
  return Date.parse(normal.start) <= Date.parse(headsUp.start) ? normal : headsUp;
}

function spanHours(episode: Episode): number {
  return Math.round((Date.parse(episode.end) - Date.parse(episode.start)) / HOUR_MS);
}

function formatTenths(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

function quietDecision(kind: AlertKind, reason: string): AlertDecision {
  return {
    kind,
    fired: false,
    status: "quiet",
    start: null,
    end: null,
    severity: null,
    source: null,
    confidence: null,
    reason,
  };
}

function confidenceFor(kind: AlertKind, episode: Episode): Confidence {
  if (episode.channel === "heads_up") return "low";
  if (kind === "ozone" && episode.source !== "airnow") return "model";
  return "valley";
}

function decisionFrom(
  kind: AlertKind,
  points: readonly HourPoint[],
  asOf: string,
  quietReason: string,
  describe: (episode: Episode) => string,
): AlertDecision {
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) {
    throw new V1RuleError("invalid_time", "asOf must be a UTC timestamp.");
  }
  const throughMs = asOfMs + DAY7_MS;
  const chosen = prefer(
    runChannel(points, "normal", asOfMs, throughMs),
    runChannel(points, "headsUp", asOfMs, throughMs),
    asOfMs,
  );
  if (!chosen) return quietDecision(kind, quietReason);
  const severity: AlertSeverity =
    chosen.channel === "heads_up"
      ? "heads_up"
      : chosen.peakAqi >= ALERT_AQI_HIGH
        ? "high"
        : "elevated";
  return {
    kind,
    fired: true,
    status: Date.parse(chosen.start) <= asOfMs ? "active" : "upcoming",
    start: chosen.start,
    end: chosen.end,
    severity,
    source: chosen.source,
    confidence: confidenceFor(kind, chosen),
    reason: describe(chosen),
  };
}

const SMOKE_QUIET =
  "No smoke alert. The stored forecast never holds PM2.5 at or above 101 for 3 hours.";
const OZONE_QUIET =
  "No ozone alert. Summer ozone needs corrected AQI at or above 101 for 3 hours in May through September.";
const INVERSION_QUIET =
  "No inversion alert. A winter inversion needs the 80 m temperature at least 1 K warmer than 2 m, wind at or under 2 m/s, and PM2.5 at or above 101 for 3 hours.";

function smokePhrase(source: AlertSource): string {
  if (source === "noaa_smoke") return "the NOAA smoke model";
  if (source === "noaa_aqf") return "NOAA's air quality forecast";
  if (source === "airnow") return "the latest AirNow PM2.5 reading";
  return "the regional forecast";
}

function smokeReason(episode: Episode, official: AlertOfficial | null): string {
  const hours = spanHours(episode);
  if (episode.channel === "heads_up") {
    return `Heads up only: ${smokePhrase(episode.source)} has PM2.5 corrected AQI ${episode.peakAqi} on days 3-7, low confidence, across ${hours} hours.`;
  }
  if (episode.source === "airnow") {
    return `Smoke alert from the latest AirNow PM2.5 reading: AQI ${episode.peakAqi}, valley confidence, across ${hours} hours.`;
  }
  const base = `Smoke alert from ${smokePhrase(episode.source)}: corrected AQI peaks at ${episode.peakAqi}, valley confidence, across ${hours} hours.`;
  if (episode.airNowCited && official?.parameter === "PM2.5") {
    return `${base} AirNow PM2.5 reads ${official.officialAqi}.`;
  }
  return base;
}

function ozoneReason(episode: Episode, official: AlertOfficial | null): string {
  const hours = spanHours(episode);
  if (episode.channel === "heads_up") {
    return `Heads up only: NOAA's air quality forecast has ozone corrected AQI ${episode.peakAqi} on days 3-7, low confidence, across ${hours} hours.`;
  }
  if (episode.source === "airnow") {
    return `Ozone alert from the latest AirNow ozone reading: AQI ${episode.peakAqi}, valley confidence, across ${hours} hours.`;
  }
  const base = `Ozone alert from NOAA's air quality forecast: corrected AQI peaks at ${episode.peakAqi}, model confidence, across ${hours} hours.`;
  if (episode.airNowCited && official?.parameter === "O3") {
    return `${base} AirNow ozone reads ${official.officialAqi}.`;
  }
  return base;
}

function inversionReason(episode: Episode): string {
  const hours = spanHours(episode);
  const lapse = formatTenths(episode.lapseK ?? 0);
  const wind = formatTenths(episode.wind10mMs ?? 0);
  if (episode.channel === "heads_up") {
    return `Heads up only: winter inversion on days 3-7, low confidence, across ${hours} hours. 80 m is ${lapse} K warmer than 2 m, wind is ${wind} m/s, and PM2.5 corrected AQI peaks at ${episode.peakAqi}.`;
  }
  return `Winter inversion across ${hours} hours: 80 m is ${lapse} K warmer than 2 m, wind is ${wind} m/s, and PM2.5 corrected AQI peaks at ${episode.peakAqi}.`;
}

export function smokeRule(input: {
  hours: readonly AlertForecastHour[];
  official: AlertOfficial | null;
  asOf: string;
}): AlertDecision {
  return decisionFrom(
    "smoke",
    smokePoints(input.hours, input.official),
    input.asOf,
    SMOKE_QUIET,
    (episode) => smokeReason(episode, input.official),
  );
}

export function ozoneRule(input: {
  hours: readonly AlertForecastHour[];
  official: AlertOfficial | null;
  asOf: string;
  timeZone: string;
}): AlertDecision {
  return decisionFrom(
    "ozone",
    ozonePoints(input.hours, input.official, input.timeZone),
    input.asOf,
    OZONE_QUIET,
    (episode) => ozoneReason(episode, input.official),
  );
}

export function inversionRule(input: {
  hours: readonly AlertForecastHour[];
  stability: readonly StabilitySample[];
  asOf: string;
  timeZone: string;
}): AlertDecision {
  return decisionFrom(
    "inversion",
    inversionPoints(input.hours, input.stability, input.timeZone),
    input.asOf,
    INVERSION_QUIET,
    inversionReason,
  );
}

function kelvinOk(value: number): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= TEMP_MIN_K &&
    value <= TEMP_MAX_K
  );
}

export async function recordStability(
  sql: Queryable,
  userId: string,
  body: StabilitySample & { placeId: string },
): Promise<StabilitySample & { placeId: string }> {
  const placeId = requireId(body.placeId, "placeId");
  const issuedAt = parseUtcInstant(body.issuedAt, "issuedAt");
  const validFor = parseUtcInstant(body.validFor, "validFor");
  const lead = Date.parse(validFor) - Date.parse(issuedAt);
  if (!Number.isFinite(lead) || lead < 0 || lead > DAY12_MS) {
    throw new V1RuleError(
      "outside_launch_window",
      "HRRR stability covers lead hours 0 through 48.",
    );
  }
  if (!kelvinOk(body.tmp2mK) || !kelvinOk(body.tmp80mK)) {
    throw new V1RuleError("invalid_field", "HRRR temperatures must be Kelvin between 180 and 330.");
  }
  if (
    typeof body.wind10mMs !== "number" ||
    !Number.isFinite(body.wind10mMs) ||
    body.wind10mMs < 0 ||
    body.wind10mMs > 100
  ) {
    throw new V1RuleError("invalid_field", "10 m wind must be a speed from 0 to 100 m/s.");
  }
  const found = await sql.query<{ id: string }>(
    "select id from saved_place where id = $1 and user_id = $2",
    [placeId, userId],
  );
  if (!found[0]) throw new V1RuleError("place_not_found", "Saved place not found.", 404);
  try {
    await sql.query(
      `insert into stability_issued
         (id, place_id, user_id, source, issued_at, valid_for, tmp_2m_k, tmp_80m_k, wind_10m_ms)
       values ($1, $2, $3, 'noaa_hrrr', $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        placeId,
        userId,
        issuedAt,
        validFor,
        body.tmp2mK,
        body.tmp80mK,
        body.wind10mMs,
      ],
    );
  } catch (err) {
    if (err instanceof V1RuleError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (/duplicate key|stability_issue_unique/i.test(message)) {
      throw new V1RuleError(
        "stability_already_recorded",
        "HRRR stability for this place, issue time, and hour is already stored.",
        409,
      );
    }
    throw err instanceof Error ? err : new Error(message);
  }
  return {
    placeId,
    issuedAt,
    validFor,
    tmp2mK: body.tmp2mK,
    tmp80mK: body.tmp80mK,
    wind10mMs: body.wind10mMs,
  };
}

interface ForecastAlertRow {
  source: ForecastSource;
  issued_at: string | Date;
  valid_for: string | Date;
  confidence: Confidence;
  corrected_aqi: number;
  pollutant: string | null;
}

interface StabilityRow {
  issued_at: string | Date;
  valid_for: string | Date;
  tmp_2m_k: number;
  tmp_80m_k: number;
  wind_10m_ms: number;
}

interface OfficialAlertRow {
  observed_at: string | Date;
  official_aqi: number;
}

function iso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new V1RuleError("invalid_time", "Stored timestamp is unreadable.");
  }
  return parsed.toISOString();
}

async function requireOwnedPlace(sql: Queryable, userId: string, placeId: string): Promise<void> {
  const found = await sql.query<{ id: string }>(
    "select id from saved_place where id = $1 and user_id = $2",
    [placeId, userId],
  );
  if (!found[0]) throw new V1RuleError("place_not_found", "Saved place not found.", 404);
}

async function loadForecastHours(
  sql: Queryable,
  userId: string,
  placeId: string,
): Promise<AlertForecastHour[]> {
  const rows = await sql.query<ForecastAlertRow>(
    `select distinct on (valid_for)
            source, issued_at, valid_for, confidence, corrected_aqi, pollutant
       from forecast_issued
      where place_id = $1 and user_id = $2
      order by valid_for asc, issued_at desc, created_at desc, id desc`,
    [placeId, userId],
  );
  return rows.map((row) => ({
    source: row.source,
    issuedAt: iso(row.issued_at),
    validFor: iso(row.valid_for),
    confidence: row.confidence,
    correctedAqi: Number(row.corrected_aqi),
    pollutant: row.pollutant,
  }));
}

async function loadStability(
  sql: Queryable,
  userId: string,
  placeId: string,
): Promise<StabilitySample[]> {
  const rows = await sql.query<StabilityRow>(
    `select distinct on (valid_for)
            issued_at, valid_for, tmp_2m_k, tmp_80m_k, wind_10m_ms
       from stability_issued
      where place_id = $1 and user_id = $2
      order by valid_for asc, issued_at desc, created_at desc, id desc`,
    [placeId, userId],
  );
  return rows.map((row) => ({
    issuedAt: iso(row.issued_at),
    validFor: iso(row.valid_for),
    tmp2mK: Number(row.tmp_2m_k),
    tmp80mK: Number(row.tmp_80m_k),
    wind10mMs: Number(row.wind_10m_ms),
  }));
}

async function loadLatestOfficial(
  sql: Queryable,
  userId: string,
  placeId: string,
): Promise<AlertOfficial | null> {
  const rows = await sql.query<OfficialAlertRow>(
    `select observed_at, official_aqi
       from official_reading
      where place_id = $1 and user_id = $2
      order by observed_at desc, created_at desc, id desc
      limit 1`,
    [placeId, userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    observedAt: iso(row.observed_at),
    officialAqi: Number(row.official_aqi),
    parameter: "unknown",
  };
}

/** Active and upcoming alerts for one saved place. Quiet rules are left out. */
export async function readAlerts(
  sql: Queryable,
  userId: string,
  placeId: string,
  asOf: string,
  timeZone: string,
): Promise<AlertsResponse> {
  await requireOwnedPlace(sql, userId, placeId);
  const hours = await loadForecastHours(sql, userId, placeId);
  const stability = await loadStability(sql, userId, placeId);
  const official = await loadLatestOfficial(sql, userId, placeId);
  const decisions = [
    smokeRule({ hours, official, asOf }),
    inversionRule({ hours, stability, asOf, timeZone }),
    ozoneRule({ hours, official, asOf, timeZone }),
  ];
  return {
    placeId,
    asOf,
    timeZone,
    through: new Date(Date.parse(asOf) + DAY7_MS).toISOString(),
    alerts: decisions.filter((decision) => decision.fired),
  };
}
