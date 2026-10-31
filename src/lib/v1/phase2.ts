import { V1RuleError } from "./errors.ts";
import { DAY12_MS, classifyForecastLead } from "./rules.ts";
import type { Confidence, ForecastSource, Horizon, Queryable, SpatialScale } from "./types.ts";

/**
 * Phase 2 reads. The best window and the outlook use corrected forecast hours only.
 * An official AirNow row is not an input. There is no new table and no scheduler.
 */

const HOUR_MS = 3_600_000;
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * `Date` rolls impossible calendar days forward (2026-02-30 becomes March 2).
 * The UTC parts have to match the text that was sent.
 */
export function parseUtcInstant(value: string, field: string): string {
  const match = ISO_UTC.exec(value);
  if (!match) {
    throw new V1RuleError("invalid_time", `${field} must be a UTC timestamp.`);
  }
  const parsed = new Date(value);
  const fraction = match[7];
  const millis = fraction ? Number(fraction.padEnd(3, "0")) : 0;
  const matches =
    !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === Number(match[1]) &&
    parsed.getUTCMonth() + 1 === Number(match[2]) &&
    parsed.getUTCDate() === Number(match[3]) &&
    parsed.getUTCHours() === Number(match[4]) &&
    parsed.getUTCMinutes() === Number(match[5]) &&
    parsed.getUTCSeconds() === Number(match[6]) &&
    parsed.getUTCMilliseconds() === millis;
  if (!matches) {
    throw new V1RuleError("invalid_time", `${field} must be a UTC timestamp.`);
  }
  return parsed.toISOString();
}

/** Same names as the iOS air levels. 201–300 is `very`. */
export const AQI_BANDS = ["good", "moderate", "usg", "unhealthy", "very", "hazardous"] as const;
export type AqiBand = (typeof AQI_BANDS)[number];

const BAND_RANK: Record<AqiBand, number> = {
  good: 0,
  moderate: 1,
  usg: 2,
  unhealthy: 3,
  very: 4,
  hazardous: 5,
};

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
type WeekdayName = (typeof WEEKDAYS)[number];

export interface LatestHour {
  source: ForecastSource;
  issuedAt: string;
  validFor: string;
  horizon: Horizon;
  spatialScale: SpatialScale;
  confidence: Confidence;
  correctedAqi: number;
}

export interface OutdoorWindow {
  /** First stored hour in the run. */
  start: string;
  /** One hour after the last stored hour, so a single hour has a one-hour span. */
  end: string;
  peakCorrectedAqi: number;
  band: AqiBand;
  sources: ForecastSource[];
}

export interface BestWindowResponse {
  placeId: string;
  asOf: string;
  /** Inclusive end of the next 48 hours. Same length as `DAY12_MS`. */
  through: string;
  bestWindow: OutdoorWindow | "none";
}

export interface DaySummary {
  worstCorrectedAqi: number;
  typicalCorrectedAqi: number;
  band: AqiBand;
  confidence: "valley" | "low";
  spatialScale: "valley" | "regional";
  horizon: "day_1_2_valley" | "day_3_7_regional_low_confidence";
  label: "valley" | "regional and low-confidence";
}

export interface OutlookDay {
  date: string;
  weekday: WeekdayName;
  summary: DaySummary | "no data";
}

export interface OutlookResponse {
  placeId: string;
  timeZone: string;
  asOf: string;
  tomorrow: OutlookDay;
  weekend: {
    saturday: OutlookDay;
    sunday: OutlookDay;
  };
}

/** EPA bands: 0–50, 51–100, 101–150, 151–200, 201–300, 301 and up. */
export function aqiBand(aqi: number): AqiBand {
  if (aqi <= 50) return "good";
  if (aqi <= 100) return "moderate";
  if (aqi <= 150) return "usg";
  if (aqi <= 200) return "unhealthy";
  if (aqi <= 300) return "very";
  return "hazardous";
}

/** Omitted `asOf` is the request clock. A present value must be a real UTC instant. */
export function parseAsOf(value: string | null): string {
  if (value == null) return new Date().toISOString();
  return parseUtcInstant(value, "asOf");
}

/**
 * `saved_place` has no time zone column, and this slice adds no migration.
 * The caller passes the place's IANA zone.
 */
