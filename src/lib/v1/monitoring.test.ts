import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { recordStability } from "./alerts.ts";
import { fetchAirNowObservation } from "./airnow.ts";
import { V1RuleError } from "./errors.ts";
import { handleV1 } from "./http.ts";
import { fallbackSensorDropout, ingestRecordedNoaa } from "./ingest.ts";
import {
  AIRNOW_CADENCE_MS,
  AIRNOW_HOURLY_LIMIT,
  AIRNOW_WARN_AT,
  HOUR_MS,
  NOAA_CADENCE_MS,
  PROJECTION_MONTH_MS,
  PROJECTION_WINDOW_MS,
  airNowBudget,
  buildStatus,
  forecastFreshness,
  noaaEndpointKind,
  projectPurpleAirPointsPerMonth,
  purpleAirPoints,
  readMonitoringStatus,
  recordUpstreamCall,
  sourceHealth,
  type MonitoringStatus,
} from "./monitoring.ts";
import {
  fetchNoaaAscii,
  fetchNoaaGrib,
  hrrrSmokeAsciiUrl,
  hrrrStabilityFilterUrls,
} from "./noaa.ts";
import { TestPushSender } from "./push.ts";
import { AIRNOW_ATTRIBUTION } from "./rules.ts";
import { addSavedPlace, issueForecast, recordOfficial } from "./store.ts";
import type { Queryable } from "./types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const AS_OF = "2026-10-30T20:00:00.000Z";
const NOW = Date.parse(AS_OF);
const CYCLE = "2026-10-30T12:00:00.000Z";
const FRESH_AT = "2026-10-30T14:00:00.000Z";
const STALE_AT = "2026-10-30T13:59:59.999Z";
const KEY = "fixture-key-not-stored";

const PLACE = {
  latitude: 43.6151,
  longitude: -116.2029,
  valley: "Treasure Valley",
  alertAt: null,
};

async function openDb(): Promise<Queryable> {
  const pg = new PGlite();
  await pg.waitReady;
  const dir = join(root, "migrations");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) {
    await pg.exec(readFileSync(join(dir, name), "utf8"));
  }
  return {
    query: async <T>(text: string, params: unknown[] = []) => {
      const result = await pg.query<T>(text, params);
      return result.rows;
    },
  };
}

function call(sql: Queryable, method: string, path: string, userId = "owner-alpha-441") {
  return handleV1(new Request(`http://localhost${path}`, { method }), {
    sql,
    userId,
    sender: new TestPushSender(),
  });
}

async function addPlace(sql: Queryable, userId: string, name: string) {
  return addSavedPlace(sql, userId, { ...PLACE, name });
}

async function issueSmoke(sql: Queryable, userId: string, placeId: string) {
  return issueForecast(sql, userId, {
    placeId,
    issuedAt: CYCLE,
    validFor: "2026-10-30T18:00:00.000Z",
    source: "noaa_smoke",
    horizon: "day_1_2_valley",
    spatialScale: "valley",
    confidence: "valley",
    correctedAqi: 42,
    pollutant: null,
  });
}

function atHour(count: number, nowMs: number): { calledAtMs: number }[] {
  return Array.from({ length: count }, () => ({ calledAtMs: nowMs }));
}

