import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { V1RuleError } from "./errors.ts";
import { ingestRecordedNoaa } from "./ingest.ts";
import {
  aqfAsciiUrl,
  fetchNoaaAscii,
  forecastBodiesFromExtracts,
  hrrrSmokeAsciiUrl,
  parseHrrrSmoke,
} from "./noaa.ts";
import { concentrationTokenToTenths, pm25TenthsToAqi } from "./pm25-aqi.ts";
import { classifyForecastLead } from "./rules.ts";
import { SAMPLE_PLACE } from "./samples.ts";
import { addSavedPlace, issueForecast } from "./store.ts";
import type { Queryable } from "./types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const CYCLE = "2026-10-30T12:00:00.000Z";

function readFixture(name: string): string {
  return readFileSync(join(root, "fixtures/v1", name), "utf8");
}

function hourStamp(issuedAt: string, hour: number): string {
  return new Date(new Date(issuedAt).getTime() + hour * 3_600_000).toISOString();
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

function networkDisabled(): typeof fetch {
  return async () => {
    throw new Error("network disabled");
  };
}

describe("v1 phase 1 ingest", { concurrency: 1 }, () => {
  it("converts NOAA PM2.5 with the 2024 breakpoints and leaves fill values empty", () => {
    assert.equal(pm25TenthsToAqi(0), 0);
    assert.equal(pm25TenthsToAqi(48), 27);
    assert.equal(pm25TenthsToAqi(90), 50);
    assert.equal(pm25TenthsToAqi(91), 51);
    assert.equal(pm25TenthsToAqi(120), 56);
    assert.equal(pm25TenthsToAqi(155), 63);
    assert.equal(pm25TenthsToAqi(354), 100);
    assert.equal(pm25TenthsToAqi(355), 101);
    assert.equal(pm25TenthsToAqi(612), 155);
    assert.equal(pm25TenthsToAqi(990), 181);
    assert.equal(pm25TenthsToAqi(3254), 500);
    assert.equal(pm25TenthsToAqi(3255), 500);
    assert.equal(concentrationTokenToTenths("6.12e-8", "kg/m3"), 612);
    assert.equal(concentrationTokenToTenths("1.55e-8", "kg/m3"), 155);
    assert.equal(concentrationTokenToTenths("4.8e-9", "kg/m3"), 48);
    assert.equal(concentrationTokenToTenths("9.90e1", "ug/m3"), 990);
    assert.equal(concentrationTokenToTenths("NaN", "ug/m3"), null);
    assert.equal(concentrationTokenToTenths("9.999e20", "ug/m3"), null);
    assert.equal(parseHrrrSmoke("masden8m, [1][1][1]\n[12][0][0] 9.999e20\n")[0]?.pm25Tenths, null);
  });

  it("keeps lead hour 48 on the smoke side and the next millisecond on days 3-7", async () => {
    const at48 = hourStamp(CYCLE, 48);
    const justAfter = new Date(new Date(CYCLE).getTime() + 48 * 3_600_000 + 1).toISOString();
    const at168 = hourStamp(CYCLE, 168);
    const past168 = new Date(new Date(CYCLE).getTime() + 168 * 3_600_000 + 1).toISOString();
    assert.equal(classifyForecastLead(CYCLE, hourStamp(CYCLE, 0)), "day_1_2");
    assert.equal(classifyForecastLead(CYCLE, at48), "day_1_2");
    assert.equal(classifyForecastLead(CYCLE, justAfter), "day_3_7");
    assert.equal(classifyForecastLead(CYCLE, at168), "day_3_7");
    assert.equal(classifyForecastLead(CYCLE, past168), "outside");

    const sql = await openDb();
    const place = await addSavedPlace(sql, "user-a", SAMPLE_PLACE);
    const smoke = await issueForecast(sql, "user-a", {
      placeId: place.id,
      source: "noaa_smoke",
      issuedAt: CYCLE,
      validFor: at48,
      horizon: "day_1_2_valley",
      spatialScale: "valley",
      confidence: "valley",
      correctedAqi: 155,
    });
    assert.equal(smoke.source, "noaa_smoke");
    assert.equal(smoke.spatialScale, "valley");
    await assert.rejects(
      () =>
        issueForecast(sql, "user-a", {
          placeId: place.id,
          source: "noaa_aqf",
          issuedAt: CYCLE,
          validFor: at48,
          horizon: "day_3_7_noaa_aqf",
          spatialScale: "regional",
          confidence: "model",
          correctedAqi: 181,
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "day_1_2_valley_only",
    );
    const aqf = await issueForecast(sql, "user-a", {
      placeId: place.id,
      source: "noaa_aqf",
      issuedAt: CYCLE,
      validFor: justAfter,
      horizon: "day_3_7_noaa_aqf",
      spatialScale: "regional",
      confidence: "model",
      correctedAqi: 56,
    });
    assert.equal(aqf.horizon, "day_3_7_noaa_aqf");
    await assert.rejects(
      () =>
        issueForecast(sql, "user-a", {
          placeId: place.id,
          source: "noaa_smoke",
          issuedAt: CYCLE,
          validFor: justAfter,
          horizon: "day_1_2_valley",
          spatialScale: "valley",
          confidence: "valley",
          correctedAqi: 155,
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "day_3_7_source",
    );
    const stored = await sql.query<{ source: string; corrected_aqi: number }>(
      "select source, corrected_aqi from forecast_issued order by valid_for",
    );
    assert.deepEqual(stored, [
      { source: "noaa_smoke", corrected_aqi: 155 },
      { source: "noaa_aqf", corrected_aqi: 56 },
    ]);
  });

  it("rejects Open-Meteo and PurpleAir before a request and builds keyless NOAA urls", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      throw new Error("network disabled");
    };
    await assert.rejects(
      () => fetchNoaaAscii("https://api.open-meteo.com/v1/forecast?latitude=43", fetchImpl),
      (err: unknown) => err instanceof V1RuleError && err.code === "open_meteo_not_for_launch",
    );
    await assert.rejects(
      () => fetchNoaaAscii("https://api.purpleair.com/v1/sensors", fetchImpl),
      (err: unknown) => err instanceof V1RuleError && err.code === "purpleair_spend_not_approved",
    );
    await assert.rejects(
      () => fetchNoaaAscii("https://nomads.ncep.noaa.gov/dods/hrrr?api_key=nope", fetchImpl),
      (err: unknown) => err instanceof V1RuleError && err.code === "noaa_url",
    );
    assert.equal(calls, 0);

    const smokeUrl = hrrrSmokeAsciiUrl({
      cycleUtc: CYCLE,
      latIndex: 100,
      lonIndex: 200,
      hourStart: 0,
      hourEnd: 48,
    });
    assert.match(
      smokeUrl,
      /^https:\/\/nomads\.ncep\.noaa\.gov\/dods\/hrrr\/hrrr20261030\/hrrr_sfc\.t12z\.ascii\?masden8m/,
    );
    assert.equal(smokeUrl.includes("API_KEY"), false);
    assert.equal(smokeUrl.includes("open-meteo"), false);
    const aqfUrl = aqfAsciiUrl({
      cycleUtc: CYCLE,
      latIndex: 40,
      lonIndex: 70,
      hourStart: 49,
      hourEnd: 168,
    });
    assert.match(
      aqfUrl,
      /^https:\/\/nomads\.ncep\.noaa\.gov\/dods\/aqm\/aqm20261030\/aqm\.t12z\.ascii\?pm25sfc/,
    );
    assert.throws(
      () =>
        hrrrSmokeAsciiUrl({
          cycleUtc: "2026-10-30T15:00:00.000Z",
          latIndex: 1,
          lonIndex: 1,
          hourStart: 0,
          hourEnd: 1,
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "noaa_cycle",
    );

    const fixture = readFixture("noaa-hrrr-smoke.ascii");
    const fetched = await fetchNoaaAscii(smokeUrl, async (requested) => {
      assert.equal(new URL(String(requested)).hostname, "nomads.ncep.noaa.gov");
      return new Response(fixture, { status: 200 });
    });
    assert.equal(
      parseHrrrSmoke(fetched).some((hour) => hour.hour === 48),
      true,
    );
    await assert.rejects(
      () => fetchNoaaAscii(smokeUrl, networkDisabled()),
      (err: unknown) => err instanceof Error && err.message === "network disabled",
    );
  });

  it("writes smoke through 48h and AQF after that, in separate forecast rows", async () => {
    const sql = await openDb();
    const place = await addSavedPlace(sql, "user-a", SAMPLE_PLACE);
    const stored = await ingestRecordedNoaa(sql, "user-a", {
      placeId: place.id,
      issuedAt: CYCLE,
      smokeAscii: readFixture("noaa-hrrr-smoke.ascii"),
      aqfAscii: readFixture("noaa-aqf.ascii"),
    });
    assert.equal(stored.length, 7);
    assert.equal(
      stored.some((row) => "officialAqi" in row || "aqi" in row),
      false,
    );

    const rows = await sql.query<{
      source: string;
      corrected_aqi: number;
      horizon: string;
      spatial_scale: string;
      confidence: string;
      valid_for: string | Date;
    }>(
      `select source, corrected_aqi, horizon, spatial_scale, confidence, valid_for
       from forecast_issued order by valid_for`,
    );
    const got = rows.map((row) => ({
      source: row.source,
      correctedAqi: row.corrected_aqi,
      horizon: row.horizon,
      spatialScale: row.spatial_scale,
      confidence: row.confidence,
      validFor: new Date(row.valid_for).toISOString(),
    }));
    assert.deepEqual(got, [
      {
        source: "noaa_smoke",
        correctedAqi: 27,
        horizon: "day_1_2_valley",
        spatialScale: "valley",
        confidence: "valley",
        validFor: hourStamp(CYCLE, 0),
      },
      {
        source: "noaa_smoke",
        correctedAqi: 63,
        horizon: "day_1_2_valley",
        spatialScale: "valley",
        confidence: "valley",
        validFor: hourStamp(CYCLE, 24),
      },
      {
        source: "noaa_smoke",
        correctedAqi: 155,
        horizon: "day_1_2_valley",
        spatialScale: "valley",
        confidence: "valley",
        validFor: hourStamp(CYCLE, 48),
      },
      {
        source: "noaa_aqf",
        correctedAqi: 56,
        horizon: "day_3_7_noaa_aqf",
        spatialScale: "regional",
        confidence: "model",
        validFor: hourStamp(CYCLE, 49),
      },
      {
        source: "noaa_aqf",
        correctedAqi: 101,
        horizon: "day_3_7_noaa_aqf",
        spatialScale: "regional",
        confidence: "model",
        validFor: hourStamp(CYCLE, 72),
      },
      {
        source: "regional",
        correctedAqi: 80,
        horizon: "day_3_7_regional_low_confidence",
        spatialScale: "regional",
        confidence: "low",
        validFor: hourStamp(CYCLE, 96),
      },
      {
        source: "noaa_aqf",
        correctedAqi: 50,
        horizon: "day_3_7_noaa_aqf",
        spatialScale: "regional",
        confidence: "model",
        validFor: hourStamp(CYCLE, 168),
      },
    ]);
    assert.equal(
      got.some((row) => row.correctedAqi === 181),
      false,
    );

    const official = await sql.query<{ n: number }>(
      "select count(*)::int as n from official_reading",
    );
    assert.equal(official[0]?.n, 0);
    const forecastColumns = await sql.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'forecast_issued'`,
    );
    const names = forecastColumns.map((row) => row.column_name);
    assert.equal(names.includes("corrected_aqi"), true);
    assert.equal(names.includes("official_aqi"), false);
    assert.equal(names.includes("official_raw"), false);

    await assert.rejects(
      () =>
        issueForecast(sql, "user-a", {
          placeId: place.id,
          source: "open-meteo",
          issuedAt: CYCLE,
          validFor: hourStamp(CYCLE, 1),
          horizon: "day_1_2_valley",
          spatialScale: "valley",
          confidence: "valley",
          correctedAqi: 10,
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "open_meteo_not_for_launch",
    );
    await assert.rejects(
      () =>
        ingestRecordedNoaa(sql, "user-a", {
          placeId: place.id,
          issuedAt: CYCLE,
          smokeAscii: "source open-meteo\nmasden8m, [1][1][1]\n[1][0][0] 4.8e-9\n",
          aqfAscii: readFixture("noaa-aqf.ascii"),
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "open_meteo_not_for_launch",
    );
    const afterReject = await sql.query<{ n: number }>(
      "select count(*)::int as n from forecast_issued",
    );
    assert.equal(afterReject[0]?.n, 7);
  });

  it("prefers an AQF model cell over regional guidance for the same hour", () => {
    const bodies = forecastBodiesFromExtracts({
      placeId: "place_boise",
      issuedAt: CYCLE,
      smokeAscii: "masden8m, [1][1][1]\n[0][0][0] 4.8e-9\n",
      aqfAscii: "pm25sfc, [1][1][1]\n[49][0][0] 1.20e1\nguidance, [49] regional_low 10\n",
    });
    const day3 = bodies.find((row) => row.validFor === hourStamp(CYCLE, 49));
    assert.equal(day3?.source, "noaa_aqf");
    assert.equal(day3?.correctedAqi, 56);
    assert.equal(day3?.confidence, "model");
  });
});
