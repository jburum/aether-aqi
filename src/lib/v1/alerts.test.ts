import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import {
  inversionRule,
  ozoneRule,
  readAlerts,
  recordStability,
  smokeRule,
  type AlertDecision,
  type AlertForecastHour,
  type AlertOfficial,
  type AlertsResponse,
  type StabilitySample,
} from "./alerts.ts";
import { V1RuleError } from "./errors.ts";
import { handleV1 } from "./http.ts";
import { hrrrStabilityAsciiUrls, stabilitySamplesFromExtracts } from "./noaa.ts";
import { TestPushSender } from "./push.ts";
import { AIRNOW_ATTRIBUTION } from "./rules.ts";
import { addSavedPlace, issueForecast, recordOfficial } from "./store.ts";
import type { Queryable } from "./types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const HOUR_MS = 3_600_000;
const ZONE = "America/Boise";

interface SteadyDay {
  name: string;
  expect: "fire" | "quiet";
  severity?: "elevated" | "high";
  asOf: string;
  issuedAt: string;
  firstValidFor: string;
  hours: number;
  tmp2mK: number;
  tmp80mK: number;
  wind10mMs: number;
  correctedAqi: number;
}

interface Met {
  tmp2mK: number;
  tmp80mK: number;
  wind10mMs: number;
  correctedAqi: number;
}

const replay = JSON.parse(
  readFileSync(join(root, "fixtures/v1/inversion-replay.json"), "utf8"),
) as {
  timeZone: string;
  days: SteadyDay[];
  flap: {
    issuedAt: string;
    firstValidFor: string;
    hours: number;
    on: Met;
    off: Met;
  };
  hold: {
    issuedAt: string;
    firstValidFor: string;
    dipIndex: number;
    on: Met;
    off: Met;
    pattern: ("on" | "off")[];
  };
};

const stabilityFixture = JSON.parse(
  readFileSync(join(root, "fixtures/v1/noaa-hrrr-stability.json"), "utf8"),
) as {
  issuedAt: string;
  tmp2m: string;
  tmp80m: string;
  ugrd10m: string;
  vgrd10m: string;
};

function at(start: string, index: number): string {
  return new Date(Date.parse(start) + index * HOUR_MS).toISOString();
}

function pmHour(
  issuedAt: string,
  validFor: string,
  correctedAqi: number,
  kind: "valley" | "later" = "valley",
  pollutant: string | null = "PM2.5",
): AlertForecastHour {
  if (kind === "later") {
    return {
      source: "noaa_aqf",
      issuedAt,
      validFor,
      confidence: "model",
      correctedAqi,
      pollutant,
    };
  }
  return {
    source: "noaa_smoke",
    issuedAt,
    validFor,
    confidence: "valley",
    correctedAqi,
    pollutant,
  };
}

function steady(day: SteadyDay): { hours: AlertForecastHour[]; stability: StabilitySample[] } {
  const hours: AlertForecastHour[] = [];
  const stability: StabilitySample[] = [];
  for (let i = 0; i < day.hours; i += 1) {
    const validFor = at(day.firstValidFor, i);
    hours.push(pmHour(day.issuedAt, validFor, day.correctedAqi));
    stability.push({
      issuedAt: day.issuedAt,
      validFor,
      tmp2mK: day.tmp2mK,
      tmp80mK: day.tmp80mK,
      wind10mMs: day.wind10mMs,
    });
  }
  return { hours, stability };
}

function patternSeries(
  issuedAt: string,
  firstValidFor: string,
  pattern: readonly ("on" | "off")[],
  on: Met,
  off: Met,
): { hours: AlertForecastHour[]; stability: StabilitySample[] } {
  const hours: AlertForecastHour[] = [];
  const stability: StabilitySample[] = [];
  pattern.forEach((flag, index) => {
    const met = flag === "on" ? on : off;
    const validFor = at(firstValidFor, index);
    hours.push(pmHour(issuedAt, validFor, met.correctedAqi));
    stability.push({
      issuedAt,
      validFor,
      tmp2mK: met.tmp2mK,
      tmp80mK: met.tmp80mK,
      wind10mMs: met.wind10mMs,
    });
  });
  return { hours, stability };
}

