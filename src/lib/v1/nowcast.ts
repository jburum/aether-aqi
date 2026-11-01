import { V1RuleError } from "./errors.ts";
import { pm25TenthsToAqi } from "./pm25-aqi.ts";

/**
 * EPA PM2.5 NowCast. Pure: no clock and no I/O.
 * Ingest does not call this. Stored model hours still use the daily breakpoints.
 */

/** Newest hour is index 0. Hours after this are outside the NowCast window. */
const NOWCAST_HOURS = 12;
const RECENT_HOURS = 3;
const RECENT_REQUIRED = 2;
/** Lower bound of the EPA weight factor (minimum divided by maximum). */
const WEIGHT_FLOOR = 0.5;

function readHour(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new V1RuleError(
      "pm25_nowcast",
      "PM2.5 hours must be non-negative µg/m³, or null when that hour is missing.",
    );
  }
  return value;
}

/**
 * Truncated NowCast tenths of a µg/m³, or null when EPA would not report one.
 * A null hour keeps its age. The weight is min/max, and it is never below 0.5.
 */
function nowcastTenths(hoursNewestFirst: readonly (number | null)[]): number | null {
  if (!Array.isArray(hoursNewestFirst)) {
    throw new V1RuleError("pm25_nowcast", "PM2.5 hours must be a list, newest first.");
  }

  const hours: (number | null)[] = [];
  const limit = Math.min(hoursNewestFirst.length, NOWCAST_HOURS);
  for (let age = 0; age < limit; age += 1) {
    hours.push(readHour(hoursNewestFirst[age]));
  }

  let recent = 0;
  for (let age = 0; age < RECENT_HOURS; age += 1) {
    if (hours[age] != null) recent += 1;
  }
  if (recent < RECENT_REQUIRED) return null;

  let min = Infinity;
  let max = 0;
  for (const value of hours) {
    if (value == null) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!(max > 0)) return 0;

  const weight = min < max * WEIGHT_FLOOR ? WEIGHT_FLOOR : min / max;
  let weighted = 0;
  let weights = 0;
  for (let age = 0; age < hours.length; age += 1) {
    const value = hours[age];
    if (value == null) continue;
    const factor = weight ** age;
    weighted += value * factor;
    weights += factor;
  }

  // TRUNC to 0.1 µg/m³. The nudge only cancels a binary residue sitting on a tenth.
  return Math.floor((weighted / weights) * 10 + 1e-9);
}

/**
 * NowCast concentration in µg/m³, truncated to 0.1, or null.
 *
 * `hoursNewestFirst` is up to the last 12 hourly PM2.5 values. Null is a missing
 * hour and keeps its place, so the next hour does not move up. Hours past the
 * 12th are ignored. Returns null when 2 of the 3 newest hours are missing.
 * The weight factor is the minimum divided by the maximum, floored at 0.5.
 */
export function nowcastPm25(hoursNewestFirst: readonly (number | null)[]): number | null {
  const tenths = nowcastTenths(hoursNewestFirst);
  if (tenths == null) return null;
  return tenths / 10;
}

/** AQI for `nowcastPm25`, through the 2024 breakpoints in `pm25-aqi.ts`. */
export function nowcastPm25Aqi(hoursNewestFirst: readonly (number | null)[]): number | null {
  const tenths = nowcastTenths(hoursNewestFirst);
  if (tenths == null) return null;
  return pm25TenthsToAqi(tenths);
}
