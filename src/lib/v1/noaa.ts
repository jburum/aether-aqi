import type { StabilitySample } from "./alerts.ts";
import { V1RuleError } from "./errors.ts";
import { readSimpleGribFields, type SimpleGribField } from "./grib.ts";
import { noaaEndpointKind, recordUpstreamCall } from "./monitoring.ts";
import { parseUtcInstant } from "./phase2.ts";
import { concentrationTokenToTenths, pm25TenthsToAqi } from "./pm25-aqi.ts";
import { classifyForecastLead, parseForecastInput, type ValidForecast } from "./rules.ts";
import type { Queryable } from "./types.ts";

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

/** Public HRRR GRIB on AWS. OpenDAP on NOMADS is retired for this field. */
export const HRRR_AWS_HOST = "noaa-hrrr-bdp-pds.s3.amazonaws.com";

const HRRR_AWS_PATH =
  /^\/hrrr\.\d{8}\/conus\/hrrr\.t(?:00|06|12|18)z\.wrfsfcf(?:[0-3]\d|4[0-8])\.grib2(?:\.idx)?$/;

/** NOMADS, or one HRRR object on the public AWS bucket. Open-Meteo and PurpleAir are refused before any request. */
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
  const awsSmoke = host === HRRR_AWS_HOST && HRRR_AWS_PATH.test(url.pathname) && url.search === "";
  if (url.protocol !== "https:" || (host !== "nomads.ncep.noaa.gov" && !awsSmoke)) {
    throw new V1RuleError(
      "noaa_host_not_allowed",
      "NOAA ingest uses keyless nomads.ncep.noaa.gov or the public HRRR bucket.",
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

/** One MASSDEN message. A larger range is refused before the body is kept. */
export const MAX_HRRR_FIELD_BYTES = 8 * 1024 * 1024;

/**
 * One HRRR CONUS surface file on the public bucket. Lead 0 through 48.
 * The sibling `.idx` is the wgrib2 inventory used to range-read MASSDEN.
 */
export function hrrrSmokeGribUrl(cycleUtc: string, lead: number): string {
  if (!Number.isInteger(lead) || lead < 0 || lead > 48) {
    throw new V1RuleError("noaa_hour", "HRRR smoke covers lead hours 0 through 48.");
  }
  const cycle = noaaCycleParts(cycleUtc);
  const hh = String(lead).padStart(2, "0");
  const url = `https://${HRRR_AWS_HOST}/hrrr.${cycle.yyyymmdd}/conus/hrrr.t${cycle.hh}z.wrfsfcf${hh}.grib2`;
  assertNoaaUrl(url);
  return url;
}

/** Byte span of `MASSDEN:8 m above ground` in a wgrib2 `.idx`. `end` is exclusive. */
export function hrrrSmokeByteRange(idx: string): { start: number; end: number | null } {
  const lines = idx.split(/\r?\n/).filter((line) => line.length > 0);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!line.includes("MASSDEN:8 m above ground")) continue;
    const start = Number(line.split(":")[1]);
    if (!Number.isInteger(start) || start < 0) {
      throw new V1RuleError(
        "noaa_smoke_parse",
        "HRRR index offset for 8 m smoke is not an integer.",
      );
    }
    const next = lines[i + 1];
    if (!next) return { start, end: null };
    const end = Number(next.split(":")[1]);
    if (!Number.isInteger(end) || end <= start) {
      throw new V1RuleError(
        "noaa_smoke_parse",
        "HRRR index offset for 8 m smoke is not an integer.",
      );
    }
    if (end - start > MAX_HRRR_FIELD_BYTES) {
      throw new V1RuleError("noaa_smoke_parse", "HRRR smoke field is larger than one message.");
    }
    return { start, end };
  }
  throw new V1RuleError("noaa_smoke_parse", "HRRR index has no 8 m smoke field.");
}

async function noteNoaaCall(
  ledger: Queryable | undefined,
  url: string,
  calledAt: Date,
  outcome: "ok" | "error",
  errorCode?: string,
): Promise<void> {
  await recordUpstreamCall(ledger, {
    source: "noaa",
    endpointKind: noaaEndpointKind(url),
    calledAt,
    outcome,
    errorCode: errorCode ?? null,
  });
}

/**
 * Keyless GET. A refused URL throws before the request and writes no ledger row.
 * When `ledger` is set, the attempt is counted after it leaves this process.
 */
