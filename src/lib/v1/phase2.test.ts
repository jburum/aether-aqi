import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { handleV1 } from "./http.ts";
import {
  readBestWindow,
  readOutlook,
  type BestWindowResponse,
  type OutlookResponse,
} from "./phase2.ts";
import { TestPushSender } from "./push.ts";
import { AIRNOW_ATTRIBUTION } from "./rules.ts";
import { addSavedPlace, issueForecast, recordOfficial } from "./store.ts";
import type { Queryable } from "./types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const TIME_ZONE = "America/Phoenix";

interface FixtureHour {
  issuedAt: string;
  validFor: string;
  correctedAqi: number;
  kind: "valley" | "model" | "low";
}

interface FixtureCase {
  asOf: string;
  hours: FixtureHour[];
}

const fixture = JSON.parse(readFileSync(join(root, "fixtures/v1/phase2-window.json"), "utf8")) as {
  timeZone: string;
  tie: FixtureCase;
  boundary: FixtureCase;
  bandEdge: FixtureCase;
  latest: FixtureCase;
  split: FixtureCase;
  laterOnly: FixtureCase;
};

const KINDS = {
  valley: {
    source: "noaa_smoke",
    horizon: "day_1_2_valley",
    spatialScale: "valley",
    confidence: "valley",
  },
  model: {
    source: "noaa_aqf",
    horizon: "day_3_7_noaa_aqf",
    spatialScale: "regional",
    confidence: "model",
  },
  low: {
    source: "regional",
    horizon: "day_3_7_regional_low_confidence",
    spatialScale: "regional",
    confidence: "low",
  },
} as const;

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

function watching(sql: Queryable): { sql: Queryable; texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    sql: {
      query: async <T>(text: string, params: unknown[] = []) => {
        texts.push(text);
        return sql.query<T>(text, params);
      },
    },
  };
}

async function seed(sql: Queryable, userId = "user-a") {
  return addSavedPlace(sql, userId, {
    name: "Phoenix",
    latitude: 33.4484,
    longitude: -112.074,
    valley: null,
    alertAt: null,
  });
}

async function insertHours(
  sql: Queryable,
  userId: string,
  placeId: string,
  hours: readonly FixtureHour[],
) {
  for (const hour of hours) {
    await issueForecast(sql, userId, {
      placeId,
      issuedAt: hour.issuedAt,
      validFor: hour.validFor,
      correctedAqi: hour.correctedAqi,
      ...KINDS[hour.kind],
    });
  }
}