describe("v1 phase 4 monitoring", { concurrency: 1 }, () => {
  it("prices PurpleAir by the points-per-field rule and does not call out", () => {
    const source = readFileSync(new URL("./monitoring.ts", import.meta.url), "utf8");
    assert.equal(source.includes("api.purpleair.com"), false);
    assert.equal(source.includes("airnowapi.org"), false);
    assert.equal(source.includes("nomads.ncep.noaa.gov"), false);
    assert.equal(source.includes("AIRNOW_API_KEY"), false);
    assert.equal(purpleAirPoints(["humidity", "pm2.5_cf_1", "location_type"], 4), 12);
    assert.equal(purpleAirPoints(["humidity", "humidity"], 2), 2);
    assert.throws(
      () => purpleAirPoints(["api_key"], 1),
      (err: unknown) => err instanceof V1RuleError && err.code === "purpleair_points",
    );
    assert.throws(
      () => purpleAirPoints([], 1),
      (err: unknown) => err instanceof V1RuleError && err.code === "purpleair_points",
    );
    assert.equal(AIRNOW_WARN_AT, AIRNOW_HOURLY_LIMIT * 0.8);
  });

  it("warns at 80% of the AirNow hour and marks the hour over at 500", () => {
    const now = 1_700_000_000_000;
    assert.equal(airNowBudget([{ calledAtMs: now - HOUR_MS }], now).requestsInLastHour, 0);
    assert.equal(airNowBudget([{ calledAtMs: now - HOUR_MS + 1 }], now).requestsInLastHour, 1);
    assert.equal(airNowBudget(atHour(399, now), now).status, "ok");
    assert.equal(airNowBudget(atHour(400, now), now).status, "warn");
    assert.equal(airNowBudget(atHour(499, now), now).status, "warn");
    const over = airNowBudget(atHour(500, now), now);
    assert.equal(over.status, "over");
    assert.equal(over.requestsInLastHour, 500);
    assert.equal(over.limitPerHour, 500);
    const noaaOnly = buildStatus({
      asOf: new Date(now).toISOString(),
      ingests: { noaa: null, airnow: null, purpleair: null },
      places: [],
      calls: Array.from({ length: 500 }, () => ({
        source: "noaa" as const,
        calledAt: new Date(now).toISOString(),
        outcome: "ok" as const,
        points: null,
      })),
    });
    assert.equal(noaaOnly.budget.airnow.status, "ok");
    assert.equal(noaaOnly.budget.airnow.requestsInLastHour, 0);
  });

  it("projects PurpleAir points per month from the call window and does not spend", () => {
    const calls = [
      { calledAtMs: NOW - PROJECTION_WINDOW_MS, points: 10 },
      { calledAtMs: NOW - PROJECTION_WINDOW_MS + 1, points: 12 },
      { calledAtMs: NOW + 1, points: 12 },
    ];
    assert.equal(projectPurpleAirPointsPerMonth(calls, NOW), 360);
    assert.equal(projectPurpleAirPointsPerMonth([], NOW), 0);
    assert.equal(
      projectPurpleAirPointsPerMonth([{ calledAtMs: NOW, points: 1 }], NOW, 7 * HOUR_MS),
      103,
    );
    const projected = buildStatus({
      asOf: AS_OF,
      ingests: { noaa: null, airnow: null, purpleair: null },
      places: [],
      calls: [
        {
          source: "purpleair",
          calledAt: new Date(NOW - PROJECTION_WINDOW_MS + 1).toISOString(),
          outcome: "error",
          points: 12,
        },
      ],
    });
    assert.equal(projected.budget.purpleair.pointsPerMonth, 360);
    assert.equal(projected.budget.purpleair.enabled, false);
    assert.equal(projected.budget.purpleair.spending, false);
    assert.equal(projected.budget.purpleair.status, "off");
    assert.equal(projected.budget.purpleair.windowMs, PROJECTION_WINDOW_MS);
    assert.equal(projected.budget.purpleair.monthMs, PROJECTION_MONTH_MS);
  });

  it("marks a feed stale one millisecond past its cadence", () => {
    const fresh = sourceHealth("noaa", new Date(NOW - NOAA_CADENCE_MS).toISOString(), NOW);
    assert.equal(fresh.stale, false);
    assert.equal(fresh.dropout, false);
    assert.equal(fresh.fallback, null);
    assert.equal(fresh.ageMs, NOAA_CADENCE_MS);
    const stale = sourceHealth("noaa", new Date(NOW - NOAA_CADENCE_MS - 1).toISOString(), NOW);
    assert.equal(stale.stale, true);
    assert.equal(stale.dropout, false);
    const air = sourceHealth("airnow", new Date(NOW - AIRNOW_CADENCE_MS - 1).toISOString(), NOW);
    assert.equal(air.stale, true);
    assert.equal(air.cadenceMs, AIRNOW_CADENCE_MS);
    assert.equal(sourceHealth("airnow", null, NOW).stale, true);
  });

  it("treats a down PurpleAir feed as dropout onto AirNow and NOAA", () => {
    const down = sourceHealth("purpleair", null, NOW);
    assert.equal(down.stale, true);
    assert.equal(down.dropout, true);
    assert.deepEqual(down.fallback, ["airnow", "noaa"]);
    const old = sourceHealth("purpleair", new Date(NOW - AIRNOW_CADENCE_MS - 1).toISOString(), NOW);
    assert.equal(old.dropout, true);
    assert.deepEqual(old.fallback, ["airnow", "noaa"]);
    const held = sourceHealth("purpleair", new Date(NOW - AIRNOW_CADENCE_MS).toISOString(), NOW);
    assert.equal(held.stale, false);
    assert.equal(held.dropout, false);
    assert.equal(held.fallback, null);
  });

  it("keeps forecast freshness per saved place inside the NOAA cadence", () => {
    const rows = forecastFreshness(
      [
        { placeId: "place-fresh", lastStoredAt: FRESH_AT },
        { placeId: "place-stale", lastStoredAt: STALE_AT },
        { placeId: "place-missing", lastStoredAt: null },
      ],
      NOW,
    );
    const byId = new Map(rows.map((row) => [row.placeId, row]));
    assert.equal(byId.get("place-fresh")?.fresh, true);
    assert.equal(byId.get("place-fresh")?.ageMs, NOAA_CADENCE_MS);
    assert.equal(byId.get("place-stale")?.fresh, false);
    assert.equal(byId.get("place-stale")?.ageMs, NOAA_CADENCE_MS + 1);
    assert.equal(byId.get("place-missing")?.fresh, false);
    assert.equal(byId.get("place-missing")?.lastStoredAt, null);
  });

  it("stores the ledger beside the v1 store without a url, user, or key", async () => {
    const sql = await openDb();
    const columns = await sql.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'upstream_call'
        order by column_name`,
    );
    assert.deepEqual(
      columns.map((row) => row.column_name),
      ["called_at", "endpoint_kind", "error_code", "id", "outcome", "points", "source"],
    );

    await assert.rejects(
      () =>
        recordUpstreamCall(sql, {
          source: "purpleair",
          endpointKind: "purpleair_sensors",
          calledAt: new Date(NOW),
          outcome: "ok",
          fields: ["api_key"],
          rows: 1,
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "purpleair_points",
    );
    await recordUpstreamCall(sql, {
      source: "purpleair",
      endpointKind: "purpleair_sensors",
      calledAt: new Date(NOW),
      outcome: "error",
      errorCode: "purpleair_fetch_failed",
      fields: ["humidity", "pm2.5_cf_1", "location_type"],
      rows: 4,
    });
    await recordUpstreamCall(sql, {
      source: "airnow",
      endpointKind: "airnow_current",
      calledAt: new Date(NOW),
      outcome: "ok",
    });
    const rows = await sql.query<Record<string, unknown>>("select * from upstream_call");
    const dumped = JSON.stringify(rows);
    assert.equal(dumped.includes("api_key"), false);
    assert.equal(dumped.includes("pm2.5_cf_1"), false);
    assert.equal(dumped.includes(KEY), false);
    assert.equal(dumped.includes("http"), false);
    const purple = rows.find((row) => row.source === "purpleair");
    assert.equal(purple?.points, 12);
    assert.equal(rows.find((row) => row.source === "airnow")?.points, null);
  });

  it("counts NOAA and AirNow attempts and skips calls that never leave", async () => {
    const sql = await openDb();
    const previous = process.env.AIRNOW_API_KEY;
    process.env.AIRNOW_API_KEY = KEY;
    const smokeUrl = hrrrSmokeAsciiUrl({
      cycleUtc: CYCLE,
      latIndex: 1,
      lonIndex: 1,
      hourStart: 0,
      hourEnd: 1,
    });
    const [gribUrl] = hrrrStabilityFilterUrls({
      cycleUtc: CYCLE,
      hourStart: 0,
      hourEnd: 0,
      south: 43.6,
      north: 43.7,
      west: -116.3,
      east: -116.2,
    });
    try {
      let calls = 0;
      const refuse = async () => {
        calls += 1;
        throw new Error("network disabled");
      };
      await assert.rejects(
        () => fetchNoaaAscii("https://api.purpleair.com/v1/sensors", refuse, sql),
        (err: unknown) => err instanceof V1RuleError && err.code === "purpleair_spend_not_approved",
      );
      await assert.rejects(
        () => fetchNoaaAscii(smokeUrl, refuse, sql),
        (err: unknown) => err instanceof Error && err.message === "network disabled",
      );
      assert.equal(calls, 1);
      await assert.rejects(
        () => fetchNoaaAscii(smokeUrl, async () => new Response("nope", { status: 503 }), sql),
        (err: unknown) => err instanceof V1RuleError && err.code === "noaa_fetch_failed",
      );
      const smoke = await fetchNoaaAscii(smokeUrl, async () => new Response("masden8m\n"), sql);
      assert.equal(smoke, "masden8m\n");
      await assert.rejects(
        () => fetchNoaaGrib(gribUrl ?? "", async () => new Response("nope"), sql),
        (err: unknown) => err instanceof V1RuleError && err.code === "noaa_stability_parse",
      );
      const grib = new Uint8Array(16);
      grib[0] = 0x47;
      await fetchNoaaGrib(gribUrl ?? "", async () => new Response(grib), sql);

      const missing = await fetchAirNowObservation(
        { latitude: 43.6151, longitude: -116.2029 },
        async () => {
          throw new Error("network disabled");
        },
        sql,
      );
      delete process.env.AIRNOW_API_KEY;
      assert.equal(missing.ok, false);
      const skipped = await fetchAirNowObservation(
        { latitude: 43.6151, longitude: -116.2029 },
        async () => {
          calls += 1;
          throw new Error("network disabled");
        },
        sql,
      );
      assert.equal(skipped.ok, false);
      if (!skipped.ok) assert.equal(skipped.code, "airnow_api_key_missing");
      assert.equal(calls, 1);

      process.env.AIRNOW_API_KEY = KEY;
      const fetched = await fetchAirNowObservation(
        { latitude: 43.6151, longitude: -116.2029 },
        async (url) => {
          assert.equal(new URL(String(url)).searchParams.get("API_KEY"), KEY);
          return new Response(
            JSON.stringify([
              {
                DateObserved: "2026-10-30",
                HourObserved: 12,
                LocalTimeZone: "MST",
                AQI: 48,
                ParameterName: "PM2.5",
              },
            ]),
            { status: 200 },
          );
        },
        sql,
      );
      assert.equal(fetched.ok, true);
    } finally {
      if (previous === undefined) delete process.env.AIRNOW_API_KEY;
      else process.env.AIRNOW_API_KEY = previous;
    }

    const rows = await sql.query<{
      source: string;
      endpoint_kind: string;
      outcome: string;
      error_code: string | null;
      points: number | null;
    }>("select source, endpoint_kind, outcome, error_code, points from upstream_call");
    const dumped = JSON.stringify(rows);
    assert.equal(dumped.includes(KEY), false);
    assert.equal(dumped.includes("purpleair.com"), false);
    assert.equal(dumped.includes("43.6151"), false);
    const got = rows
      .map((row) => [row.source, row.endpoint_kind, row.outcome, row.error_code, row.points])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(got, [
      ["airnow", "airnow_current", "error", "airnow_fetch_failed", null],
      ["airnow", "airnow_current", "ok", null, null],
      ["noaa", "hrrr_smoke_ascii", "error", "noaa_fetch_failed", null],
      ["noaa", "hrrr_smoke_ascii", "error", "noaa_fetch_failed", null],
      ["noaa", "hrrr_smoke_ascii", "ok", null, null],
      ["noaa", "hrrr_stability_grib", "error", "noaa_stability_parse", null],
      ["noaa", "hrrr_stability_grib", "ok", null, null],
    ]);
    assert.equal(noaaEndpointKind(smokeUrl), "hrrr_smoke_ascii");
    assert.equal(noaaEndpointKind(gribUrl ?? ""), "hrrr_stability_grib");
  });

  it("reports stale places, PurpleAir dropout, and an over-budget hour", async () => {
    const sql = await openDb();
    const alpha = await addPlace(sql, "owner-alpha-441", "Monitor Ridge");
    const beta = await addPlace(sql, "owner-beta-442", "Monitor Bench");
    const gamma = await addPlace(sql, "owner-gamma-443", "Monitor Flat");
    await issueSmoke(sql, "owner-alpha-441", alpha.id);
    await issueSmoke(sql, "owner-beta-442", beta.id);
    await sql.query("update forecast_issued set created_at = $1 where place_id = $2", [
      FRESH_AT,
      alpha.id,
    ]);
    await sql.query("update forecast_issued set created_at = $1 where place_id = $2", [
      STALE_AT,
      beta.id,
    ]);
    await recordOfficial(sql, "owner-alpha-441", {
      placeId: alpha.id,
      observedAt: "2026-10-30T18:00:00.000Z",
      officialAqi: 48,
      officialRaw: "48",
      source: "airnow",
      preliminary: true,
      attribution: AIRNOW_ATTRIBUTION,
    });
    await sql.query("update official_reading set created_at = $1 where place_id = $2", [
      "2026-10-30T19:00:00.000Z",
      alpha.id,
    ]);
    await recordUpstreamCall(sql, {
      source: "purpleair",
      endpointKind: "purpleair_history",
      calledAt: new Date(NOW - PROJECTION_WINDOW_MS),
      outcome: "ok",
      fields: ["humidity"],
      rows: 10,
    });
    await recordUpstreamCall(sql, {
      source: "purpleair",
      endpointKind: "purpleair_sensors",
      calledAt: new Date(NOW - PROJECTION_WINDOW_MS + 1),
      outcome: "ok",
      fields: ["humidity", "pm2.5_cf_1", "location_type"],
      rows: 4,
    });
    await recordUpstreamCall(sql, {
      source: "airnow",
      endpointKind: "airnow_current",
      calledAt: new Date(NOW - HOUR_MS),
      outcome: "ok",
    });
    await recordUpstreamCall(sql, {
      source: "airnow",
      endpointKind: "airnow_current",
      calledAt: new Date(NOW - HOUR_MS + 1),
      outcome: "error",
      errorCode: "airnow_fetch_failed",
    });
    for (let i = 0; i < AIRNOW_HOURLY_LIMIT - 1; i += 1) {
      await recordUpstreamCall(sql, {
        source: "airnow",
        endpointKind: "airnow_current",
        calledAt: new Date(NOW),
        outcome: "ok",
      });
    }

    const response = await call(sql, "GET", `/api/v1/status?asOf=${encodeURIComponent(AS_OF)}`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as MonitoringStatus;
    assert.equal(body.asOf, AS_OF);
    assert.equal(body.feeds.noaa.stale, false);
    assert.equal(body.feeds.noaa.lastSuccessAt, FRESH_AT);
    assert.equal(body.feeds.noaa.dropout, false);
    assert.equal(body.feeds.airnow.stale, false);
    assert.equal(body.feeds.airnow.ageMs, AIRNOW_CADENCE_MS);
    assert.equal(body.feeds.purpleair.lastSuccessAt, null);
    assert.equal(body.feeds.purpleair.dropout, true);
    assert.deepEqual(body.feeds.purpleair.fallback, ["airnow", "noaa"]);
    assert.equal(body.budget.airnow.requestsInLastHour, 500);
    assert.equal(body.budget.airnow.status, "over");
    assert.equal(body.budget.purpleair.pointsPerMonth, 360);
    assert.equal(body.budget.purpleair.spending, false);
    assert.equal(body.budget.purpleair.status, "off");
    assert.equal(body.forecastStore.placeCount, 3);
    assert.equal(body.forecastStore.freshCount, 1);
    assert.equal(body.forecastStore.staleCount, 1);
    assert.equal(body.forecastStore.missingCount, 1);
    assert.deepEqual(body.forecastStore.places, [
      { lastStoredAt: null, ageMs: null, fresh: false },
      { lastStoredAt: STALE_AT, ageMs: NOAA_CADENCE_MS + 1, fresh: false },
      { lastStoredAt: FRESH_AT, ageMs: NOAA_CADENCE_MS, fresh: true },
    ]);

    const dumped = JSON.stringify(body);
    for (const secret of [
      alpha.id,
      beta.id,
      gamma.id,
      "owner-alpha-441",
      "owner-beta-442",
      "owner-gamma-443",
      "Monitor Ridge",
      "Monitor Bench",
      "Monitor Flat",
      "Treasure Valley",
      "43.6151",
      "-116.2029",
      AIRNOW_ATTRIBUTION,
      "pm2.5_cf_1",
      KEY,
    ]) {
      assert.equal(dumped.includes(secret), false, secret);
    }
    assert.equal(dumped.includes("42"), false);

    const other = await call(
      sql,
      "GET",
      `/api/v1/status?asOf=${encodeURIComponent(AS_OF)}`,
      "owner-beta-442",
    );
    assert.deepEqual(await other.json(), body);

    const posted = await call(sql, "POST", "/api/v1/status");
    assert.equal(posted.status, 405);
    assert.deepEqual(await posted.json(), {
      error: "method_not_allowed",
      message: "Method not allowed",
    });
    const removed = await call(sql, "DELETE", "/api/v1/status");
    assert.equal(removed.status, 405);
    const badClock = await call(sql, "GET", "/api/v1/status?asOf=tomorrow");
    assert.equal(badClock.status, 400);
    assert.equal(((await badClock.json()) as { error: string }).error, "invalid_time");
    const impossible = await call(sql, "GET", "/api/v1/status?asOf=2026-02-30T00:00:00.000Z");
    assert.equal(impossible.status, 400);
    assert.equal(((await impossible.json()) as { error: string }).error, "invalid_time");
  });

  it("counts a stability write as NOAA ingest and a recorded cycle as no call", async () => {
    const sql = await openDb();
    const place = await addPlace(sql, "owner-alpha-441", "Monitor Ridge");
    await recordStability(sql, "owner-alpha-441", {
      placeId: place.id,
      issuedAt: CYCLE,
      validFor: CYCLE,
      tmp2mK: 270,
      hpblM: 80,
      wind10mMs: 1,
    });
    await sql.query("update stability_issued set created_at = $1", [FRESH_AT]);
    const status = await readMonitoringStatus(sql, AS_OF);
    assert.equal(status.feeds.noaa.lastSuccessAt, FRESH_AT);
    assert.equal(status.feeds.noaa.stale, false);
    assert.equal(status.forecastStore.missingCount, 1);
    assert.equal(status.feeds.airnow.lastSuccessAt, null);
    assert.equal(status.feeds.airnow.stale, true);
    assert.equal(status.feeds.airnow.dropout, false);

    const recorded = await openDb();
    const saved = await addPlace(recorded, "owner-alpha-441", "Monitor Ridge");
    await ingestRecordedNoaa(recorded, "owner-alpha-441", {
      placeId: saved.id,
      issuedAt: CYCLE,
      smokeAscii: readFileSync(join(root, "fixtures/v1/noaa-hrrr-smoke.ascii"), "utf8"),
      aqfAscii: readFileSync(join(root, "fixtures/v1/noaa-aqf.ascii"), "utf8"),
    });
    const calls = await recorded.query<{ n: number }>(
      "select count(*)::int as n from upstream_call",
    );
    assert.equal(calls[0]?.n, 0);
    const after = await readMonitoringStatus(recorded, new Date().toISOString());
    assert.equal(after.feeds.noaa.stale, false);
    assert.equal(after.forecastStore.freshCount, 1);
  });

  it("counts the live AirNow fallback and still writes NOAA when the body fails", async () => {
    const previous = process.env.AIRNOW_API_KEY;
    process.env.AIRNOW_API_KEY = KEY;
    try {
      const sql = await openDb();
      const place = await addPlace(sql, "owner-alpha-441", "Monitor Ridge");
      const result = await fallbackSensorDropout(sql, "owner-alpha-441", {
        samples: [
          { location: "indoor", pmCf1: 80, relativeHumidity: 30 },
          { location: "outdoor", pmCf1: null, relativeHumidity: 30 },
        ],
        placeId: place.id,
        issuedAt: CYCLE,
        smokeAscii: readFileSync(join(root, "fixtures/v1/noaa-hrrr-smoke.ascii"), "utf8"),
        point: { latitude: 43.6151, longitude: -116.2029 },
        fetchImpl: async () => new Response("nope", { status: 500 }),
      });
      assert.equal(result.airnowError, "airnow_fetch_failed");
      assert.equal(result.forecast.source, "noaa_smoke");
      const rows = await sql.query<{ source: string; outcome: string; error_code: string | null }>(
        "select source, outcome, error_code from upstream_call",
      );
      assert.deepEqual(rows, [
        { source: "airnow", outcome: "error", error_code: "airnow_fetch_failed" },
      ]);
      const dumped = JSON.stringify(rows);
      assert.equal(dumped.includes(KEY), false);
    } finally {
      if (previous === undefined) delete process.env.AIRNOW_API_KEY;
      else process.env.AIRNOW_API_KEY = previous;
    }
  });
});
