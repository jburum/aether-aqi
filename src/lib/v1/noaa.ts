import { V1RuleError } from "./errors.ts";
import { concentrationTokenToTenths, pm25TenthsToAqi } from "./pm25-aqi.ts";
import { classifyForecastLead, parseForecastInput, type ValidForecast } from "./rules.ts";

/** Keyless public NOMADS OPeNDAP. No API key is added to these URLs. */
export const NOAA_ORIGIN = "https://nomads.ncep.noaa.gov";

export const NOAA_USER_AGENT = "aether-aqi/v1 (+https://bbcvc.dev)";

export interface ModelHour {
  hour: number;
  /** Truncated PM2.5 in tenths of a µg/m³. Null when that hour has no model cell. */
  pm25Tenths: number | null;
  /** Explicit regional AQI from the extract. Used only when the model cell is empty. */
  regionalLowAqi: number | null;
}

function rejectForeignFeed(text: string): void {
  if (/purpleair|api\.purpleair/i.test(text)) {
    throw new V1RuleError(
      "purpleair_spend_not_approved",
      "PurpleAir is out. Spend is not approved, and this parser does not read it.",
    );
  }
  if (/open-?meteo/i.test(text)) {
    throw new V1RuleError(
      "open_meteo_not_for_launch",
      "Open-Meteo is not a launch source. Days 1-2 use the NOAA smoke model. Days 3-7 use NOAA's air quality forecast.",
    );
  }
}

/** https://nomads.ncep.noaa.gov only. Open-Meteo and PurpleAir are refused before any request. */
export function assertNoaaUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new V1RuleError("noaa_url", "NOAA URL is invalid.");
  }
  const host = url.hostname.toLowerCase();
  if (host.includes("purpleair")) {
    throw new V1RuleError(
      "purpleair_spend_not_approved",
      "PurpleAir is out. Spend is not approved, and this client does not call it.",
    );
  }
  if (host.includes("open-meteo") || host.includes("openmeteo")) {
    throw new V1RuleError(
      "open_meteo_not_for_launch",
      "Open-Meteo is not a launch source. Days 1-2 use the NOAA smoke model. Days 3-7 use NOAA's air quality forecast.",
    );
  }
  if (url.protocol !== "https:" || host !== "nomads.ncep.noaa.gov") {
    throw new V1RuleError(
      "noaa_host_not_allowed",
      "NOAA ingest uses keyless nomads.ncep.noaa.gov only.",
    );
  }
  if (url.username || url.password) {
    throw new V1RuleError("noaa_url", "NOAA URL must not include credentials.");
  }
  for (const key of url.searchParams.keys()) {
    if (/key|token|secret|password/i.test(key)) {
      throw new V1RuleError(
        "noaa_url",
        "NOAA endpoints are keyless. This URL includes a credential parameter.",
      );
    }
  }
  return url;
}

function assertGridIndex(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 5000) {
    throw new V1RuleError("noaa_grid", `${field} must be a NOMADS grid index.`);
  }
}

function assertQueryHour(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 168) {
    throw new V1RuleError("noaa_hour", `${field} must be a lead hour from 0 through 168.`);
  }
}

/** Synoptic hours NOMADS publishes for these models. Minutes must be zero. */
export function noaaCycleParts(cycleUtc: string): { yyyymmdd: string; hh: string } {
  const parsed = new Date(cycleUtc);
  if (Number.isNaN(parsed.getTime()) || !cycleUtc.endsWith("Z")) {
    throw new V1RuleError("invalid_time", "NOAA cycle must be a UTC timestamp.");
  }
  if (
    parsed.getUTCMinutes() !== 0 ||
    parsed.getUTCSeconds() !== 0 ||
    parsed.getUTCMilliseconds() !== 0
  ) {
    throw new V1RuleError("noaa_cycle", "NOAA cycle must fall on an exact UTC hour.");
  }
  const hh = String(parsed.getUTCHours()).padStart(2, "0");
  if (hh !== "00" && hh !== "06" && hh !== "12" && hh !== "18") {
    throw new V1RuleError("noaa_cycle", "NOAA model cycles used here are 00, 06, 12, and 18 UTC.");
  }
  const y = parsed.getUTCFullYear();
  const m = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const d = String(parsed.getUTCDate()).padStart(2, "0");
  return { yyyymmdd: `${y}${m}${d}`, hh };
}

export interface NoaaSeriesQuery {
  cycleUtc: string;
  latIndex: number;
  lonIndex: number;
  hourStart: number;
  hourEnd: number;
}