export async function fetchNoaaAscii(
  url: string,
  fetchImpl: typeof fetch,
  ledger?: Queryable,
): Promise<string> {
  const allowed = assertNoaaUrl(url);
  const calledAt = new Date();
  const target = allowed.toString();
  let response: Response;
  try {
    response = await fetchImpl(target, {
      headers: { accept: "text/plain", "user-agent": NOAA_USER_AGENT },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    await noteNoaaCall(ledger, target, calledAt, "error", "noaa_fetch_failed");
    throw err;
  }
  if (!response.ok) {
    await noteNoaaCall(ledger, target, calledAt, "error", "noaa_fetch_failed");
    throw new V1RuleError("noaa_fetch_failed", `NOAA responded ${response.status}.`);
  }
  let body: string;
  try {
    body = await response.text();
  } catch (err) {
    await noteNoaaCall(ledger, target, calledAt, "error", "noaa_fetch_failed");
    throw err;
  }
  await noteNoaaCall(ledger, target, calledAt, "ok");
  return body;
}

interface NoaaByteRequest {
  headers: Record<string, string>;
  timeoutMs: number;
  allowMissing: boolean;
  /** Index span. `end` is exclusive. The object must answer 206 for this span. */
  byteRange?: { start: number; end: number | null };
}

const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/;

function rangeHeader(range: { start: number; end: number | null }): string {
  if (range.end == null) return `bytes=${range.start}-`;
  return `bytes=${range.start}-${range.end - 1}`;
}

async function releaseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be closed.
  }
}

function parseContentRange(header: string | null): { start: number; endInclusive: number } | null {
  const match = CONTENT_RANGE.exec(header?.trim() ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const endInclusive = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || endInclusive < start) {
    return null;
  }
  return { start, endInclusive };
}

/**
 * Read a 206 body up to `expected` bytes. A chunk past the cap or the
 * Content-Range length cancels the rest and does not keep that chunk.
 */
