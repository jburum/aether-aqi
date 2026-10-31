import { V1RuleError } from "./errors.ts";

/**
 * US EPA PM2.5 breakpoints revised in 2024 (Good tops out at 9.0 µg/m³).
 * Concentrations are tenths of a µg/m³, which is the 1-decimal truncation
 * the AQI formula requires. This is for NOAA model concentrations only.
 * An official AirNow AQI is never passed through here.
 */
const PM25_TENTH_BANDS = [
  { aqiLo: 0, aqiHi: 50, lo: 0, hi: 90 },
  { aqiLo: 51, aqiHi: 100, lo: 91, hi: 354 },
  { aqiLo: 101, aqiHi: 150, lo: 355, hi: 554 },
  { aqiLo: 151, aqiHi: 200, lo: 555, hi: 1254 },
  { aqiLo: 201, aqiHi: 300, lo: 1255, hi: 2254 },
  { aqiLo: 301, aqiHi: 500, lo: 2255, hi: 3254 },
] as const;

/** Above this, the token is a grid fill (GRIB missing is ~1e20), not smoke. */
const FILL_TENTHS = 1_000_000n;

export function pm25TenthsToAqi(tenths: number): number {
  if (!Number.isInteger(tenths) || tenths < 0) {
    throw new V1RuleError(
      "pm25_aqi",
      "PM2.5 tenths must be a whole number of 0.1 µg/m³, already truncated.",
    );
  }
  if (tenths > 3254) return 500;
  for (const band of PM25_TENTH_BANDS) {
    if (tenths < band.lo || tenths > band.hi) continue;
    const value =
      ((band.aqiHi - band.aqiLo) / (band.hi - band.lo)) * (tenths - band.lo) + band.aqiLo;
    return Math.round(value);
  }
  throw new V1RuleError("pm25_aqi", "PM2.5 concentration is outside the AQI breakpoint table.");
}

/**
 * Parse one NOAA ASCII float into truncated PM2.5 tenths.
 * `kg/m3` is HRRR-Smoke MASSDEN. `ug/m3` is the AQF surface field.
 * Missing cells and fill sentinels return null. They are not turned into AQI 500.
 */
export function concentrationTokenToTenths(token: string, unit: "kg/m3" | "ug/m3"): number | null {
  const trimmed = token.trim();
  if (/^(nan|null|missing|m)$/i.test(trimmed)) return null;
  if (/^-9999(?:\.0+)?$/.test(trimmed)) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(trimmed);
  if (!match) {
    throw new V1RuleError(
      "noaa_concentration",
      `NOAA concentration ${trimmed} is not a plain number.`,
    );
  }
  const frac = match[2] ?? "";
  const mantissa = BigInt(match[1] + frac);
  const exponent = BigInt(match[3] ?? "0");
  const unitAdjust = unit === "kg/m3" ? 9n : 0n;
  const tenthsExp = exponent - BigInt(frac.length) + unitAdjust + 1n;
  if (tenthsExp > 8n) return null;
  const tenths = tenthsExp >= 0n ? mantissa * 10n ** tenthsExp : mantissa / 10n ** -tenthsExp;
  if (tenths > FILL_TENTHS) return null;
  if (tenths > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(tenths);
}
