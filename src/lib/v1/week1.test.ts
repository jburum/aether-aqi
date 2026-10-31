import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { V1RuleError } from "./errors.ts";
import { handleV1 } from "./http.ts";
import {
  epaPurpleAirPm25,
  ingestOutdoorSensors,
  outdoorReadings,
  planSensorGap,
  type SensorSample,
} from "./purpleair.ts";
import { TestPushSender, type PushSender } from "./push.ts";
import { parseForecastInput, parseOfficialInput } from "./rules.ts";
import {
  SAMPLE_FORECAST_DAY1,
  SAMPLE_FORECAST_DAY5,
  SAMPLE_FORECAST_DAY6,
  SAMPLE_ISSUED_AT,
  SAMPLE_OFFICIAL,
  SAMPLE_PLACE,
  SAMPLE_VALID_DAY1,
  samplePushPayloads,
} from "./samples.ts";
import {
  addSavedPlace,
  applySensorGap,
  deliverForecastPush,
  issueForecast,
  listBeside,
  recordOfficial,
  registerTestDevice,
} from "./store.ts";
import type { Queryable } from "./types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

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

function hoursAfter(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 3_600_000).toISOString();
}

async function seedPlace(sql: Queryable, userId = "user-a") {
  return addSavedPlace(sql, userId, SAMPLE_PLACE);
}

