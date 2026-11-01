/**
 * One place, one NOAA cycle, no database.
 * HRRR-Smoke on the public AWS bucket, AQM on NOMADS. AirNow stays off.
 *
 *   npm run ingest:dry-run
 *   npm run ingest:dry-run -- --lat 43.615 --lon -116.202
 *   npm run ingest:dry-run -- --cycle 2026-10-30T12:00:00.000Z
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { fetchAirNowObservation } from "../src/lib/v1/airnow.ts";
import { V1RuleError } from "../src/lib/v1/errors.ts";
import type { ModelCell } from "../src/lib/v1/grid.ts";
import { HRRR_AWS_HOST, latestAqmCycle } from "../src/lib/v1/noaa.ts";
import { latestNoaaCycle, loadPlaceCycle } from "../src/lib/v1/place-ingest.ts";
import { FORECAST_HORIZON_HOURS } from "../src/lib/v1/rules.ts";
import type { Queryable } from "../src/lib/v1/types.ts";

/** Saved-place coordinates from docs/v1/INGEST.md. */
export const DRY_RUN_BOISE = { name: "Boise", latitude: 43.615, longitude: -116.202 } as const;

const DRY_RUN_PLACE_ID = "dry-run";
const NOMADS_HOST = "nomads.ncep.noaa.gov";

export interface DryRunHour {
  lead: number;
  source: string | null;
  horizon: string | null;
  correctedAqi: number | null;
  /** `stored` would insert. `unavailable` is hours 73–168. `missing` had no model value. */
  outcome: "stored" | "unavailable" | "missing";
}

export interface DryRunTimings {
  smokeMs: number;
  aqmMs: number;
  airnowMs: number;
  totalMs: number;
  requests: number;
}

export interface DryRunResult {
  name: string;
  latitude: number;
  longitude: number;
  cycleUtc: string;
  aqmCycleUtc: string;
  hrrr: ModelCell;
  aqm: ModelCell;
  lambert: { i: number; j: number } | null;
  /** Forecast rows an empty place would insert. Nothing is written. */
  stored: number;
  /** Always 0. The dry run does not read rows it could skip. */
  skipped: number;
  /** Always 0. The dry run does not read a stored value it could conflict with. */
  conflicts: number;
  unavailable: number;
  unavailableHours: number[];
  missing: number;
  aqfError: string | null;
  airnowError: string;
  /** Calls `fetchAirNowObservation` made. The missing-key path leaves this at 0. */
  airnowRequests: number;
  hosts: string[];
  timings: DryRunTimings;
  hours: DryRunHour[];
}

export interface DryRunInput {
  latitude: number;
  longitude: number;
  name?: string;
  /** Omitted: latest 00, 06, 12, or 18 UTC cycle at or before `now`. */
  cycleUtc?: string;
  now?: Date;
  fetchImpl: typeof fetch;
  /**
   * Accepted so a test can hand over PGLite and prove this path never queries it.
   * The dry run does not read or write that database.
   */
  sql?: Queryable;
}

