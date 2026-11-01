import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { V1RuleError } from "./errors.ts";
import { resolveModelCells } from "./grid.ts";
import { handleV1 } from "./http.ts";
import { AIRNOW_HOURLY_LIMIT } from "./monitoring.ts";
import { aqfAsciiUrl, hrrrSmokeAsciiUrl } from "./noaa.ts";
import { ingestPlaceCycle, ingestSavedPlaces, latestNoaaCycle } from "./place-ingest.ts";
import { TestPushSender } from "./push.ts";
import { SAMPLE_PLACE } from "./samples.ts";
import { addSavedPlace } from "./store.ts";
import type { Queryable } from "./types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const CYCLE = "2026-10-30T12:00:00.000Z";
const KEY = "fixture-key";
const BOISE = { latitude: 43.615, longitude: -116.202 };
const MCCALL = { name: "McCall", latitude: 44.911, longitude: -116.099, valley: "Long Valley" };
const TAMARACK = {
  name: "Tamarack",
  latitude: 44.671,
  longitude: -116.117,
  valley: "Long Valley",
};

function readFixture(name: string): string {
  return readFileSync(join(root, "fixtures/v1", name), "utf8");
}

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

async function grantPro(sql: Queryable, userId: string): Promise<void> {
  await sql.query(
    `insert into entitlement (user_id, tier, product, source, expires_at, state)
     values ($1, 'pro', 'yearly', 'storekit', '2099-01-01T00:00:00.000Z', 'active')`,
    [userId],
  );
}

function airNowBody(aqi: number): string {
  const rows = JSON.parse(readFixture("airnow-current.json")) as { AQI: number }[];
  for (const row of rows) row.AQI = aqi;
  return JSON.stringify(rows);
}

interface FakeFetch {
  fetchImpl: typeof fetch;
  urls: string[];
}

function fakeFetch(bodies: { smoke: string; aqf: string; airnow?: string }): FakeFetch {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("purpleair") || url.includes("open-meteo") || url.includes("openmeteo")) {
      throw new Error("refused host");
    }
    if (url.includes("masden8m")) return new Response(bodies.smoke, { status: 200 });
    if (url.includes("pm25sfc")) return new Response(bodies.aqf, { status: 200 });
    if (url.includes("airnowapi.org")) {
      if (bodies.airnow == null) throw new Error("airnow was called");
      return new Response(bodies.airnow, { status: 200 });
    }
    throw new Error("unexpected host");
  };
  return { fetchImpl, urls };
}

function leadHours(issuedAt: string, validFor: string | Date): number {
  return (new Date(validFor).getTime() - new Date(issuedAt).getTime()) / 3_600_000;
}

