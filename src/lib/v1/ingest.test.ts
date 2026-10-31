import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { fetchAirNowObservation, officialInputFromAirNow, parseAirNowCurrent } from "./airnow.ts";
import { V1RuleError } from "./errors.ts";
import { fallbackSensorDropout, ingestRecordedAirNow, ingestRecordedNoaa } from "./ingest.ts";
import {
  aqfAsciiUrl,
  fetchNoaaAscii,
  forecastBodiesFromExtracts,
  hrrrSmokeAsciiUrl,
  parseHrrrSmoke,
} from "./noaa.ts";
import { concentrationTokenToTenths, pm25TenthsToAqi } from "./pm25-aqi.ts";
import { classifyForecastLead } from "./rules.ts";
import { ingestOutdoorSensors, type SensorSample } from "./purpleair.ts";
import { SAMPLE_PLACE } from "./samples.ts";
import { addSavedPlace, issueForecast, listBeside } from "./store.ts";
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

  it("stores the AirNow integer unaltered beside the corrected forecast", async () => {
    const sql = await openDb();
    const place = await addSavedPlace(sql, "user-a", SAMPLE_PLACE);
    await ingestRecordedNoaa(sql, "user-a", {
      placeId: place.id,
      issuedAt: CYCLE,
      smokeAscii: readFixture("noaa-hrrr-smoke.ascii"),
      aqfAscii: readFixture("noaa-aqf.ascii"),
    });
    const official = await ingestRecordedAirNow(
      sql,
      "user-a",
      place.id,
      readFixture("airnow-current.json"),
    );
    assert.equal(official.officialAqi, 48);
    assert.equal(official.officialRaw, "48");
    assert.equal(official.preliminary, true);
    assert.equal(official.source, "airnow");
    assert.match(official.attribution, /AirNow/);
    assert.equal(official.observedAt, hourStamp(CYCLE, 48));
    assert.equal("correctedAqi" in official, false);

    const beside = await listBeside(sql, "user-a", place.id);
    const hour48 = beside.find((row) => row.forecast.validFor === hourStamp(CYCLE, 48));
    assert.equal(hour48?.forecast.correctedAqi, 155);
    assert.equal(hour48?.forecast.source, "noaa_smoke");
    assert.equal(hour48?.official?.aqi, 48);
    assert.equal(hour48?.official?.raw, "48");
    assert.equal(hour48?.official?.preliminary, true);
    assert.equal(hour48?.official != null && "correctedAqi" in hour48.official, false);
    assert.equal(hour48 != null && "aqi" in hour48.forecast, false);

    const forecastColumns = await sql.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'forecast_issued'`,
    );
    const officialColumns = await sql.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'official_reading'`,
    );
    const forecastNames = forecastColumns.map((row) => row.column_name);
    const officialNames = officialColumns.map((row) => row.column_name);
    assert.equal(forecastNames.includes("corrected_aqi"), true);
    assert.equal(forecastNames.includes("official_aqi"), false);
    assert.equal(officialNames.includes("official_aqi"), true);
    assert.equal(officialNames.includes("corrected_aqi"), false);

    const corrected = await sql.query<{ corrected_aqi: number }>(
      "select corrected_aqi from forecast_issued",
    );
    const officialRows = await sql.query<{ official_aqi: number; official_raw: string }>(
      "select official_aqi, official_raw from official_reading",
    );
    assert.equal(
      corrected.some((row) => row.corrected_aqi === 48),
      false,
    );
    assert.equal(
      officialRows.some((row) => row.official_aqi === 155),
      false,
    );
    assert.equal(officialRows[0]?.official_raw, "48");

    const rewritten = readFixture("airnow-current.json").replace('"AQI": 48', '"AQI": 90');
    await assert.rejects(
      () => ingestRecordedAirNow(sql, "user-a", place.id, rewritten),
      (err: unknown) => err instanceof V1RuleError && err.code === "official_already_recorded",
    );
    const still = await sql.query<{ official_aqi: number }>(
      "select official_aqi from official_reading",
    );
    assert.equal(still[0]?.official_aqi, 48);
    assert.equal(still.length, 1);
  });

  it("does not round a non-integer AirNow AQI or take a corrected field", async () => {
    const floated = `[{
      "DateObserved": "2026-11-01",
      "HourObserved": 5,
      "LocalTimeZone": "MST",
      "ParameterName": "PM2.5",
      "AQI": 48.2,
      "correctedAqi": 155,
      "Category": { "Number": 2, "Name": "Moderate" }
    }]`;
    const parsed = parseAirNowCurrent(floated);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.code, "airnow_aqi_not_integer");

    const decoy = readFixture("airnow-current.json").replace(
      '"AQI": 48',
      '"AQI": 48, "correctedAqi": 155',
    );
    const kept = parseAirNowCurrent(decoy);
    assert.equal(kept.ok, true);
    if (kept.ok) {
      assert.equal(kept.reading.aqi, 48);
      assert.equal(kept.reading.raw, "48");
      const input = officialInputFromAirNow("place_boise", kept.reading);
      assert.equal(input.officialAqi, 48);
      assert.equal(input.officialRaw, "48");
      assert.equal(input.preliminary, true);
      assert.equal("correctedAqi" in input, false);
    }

    const ozoneHigher = readFixture("airnow-current.json").replace('"AQI": 32', '"AQI": 60');
    const higher = parseAirNowCurrent(ozoneHigher);
    assert.equal(higher.ok, true);
    if (higher.ok) {
      assert.equal(higher.reading.aqi, 60);
      assert.equal(higher.reading.raw, "60");
      assert.equal(higher.reading.parameter, "O3");
    }

    const spaced = readFixture("airnow-current.json").replaceAll("2026-11-01", "2026-11-01 ");
    const trimmed = parseAirNowCurrent(spaced);
    assert.equal(trimmed.ok, true);
    if (trimmed.ok) assert.equal(trimmed.reading.observedAt, hourStamp(CYCLE, 48));

    const sql = await openDb();
    const place = await addSavedPlace(sql, "user-a", SAMPLE_PLACE);
    await assert.rejects(
      () => ingestRecordedAirNow(sql, "user-a", place.id, floated),
      (err: unknown) => err instanceof V1RuleError && err.code === "airnow_aqi_not_integer",
    );
    await assert.rejects(
      () => ingestRecordedAirNow(sql, "user-a", place.id, '{"source":"open-meteo","AQI":10}'),
      (err: unknown) => err instanceof V1RuleError && err.code === "open_meteo_not_for_launch",
    );
    const official = await sql.query<{ n: number }>(
      "select count(*)::int as n from official_reading",
    );
    assert.equal(official[0]?.n, 0);
  });

  it("skips AirNow when the key is unset and does not call out", async () => {
    const previous = process.env.AIRNOW_API_KEY;
    delete process.env.AIRNOW_API_KEY;
    let calls = 0;
    try {
      const missing = await fetchAirNowObservation(
        { latitude: 43.615, longitude: -116.202 },
        async () => {
          calls += 1;
          throw new Error("network disabled");
        },
      );
      assert.equal(missing.ok, false);
      if (!missing.ok) {
        assert.equal(missing.code, "airnow_api_key_missing");
        assert.match(missing.message, /AIRNOW_API_KEY/);
      }
      assert.equal(calls, 0);
    } finally {
      if (previous === undefined) delete process.env.AIRNOW_API_KEY;
      else process.env.AIRNOW_API_KEY = previous;
    }
  });

  it("reads AIRNOW_API_KEY from the environment and stores that payload", async () => {
    const previous = process.env.AIRNOW_API_KEY;
    process.env.AIRNOW_API_KEY = "fixture-key";
    try {
      let requested = "";
      const fetched = await fetchAirNowObservation(
        { latitude: 43.615, longitude: -116.202 },
        async (url) => {
          requested = String(url);
          return new Response(readFixture("airnow-current.json"), { status: 200 });
        },
      );
      assert.equal(fetched.ok, true);
      if (!fetched.ok) return;
      assert.equal(fetched.reading.aqi, 48);
      assert.equal(fetched.reading.raw, "48");
      const url = new URL(requested);
      assert.equal(url.hostname, "www.airnowapi.org");
      assert.equal(url.searchParams.get("API_KEY"), "fixture-key");
      assert.equal(url.searchParams.get("format"), "application/json");
      assert.equal(url.searchParams.get("distance"), "25");
      const sql = await openDb();
      const place = await addSavedPlace(sql, "user-a", SAMPLE_PLACE);
      const stored = await ingestRecordedAirNow(
        sql,
        "user-a",
        place.id,
        readFixture("airnow-current.json"),
      );
      assert.equal(stored.officialAqi, fetched.reading.aqi);
      assert.equal(stored.officialRaw, fetched.reading.raw);
    } finally {
      if (previous === undefined) delete process.env.AIRNOW_API_KEY;
      else process.env.AIRNOW_API_KEY = previous;
    }
  });

  it("falls back to AirNow plus NOAA and still refuses PurpleAir", async () => {
    const indoor: SensorSample = { location: "indoor", pmCf1: 80, relativeHumidity: 30 };
    const dropped: SensorSample = { location: "outdoor", pmCf1: null, relativeHumidity: 30 };
    const outdoor: SensorSample = { location: "outdoor", pmCf1: 10, relativeHumidity: 40 };
    assert.throws(
      () => ingestOutdoorSensors([outdoor]),
      (err: unknown) => err instanceof V1RuleError && err.code === "purpleair_spend_not_approved",
    );

    const sql = await openDb();
    const place = await addSavedPlace(sql, "user-a", SAMPLE_PLACE);
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      throw new Error("network disabled");
    };
    await assert.rejects(
      () =>
        fallbackSensorDropout(sql, "user-a", {
          samples: [outdoor],
          placeId: place.id,
          issuedAt: CYCLE,
          smokeAscii: readFixture("noaa-hrrr-smoke.ascii"),
          airnowBody: readFixture("airnow-current.json"),
          fetchImpl,
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "purpleair_spend_not_approved",
    );
    assert.equal(calls, 0);
    const blockedForecasts = await sql.query<{ n: number }>(
      "select count(*)::int as n from forecast_issued",
    );
    const blockedOfficial = await sql.query<{ n: number }>(
      "select count(*)::int as n from official_reading",
    );
    assert.equal(blockedForecasts[0]?.n, 0);
    assert.equal(blockedOfficial[0]?.n, 0);

    const paired = await fallbackSensorDropout(sql, "user-a", {
      samples: [indoor, dropped],
      placeId: place.id,
      issuedAt: CYCLE,
      smokeAscii: readFixture("noaa-hrrr-smoke.ascii"),
      airnowBody: readFixture("airnow-current.json"),
      fetchImpl,
    });
    assert.equal(calls, 0);
    assert.equal(paired.action, "fall_back_to_airnow_and_noaa");
    assert.equal(paired.airnowError, null);
    assert.equal(paired.forecast.source, "noaa_smoke");
    assert.equal(paired.forecast.correctedAqi, 27);
    assert.equal(paired.forecast.spatialScale, "valley");
    assert.equal(paired.officialAqi, 48);
    const forecastCount = await sql.query<{ n: number }>(
      "select count(*)::int as n from forecast_issued",
    );
    assert.equal(forecastCount[0]?.n, 1);
    const official = await sql.query<{ official_aqi: number; official_raw: string }>(
      "select official_aqi, official_raw from official_reading",
    );
    assert.equal(official[0]?.official_aqi, 48);
    assert.equal(official[0]?.official_raw, "48");

    const previous = process.env.AIRNOW_API_KEY;
    delete process.env.AIRNOW_API_KEY;
    const sql2 = await openDb();
    const place2 = await addSavedPlace(sql2, "user-a", SAMPLE_PLACE);
    try {
      const skipped = await fallbackSensorDropout(sql2, "user-a", {
        samples: [indoor, dropped],
        placeId: place2.id,
        issuedAt: CYCLE,
        smokeAscii: readFixture("noaa-hrrr-smoke.ascii"),
        fetchImpl,
      });
      assert.equal(calls, 0);
      assert.equal(skipped.officialAqi, null);
      assert.equal(skipped.airnowError, "airnow_api_key_missing");
      assert.equal(skipped.forecast.correctedAqi, 27);
      assert.equal(skipped.forecast.source, "noaa_smoke");
      const officialAfter = await sql2.query<{ n: number }>(
        "select count(*)::int as n from official_reading",
      );
      assert.equal(officialAfter[0]?.n, 0);
    } finally {
      if (previous === undefined) delete process.env.AIRNOW_API_KEY;
      else process.env.AIRNOW_API_KEY = previous;
    }
  });
});