async function readStreamCapped(
  response: Response,
  expected: number,
  cap: number,
): Promise<Uint8Array> {
  const body = response.body;
  if (!body) throw new V1RuleError("noaa_fetch_failed", "NOAA response has no body.");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  const stop = async (error: V1RuleError): Promise<never> => {
    await reader.cancel().catch(() => undefined);
    throw error;
  };
  try {
    while (received < expected) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const next = received + value.byteLength;
      if (next > cap) {
        return await stop(
          new V1RuleError("noaa_smoke_parse", "HRRR smoke field is larger than one message."),
        );
      }
      if (next > expected) {
        return await stop(
          new V1RuleError("noaa_smoke_parse", "HRRR byte range does not match the index."),
        );
      }
      chunks.push(value);
      received = next;
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }
  if (received !== expected) {
    await reader.cancel().catch(() => undefined);
    throw new V1RuleError("noaa_smoke_parse", "HRRR byte range does not match the index.");
  }
  await reader.cancel().catch(() => undefined);
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** 206 only. Content-Range start/end must match the index span and the body length. */
async function readHrrrRangeBody(
  response: Response,
  range: { start: number; end: number | null },
): Promise<Uint8Array> {
  const parsed = parseContentRange(response.headers.get("content-range"));
  const expected = parsed ? parsed.endInclusive - parsed.start + 1 : 0;
  const endMatches = range.end == null || parsed?.endInclusive === range.end - 1;
  const lengthMatches = range.end == null || expected === range.end - range.start;
  if (!parsed || parsed.start !== range.start || !endMatches || !lengthMatches || expected < 1) {
    await releaseBody(response);
    throw new V1RuleError("noaa_smoke_parse", "HRRR byte range does not match the index.");
  }
  if (expected > MAX_HRRR_FIELD_BYTES) {
    await releaseBody(response);
    throw new V1RuleError("noaa_smoke_parse", "HRRR smoke field is larger than one message.");
  }
  return readStreamCapped(response, expected, MAX_HRRR_FIELD_BYTES);
}

async function fetchNoaaBytes(
  url: string,
  fetchImpl: typeof fetch,
  ledger: Queryable | undefined,
  init: NoaaByteRequest,
): Promise<Uint8Array | null> {
  const allowed = assertNoaaUrl(url);
  const calledAt = new Date();
  const target = allowed.toString();
  const headers: Record<string, string> = {
    accept: "application/octet-stream",
    "user-agent": NOAA_USER_AGENT,
    ...init.headers,
  };
  if (init.byteRange) headers.range = rangeHeader(init.byteRange);
  let response: Response;
  try {
    response = await fetchImpl(target, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (err) {
    await noteNoaaCall(ledger, target, calledAt, "error", "noaa_fetch_failed");
    throw err;
  }
  if (response.status === 404 && init.allowMissing) {
    await releaseBody(response);
    await noteNoaaCall(ledger, target, calledAt, "error", "noaa_hour_missing");
    return null;
  }
  let bytes: Uint8Array;
  try {
    if (init.byteRange) {
      if (response.status !== 206) {
        await releaseBody(response);
        throw new V1RuleError("noaa_fetch_failed", `NOAA responded ${response.status}.`);
      }
      bytes = await readHrrrRangeBody(response, init.byteRange);
    } else if (!response.ok) {
      await releaseBody(response);
      throw new V1RuleError("noaa_fetch_failed", `NOAA responded ${response.status}.`);
    } else {
      bytes = new Uint8Array(await response.arrayBuffer());
    }
  } catch (err) {
    await releaseBody(response);
    const code = err instanceof V1RuleError ? err.code : "noaa_fetch_failed";
    await noteNoaaCall(ledger, target, calledAt, "error", code);
    throw err;
  }
  await noteNoaaCall(ledger, target, calledAt, "ok");
  return bytes;
}

/**
 * Index, then a byte-range GET of the 8 m MASSDEN message.
 * The object must answer 206, and Content-Range must match the index span.
 * A 404 on the index or the object skips that lead hour.
 * The returned bytes are one GRIB2 message, not the whole surface file.
 */
export async function fetchHrrrSmokeField(
  cycleUtc: string,
  lead: number,
  fetchImpl: typeof fetch,
  ledger?: Queryable,
): Promise<Uint8Array | null> {
  const gribUrl = hrrrSmokeGribUrl(cycleUtc, lead);
  const idx = await fetchNoaaBytes(`${gribUrl}.idx`, fetchImpl, ledger, {
    headers: {},
    timeoutMs: 15_000,
    allowMissing: true,
  });
  if (!idx) return null;
  const text = new TextDecoder().decode(idx);
  const range = hrrrSmokeByteRange(text);
  const message = await fetchNoaaBytes(gribUrl, fetchImpl, ledger, {
    headers: {},
    timeoutMs: 30_000,
    allowMissing: true,
    byteRange: range,
  });
  if (!message) return null;
  if (message.length < 16 || message[0] !== 0x47) {
    throw new V1RuleError("noaa_smoke_parse", "NOAA response is not a GRIB2 file.");
  }
  return message;
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

/** Lead-0 valley row used when outdoor sensors drop out. Later hours stay on the cycle ingest. */
export function lead0SmokeForecast(
  placeId: string,
  issuedAt: string,
  smokeAscii: string,
): ValidForecast {
  const hour = parseHrrrSmoke(smokeAscii).find((row) => row.hour === 0);
  const body = hour ? smokeBody(placeId, issuedAt, hour) : null;
  if (!body) {
    throw new V1RuleError(
      "noaa_smoke_missing",
      "Sensor dropout needs a NOAA smoke value at lead 0. No official number was written.",
    );
  }
  return body;
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
 * Days 1-2 come from smoke (lead 0 through 48h, valley).
 * Later hours through day 7 come from AQF when the cell is present (regional model),
 * otherwise from an explicit regional number on an ASCII extract (regional, low).
 * A smoke value after 48h is ignored. An AQF value at or before 48h is ignored.
 */
export function forecastBodiesFromHours(input: {
  placeId: string;
  issuedAt: string;
  smoke: readonly ModelHour[];
  aqf: readonly ModelHour[];
}): ValidForecast[] {
  const bodies: ValidForecast[] = [];
  const seen = new Set<string>();
  for (const hour of input.smoke) {
    const body = smokeBody(input.placeId, input.issuedAt, hour);
    if (!body) continue;
    seen.add(body.validFor);
    bodies.push(body);
  }
  for (const hour of input.aqf) {
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

/** Recorded ASCII fixtures. Live smoke passes hours from the GRIB field instead. */
export function forecastBodiesFromExtracts(input: {
  placeId: string;
  issuedAt: string;
  smokeAscii: string;
  aqfAscii: string;
}): ValidForecast[] {
  return forecastBodiesFromHours({
    placeId: input.placeId,
    issuedAt: input.issuedAt,
    smoke: parseHrrrSmoke(input.smokeAscii),
    aqf: parseNoaaAqf(input.aqfAscii),
  });
}

const STABILITY_BOX_DEGREES = 0.2;

/** WMO / NCEP identities on the HRRR surface file. Skin temperature is category 0 on surface type 1 and is ignored. */
const STABILITY_FIELDS = {
  tmp: { category: 0, parameter: 0, surfaceType: 103, level: 2 },
  u: { category: 2, parameter: 2, surfaceType: 103, level: 10 },
  v: { category: 2, parameter: 3, surfaceType: 103, level: 10 },
  hpbl: { category: 3, parameter: 18, surfaceType: 1, level: 0 },
} as const;

type StabilityFieldName = keyof typeof STABILITY_FIELDS;

export interface HrrrStabilityQuery {
  cycleUtc: string;
  hourStart: number;
  hourEnd: number;
  south: number;
  north: number;
  west: number;
  east: number;
}

function assertStabilityBox(input: HrrrStabilityQuery): void {
  const { south, north, west, east } = input;
  for (const value of [south, north, west, east]) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new V1RuleError("noaa_grid", "Stability box edges must be finite degrees.");
    }
  }
  if (south < -90 || north > 90 || !(south < north) || north - south > STABILITY_BOX_DEGREES) {
    throw new V1RuleError(
      "noaa_grid",
      "Stability box runs south to north and spans at most 0.2 degrees.",
    );
  }
  if (west < -180 || east > 180 || !(west < east) || east - west > STABILITY_BOX_DEGREES) {
    throw new V1RuleError(
      "noaa_grid",
      "Stability box runs west to east and spans at most 0.2 degrees.",
    );
  }
}

/**
 * Keyless NOMADS GRIB filter for one lead hour. OpenDAP ASCII is retired.
 * `lev_surface` is on so mixing height is included. Skin temperature comes along and is ignored.
 * `var_WIND` is left off: that message is the day's max wind, not this hour.
 */
export function hrrrStabilityFilterUrls(input: HrrrStabilityQuery): string[] {
  if (input.hourStart > 48 || input.hourEnd > 48) {
    throw new V1RuleError("noaa_hour", "HRRR stability covers lead hours 0 through 48.");
  }
  const cycle = noaaCycleParts(input.cycleUtc);
  assertQueryHour(input.hourStart, "hourStart");
  assertQueryHour(input.hourEnd, "hourEnd");
  if (input.hourEnd < input.hourStart) {
    throw new V1RuleError("noaa_hour", "hourEnd is before hourStart.");
  }
  assertStabilityBox(input);
  const urls: string[] = [];
  for (let lead = input.hourStart; lead <= input.hourEnd; lead += 1) {
    const file = `hrrr.t${cycle.hh}z.wrfsfcf${String(lead).padStart(2, "0")}.grib2`;
    const params = new URLSearchParams();
    params.set("dir", `/hrrr.${cycle.yyyymmdd}/conus`);
    params.set("file", file);
    params.set("var_TMP", "on");
    params.set("var_UGRD", "on");
    params.set("var_VGRD", "on");
    params.set("var_HPBL", "on");
    params.set("lev_2_m_above_ground", "on");
    params.set("lev_10_m_above_ground", "on");
    params.set("lev_surface", "on");
    params.set("subregion", "");
    params.set("toplat", String(input.north));
    params.set("leftlon", String(input.west));
    params.set("rightlon", String(input.east));
    params.set("bottomlat", String(input.south));
    const url = `${NOAA_ORIGIN}/cgi-bin/filter_hrrr_2d.pl?${params.toString()}`;
    assertNoaaUrl(url);
    urls.push(url);
  }
  return urls;
}

/** Same ledger rules as `fetchNoaaAscii`. The GRIB magic check is an error row. */
export async function fetchNoaaGrib(
  url: string,
  fetchImpl: typeof fetch,
  ledger?: Queryable,
): Promise<Uint8Array> {
  const allowed = assertNoaaUrl(url);
  const calledAt = new Date();
  const target = allowed.toString();
  let response: Response;
  try {
    response = await fetchImpl(target, {
      headers: { accept: "application/octet-stream", "user-agent": NOAA_USER_AGENT },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    await noteNoaaCall(ledger, target, calledAt, "error", "noaa_fetch_failed");
    throw err;
  }
  if (!response.ok) {
    await noteNoaaCall(ledger, target, calledAt, "error", "noaa_fetch_failed");
    throw new V1RuleError("noaa_fetch_failed", `NOAA responded ${response.status}.`);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (err) {
    await noteNoaaCall(ledger, target, calledAt, "error", "noaa_fetch_failed");
    throw err;
  }
  if (bytes.length < 16 || bytes[0] !== 0x47) {
    await noteNoaaCall(ledger, target, calledAt, "error", "noaa_stability_parse");
    throw new V1RuleError("noaa_stability_parse", "NOAA stability response is not a GRIB2 file.");
  }
  await noteNoaaCall(ledger, target, calledAt, "ok");
  return bytes;
}

function sameField(field: SimpleGribField, name: StabilityFieldName): boolean {
  const identity = STABILITY_FIELDS[name];
  return (
    field.category === identity.category &&
    field.parameter === identity.parameter &&
    field.surfaceType === identity.surfaceType &&
    Math.abs(field.level - identity.level) < 1e-6
  );
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/**
 * One lead hour from a filter extract. The sample is the mean of the cells in the box.
 * Wind is `hypot` of the mean 10 m components. Lead hours stop at 48.
 */
export function stabilitySampleFromGrib(bytes: Uint8Array, issuedAt: string): StabilitySample {
  const cycle = parseUtcInstant(issuedAt, "issuedAt");
  const picked = new Map<StabilityFieldName, SimpleGribField>();
  for (const field of readSimpleGribFields(bytes)) {
    for (const name of Object.keys(STABILITY_FIELDS) as StabilityFieldName[]) {
      if (!sameField(field, name)) continue;
      if (picked.has(name)) {
        throw new V1RuleError("noaa_stability_parse", "GRIB2 extract repeats a stability field.");
      }
      picked.set(name, field);
    }
  }
  const tmp = picked.get("tmp");
  const u = picked.get("u");
  const v = picked.get("v");
  const hpbl = picked.get("hpbl");
  if (!tmp || !u || !v || !hpbl) {
    throw new V1RuleError(
      "noaa_stability_parse",
      "GRIB2 extract is missing 2 m temperature, 10 m wind, or mixing height.",
    );
  }
  const group = [tmp, u, v, hpbl];
  const forecastHour = tmp.forecastHour;
  if (tmp.referenceTime !== cycle) {
    throw new V1RuleError("noaa_stability_parse", "GRIB reference time does not match issuedAt.");
  }
  if (group.some((field) => field.referenceTime !== cycle || field.forecastHour !== forecastHour)) {
    throw new V1RuleError(
      "noaa_stability_parse",
      "GRIB2 stability fields disagree on the valid hour.",
    );
  }
  if (!Number.isInteger(forecastHour) || forecastHour < 0 || forecastHour > 48) {
    throw new V1RuleError("noaa_hour", "HRRR stability covers lead hours 0 through 48.");
  }
  const validFor = new Date(Date.parse(cycle) + forecastHour * 3_600_000).toISOString();
  if (classifyForecastLead(cycle, validFor) !== "day_1_2") {
    throw new V1RuleError("noaa_hour", "HRRR stability covers lead hours 0 through 48.");
  }
  const tmp2mK = mean(tmp.values);
  const hpblM = mean(hpbl.values);
  const wind10mMs = Math.hypot(mean(u.values), mean(v.values));
  if (tmp2mK < 180 || tmp2mK > 330) {
    throw new V1RuleError("invalid_field", "HRRR temperatures must be Kelvin between 180 and 330.");
  }
  if (hpblM < 0 || hpblM > 20_000) {
    throw new V1RuleError("invalid_field", "Mixing height must be from 0 to 20000 m.");
  }
  if (wind10mMs > 100) {
    throw new V1RuleError("invalid_field", "10 m wind must be a speed from 0 to 100 m/s.");
  }
  return { issuedAt: cycle, validFor, tmp2mK, hpblM, wind10mMs };
}