function seriesBounds(input: NoaaSeriesQuery): {
  cycle: { yyyymmdd: string; hh: string };
  query: string;
} {
  const cycle = noaaCycleParts(input.cycleUtc);
  assertGridIndex(input.latIndex, "latIndex");
  assertGridIndex(input.lonIndex, "lonIndex");
  assertQueryHour(input.hourStart, "hourStart");
  assertQueryHour(input.hourEnd, "hourEnd");
  if (input.hourEnd < input.hourStart) {
    throw new V1RuleError("noaa_hour", "hourEnd is before hourStart.");
  }
  const query = `[${input.hourStart}:${input.hourEnd}][${input.latIndex}:${input.latIndex}][${input.lonIndex}:${input.lonIndex}]`;
  return { cycle, query };
}

/**
 * HRRR-Smoke near-surface mass density (MASSDEN, 8 m above ground), one grid cell.
 * Days 1-2. The ASCII body is what `parseHrrrSmoke` reads.
 */
export function hrrrSmokeAsciiUrl(input: NoaaSeriesQuery): string {
  const { cycle, query } = seriesBounds(input);
  const url = `${NOAA_ORIGIN}/dods/hrrr/hrrr${cycle.yyyymmdd}/hrrr_sfc.t${cycle.hh}z.ascii?masden8m${query}`;
  assertNoaaUrl(url);
  return url;
}

/**
 * NOAA air quality model surface PM2.5, one grid cell. Days 3-7.
 * The ASCII body is what `parseNoaaAqf` reads.
 */
export function aqfAsciiUrl(input: NoaaSeriesQuery): string {
  const { cycle, query } = seriesBounds(input);
  const url = `${NOAA_ORIGIN}/dods/aqm/aqm${cycle.yyyymmdd}/aqm.t${cycle.hh}z.ascii?pm25sfc${query}`;
  assertNoaaUrl(url);
  return url;
}

export async function fetchNoaaAscii(url: string, fetchImpl: typeof fetch): Promise<string> {
  const allowed = assertNoaaUrl(url);
  const response = await fetchImpl(allowed.toString(), {
    headers: { accept: "text/plain", "user-agent": NOAA_USER_AGENT },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new V1RuleError("noaa_fetch_failed", `NOAA responded ${response.status}.`);
  }
  return response.text();
}

const DATA_LINE = /^\[(\d+)\]\[(\d+)\]\[(\d+)\]\s*,?\s+(\S+)\s*$/;
const GUIDANCE_LINE = /^guidance, \[(\d+)\] regional_low (\d+)\s*$/;

function parseCode(variable: "masden8m" | "pm25sfc"): string {
  return variable === "masden8m" ? "noaa_smoke_parse" : "noaa_aqf_parse";
}

function parseHours(
  text: string,
  variable: "masden8m" | "pm25sfc",
  unit: "kg/m3" | "ug/m3",
): ModelHour[] {
  rejectForeignFeed(text);
  const hours = new Map<number, ModelHour>();
  const concentrationSeen = new Set<number>();
  let seenHeader = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("---") || line.startsWith("Dataset")) continue;
    if (line.startsWith(variable)) {
      seenHeader = true;
      continue;
    }
    if (variable === "masden8m" && line.startsWith("pm25sfc")) {
      throw new V1RuleError(
        "noaa_smoke_parse",
        "The smoke file is HRRR MASSDEN, not the air quality PM2.5 field.",
      );
    }
    if (variable === "pm25sfc" && line.startsWith("masden8m")) {
      throw new V1RuleError(
        "noaa_aqf_parse",
        "The air quality file is surface PM2.5, not HRRR smoke mass density.",
      );
    }
    const guidance = GUIDANCE_LINE.exec(line);
    if (guidance) {
      if (variable !== "pm25sfc") {
        throw new V1RuleError(
          "noaa_smoke_parse",
          "Regional low-confidence guidance belongs on the days 3-7 air quality file.",
        );
      }
      const hour = Number(guidance[1]);
      const aqi = Number(guidance[2]);
      if (!Number.isInteger(aqi) || aqi < 0 || aqi > 500) {
        throw new V1RuleError("invalid_aqi", "Regional guidance must be an integer from 0 to 500.");
      }
      const existing = hours.get(hour) ?? { hour, pm25Tenths: null, regionalLowAqi: null };
      if (existing.regionalLowAqi != null) {
        throw new V1RuleError("noaa_duplicate_hour", `Regional guidance repeats hour ${hour}.`);
      }
      existing.regionalLowAqi = aqi;
      hours.set(hour, existing);
      continue;
    }
    const data = DATA_LINE.exec(line);
    if (!data) {
      throw new V1RuleError(parseCode(variable), "NOAA ASCII line is not a single-cell extract.");
    }
    if (!seenHeader) {
      throw new V1RuleError(parseCode(variable), "NOAA ASCII is missing the variable header.");
    }
    const hour = Number(data[1]);
    if (Number(data[2]) !== 0 || Number(data[3]) !== 0) {
      throw new V1RuleError(
        "noaa_point_only",
        "Phase 1 parses one grid cell. Record the ASCII for that cell.",
      );
    }
    if (concentrationSeen.has(hour)) {
      throw new V1RuleError("noaa_duplicate_hour", `NOAA extract repeats hour ${hour}.`);
    }
    concentrationSeen.add(hour);
    const tenths = concentrationTokenToTenths(data[4] ?? "", unit);
    const row = hours.get(hour) ?? { hour, pm25Tenths: null, regionalLowAqi: null };
    row.pm25Tenths = tenths;
    hours.set(hour, row);
  }
  if (!seenHeader) {
    throw new V1RuleError(parseCode(variable), "NOAA ASCII is missing the variable header.");
  }
  return [...hours.values()].sort((a, b) => a.hour - b.hour);
}