describe("v1 place ingest", { concurrency: 1 }, () => {
  it("picks the latest 00, 06, 12, or 18 UTC cycle", () => {
    assert.equal(latestNoaaCycle(new Date("2026-10-30T00:00:00.000Z")), "2026-10-30T00:00:00.000Z");
    assert.equal(latestNoaaCycle(new Date("2026-10-30T05:59:59.999Z")), "2026-10-30T00:00:00.000Z");
    assert.equal(latestNoaaCycle(new Date("2026-10-30T06:00:00.000Z")), "2026-10-30T06:00:00.000Z");
    assert.equal(latestNoaaCycle(new Date("2026-10-30T12:00:00.000Z")), CYCLE);
    assert.equal(latestNoaaCycle(new Date("2026-10-30T23:59:59.999Z")), "2026-10-30T18:00:00.000Z");
  });

  it("stores smoke through 48h and the air quality forecast after that", async () => {
    const previous = process.env.AIRNOW_API_KEY;
    process.env.AIRNOW_API_KEY = KEY;
    const sql = await openDb();
    const place = await addSavedPlace(sql, "user-a", SAMPLE_PLACE);
    const cells = resolveModelCells(BOISE.latitude, BOISE.longitude);
    const fake = fakeFetch({
      smoke: readFixture("noaa-hrrr-smoke.ascii"),
      aqf: readFixture("noaa-aqf.ascii"),
      airnow: readFixture("airnow-current.json"),
    });
    try {
      const stored = await ingestPlaceCycle(sql, "user-a", {
        placeId: place.id,
        cycleUtc: CYCLE,
        fetchImpl: fake.fetchImpl,
      });
      assert.deepEqual(stored.hrrr, cells.hrrr);
      assert.deepEqual(stored.aqm, cells.aqm);
      assert.equal(stored.forecastsStored, 7);
      assert.equal(stored.forecastsUnchanged, 0);
      assert.equal(stored.officialStatus, "stored");
      assert.equal(stored.officialAqi, 48);
      assert.equal(stored.airnowError, null);
      assert.deepEqual(fake.urls, [
        hrrrSmokeAsciiUrl({
          cycleUtc: CYCLE,
          latIndex: cells.hrrr.latIndex,
          lonIndex: cells.hrrr.lonIndex,
          hourStart: 0,
          hourEnd: 48,
        }),
        aqfAsciiUrl({
          cycleUtc: CYCLE,
          latIndex: cells.aqm.latIndex,
          lonIndex: cells.aqm.lonIndex,
          hourStart: 49,
          hourEnd: 168,
        }),
        fake.urls[2],
      ]);
      const airnowUrl = new URL(fake.urls[2] ?? "");
      assert.equal(airnowUrl.hostname, "www.airnowapi.org");
      assert.equal(airnowUrl.searchParams.get("API_KEY"), KEY);
      const rows = await sql.query<{
        source: string;
        valid_for: string | Date;
        corrected_aqi: number;
      }>("select source, valid_for, corrected_aqi from forecast_issued order by valid_for, source");
      assert.deepEqual(
        rows.map((row) => ({
          source: row.source,
          lead: leadHours(CYCLE, row.valid_for),
          corrected_aqi: row.corrected_aqi,
        })),
        [
          { source: "noaa_smoke", lead: 0, corrected_aqi: 27 },
          { source: "noaa_smoke", lead: 24, corrected_aqi: 63 },
          { source: "noaa_smoke", lead: 48, corrected_aqi: 155 },
          { source: "noaa_aqf", lead: 49, corrected_aqi: 56 },
          { source: "noaa_aqf", lead: 72, corrected_aqi: 101 },
          { source: "regional", lead: 96, corrected_aqi: 80 },
          { source: "noaa_aqf", lead: 168, corrected_aqi: 50 },
        ],
      );
      const ledger = await sql.query<{ source: string; endpoint_kind: string; outcome: string }>(
        "select source, endpoint_kind, outcome from upstream_call order by source, endpoint_kind",
      );
      assert.deepEqual(ledger, [
        { source: "airnow", endpoint_kind: "airnow_current", outcome: "ok" },
        { source: "noaa", endpoint_kind: "aqf_ascii", outcome: "ok" },
        { source: "noaa", endpoint_kind: "hrrr_smoke_ascii", outcome: "ok" },
      ]);
      const dumped = JSON.stringify(ledger);
      assert.equal(dumped.includes(KEY), false);
      assert.equal(dumped.includes("nomads"), false);
      assert.equal(dumped.includes("43.615"), false);
    } finally {
      if (previous === undefined) delete process.env.AIRNOW_API_KEY;
      else process.env.AIRNOW_API_KEY = previous;
    }
  });

  it("leaves a repeat cycle and the official number unchanged", async () => {
    const previous = process.env.AIRNOW_API_KEY;
    process.env.AIRNOW_API_KEY = KEY;
    const sql = await openDb();
    const place = await addSavedPlace(sql, "user-a", SAMPLE_PLACE);
    const first = fakeFetch({
      smoke: readFixture("noaa-hrrr-smoke.ascii"),
      aqf: readFixture("noaa-aqf.ascii"),
      airnow: readFixture("airnow-current.json"),
    });
    const second = fakeFetch({
      smoke: readFixture("noaa-hrrr-smoke.ascii").replace("4.8e-9", "6.12e-8"),
      aqf: readFixture("noaa-aqf.ascii"),
      airnow: airNowBody(90),
    });
    try {
      await ingestPlaceCycle(sql, "user-a", {
        placeId: place.id,
        cycleUtc: CYCLE,
        fetchImpl: first.fetchImpl,
      });
      const again = await ingestPlaceCycle(sql, "user-a", {
        placeId: place.id,
        cycleUtc: CYCLE,
        fetchImpl: second.fetchImpl,
      });
      assert.equal(again.forecastsStored, 0);
      assert.equal(again.forecastsUnchanged, 7);
      assert.equal(again.officialStatus, "unchanged");
      assert.equal(again.officialAqi, 48);
      const forecasts = await sql.query<{ n: number; aqi: number }>(
        `select count(*)::int as n,
                min(corrected_aqi) filter (where valid_for = issued_at) as aqi
           from forecast_issued`,
      );
      assert.equal(forecasts[0]?.n, 7);
      assert.equal(forecasts[0]?.aqi, 27);
      const official = await sql.query<{ n: number; official_aqi: number; official_raw: string }>(
        "select count(*)::int as n, official_aqi, official_raw from official_reading group by official_aqi, official_raw",
      );
      assert.equal(official.length, 1);
      assert.equal(official[0]?.n, 1);
      assert.equal(official[0]?.official_aqi, 48);
      assert.equal(official[0]?.official_raw, "48");
    } finally {
      if (previous === undefined) delete process.env.AIRNOW_API_KEY;
      else process.env.AIRNOW_API_KEY = previous;
    }
  });

  it("skips AirNow when the key is unset and does not call out", async () => {
    const previous = process.env.AIRNOW_API_KEY;
    delete process.env.AIRNOW_API_KEY;
    const sql = await openDb();
    const place = await addSavedPlace(sql, "user-a", SAMPLE_PLACE);
    const fake = fakeFetch({
      smoke: readFixture("noaa-hrrr-smoke.ascii"),
      aqf: readFixture("noaa-aqf.ascii"),
    });
    try {
      const stored = await ingestPlaceCycle(sql, "user-a", {
        placeId: place.id,
        cycleUtc: CYCLE,
        fetchImpl: fake.fetchImpl,
      });
      assert.equal(stored.airnowError, "airnow_api_key_missing");
      assert.equal(stored.officialStatus, "skipped");
      assert.equal(stored.officialAqi, null);
      assert.equal(stored.forecastsStored, 7);
      assert.equal(
        fake.urls.some((url) => url.includes("airnowapi.org")),
        false,
      );
      const official = await sql.query<{ n: number }>(
        "select count(*)::int as n from official_reading",
      );
      const airnowCalls = await sql.query<{ n: number }>(
        "select count(*)::int as n from upstream_call where source = 'airnow'",
      );
      assert.equal(official[0]?.n, 0);
      assert.equal(airnowCalls[0]?.n, 0);
    } finally {
      if (previous === undefined) delete process.env.AIRNOW_API_KEY;
      else process.env.AIRNOW_API_KEY = previous;
    }
  });

  it("refuses AirNow at 500 in the hour and does not call out", async () => {
    const previous = process.env.AIRNOW_API_KEY;
    process.env.AIRNOW_API_KEY = KEY;
    const sql = await openDb();
    const place = await addSavedPlace(sql, "user-a", SAMPLE_PLACE);
    await sql.query(
      `insert into upstream_call (id, source, endpoint_kind, called_at, outcome, error_code, points)
       select 'airnow-seed-' || i, 'airnow', 'airnow_current', clock_timestamp(), 'ok', null, null
         from generate_series(1, ${AIRNOW_HOURLY_LIMIT}) as i`,
    );
    const fake = fakeFetch({
      smoke: readFixture("noaa-hrrr-smoke.ascii"),
      aqf: readFixture("noaa-aqf.ascii"),
    });
    try {
      const stored = await ingestPlaceCycle(sql, "user-a", {
        placeId: place.id,
        cycleUtc: CYCLE,
        fetchImpl: fake.fetchImpl,
      });
      assert.equal(stored.airnowError, "airnow_hourly_limit");
      assert.equal(stored.officialStatus, "skipped");
      assert.equal(stored.forecastsStored, 7);
      assert.equal(
        fake.urls.some((url) => url.includes("airnowapi.org")),
        false,
      );
      const counts = await sql.query<{ source: string; n: number }>(
        "select source, count(*)::int as n from upstream_call group by source order by source",
      );
      assert.deepEqual(counts, [
        { source: "airnow", n: AIRNOW_HOURLY_LIMIT },
        { source: "noaa", n: 2 },
      ]);
      const official = await sql.query<{ n: number }>(
        "select count(*)::int as n from official_reading",
      );
      assert.equal(official[0]?.n, 0);
      assert.equal(JSON.stringify(counts).includes(KEY), false);
    } finally {
      if (previous === undefined) delete process.env.AIRNOW_API_KEY;
      else process.env.AIRNOW_API_KEY = previous;
    }
  });

  it("does not fetch when a saved place is outside the grid", async () => {
    const sql = await openDb();
    await grantPro(sql, "user-a");
    await addSavedPlace(sql, "user-a", SAMPLE_PLACE);
    await addSavedPlace(sql, "user-a", {
      name: "London",
      latitude: 51.507,
      longitude: -0.128,
      valley: null,
      alertAt: null,
    });
    const fake = fakeFetch({
      smoke: readFixture("noaa-hrrr-smoke.ascii"),
      aqf: readFixture("noaa-aqf.ascii"),
    });
    await assert.rejects(
      () =>
        ingestSavedPlaces(sql, "user-a", {
          cycleUtc: CYCLE,
          fetchImpl: fake.fetchImpl,
        }),
      (err: unknown) =>
        err instanceof V1RuleError &&
        err.code === "outside_model_coverage" &&
        /London/.test(err.message) &&
        /No upstream call was made/.test(err.message),
    );
    assert.equal(fake.urls.length, 0);
    const forecasts = await sql.query<{ n: number }>(
      "select count(*)::int as n from forecast_issued",
    );
    const calls = await sql.query<{ n: number }>("select count(*)::int as n from upstream_call");
    assert.equal(forecasts[0]?.n, 0);
    assert.equal(calls[0]?.n, 0);
  });

  it("ingests only the signed-in user's places through POST /api/v1/ingest/run", async () => {
    const previous = process.env.AIRNOW_API_KEY;
    process.env.AIRNOW_API_KEY = KEY;
    const sql = await openDb();
    await grantPro(sql, "user-a");
    const boise = await addSavedPlace(sql, "user-a", SAMPLE_PLACE);
    const mccall = await addSavedPlace(sql, "user-a", { ...MCCALL, alertAt: 100 });
    const tamarack = await addSavedPlace(sql, "user-b", { ...TAMARACK, alertAt: 100 });
    const fake = fakeFetch({
      smoke: readFixture("noaa-hrrr-smoke.ascii"),
      aqf: readFixture("noaa-aqf.ascii"),
      airnow: readFixture("airnow-current.json"),
    });
    const sender = new TestPushSender();
    try {
      const denied = await handleV1(new Request("http://localhost/api/v1/ingest/run"), {
        sql,
        userId: "user-a",
        sender,
        fetchImpl: fake.fetchImpl,
      });
      assert.equal(denied.status, 405);
      const badCycle = await handleV1(
        new Request("http://localhost/api/v1/ingest/run", {
          method: "POST",
          body: JSON.stringify({ cycleUtc: "2026-10-30T11:00:00.000Z" }),
        }),
        { sql, userId: "user-a", sender, fetchImpl: fake.fetchImpl },
      );
      assert.equal(badCycle.status, 400);
      const badBody = (await badCycle.json()) as { error: string; message: string };
      assert.equal(badBody.error, "noaa_cycle");
      assert.equal(typeof badBody.message, "string");
      assert.equal(fake.urls.length, 0);

      const response = await handleV1(
        new Request("http://localhost/api/v1/ingest/run", {
          method: "POST",
          body: JSON.stringify({ cycleUtc: CYCLE }),
        }),
        { sql, userId: "user-a", sender, fetchImpl: fake.fetchImpl },
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        cycleUtc: string;
        places: {
          placeId: string;
          hrrr: { latIndex: number; lonIndex: number };
          officialAqi: number;
        }[];
      };
      assert.equal(body.cycleUtc, CYCLE);
      assert.deepEqual(
        body.places.map((place) => place.placeId),
        [boise.id, mccall.id],
      );
      assert.deepEqual(body.places[0]?.hrrr, { latIndex: 755, lonIndex: 440 });
      assert.deepEqual(body.places[1]?.hrrr, { latIndex: 799, lonIndex: 442 });
      assert.equal(JSON.stringify(body).includes(KEY), false);
      const others = await sql.query<{ n: number }>(
        "select count(*)::int as n from forecast_issued where place_id = $1",
        [tamarack.id],
      );
      assert.equal(others[0]?.n, 0);
      const smokeUrls = fake.urls.filter((url) => url.includes("masden8m"));
      assert.equal(smokeUrls.length, 2);
      assert.match(smokeUrls[0] ?? "", /\[0:48\]\[755:755\]\[440:440\]/);
      assert.match(smokeUrls[1] ?? "", /\[0:48\]\[799:799\]\[442:442\]/);
    } finally {
      if (previous === undefined) delete process.env.AIRNOW_API_KEY;
      else process.env.AIRNOW_API_KEY = previous;
    }
  });

  it("uses the latest cycle when the POST body is empty", async () => {
    const previous = process.env.AIRNOW_API_KEY;
    delete process.env.AIRNOW_API_KEY;
    const sql = await openDb();
    await addSavedPlace(sql, "user-a", SAMPLE_PLACE);
    const fake = fakeFetch({
      smoke: readFixture("noaa-hrrr-smoke.ascii"),
      aqf: readFixture("noaa-aqf.ascii"),
    });
    const before = latestNoaaCycle(new Date());
    try {
      const response = await handleV1(
        new Request("http://localhost/api/v1/ingest/run", { method: "POST" }),
        { sql, userId: "user-a", sender: new TestPushSender(), fetchImpl: fake.fetchImpl },
      );
      const after = latestNoaaCycle(new Date());
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        cycleUtc: string;
        places: { forecastsStored: number }[];
      };
      assert.equal(body.cycleUtc === before || body.cycleUtc === after, true);
      assert.equal(body.places[0]?.forecastsStored, 7);
      const issued = await sql.query<{ issued_at: string | Date }>(
        "select distinct issued_at from forecast_issued",
      );
      assert.equal(issued.length, 1);
      assert.equal(new Date(issued[0].issued_at).toISOString(), body.cycleUtc);
    } finally {
      if (previous === undefined) delete process.env.AIRNOW_API_KEY;
      else process.env.AIRNOW_API_KEY = previous;
    }
  });
});