interface FetchSink {
  smokeMs: number;
  aqmMs: number;
  requests: number;
  hosts: Set<string>;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Second gate. The NOAA client already refuses anything that is not these two hosts. */
function assertDryRunHost(url: URL): void {
  const host = url.hostname.toLowerCase();
  if (host.includes("purpleair")) {
    throw new V1RuleError(
      "purpleair_spend_not_approved",
      "PurpleAir is out. The dry run does not call it.",
    );
  }
  if (host.includes("open-meteo") || host.includes("openmeteo")) {
    throw new V1RuleError(
      "open_meteo_not_for_launch",
      "Open-Meteo is not a launch source. The dry run does not call it.",
    );
  }
  if (host.includes("airnow")) {
    throw new V1RuleError("airnow_api_key_missing", "Dry run does not call AirNow.");
  }
  if (url.protocol !== "https:" || (host !== HRRR_AWS_HOST && host !== NOMADS_HOST)) {
    throw new V1RuleError(
      "noaa_host_not_allowed",
      "Dry run uses the public HRRR bucket and nomads.ncep.noaa.gov only.",
    );
  }
  if (url.username || url.password) {
    throw new V1RuleError("noaa_url", "Dry run URLs are keyless.");
  }
  for (const key of url.searchParams.keys()) {
    if (/key|token|secret|password/i.test(key)) {
      throw new V1RuleError("noaa_url", "Dry run URLs are keyless.");
    }
  }
}

function watchNoaaFetch(fetchImpl: typeof fetch, sink: FetchSink): typeof fetch {
  return async (input, init) => {
    const url = new URL(requestUrl(input));
    assertDryRunHost(url);
    const host = url.hostname.toLowerCase();
    const start = performance.now();
    try {
      return await fetchImpl(input, init);
    } finally {
      const ms = performance.now() - start;
      sink.requests += 1;
      sink.hosts.add(host);
      if (host === HRRR_AWS_HOST) sink.smokeMs += ms;
      else sink.aqmMs += ms;
    }
  };
}

/**
 * AirNow stays off. Clearing the key forces `airnow_api_key_missing`
 * from `fetchAirNowObservation`, which returns before any request.
 * The fetch passed here throws if that client does call.
 */
async function refuseAirNow(point: {
  latitude: number;
  longitude: number;
}): Promise<{ code: string; requests: number }> {
  const saved = process.env.AIRNOW_API_KEY;
  delete process.env.AIRNOW_API_KEY;
  let requests = 0;
  const fetchImpl: typeof fetch = async () => {
    requests += 1;
    throw new V1RuleError("airnow_api_key_missing", "Dry run does not call AirNow.");
  };
  try {
    const result = await fetchAirNowObservation(point, fetchImpl);
    if (!result.ok) return { code: result.code, requests };
    return { code: "airnow_api_key_missing", requests };
  } finally {
    if (saved === undefined) delete process.env.AIRNOW_API_KEY;
    else process.env.AIRNOW_API_KEY = saved;
  }
}

function leadOf(issuedAt: string, validFor: string): number {
  const lead = (Date.parse(validFor) - Date.parse(issuedAt)) / 3_600_000;
  if (!Number.isInteger(lead)) {
    throw new V1RuleError("noaa_hour", "Dry run lead is not a whole hour.");
  }
  return lead;
}

/**
 * Runs the place-ingest decode for one coordinate.
 * `fetchImpl` is the only HTTP client. No forecast row and no ledger row is written.
 * `stored` is the insert count on an empty place. `skipped` and `conflicts` stay 0.
 */
export async function dryRunPlaceIngest(input: DryRunInput): Promise<DryRunResult> {
  const started = performance.now();
  if (input.sql != null && typeof input.sql.query !== "function") {
    throw new V1RuleError("invalid_body", "Dry run was given a database that cannot query.");
  }
  const name = input.name ?? DRY_RUN_BOISE.name;
  const cycleUtc = input.cycleUtc ?? latestNoaaCycle(input.now ?? new Date());
  const sink: FetchSink = { smokeMs: 0, aqmMs: 0, requests: 0, hosts: new Set() };
  const loaded = await loadPlaceCycle({
    name,
    latitude: input.latitude,
    longitude: input.longitude,
    placeId: DRY_RUN_PLACE_ID,
    cycleUtc,
    fetchImpl: watchNoaaFetch(input.fetchImpl, sink),
  });
  const airnowStarted = performance.now();
  const airnow = await refuseAirNow({ latitude: input.latitude, longitude: input.longitude });
  const airnowMs = performance.now() - airnowStarted;
  const unavailable = new Set(loaded.unavailableHours);
  const storedByLead = new Map<number, DryRunHour>();
  for (const body of loaded.forecasts) {
    const lead = leadOf(body.issuedAt, body.validFor);
    storedByLead.set(lead, {
      lead,
      source: body.source,
      horizon: body.horizon,
      correctedAqi: body.correctedAqi,
      outcome: "stored",
    });
  }
  const hours: DryRunHour[] = [];
  for (let lead = 0; lead <= FORECAST_HORIZON_HOURS; lead += 1) {
    const stored = storedByLead.get(lead);
    if (stored) {
      hours.push(stored);
      continue;
    }
    if (unavailable.has(lead)) {
      hours.push({
        lead,
        source: null,
        horizon: null,
        correctedAqi: null,
        outcome: "unavailable",
      });
      continue;
    }
    hours.push({ lead, source: null, horizon: null, correctedAqi: null, outcome: "missing" });
  }
  const stored = hours.filter((hour) => hour.outcome === "stored").length;
  const missing = hours.filter((hour) => hour.outcome === "missing").length;
  return {
    name,
    latitude: input.latitude,
    longitude: input.longitude,
    cycleUtc: new Date(cycleUtc).toISOString(),
    aqmCycleUtc: latestAqmCycle(cycleUtc),
    hrrr: loaded.hrrr,
    aqm: loaded.aqm,
    lambert: loaded.lambert ? { i: loaded.lambert.i, j: loaded.lambert.j } : null,
    stored,
    skipped: 0,
    conflicts: 0,
    unavailable: loaded.unavailableHours.length,
    unavailableHours: loaded.unavailableHours,
    missing,
    aqfError: loaded.aqfError,
    airnowError: airnow.code,
    airnowRequests: airnow.requests,
    hosts: [...sink.hosts].sort(),
    timings: {
      smokeMs: Math.round(sink.smokeMs),
      aqmMs: Math.round(sink.aqmMs),
      airnowMs: Math.round(airnowMs),
      totalMs: Math.round(performance.now() - started),
      requests: sink.requests,
    },
    hours,
  };
}

export function formatDryRun(result: DryRunResult): string {
  const lines = [
    `place: ${result.name}`,
    `latitude: ${result.latitude}`,
    `longitude: ${result.longitude}`,
    `cycle: ${result.cycleUtc}`,
    `aqmCycle: ${result.aqmCycleUtc}`,
    `hrrr: ${result.hrrr.latIndex},${result.hrrr.lonIndex}`,
    `aqm: ${result.aqm.latIndex},${result.aqm.lonIndex}`,
    `lambert: ${result.lambert ? `${result.lambert.i},${result.lambert.j}` : "-"}`,
    `counts: stored=${result.stored} skipped=${result.skipped} conflicts=${result.conflicts} unavailable=${result.unavailable} missing=${result.missing}`,
    `airnow: ${result.airnowError}`,
    `airnowRequests: ${result.airnowRequests}`,
    `aqfError: ${result.aqfError ?? "null"}`,
    `hosts: ${result.hosts.join(" ") || "-"}`,
    `timings: smokeMs=${result.timings.smokeMs} aqmMs=${result.timings.aqmMs} airnowMs=${result.timings.airnowMs} totalMs=${result.timings.totalMs} requests=${result.timings.requests}`,
    "lead source horizon correctedAqi outcome",
  ];
  for (const hour of result.hours) {
    lines.push(
      [
        hour.lead,
        hour.source ?? "-",
        hour.horizon ?? "-",
        hour.correctedAqi ?? "-",
        hour.outcome,
      ].join(" "),
    );
  }
  return `${lines.join("\n")}\n`;
}

function requireNumber(value: string | undefined, flag: string): number {
  if (value == null || value.trim() === "" || !Number.isFinite(Number(value))) {
    throw new Error(`${flag} needs a number.`);
  }
  return Number(value);
}

export function parseDryRunArgs(argv: readonly string[]): {
  latitude: number;
  longitude: number;
  name: string;
  cycleUtc?: string;
} {
  let latitude: number = DRY_RUN_BOISE.latitude;
  let longitude: number = DRY_RUN_BOISE.longitude;
  let name: string = DRY_RUN_BOISE.name;
  let cycleUtc: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--lat") {
      latitude = requireNumber(next, "--lat");
      i += 1;
    } else if (flag === "--lon") {
      longitude = requireNumber(next, "--lon");
      i += 1;
    } else if (flag === "--name") {
      if (next == null || next.startsWith("--")) throw new Error("--name needs a value.");
      name = next;
      i += 1;
    } else if (flag === "--cycle") {
      if (next == null || next.startsWith("--")) throw new Error("--cycle needs a UTC timestamp.");
      cycleUtc = next;
      i += 1;
    } else {
      throw new Error(`Unknown argument ${flag ?? ""}.`);
    }
  }
  return { latitude, longitude, name, cycleUtc };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = parseDryRunArgs(process.argv.slice(2));
  let requests = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    requests += 1;
    const url = new URL(requestUrl(input));
    const file = url.pathname.split("/").pop() ?? url.hostname;
    if (requests === 1 || requests % 20 === 0) {
      process.stderr.write(`fetch ${requests} ${url.hostname} ${file}\n`);
    }
    return globalThis.fetch(input, init);
  };
  const result = await dryRunPlaceIngest({ ...args, fetchImpl });
  process.stderr.write(`fetch ${requests} done\n`);
  process.stdout.write(formatDryRun(result));
}

if (isDirectRun()) {
  main().catch((err: unknown) => {
    if (err instanceof V1RuleError) process.stderr.write(`${err.code}: ${err.message}\n`);
    else if (err instanceof Error) process.stderr.write(`${err.message}\n`);
    else process.stderr.write("dry run failed\n");
    process.exitCode = 1;
  });
}