/** HRRR-Smoke ASCII (`masden8m`, kg/m³) for one cell, lead hours in the first index. */
export function parseHrrrSmoke(text: string): ModelHour[] {
  return parseHours(text, "masden8m", "kg/m3");
}

/** NOAA AQF ASCII (`pm25sfc`, µg/m³) plus optional `regional_low` guidance. */
export function parseNoaaAqf(text: string): ModelHour[] {
  return parseHours(text, "pm25sfc", "ug/m3");
}

function validForHour(issuedAt: string, hour: number): string {
  return new Date(new Date(issuedAt).getTime() + hour * 3_600_000).toISOString();
}

function smokeBody(placeId: string, issuedAt: string, hour: ModelHour): ValidForecast | null {
  if (hour.pm25Tenths == null) return null;
  const validFor = validForHour(issuedAt, hour.hour);
  if (classifyForecastLead(issuedAt, validFor) !== "day_1_2") return null;
  return parseForecastInput({
    placeId,
    source: "noaa_smoke",
    issuedAt,
    validFor,
    horizon: "day_1_2_valley",
    spatialScale: "valley",
    confidence: "valley",
    correctedAqi: pm25TenthsToAqi(hour.pm25Tenths),
    pollutant: "PM2.5",
  });
}

function aqfBody(placeId: string, issuedAt: string, hour: ModelHour): ValidForecast | null {
  const validFor = validForHour(issuedAt, hour.hour);
  if (classifyForecastLead(issuedAt, validFor) !== "day_3_7") return null;
  if (hour.pm25Tenths != null) {
    return parseForecastInput({
      placeId,
      source: "noaa_aqf",
      issuedAt,
      validFor,
      horizon: "day_3_7_noaa_aqf",
      spatialScale: "regional",
      confidence: "model",
      correctedAqi: pm25TenthsToAqi(hour.pm25Tenths),
      pollutant: "PM2.5",
    });
  }
  if (hour.regionalLowAqi == null) return null;
  return parseForecastInput({
    placeId,
    source: "regional",
    issuedAt,
    validFor,
    horizon: "day_3_7_regional_low_confidence",
    spatialScale: "regional",
    confidence: "low",
    correctedAqi: hour.regionalLowAqi,
    pollutant: null,
  });
}

/**
 * Days 1-2 come from the smoke extract (lead 0 through 48h, valley).
 * Later hours through day 7 come from AQF when the cell is present (regional model),
 * otherwise from an explicit regional number on that extract (regional, low).
 * A smoke value after 48h is ignored. An AQF value at or before 48h is ignored.
 */
export function forecastBodiesFromExtracts(input: {
  placeId: string;
  issuedAt: string;
  smokeAscii: string;
  aqfAscii: string;
}): ValidForecast[] {
  const bodies: ValidForecast[] = [];
  const seen = new Set<string>();
  for (const hour of parseHrrrSmoke(input.smokeAscii)) {
    const body = smokeBody(input.placeId, input.issuedAt, hour);
    if (!body) continue;
    seen.add(body.validFor);
    bodies.push(body);
  }
  for (const hour of parseNoaaAqf(input.aqfAscii)) {
    const body = aqfBody(input.placeId, input.issuedAt, hour);
    if (!body) continue;
    if (seen.has(body.validFor)) {
      throw new V1RuleError(
        "noaa_hour_overlap",
        "Smoke and the air quality forecast both produced the same valid hour.",
      );
    }
    bodies.push(body);
  }
  return bodies;
}