describe("v1 week 1", { concurrency: 1 }, () => {
  it("keeps the official number and the corrected forecast in different tables", async () => {
    const sql = await openDb();
    const place = await seedPlace(sql);
    const forecast = await issueForecast(sql, "user-a", {
      ...SAMPLE_FORECAST_DAY1,
      placeId: place.id,
    });
    const official = await recordOfficial(sql, "user-a", {
      ...SAMPLE_OFFICIAL,
      placeId: place.id,
    });

    assert.equal(forecast.correctedAqi, 155);
    assert.equal(official.officialAqi, 48);
    assert.equal(official.officialRaw, "48");
    assert.equal(official.preliminary, true);
    assert.match(official.attribution, /AirNow/);

    const forecastColumns = await sql.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'forecast_issued'`,
    );
    const officialColumns = await sql.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'official_reading'`,
    );
    const forecastNames = forecastColumns.map((row) => row.column_name);
    const officialNames = officialColumns.map((row) => row.column_name);
    assert.ok(forecastNames.includes("corrected_aqi"));
    assert.equal(forecastNames.includes("official_aqi"), false);
    assert.equal(forecastNames.includes("official_raw"), false);
    assert.ok(officialNames.includes("official_aqi"));
    assert.equal(officialNames.includes("corrected_aqi"), false);

    const beside = await listBeside(sql, "user-a", place.id);
    assert.equal(beside.length, 1);
    assert.equal(beside[0]?.forecast.correctedAqi, 155);
    assert.equal(beside[0]?.official?.aqi, 48);
    assert.equal(beside[0]?.official?.raw, "48");

    const storedForecast = await sql.query<{ corrected_aqi: number }>(
      "select corrected_aqi from forecast_issued where id = $1",
      [forecast.id],
    );
    const storedOfficial = await sql.query<{ official_aqi: number; official_raw: string }>(
      "select official_aqi, official_raw from official_reading where id = $1",
      [official.id],
    );
    assert.equal(storedForecast[0]?.corrected_aqi, 155);
    assert.equal(storedOfficial[0]?.official_aqi, 48);
    assert.equal(storedOfficial[0]?.official_raw, "48");
  });

  it("leaves both numbers alone when they happen to match", async () => {
    const sql = await openDb();
    const place = await seedPlace(sql);
    await issueForecast(sql, "user-a", {
      ...SAMPLE_FORECAST_DAY1,
      placeId: place.id,
      correctedAqi: 100,
    });
    await recordOfficial(sql, "user-a", {
      placeId: place.id,
      observedAt: SAMPLE_VALID_DAY1,
      officialAqi: 100,
      officialRaw: "100",
    });
    const beside = await listBeside(sql, "user-a", place.id);
    assert.equal(beside[0]?.forecast.correctedAqi, 100);
    assert.equal(beside[0]?.official?.aqi, 100);
    assert.equal(beside[0]?.official?.source, "airnow");
    assert.equal("correctedAqi" in (beside[0]?.official ?? {}), false);
    assert.equal("aqi" in beside[0]!.forecast, false);
  });

  it("does not change the official row when a later forecast is issued", async () => {
    const sql = await openDb();
    const place = await seedPlace(sql);
    await issueForecast(sql, "user-a", { ...SAMPLE_FORECAST_DAY1, placeId: place.id });
    await recordOfficial(sql, "user-a", { ...SAMPLE_OFFICIAL, placeId: place.id });
    await issueForecast(sql, "user-a", {
      ...SAMPLE_FORECAST_DAY1,
      placeId: place.id,
      issuedAt: hoursAfter(SAMPLE_ISSUED_AT, 1),
      correctedAqi: 160,
    });
    const beside = await listBeside(sql, "user-a", place.id);
    assert.deepEqual(
      beside.map((row) => row.forecast.correctedAqi).sort((a, b) => a - b),
      [155, 160],
    );
    assert.deepEqual(
      beside.map((row) => row.official?.aqi),
      [48, 48],
    );
    const officialRows = await sql.query<{ n: number }>(
      "select count(*)::int as n from official_reading",
    );
    assert.equal(officialRows[0]?.n, 1);
  });

  it("refuses a second official write and keeps the first number", async () => {
    const sql = await openDb();
    const place = await seedPlace(sql);
    await recordOfficial(sql, "user-a", { ...SAMPLE_OFFICIAL, placeId: place.id });
    await assert.rejects(
      () =>
        recordOfficial(sql, "user-a", {
          placeId: place.id,
          observedAt: SAMPLE_VALID_DAY1,
          officialAqi: 90,
          officialRaw: "90",
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "official_already_recorded",
    );
    const rows = await sql.query<{ official_aqi: number }>(
      "select official_aqi from official_reading",
    );
    assert.equal(rows[0]?.official_aqi, 48);
  });

  it("rejects a corrected number on an official write and the reverse", () => {
    assert.throws(
      () =>
        parseOfficialInput({
          placeId: "place_boise",
          observedAt: SAMPLE_VALID_DAY1,
          officialAqi: 48,
          officialRaw: "48",
          correctedAqi: 155,
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "corrected_on_official",
    );
    assert.throws(
      () =>
        parseForecastInput({
          ...SAMPLE_FORECAST_DAY1,
          placeId: "place_boise",
          officialAqi: 48,
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "official_on_forecast",
    );
    assert.throws(
      () =>
        parseOfficialInput({
          placeId: "place_boise",
          observedAt: SAMPLE_VALID_DAY1,
          officialAqi: 48,
          officialRaw: "49",
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "official_altered",
    );
  });

  it("rejects Open-Meteo and PurpleAir before any row is written", async () => {
    const sql = await openDb();
    const place = await seedPlace(sql);
    for (const source of ["open-meteo", "OpenMeteo", "cams"]) {
      await assert.rejects(
        () =>
          issueForecast(sql, "user-a", {
            ...SAMPLE_FORECAST_DAY1,
            placeId: place.id,
            source,
          }),
        (err: unknown) => err instanceof V1RuleError && err.code === "open_meteo_not_for_launch",
      );
    }
    await assert.rejects(
      () =>
        issueForecast(sql, "user-a", {
          ...SAMPLE_FORECAST_DAY1,
          placeId: place.id,
          source: "purpleair",
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "purpleair_spend_not_approved",
    );
    const forecasts = await sql.query<{ n: number }>(
      "select count(*)::int as n from forecast_issued",
    );
    assert.equal(forecasts[0]?.n, 0);
  });

  it("enforces valley smoke for days 1-2 and NOAA or low confidence after that", async () => {
    const sql = await openDb();
    const place = await seedPlace(sql);
    await assert.rejects(
      () =>
        issueForecast(sql, "user-a", {
          ...SAMPLE_FORECAST_DAY1,
          placeId: place.id,
          spatialScale: "regional",
          confidence: "low",
          horizon: "day_3_7_regional_low_confidence",
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "day_1_2_valley_only",
    );
    const day5 = await issueForecast(sql, "user-a", {
      ...SAMPLE_FORECAST_DAY5,
      placeId: place.id,
    });
    assert.equal(day5.source, "noaa_aqf");
    assert.equal(day5.confidence, "model");
    const day6 = await issueForecast(sql, "user-a", {
      ...SAMPLE_FORECAST_DAY6,
      placeId: place.id,
    });
    assert.equal(day6.confidence, "low");
    assert.equal(day6.spatialScale, "regional");
    await assert.rejects(
      () =>
        issueForecast(sql, "user-a", {
          ...SAMPLE_FORECAST_DAY1,
          placeId: place.id,
          issuedAt: SAMPLE_ISSUED_AT,
          validFor: hoursAfter(SAMPLE_ISSUED_AT, 96),
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "day_3_7_source",
    );
    await assert.rejects(
      () =>
        issueForecast(sql, "user-a", {
          ...SAMPLE_FORECAST_DAY5,
          placeId: place.id,
          validFor: hoursAfter(SAMPLE_ISSUED_AT, 169),
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "outside_launch_window",
    );
  });

  it("caps saved places at 5 in the database", async () => {
    const sql = await openDb();
    for (let i = 0; i < 5; i += 1) {
      await addSavedPlace(sql, "user-a", {
        ...SAMPLE_PLACE,
        name: `Place ${i + 1}`,
        latitude: 43 + i / 10,
      });
    }
    await assert.rejects(
      () => addSavedPlace(sql, "user-a", { ...SAMPLE_PLACE, name: "Place 6" }),
      (err: unknown) => err instanceof V1RuleError && err.code === "place_cap",
    );
    await assert.rejects(() =>
      sql.query(
        `insert into saved_place (id, user_id, name, latitude, longitude, position)
         values ('sixth', 'user-a', 'Place 6', 43.6, -116.2, 6)`,
      ),
    );
    const mine = await sql.query<{ n: number }>(
      "select count(*)::int as n from saved_place where user_id = 'user-a'",
    );
    assert.equal(mine[0]?.n, 5);
    const other = await addSavedPlace(sql, "user-b", SAMPLE_PLACE);
    assert.equal(other.name, SAMPLE_PLACE.name);
  });

  it("hides one user's forecast from another", async () => {
    const sql = await openDb();
    const place = await seedPlace(sql, "user-a");
    const forecast = await issueForecast(sql, "user-a", {
      ...SAMPLE_FORECAST_DAY1,
      placeId: place.id,
    });
    const seen = await listBeside(sql, "user-b");
    assert.equal(seen.length, 0);
    await assert.rejects(
      () => recordOfficial(sql, "user-b", { ...SAMPLE_OFFICIAL, placeId: place.id }),
      (err: unknown) => err instanceof V1RuleError && err.code === "place_not_found",
    );
    assert.equal(forecast.correctedAqi, 155);
  });

  it("rejects a raw official or purpleair source in SQL", async () => {
    const sql = await openDb();
    const place = await seedPlace(sql);
    await assert.rejects(() =>
      sql.query(
        `insert into forecast_issued
           (id, place_id, user_id, source, issued_at, valid_for, horizon, spatial_scale,
            confidence, corrected_aqi)
         values ($1, $2, 'user-a', 'open-meteo', $3, $4, 'day_1_2_valley', 'valley', 'valley', 10)`,
        [crypto.randomUUID(), place.id, SAMPLE_ISSUED_AT, SAMPLE_VALID_DAY1],
      ),
    );
    await assert.rejects(() =>
      sql.query(
        `insert into official_reading
           (id, place_id, user_id, source, observed_at, official_aqi, official_raw, preliminary, attribution)
         values ($1, $2, 'user-a', 'purpleair', $3, 10, '10', true, $4)`,
        [
          crypto.randomUUID(),
          place.id,
          SAMPLE_VALID_DAY1,
          "Observations courtesy of the U.S. EPA AirNow program, not this row.",
        ],
      ),
    );
  });

  it("applies the EPA formula on samples and does not store PurpleAir", async () => {
    const corrected = epaPurpleAirPm25(10, 40);
    assert.ok(Math.abs(corrected - 7.542) < 1e-9);
    assert.throws(
      () => epaPurpleAirPm25(400, 40),
      (err: unknown) => err instanceof V1RuleError && err.code === "epa_correction_outside_range",
    );

    const indoor: SensorSample = { location: "indoor", pmCf1: 80, relativeHumidity: 30 };
    const dropped: SensorSample = { location: "outdoor", pmCf1: null, relativeHumidity: 30 };
    const outdoor: SensorSample = { location: "outdoor", pmCf1: 10, relativeHumidity: 40 };
    assert.equal(outdoorReadings([indoor, dropped]).length, 0);
    assert.deepEqual(planSensorGap([indoor, dropped]), {
      action: "fall_back_to_noaa_valley",
      officialAqi: null,
    });
    assert.deepEqual(planSensorGap([outdoor]), { action: "purpleair_blocked", stored: false });
    assert.throws(
      () => ingestOutdoorSensors([outdoor]),
      (err: unknown) => err instanceof V1RuleError && err.code === "purpleair_spend_not_approved",
    );

    const sql = await openDb();
    const place = await seedPlace(sql);
    await assert.rejects(
      () =>
        applySensorGap(sql, "user-a", [outdoor], {
          ...SAMPLE_FORECAST_DAY1,
          placeId: place.id,
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "purpleair_spend_not_approved",
    );
    const blockedForecasts = await sql.query<{ n: number }>(
      "select count(*)::int as n from forecast_issued",
    );
    const blockedOfficial = await sql.query<{ n: number }>(
      "select count(*)::int as n from official_reading",
    );
    assert.equal(blockedForecasts[0]?.n, 0);
    assert.equal(blockedOfficial[0]?.n, 0);

    const fallback = await applySensorGap(sql, "user-a", [indoor, dropped], {
      ...SAMPLE_FORECAST_DAY1,
      placeId: place.id,
    });
    assert.equal(fallback.officialAqi, null);
    assert.equal(fallback.forecast.correctedAqi, 155);
    assert.equal(fallback.forecast.source, "noaa_smoke");
    const officialAfter = await sql.query<{ n: number }>(
      "select count(*)::int as n from official_reading",
    );
    assert.equal(officialAfter[0]?.n, 0);
    const beside = await listBeside(sql, "user-a", place.id);
    assert.equal(beside[0]?.official, null);
    assert.equal(beside[0]?.forecast.correctedAqi, 155);
  });

  it("delivers a test push with the two numbers in separate fields", async () => {
    const sql = await openDb();
    const place = await seedPlace(sql);
    const forecast = await issueForecast(sql, "user-a", {
      ...SAMPLE_FORECAST_DAY1,
      placeId: place.id,
    });
    await recordOfficial(sql, "user-a", { ...SAMPLE_OFFICIAL, placeId: place.id });
    const sender = new TestPushSender();
    await registerTestDevice(sql, "user-a", "test-device-boise");
    const deliveries = await deliverForecastPush(sql, "user-a", forecast.id, sender);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.status, "sent");
    assert.equal(deliveries[0]?.sender, "test");
    assert.equal(sender.sent.length, 1);
    const payload = sender.sent[0];
    assert.ok(payload);
    assert.equal(payload.forecast.correctedAqi, 155);
    assert.equal(payload.official?.aqi, 48);
    assert.equal(payload.official?.raw, "48");
    assert.equal(payload.official?.preliminary, true);
    assert.match(payload.official?.attribution ?? "", /AirNow/);
    assert.equal(payload.forecast.source, "noaa_smoke");
    assert.equal("aqi" in payload.forecast, false);
    assert.equal(payload.official != null && "correctedAqi" in payload.official, false);

    const stored = await sql.query<{ corrected_aqi: number }>(
      "select corrected_aqi from forecast_issued where id = $1",
      [forecast.id],
    );
    const storedOfficial = await sql.query<{ official_aqi: number }>(
      "select official_aqi from official_reading",
    );
    assert.equal(stored[0]?.corrected_aqi, 155);
    assert.equal(storedOfficial[0]?.official_aqi, 48);

    const logged = await sql.query<{
      payload: { forecast: { correctedAqi: number }; official: { aqi: number } };
      sender: string;
    }>("select payload, sender from push_delivery");
    assert.equal(logged[0]?.sender, "test");
    assert.equal(logged[0]?.payload.forecast.correctedAqi, 155);
    assert.equal(logged[0]?.payload.official.aqi, 48);

    const apns: PushSender = {
      name: "apns",
      async send() {
        return { ok: true, providerId: "nope" };
      },
    };
    await assert.rejects(
      () => deliverForecastPush(sql, "user-a", forecast.id, apns),
      (err: unknown) => err instanceof V1RuleError && err.code === "push_sender_is_test_only",
    );
  });

  it("records a failed test send without editing either number", async () => {
    const sql = await openDb();
    const place = await seedPlace(sql);
    const forecast = await issueForecast(sql, "user-a", {
      ...SAMPLE_FORECAST_DAY1,
      placeId: place.id,
      correctedAqi: 155,
    });
    await recordOfficial(sql, "user-a", { ...SAMPLE_OFFICIAL, placeId: place.id });
    await registerTestDevice(sql, "user-a", "test-device-boise");
    const sender = new TestPushSender();
    sender.failNext = true;
    const deliveries = await deliverForecastPush(sql, "user-a", forecast.id, sender);
    assert.equal(deliveries[0]?.status, "failed");
    assert.equal(sender.sent.length, 0);
    const forecastRow = await sql.query<{ corrected_aqi: number }>(
      "select corrected_aqi from forecast_issued where id = $1",
      [forecast.id],
    );
    const officialRow = await sql.query<{ official_aqi: number }>(
      "select official_aqi from official_reading",
    );
    assert.equal(forecastRow[0]?.corrected_aqi, 155);
    assert.equal(officialRow[0]?.official_aqi, 48);
  });

  it("serves the sample payloads and the HTTP round trip", async () => {
    const payloads = samplePushPayloads();
    assert.equal(payloads.length, 3);
    assert.equal(payloads[0]?.forecast.correctedAqi, 155);
    assert.equal(payloads[0]?.official?.aqi, 48);
    assert.equal(payloads[1]?.forecast.source, "noaa_aqf");
    assert.equal(payloads[1]?.official, null);
    assert.equal(payloads[2]?.forecast.confidence, "low");
    assert.match(payloads[2]?.body ?? "", /low confidence/);

    const fixtureDir = join(root, "fixtures/v1");
    for (const [index, name] of ["push-day1.json", "push-day5.json", "push-day6.json"].entries()) {
      const file = JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as unknown;
      assert.deepEqual(file, payloads[index]);
    }

    const sql = await openDb();
    const sender = new TestPushSender();
    const call = (method: string, path: string, body?: unknown, userId = "user-a") =>
      handleV1(
        new Request(`http://localhost${path}`, {
          method,
          headers: body ? { "content-type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        }),
        { sql, userId, sender },
      );

    const samples = await call("GET", "/api/v1/push/samples");
    assert.equal(samples.status, 200);
    const sampleBody = (await samples.json()) as { sender: string; payloads: unknown[] };
    assert.equal(sampleBody.sender, "test");
    assert.equal(sampleBody.payloads.length, 3);

    const created = await call("POST", "/api/v1/places", SAMPLE_PLACE);
    assert.equal(created.status, 201);
    const { place } = (await created.json()) as { place: { id: string } };

    const issued = await call("POST", "/api/v1/forecasts", {
      ...SAMPLE_FORECAST_DAY1,
      placeId: place.id,
    });
    assert.equal(issued.status, 201);
    const { forecast } = (await issued.json()) as {
      forecast: { id: string; correctedAqi: number };
    };
    assert.equal(forecast.correctedAqi, 155);

    const observed = await call("POST", "/api/v1/observations", {
      ...SAMPLE_OFFICIAL,
      placeId: place.id,
    });
    assert.equal(observed.status, 201);

    const listed = await call("GET", `/api/v1/forecasts?placeId=${place.id}`);
    const listedBody = (await listed.json()) as {
      forecasts: { forecast: { correctedAqi: number }; official: { aqi: number } | null }[];
    };
    assert.equal(listedBody.forecasts[0]?.forecast.correctedAqi, 155);
    assert.equal(listedBody.forecasts[0]?.official?.aqi, 48);

    const other = await call("GET", "/api/v1/forecasts", undefined, "user-b");
    const otherBody = (await other.json()) as { forecasts: unknown[] };
    assert.equal(otherBody.forecasts.length, 0);

    await call("POST", "/api/v1/push/devices", { token: "test-device-boise", platform: "test" });
    const delivered = await call("POST", "/api/v1/push/deliver", { forecastId: forecast.id });
    assert.equal(delivered.status, 200);
    const deliveredBody = (await delivered.json()) as {
      deliveries: { payload: { forecast: { correctedAqi: number }; official: { aqi: number } } }[];
    };
    assert.equal(deliveredBody.deliveries[0]?.payload.forecast.correctedAqi, 155);
    assert.equal(deliveredBody.deliveries[0]?.payload.official.aqi, 48);

    const apns = await call("POST", "/api/v1/push/devices", {
      token: "test-device-boise",
      platform: "apns",
    });
    assert.equal(apns.status, 400);
    const apnsBody = (await apns.json()) as { error: string };
    assert.equal(apnsBody.error, "push_sender_is_test_only");
  });
});