describe("v1 phase 2 best window and outlook", { concurrency: 1 }, () => {
  it("keeps the earlier run when the clean band ties, and ignores a longer dirtier run", async () => {
    const sql = await openDb();
    const place = await seed(sql);
    await insertHours(sql, "user-a", place.id, fixture.tie.hours);
    const result = await readBestWindow(sql, "user-a", place.id, fixture.tie.asOf);
    assert.equal(result.through, "2026-01-10T19:00:00.000Z");
    assert.deepEqual(result.bestWindow, {
      start: "2026-01-08T21:00:00.000Z",
      end: "2026-01-08T23:00:00.000Z",
      peakCorrectedAqi: 40,
      band: "good",
      sources: ["noaa_smoke"],
    });
  });

  it("includes the hour at exactly 48 hours and not one millisecond later", async () => {
    const sql = await openDb();
    const place = await seed(sql);
    await insertHours(sql, "user-a", place.id, fixture.boundary.hours);
    const result = await readBestWindow(sql, "user-a", place.id, fixture.boundary.asOf);
    assert.equal(result.through, "2026-01-10T19:00:00.000Z");
    assert.deepEqual(result.bestWindow, {
      start: "2026-01-10T19:00:00.000Z",
      end: "2026-01-10T20:00:00.000Z",
      peakCorrectedAqi: 25,
      band: "good",
      sources: ["noaa_smoke"],
    });
  });

  it("treats 50 as a lower band than a longer run of 51", async () => {
    const sql = await openDb();
    const place = await seed(sql);
    await insertHours(sql, "user-a", place.id, fixture.bandEdge.hours);
    const result = await readBestWindow(sql, "user-a", place.id, fixture.bandEdge.asOf);
    assert.deepEqual(result.bestWindow, {
      start: "2026-01-08T20:00:00.000Z",
      end: "2026-01-08T21:00:00.000Z",
      peakCorrectedAqi: 50,
      band: "good",
      sources: ["noaa_smoke"],
    });
  });

  it("uses the latest issue for a valid hour", async () => {
    const sql = await openDb();
    const place = await seed(sql);
    await insertHours(sql, "user-a", place.id, fixture.latest.hours);
    const result = await readBestWindow(sql, "user-a", place.id, fixture.latest.asOf);
    assert.deepEqual(result.bestWindow, {
      start: "2026-01-09T00:00:00.000Z",
      end: "2026-01-09T01:00:00.000Z",
      peakCorrectedAqi: 22,
      band: "good",
      sources: ["noaa_smoke"],
    });
  });

  it("returns none when the place has no stored hours", async () => {
    const sql = await openDb();
    const place = await seed(sql);
    const asOf = "2026-01-08T19:00:00.000Z";
    const window = await readBestWindow(sql, "user-a", place.id, asOf);
    assert.equal(window.bestWindow, "none");
    const outlook = await readOutlook(sql, "user-a", place.id, asOf, TIME_ZONE);
    assert.deepEqual(outlook.tomorrow, {
      date: "2026-01-09",
      weekday: "friday",
      summary: "no data",
    });
    assert.deepEqual(outlook.weekend.saturday, {
      date: "2026-01-10",
      weekday: "saturday",
      summary: "no data",
    });
    assert.deepEqual(outlook.weekend.sunday, {
      date: "2026-01-11",
      weekday: "sunday",
      summary: "no data",
    });
  });

  it("stops the best window at 48 hours and still summarizes the later day", async () => {
    const sql = await openDb();
    const place = await seed(sql);
    await insertHours(sql, "user-a", place.id, fixture.laterOnly.hours);
    const window = await readBestWindow(sql, "user-a", place.id, fixture.laterOnly.asOf);
    assert.equal(window.bestWindow, "none");
    const outlook = await readOutlook(sql, "user-a", place.id, fixture.laterOnly.asOf, TIME_ZONE);
    assert.equal(outlook.tomorrow.summary, "no data");
    assert.equal(outlook.weekend.saturday.summary, "no data");
    assert.deepEqual(outlook.weekend.sunday.summary, {
      worstCorrectedAqi: 90,
      typicalCorrectedAqi: 90,
      band: "moderate",
      confidence: "low",
      spatialScale: "regional",
      horizon: "day_3_7_regional_low_confidence",
      label: "regional and low-confidence",
    });
  });

  it("labels a day split across valley and regional hours as low-confidence", async () => {
    const sql = await openDb();
    const place = await seed(sql);
    await insertHours(sql, "user-a", place.id, fixture.split.hours);
    const outlook = await readOutlook(
      sql,
      "user-a",
      place.id,
      fixture.split.asOf,
      fixture.timeZone,
    );
    assert.equal(outlook.timeZone, TIME_ZONE);
    assert.deepEqual(outlook.tomorrow, {
      date: "2026-01-09",
      weekday: "friday",
      summary: {
        worstCorrectedAqi: 100,
        typicalCorrectedAqi: 25,
        band: "moderate",
        confidence: "valley",
        spatialScale: "valley",
        horizon: "day_1_2_valley",
        label: "valley",
      },
    });
    assert.deepEqual(outlook.weekend.saturday, {
      date: "2026-01-10",
      weekday: "saturday",
      summary: {
        worstCorrectedAqi: 80,
        typicalCorrectedAqi: 45,
        band: "moderate",
        confidence: "low",
        spatialScale: "regional",
        horizon: "day_3_7_regional_low_confidence",
        label: "regional and low-confidence",
      },
    });
    assert.deepEqual(outlook.weekend.sunday, {
      date: "2026-01-11",
      weekday: "sunday",
      summary: "no data",
    });
  });

  it("keeps this weekend when today is Saturday or Sunday", async () => {
    const sql = await openDb();
    const place = await seed(sql);
    const saturday = await readOutlook(
      sql,
      "user-a",
      place.id,
      "2026-01-10T19:00:00.000Z",
      TIME_ZONE,
    );
    assert.equal(saturday.tomorrow.date, "2026-01-11");
    assert.equal(saturday.weekend.saturday.date, "2026-01-10");
    assert.equal(saturday.weekend.sunday.date, "2026-01-11");
    const sunday = await readOutlook(
      sql,
      "user-a",
      place.id,
      "2026-01-11T19:00:00.000Z",
      TIME_ZONE,
    );
    assert.equal(sunday.tomorrow.date, "2026-01-12");
    assert.equal(sunday.tomorrow.weekday, "monday");
    assert.equal(sunday.weekend.saturday.date, "2026-01-10");
    assert.equal(sunday.weekend.sunday.date, "2026-01-11");
    assert.equal(sunday.weekend.sunday.summary, "no data");
  });

  it("does not let an official AirNow number change the window or the outlook", async () => {
    const sql = await openDb();
    const place = await seed(sql);
    await insertHours(sql, "user-a", place.id, fixture.tie.hours);
    const seen = watching(sql);
    const beforeWindow = await readBestWindow(seen.sql, "user-a", place.id, fixture.tie.asOf);
    const beforeOutlook = await readOutlook(
      seen.sql,
      "user-a",
      place.id,
      fixture.tie.asOf,
      TIME_ZONE,
    );
    assert.equal(
      seen.texts.some((text) => /official_/i.test(text)),
      false,
    );

    await recordOfficial(sql, "user-a", {
      placeId: place.id,
      observedAt: "2026-01-08T21:00:00.000Z",
      officialAqi: 500,
      officialRaw: "500",
      source: "airnow",
      preliminary: true,
      attribution: AIRNOW_ATTRIBUTION,
    });

    seen.texts.length = 0;
    const afterWindow = await readBestWindow(seen.sql, "user-a", place.id, fixture.tie.asOf);
    const afterOutlook = await readOutlook(
      seen.sql,
      "user-a",
      place.id,
      fixture.tie.asOf,
      TIME_ZONE,
    );
    assert.deepEqual(afterWindow, beforeWindow);
    assert.deepEqual(afterOutlook, beforeOutlook);
    assert.equal(JSON.stringify(afterWindow).includes("500"), false);
    assert.equal(JSON.stringify(afterOutlook).includes("500"), false);
    assert.equal(
      seen.texts.some((text) => /official_/i.test(text)),
      false,
    );
  });

  it("serves the reads to the owner and refuses other people and writes", async () => {
    const sql = await openDb();
    const sender = new TestPushSender();
    const place = await seed(sql);
    await insertHours(sql, "user-a", place.id, fixture.tie.hours);
    const asOf = encodeURIComponent(fixture.tie.asOf);
    const call = (method: string, path: string, userId = "user-a") =>
      handleV1(new Request(`http://localhost${path}`, { method }), { sql, userId, sender });

    const window = await call("GET", `/api/v1/places/${place.id}/best-window?asOf=${asOf}`);
    assert.equal(window.status, 200);
    const windowBody = (await window.json()) as BestWindowResponse;
    assert.equal(windowBody.placeId, place.id);
    assert.deepEqual(windowBody.bestWindow, {
      start: "2026-01-08T21:00:00.000Z",
      end: "2026-01-08T23:00:00.000Z",
      peakCorrectedAqi: 40,
      band: "good",
      sources: ["noaa_smoke"],
    });

    const outlook = await call(
      "GET",
      `/api/v1/places/${place.id}/outlook?asOf=${asOf}&timeZone=${encodeURIComponent(TIME_ZONE)}`,
    );
    assert.equal(outlook.status, 200);
    const outlookBody = (await outlook.json()) as OutlookResponse;
    assert.deepEqual(outlookBody.tomorrow, {
      date: "2026-01-09",
      weekday: "friday",
      summary: {
        worstCorrectedAqi: 64,
        typicalCorrectedAqi: 63,
        band: "moderate",
        confidence: "valley",
        spatialScale: "valley",
        horizon: "day_1_2_valley",
        label: "valley",
      },
    });
    assert.equal(outlookBody.weekend.saturday.summary, "no data");

    const other = await call(
      "GET",
      `/api/v1/places/${place.id}/best-window?asOf=${asOf}`,
      "user-b",
    );
    assert.equal(other.status, 404);
    assert.equal(((await other.json()) as { error: string }).error, "place_not_found");

    const otherOutlook = await call(
      "GET",
      `/api/v1/places/${place.id}/outlook?asOf=${asOf}&timeZone=${encodeURIComponent(TIME_ZONE)}`,
      "user-b",
    );
    assert.equal(otherOutlook.status, 404);

    const posted = await call("POST", `/api/v1/places/${place.id}/best-window`);
    assert.equal(posted.status, 405);
    const postedOutlook = await call("POST", `/api/v1/places/${place.id}/outlook`);
    assert.equal(postedOutlook.status, 405);

    const badClock = await call("GET", `/api/v1/places/${place.id}/best-window?asOf=tomorrow`);
    assert.equal(badClock.status, 400);
    assert.equal(((await badClock.json()) as { error: string }).error, "invalid_time");

    const impossible = await call(
      "GET",
      `/api/v1/places/${place.id}/best-window?asOf=2026-02-30T00:00:00.000Z`,
    );
    assert.equal(impossible.status, 400);
    assert.equal(((await impossible.json()) as { error: string }).error, "invalid_time");

    const noZone = await call("GET", `/api/v1/places/${place.id}/outlook?asOf=${asOf}`);
    assert.equal(noZone.status, 400);
    assert.equal(((await noZone.json()) as { error: string }).error, "invalid_time_zone");
  });
});