export function parseTimeZone(value: string | null): string {
  if (value == null || value.trim() === "") {
    throw new V1RuleError("invalid_time_zone", "timeZone is required and must be an IANA zone.");
  }
  const timeZone = value.trim();
  if (timeZone.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(timeZone)) {
    throw new V1RuleError("invalid_time_zone", "timeZone must be an IANA zone.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new V1RuleError("invalid_time_zone", "timeZone must be an IANA zone.");
  }
  return timeZone;
}

interface LocalDay {
  key: string;
  weekday: number;
}

function localDate(iso: string, timeZone: string): LocalDay {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = new Map(fmt.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  const weekday = parts.get("weekday");
  const index = weekday ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday) : -1;
  if (!year || !month || !day || index < 0) {
    throw new V1RuleError("invalid_time", "Stored timestamp is unreadable in that time zone.");
  }
  return { key: `${year}-${month}-${day}`, weekday: index };
}

function shiftDate(key: string, days: number): string {
  const [yearRaw, monthRaw, dayRaw] = key.split("-");
  const shifted = new Date(Date.UTC(Number(yearRaw), Number(monthRaw) - 1, Number(dayRaw) + days));
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

function weekdayName(key: string): WeekdayName {
  const [yearRaw, monthRaw, dayRaw] = key.split("-");
  const index = new Date(
    Date.UTC(Number(yearRaw), Number(monthRaw) - 1, Number(dayRaw)),
  ).getUTCDay();
  const name = WEEKDAYS[index];
  if (!name) throw new V1RuleError("invalid_time", "Calendar day is unreadable.");
  return name;
}

/** Median of the stored hours. An even count rounds the midpoint half up. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  const left = sorted[mid - 1] ?? 0;
  const right = sorted[mid] ?? 0;
  return Math.round((left + right) / 2);
}

function uniqueSources(hours: readonly LatestHour[]): ForecastSource[] {
  const sources: ForecastSource[] = [];
  for (const hour of hours) {
    if (!sources.includes(hour.source)) sources.push(hour.source);
  }
  return sources;
}

/**
 * Lowest corrected band, then the longest run of hours one hour apart.
 * Equal length keeps the earlier start. Hours outside `[asOf, asOf + 48h]` are out,
 * including one millisecond past 48 hours. The exact 48-hour instant stays in.
 */
export function bestWindowFromHours(
  hours: readonly LatestHour[],
  asOf: string,
): OutdoorWindow | "none" {
  const startMs = Date.parse(asOf);
  const endMs = startMs + DAY12_MS;
  const candidates = hours
    .filter((hour) => {
      const validMs = Date.parse(hour.validFor);
      return validMs >= startMs && validMs <= endMs;
    })
    .sort((a, b) => Date.parse(a.validFor) - Date.parse(b.validFor));
  if (candidates.length === 0) return "none";

  let lowest = BAND_RANK.hazardous;
  for (const hour of candidates) {
    const rank = BAND_RANK[aqiBand(hour.correctedAqi)];
    if (rank < lowest) lowest = rank;
  }
  const inBand = candidates.filter((hour) => BAND_RANK[aqiBand(hour.correctedAqi)] === lowest);

  let best: LatestHour[] = [];
  let run: LatestHour[] = [];
  const consider = () => {
    if (run.length > best.length) best = run;
  };
  for (const hour of inBand) {
    const prev = run[run.length - 1];
    if (prev && Date.parse(hour.validFor) - Date.parse(prev.validFor) !== HOUR_MS) {
      consider();
      run = [hour];
      continue;
    }
    run = [...run, hour];
  }
  consider();

  const first = best[0];
  const last = best[best.length - 1];
  if (!first || !last) return "none";
  const peakCorrectedAqi = best.reduce((max, hour) => Math.max(max, hour.correctedAqi), 0);
  return {
    start: first.validFor,
    end: new Date(Date.parse(last.validFor) + HOUR_MS).toISOString(),
    peakCorrectedAqi,
    band: aqiBand(peakCorrectedAqi),
    sources: uniqueSources(best),
  };
}

function summarizeDay(key: string, hours: readonly LatestHour[]): OutlookDay {
  const weekday = weekdayName(key);
  if (hours.length === 0) return { date: key, weekday, summary: "no data" };
  const values = hours.map((hour) => hour.correctedAqi);
  const worstCorrectedAqi = Math.max(...values);
  // Any hour past the 48-hour lead makes the day regional and low-confidence,
  // including a stored NOAA air-quality row whose own confidence is `model`.
  const pastValley = hours.some(
    (hour) => classifyForecastLead(hour.issuedAt, hour.validFor) !== "day_1_2",
  );
  return {
    date: key,
    weekday,
    summary: {
      worstCorrectedAqi,
      typicalCorrectedAqi: median(values),
      band: aqiBand(worstCorrectedAqi),
      confidence: pastValley ? "low" : "valley",
      spatialScale: pastValley ? "regional" : "valley",
      horizon: pastValley ? "day_3_7_regional_low_confidence" : "day_1_2_valley",
      label: pastValley ? "regional and low-confidence" : "valley",
    },
  };
}

/**
 * Tomorrow, and Saturday plus Sunday of this weekend, in `timeZone`.
 * On Saturday or Sunday the remaining weekend day stays in this weekend.
 * A local day with no stored hour is "no data". Missing hours are not filled in.
 */
export function outlookFromHours(
  hours: readonly LatestHour[],
  asOf: string,
  timeZone: string,
): Omit<OutlookResponse, "placeId"> {
  const today = localDate(asOf, timeZone);
  const tomorrowKey = shiftDate(today.key, 1);
  const untilSaturday = today.weekday === 0 ? -1 : 6 - today.weekday;
  const saturdayKey = shiftDate(today.key, untilSaturday);
  const sundayKey = shiftDate(saturdayKey, 1);
  const byDay = new Map<string, LatestHour[]>();
  for (const hour of hours) {
    const key = localDate(hour.validFor, timeZone).key;
    const list = byDay.get(key);
    if (list) list.push(hour);
    else byDay.set(key, [hour]);
  }
  return {
    timeZone,
    asOf,
    tomorrow: summarizeDay(tomorrowKey, byDay.get(tomorrowKey) ?? []),
    weekend: {
      saturday: summarizeDay(saturdayKey, byDay.get(saturdayKey) ?? []),
      sunday: summarizeDay(sundayKey, byDay.get(sundayKey) ?? []),
    },
  };
}

interface HourRow {
  source: ForecastSource;
  issued_at: string | Date;
  valid_for: string | Date;
  horizon: Horizon;
  spatial_scale: SpatialScale;
  confidence: Confidence;
  corrected_aqi: number;
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

/** Latest issue for each valid hour. The same issue instant keeps the later insert. */
export async function loadLatestHours(
  sql: Queryable,
  userId: string,
  placeId: string,
): Promise<LatestHour[]> {
  const rows = await sql.query<HourRow>(
    `select distinct on (valid_for)
            source, issued_at, valid_for, horizon, spatial_scale, confidence, corrected_aqi
       from forecast_issued
      where place_id = $1 and user_id = $2
      order by valid_for asc, issued_at desc, created_at desc, id desc`,
    [placeId, userId],
  );
  return rows.map((row) => ({
    source: row.source,
    issuedAt: iso(row.issued_at),
    validFor: iso(row.valid_for),
    horizon: row.horizon,
    spatialScale: row.spatial_scale,
    confidence: row.confidence,
    correctedAqi: Number(row.corrected_aqi),
  }));
}

export async function readBestWindow(
  sql: Queryable,
  userId: string,
  placeId: string,
  asOf: string,
): Promise<BestWindowResponse> {
  await requireOwnedPlace(sql, userId, placeId);
  const hours = await loadLatestHours(sql, userId, placeId);
  const through = new Date(Date.parse(asOf) + DAY12_MS).toISOString();
  return {
    placeId,
    asOf,
    through,
    bestWindow: bestWindowFromHours(hours, asOf),
  };
}

export async function readOutlook(
  sql: Queryable,
  userId: string,
  placeId: string,
  asOf: string,
  timeZone: string,
): Promise<OutlookResponse> {
  await requireOwnedPlace(sql, userId, placeId);
  const hours = await loadLatestHours(sql, userId, placeId);
  return { placeId, ...outlookFromHours(hours, asOf, timeZone) };
}