function hoursOf(
  issuedAt: string,
  firstValidFor: string,
  count: number,
  correctedAqi: number,
  kind: "valley" | "later" = "valley",
  pollutant: string | null = "PM2.5",
): AlertForecastHour[] {
  return Array.from({ length: count }, (_, index) =>
    pmHour(issuedAt, at(firstValidFor, index), correctedAqi, kind, pollutant),
  );
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

describe("v1 alert rules", () => {
  it("fires smoke on days 1-2 and keeps days 3-7 as a low-confidence heads up", () => {
    const asOf = "2026-01-15T12:00:00.000Z";
    const fired = smokeRule({
      hours: hoursOf(asOf, "2026-01-15T16:00:00.000Z", 4, 142),
      official: null,
      asOf: "2026-01-15T16:00:00.000Z",
    });
    assert.equal(fired.fired, true);
    assert.equal(fired.status, "active");
    assert.equal(fired.severity, "elevated");
    assert.equal(fired.source, "noaa_smoke");
    assert.equal(fired.confidence, "valley");
    assert.equal(fired.start, "2026-01-15T16:00:00.000Z");
    assert.equal(fired.end, "2026-01-15T20:00:00.000Z");
    assert.match(fired.reason, /Smoke alert from the NOAA smoke model/);
    assert.match(fired.reason, /142/);

    const high = smokeRule({
      hours: hoursOf(asOf, "2026-01-15T16:00:00.000Z", 4, 170),
      official: null,
      asOf: "2026-01-15T16:00:00.000Z",
    });
    assert.equal(high.severity, "high");

    const laterIssued = "2026-01-10T12:00:00.000Z";
    const heads = smokeRule({
      hours: hoursOf(laterIssued, "2026-01-13T18:00:00.000Z", 4, 180, "later"),
      official: null,
      asOf: laterIssued,
    });
    assert.equal(heads.fired, true);
    assert.equal(heads.status, "upcoming");
    assert.equal(heads.severity, "heads_up");
    assert.equal(heads.confidence, "low");
    assert.equal(heads.source, "noaa_aqf");
    assert.match(heads.reason, /Heads up only/);
    assert.match(heads.reason, /low confidence/);

    const under = smokeRule({
      hours: hoursOf(asOf, "2026-01-15T16:00:00.000Z", 4, 100),
      official: null,
      asOf,
    });
    assert.equal(under.fired, false);
    assert.equal(under.status, "quiet");
    assert.equal(under.start, null);

    const spike = smokeRule({
      hours: hoursOf(asOf, "2026-01-15T16:00:00.000Z", 2, 160),
      official: null,
      asOf,
    });
    assert.equal(spike.fired, false);
  });

  it("lets a known AirNow PM2.5 reading promote a moderate days 1-2 forecast", () => {
    const issuedAt = "2026-01-15T12:00:00.000Z";
    const first = "2026-01-15T16:00:00.000Z";
    const official: AlertOfficial = {
      observedAt: first,
      officialAqi: 160,
      parameter: "PM2.5",
    };
    const promoted = smokeRule({
      hours: hoursOf(issuedAt, first, 4, 80),
      official,
      asOf: first,
    });
    assert.equal(promoted.fired, true);
    assert.equal(promoted.source, "airnow");
    assert.equal(promoted.confidence, "valley");
    assert.equal(promoted.severity, "high");
    assert.match(promoted.reason, /AirNow PM2.5/);

    const unknown = smokeRule({
      hours: hoursOf(issuedAt, first, 4, 80),
      official: { ...official, parameter: "unknown" },
      asOf: first,
    });
    assert.equal(unknown.fired, false);

    const later = smokeRule({
      hours: hoursOf("2026-01-10T12:00:00.000Z", "2026-01-13T18:00:00.000Z", 4, 80, "later"),
      official: { observedAt: "2026-01-13T18:00:00.000Z", officialAqi: 160, parameter: "PM2.5" },
      asOf: "2026-01-10T12:00:00.000Z",
    });
    assert.equal(later.fired, false);
  });

  it("fires summer ozone, stays quiet in winter, and heads-up only after 48 hours", () => {
    const issuedAt = "2026-07-15T18:00:00.000Z";
    // Lead is 2 hours, so this is a days 1-2 ozone hour. The store still rejects that row.
    const summer = ozoneRule({
      hours: hoursOf(issuedAt, "2026-07-15T20:00:00.000Z", 4, 128, "later", "O3"),
      official: null,
      asOf: "2026-07-15T20:00:00.000Z",
      timeZone: ZONE,
    });
    assert.equal(summer.fired, true);
    assert.equal(summer.severity, "elevated");
    assert.equal(summer.confidence, "model");
    assert.equal(summer.source, "noaa_aqf");
    assert.match(summer.reason, /Ozone alert/);

    const winter = ozoneRule({
      hours: hoursOf(
        "2026-01-15T18:00:00.000Z",
        "2026-01-15T20:00:00.000Z",
        4,
        160,
        "valley",
        "O3",
      ),
      official: null,
      asOf: "2026-01-15T20:00:00.000Z",
      timeZone: ZONE,
    });
    assert.equal(winter.fired, false);
    assert.match(winter.reason, /No ozone alert/);

    const heads = ozoneRule({
      hours: hoursOf("2026-07-10T12:00:00.000Z", "2026-07-13T18:00:00.000Z", 4, 190, "later", "O3"),
      official: null,
      asOf: "2026-07-10T12:00:00.000Z",
      timeZone: ZONE,
    });
    assert.equal(heads.fired, true);
    assert.equal(heads.severity, "heads_up");
    assert.equal(heads.confidence, "low");
    assert.match(heads.reason, /Heads up only/);
  });

  it("replays inversion days and stays quiet on clear days", () => {
    for (const day of replay.days) {
      const series = steady(day);
      const decision = inversionRule({
        hours: series.hours,
        stability: series.stability,
        asOf: day.asOf,
        timeZone: replay.timeZone,
      });
      assert.equal(decision.fired, day.expect === "fire", day.name);
      if (day.expect === "fire") {
        assert.equal(decision.severity, day.severity, day.name);
        assert.equal(decision.source, "noaa_hrrr", day.name);
        assert.equal(decision.confidence, "valley", day.name);
        assert.equal(decision.status, "active", day.name);
        assert.match(decision.reason, /Winter inversion/, day.name);
      } else {
        assert.equal(decision.status, "quiet", day.name);
        assert.equal(decision.start, null, day.name);
        assert.match(decision.reason, /No inversion alert/, day.name);
      }
    }
  });

  it("does not flap an inversion hour to hour", () => {
    const flap = patternSeries(
      replay.flap.issuedAt,
      replay.flap.firstValidFor,
      Array.from({ length: replay.flap.hours }, (_, index) => (index % 2 === 0 ? "on" : "off")),
      replay.flap.on,
      replay.flap.off,
    );
    for (let index = 0; index < replay.flap.hours; index += 1) {
      const decision = inversionRule({
        hours: flap.hours,
        stability: flap.stability,
        asOf: at(replay.flap.firstValidFor, index),
        timeZone: ZONE,
      });
      assert.equal(decision.fired, false, `flap hour ${index}`);
    }

    const hold = patternSeries(
      replay.hold.issuedAt,
      replay.hold.firstValidFor,
      replay.hold.pattern,
      replay.hold.on,
      replay.hold.off,
    );
    const duringDip = inversionRule({
      hours: hold.hours,
      stability: hold.stability,
      asOf: at(replay.hold.firstValidFor, replay.hold.dipIndex),
      timeZone: ZONE,
    });
    assert.equal(duringDip.fired, true);
    assert.equal(duringDip.status, "active");
    assert.equal(duringDip.start, replay.hold.firstValidFor);
    assert.equal(duringDip.end, at(replay.hold.firstValidFor, replay.hold.pattern.length));
    assert.equal(duringDip.source, "noaa_hrrr");

    const cleared = patternSeries(
      "2026-01-22T12:00:00.000Z",
      "2026-01-22T16:00:00.000Z",
      ["on", "on", "on", "on", "on", "on", "off", "off", "off", "off", "on"],
      replay.hold.on,
      replay.hold.off,
    );
    const whileOn = inversionRule({
      hours: cleared.hours,
      stability: cleared.stability,
      asOf: "2026-01-22T20:00:00.000Z",
      timeZone: ZONE,
    });
    assert.equal(whileOn.fired, true);
    assert.equal(whileOn.end, "2026-01-22T22:00:00.000Z");
    const afterClear = inversionRule({
      hours: cleared.hours,
      stability: cleared.stability,
      asOf: "2026-01-22T22:00:00.000Z",
      timeZone: ZONE,
    });
    assert.equal(afterClear.fired, false);
    const loneSpike = inversionRule({
      hours: cleared.hours,
      stability: cleared.stability,
      asOf: at("2026-01-22T16:00:00.000Z", 10),
      timeZone: ZONE,
    });
    assert.equal(loneSpike.fired, false);
  });

  it("holds the inversion threshold at 1 K and 2 m/s", () => {
    const issuedAt = "2026-01-15T12:00:00.000Z";
    const first = "2026-01-15T16:00:00.000Z";
    const run = (tmp80mK: number, wind10mMs: number, correctedAqi: number) => {
      const hours: AlertForecastHour[] = [];
      const stability: StabilitySample[] = [];
      for (let i = 0; i < 3; i += 1) {
        const validFor = at(first, i);
        hours.push(pmHour(issuedAt, validFor, correctedAqi));
        stability.push({ issuedAt, validFor, tmp2mK: 270, tmp80mK, wind10mMs });
      }
      return inversionRule({ hours, stability, asOf: first, timeZone: ZONE });
    };
    assert.equal(run(271, 2, 101).fired, true);
    assert.equal(run(270.9, 2, 101).fired, false);
    assert.equal(run(271, 2.1, 101).fired, false);
    assert.equal(run(271, 2, 100).fired, false);
  });

  it("parses HRRR stability ASCII and builds keyless URLs", () => {
    const samples = stabilitySamplesFromExtracts(stabilityFixture);
    assert.deepEqual(
      samples.map((sample) => sample.validFor),
      ["2026-01-15T12:00:00.000Z", "2026-01-17T12:00:00.000Z"],
    );
    assert.equal(samples[0]?.tmp2mK, 270.15);
    assert.equal(samples[0]?.tmp80mK, 273.4);
    assert.equal(samples[0]?.wind10mMs, 1);
    assert.equal(samples[1]?.wind10mMs, 0.5);

    const urls = hrrrStabilityAsciiUrls({
      cycleUtc: "2026-01-15T12:00:00.000Z",
      latIndex: 10,
      lonIndex: 20,
      hourStart: 0,
      hourEnd: 48,
    });
    assert.match(urls.tmp2m, /^https:\/\/nomads\.ncep\.noaa\.gov\/dods\/hrrr\/hrrr20260115\//);
    assert.match(urls.tmp2m, /tmp2m\[0:48\]\[10:10\]\[20:20\]$/);
    assert.match(urls.tmp80m, /tmp80m\[0:48\]/);
    assert.match(urls.ugrd10m, /ugrd10m\[0:48\]/);
    assert.match(urls.vgrd10m, /vgrd10m\[0:48\]/);
    for (const url of Object.values(urls)) {
      assert.equal(url.includes("API_KEY"), false);
      assert.equal(url.includes("api_key"), false);
    }
    assert.throws(
      () =>
        hrrrStabilityAsciiUrls({
          cycleUtc: "2026-01-15T12:00:00.000Z",
          latIndex: 1,
          lonIndex: 1,
          hourStart: 0,
          hourEnd: 49,
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "noaa_hour",
    );
  });
});

describe("v1 alert route", () => {
  it("returns active smoke and inversion alerts and omits a windy false alarm", async () => {
    const sql = await openDb();
    const sender = new TestPushSender();
    const place = await addSavedPlace(sql, "user-a", {
      name: "Boise",
      latitude: 43.615,
      longitude: -116.2023,
      valley: "Treasure Valley",
      alertAt: null,
    });
    const issuedAt = "2026-01-15T12:00:00.000Z";
    const first = "2026-01-15T16:00:00.000Z";
    for (let i = 0; i < 6; i += 1) {
      const validFor = at(first, i);
      await issueForecast(sql, "user-a", {
        placeId: place.id,
        source: "noaa_smoke",
        issuedAt,
        validFor,
        horizon: "day_1_2_valley",
        spatialScale: "valley",
        confidence: "valley",
        correctedAqi: 148,
        pollutant: "PM2.5",
      });
      await recordStability(sql, "user-a", {
        placeId: place.id,
        issuedAt,
        validFor,
        tmp2mK: 270,
        tmp80mK: 273,
        wind10mMs: 1.2,
      });
    }
    const windyIssued = "2026-01-18T12:00:00.000Z";
    const windyFirst = "2026-01-18T16:00:00.000Z";
    for (let i = 0; i < 4; i += 1) {
      const validFor = at(windyFirst, i);
      await issueForecast(sql, "user-a", {
        placeId: place.id,
        source: "noaa_smoke",
        issuedAt: windyIssued,
        validFor,
        horizon: "day_1_2_valley",
        spatialScale: "valley",
        confidence: "valley",
        correctedAqi: 136,
        pollutant: "PM2.5",
      });
      await recordStability(sql, "user-a", {
        placeId: place.id,
        issuedAt: windyIssued,
        validFor,
        tmp2mK: 272,
        tmp80mK: 270,
        wind10mMs: 6.5,
      });
    }
    await recordOfficial(sql, "user-a", {
      placeId: place.id,
      observedAt: first,
      officialAqi: 200,
      officialRaw: "200",
      preliminary: true,
      attribution: AIRNOW_ATTRIBUTION,
      source: "airnow",
    });

    const asOf = "2026-01-15T18:00:00.000Z";
    const body = await readAlerts(sql, "user-a", place.id, asOf, ZONE);
    const kinds = body.alerts.map((alert) => alert.kind);
    assert.deepEqual(kinds, ["smoke", "inversion"]);
    const inversion = body.alerts[1] as AlertDecision;
    assert.equal(inversion.fired, true);
    assert.equal(inversion.status, "active");
    assert.equal(inversion.source, "noaa_hrrr");
    assert.equal(inversion.confidence, "valley");
    assert.equal(body.through, "2026-01-22T18:00:00.000Z");

    const onWindyDay = await readAlerts(sql, "user-a", place.id, "2026-01-18T18:00:00.000Z", ZONE);
    assert.equal(
      onWindyDay.alerts.some((alert) => alert.kind === "inversion"),
      false,
    );
    assert.equal(
      onWindyDay.alerts.some((alert) => alert.kind === "smoke"),
      true,
    );

    const path = `/api/v1/places/${place.id}/alerts?asOf=${encodeURIComponent(asOf)}&timeZone=${encodeURIComponent(ZONE)}`;
    const call = (method: string, url: string, userId = "user-a") =>
      handleV1(new Request(`http://localhost${url}`, { method }), { sql, userId, sender });
    const ok = await call("GET", path);
    assert.equal(ok.status, 200);
    const served = (await ok.json()) as AlertsResponse;
    assert.equal(served.alerts.length, 2);

    const other = await call("GET", path, "user-b");
    assert.equal(other.status, 404);
    assert.equal(((await other.json()) as { error: string }).error, "place_not_found");

    const posted = await call("POST", path);
    assert.equal(posted.status, 405);

    const noZone = await call(
      "GET",
      `/api/v1/places/${place.id}/alerts?asOf=${encodeURIComponent(asOf)}`,
    );
    assert.equal(noZone.status, 400);
    assert.equal(((await noZone.json()) as { error: string }).error, "invalid_time_zone");

    const impossible = await call(
      "GET",
      `/api/v1/places/${place.id}/alerts?asOf=2026-02-30T00:00:00.000Z&timeZone=${encodeURIComponent(ZONE)}`,
    );
    assert.equal(impossible.status, 400);
    assert.equal(((await impossible.json()) as { error: string }).error, "invalid_time");
  });

  it("returns an ozone heads up from a stored days 3-7 row and refuses days 1-2 ozone storage", async () => {
    const sql = await openDb();
    const place = await addSavedPlace(sql, "user-a", {
      name: "Boise",
      latitude: 43.615,
      longitude: -116.2023,
      valley: null,
      alertAt: null,
    });
    const issuedAt = "2026-07-10T12:00:00.000Z";
    const first = "2026-07-13T18:00:00.000Z";
    for (let i = 0; i < 4; i += 1) {
      await issueForecast(sql, "user-a", {
        placeId: place.id,
        source: "noaa_aqf",
        issuedAt,
        validFor: at(first, i),
        horizon: "day_3_7_noaa_aqf",
        spatialScale: "regional",
        confidence: "model",
        correctedAqi: 132,
        pollutant: "O3",
      });
    }
    const body = await readAlerts(sql, "user-a", place.id, issuedAt, ZONE);
    assert.equal(body.alerts.length, 1);
    assert.equal(body.alerts[0]?.kind, "ozone");
    assert.equal(body.alerts[0]?.severity, "heads_up");
    assert.equal(body.alerts[0]?.confidence, "low");
    assert.equal(body.alerts[0]?.status, "upcoming");

    await assert.rejects(
      () =>
        issueForecast(sql, "user-a", {
          placeId: place.id,
          source: "noaa_aqf",
          issuedAt: "2026-07-15T18:00:00.000Z",
          validFor: "2026-07-15T20:00:00.000Z",
          horizon: "day_1_2_valley",
          spatialScale: "valley",
          confidence: "valley",
          correctedAqi: 128,
          pollutant: "O3",
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "day_1_2_valley_only",
    );
  });
});
