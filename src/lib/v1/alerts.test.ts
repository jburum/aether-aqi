import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { parseAirNowCurrent } from "./airnow.ts";
import {
  INVERSION_HPBL_M,
  INVERSION_WIND_MS,
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
import { ingestRecordedAirNow, ingestRecordedStability } from "./ingest.ts";
import { fetchNoaaGrib, hrrrStabilityFilterUrls, stabilitySampleFromGrib } from "./noaa.ts";
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
  hpblM: number;
  wind10mMs: number;
  correctedAqi: number;
}

interface Met {
  tmp2mK: number;
  hpblM: number;
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

interface RecordedCellHour {
  localDate: string;
  kind: "inversion" | "control";
  utc: string;
  localHour: number;
  tmp2mK: number;
  ugrd10m: number;
  vgrd10m: number;
  wind10mMs: number;
  hpblM: number;
  massdenKgM3: number;
  pm25Tenths: number;
  correctedAqi: number;
}

const recorded = JSON.parse(
  readFileSync(join(root, "fixtures/v1/inversion-recorded.json"), "utf8"),
) as {
  timeZone: string;
  boise: {
    cell: { i: number; j: number; nx: number; index: number };
    hours: RecordedCellHour[];
  };
};

const stabilityIssuedAt = "2026-10-30T12:00:00.000Z";
const stabilityF00 = new Uint8Array(
  readFileSync(join(root, "fixtures/v1/noaa-hrrr-stability-f00.grib2")),
);
const stabilityF06 = new Uint8Array(
  readFileSync(join(root, "fixtures/v1/noaa-hrrr-stability-f06.grib2")),
);
const boiseBox = { south: 43.59, north: 43.63, west: -116.22, east: -116.18 };

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
      hpblM: day.hpblM,
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
      hpblM: met.hpblM,
      wind10mMs: met.wind10mMs,
    });
  });
  return { hours, stability };
}

function metStreak(hours: readonly RecordedCellHour[]): number {
  let streak = 0;
  let best = 0;
  for (const hour of hours) {
    if (hour.hpblM <= INVERSION_HPBL_M && hour.wind10mMs <= INVERSION_WIND_MS) {
      streak += 1;
      if (streak > best) best = streak;
    } else {
      streak = 0;
    }
  }
  return best;
}

function recordedDecision(hours: readonly RecordedCellHour[], asOf: string): AlertDecision {
  return inversionRule({
    hours: hours.map((hour) => pmHour(hour.utc, hour.utc, hour.correctedAqi)),
    stability: hours.map((hour) => ({
      issuedAt: hour.utc,
      validFor: hour.utc,
      tmp2mK: hour.tmp2mK,
      hpblM: hour.hpblM,
      wind10mMs: hour.wind10mMs,
    })),
    asOf,
    timeZone: recorded.timeZone,
  });
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

  it("keeps a four-hour PM2.5 alert when a newer clean ozone row shares the hour", () => {
    const issuedAt = "2026-01-15T12:00:00.000Z";
    const newer = "2026-01-15T14:00:00.000Z";
    const first = "2026-01-15T16:00:00.000Z";
    const pm = hoursOf(issuedAt, first, 4, 180);
    const ozone = hoursOf(newer, first, 4, 12, "valley", "O3");
    const smoke = smokeRule({
      hours: [...pm, ...ozone],
      official: null,
      asOf: first,
    });
    assert.equal(smoke.fired, true);
    assert.equal(smoke.severity, "high");
    assert.equal(smoke.source, "noaa_smoke");
    assert.match(smoke.reason, /peaks at 180/);

    const replaced = smokeRule({
      hours: [...pm, ...hoursOf(newer, first, 4, 12)],
      official: null,
      asOf: first,
    });
    assert.equal(replaced.fired, false);

    const ozoneIssued = "2026-07-15T12:00:00.000Z";
    const ozoneFirst = "2026-07-15T16:00:00.000Z";
    const ozoneDecision = ozoneRule({
      hours: [
        ...hoursOf(ozoneIssued, ozoneFirst, 4, 160, "later", "O3"),
        ...hoursOf("2026-07-15T14:00:00.000Z", ozoneFirst, 4, 40, "valley", "PM2.5"),
      ],
      official: null,
      asOf: ozoneFirst,
      timeZone: ZONE,
    });
    assert.equal(ozoneDecision.fired, true);
    assert.equal(ozoneDecision.source, "noaa_aqf");
    assert.equal(ozoneDecision.severity, "high");
    assert.match(ozoneDecision.reason, /160/);
    assert.equal(ozoneDecision.reason.includes("40"), false);
  });

  it("stays quiet when four newer low hours use an equivalent pollutant label", () => {
    const issuedAt = "2026-01-15T12:00:00.000Z";
    const newer = "2026-01-15T14:00:00.000Z";
    const first = "2026-01-15T16:00:00.000Z";
    const smokePairs: readonly (readonly [string | null, string | null])[] = [
      [null, "PM2.5"],
      ["PM2.5", null],
    ];
    for (const [olderLabel, newerLabel] of smokePairs) {
      const smoke = smokeRule({
        hours: [
          ...hoursOf(issuedAt, first, 4, 180, "valley", olderLabel),
          ...hoursOf(newer, first, 4, 12, "valley", newerLabel),
        ],
        official: null,
        asOf: first,
      });
      assert.equal(smoke.fired, false, `smoke ${olderLabel} then ${newerLabel}`);
      assert.equal(smoke.status, "quiet", `smoke ${olderLabel} then ${newerLabel}`);
    }

    const ozoneIssued = "2026-07-15T12:00:00.000Z";
    const ozoneNewer = "2026-07-15T14:00:00.000Z";
    const ozoneFirst = "2026-07-15T16:00:00.000Z";
    const ozonePairs: readonly (readonly [string, string])[] = [
      ["O3", "ozone"],
      ["ozone", "O3"],
    ];
    for (const [olderLabel, newerLabel] of ozonePairs) {
      const ozone = ozoneRule({
        hours: [
          ...hoursOf(ozoneIssued, ozoneFirst, 4, 180, "valley", olderLabel),
          ...hoursOf(ozoneNewer, ozoneFirst, 4, 12, "valley", newerLabel),
        ],
        official: null,
        asOf: ozoneFirst,
        timeZone: ZONE,
      });
      assert.equal(ozone.fired, false, `ozone ${olderLabel} then ${newerLabel}`);
      assert.equal(ozone.status, "quiet", `ozone ${olderLabel} then ${newerLabel}`);
    }
  });

  it("cites AirNow beside a forecast that is already on", () => {
    const issuedAt = "2026-01-15T12:00:00.000Z";
    const first = "2026-01-15T16:00:00.000Z";
    for (const officialAqi of [180, 200]) {
      const smoke = smokeRule({
        hours: hoursOf(issuedAt, first, 4, 110),
        official: { observedAt: first, officialAqi, parameter: "PM2.5" },
        asOf: first,
      });
      assert.equal(smoke.fired, true);
      assert.equal(smoke.source, "noaa_smoke");
      assert.equal(smoke.confidence, "valley");
      assert.equal(smoke.severity, "elevated");
      assert.match(smoke.reason, /the NOAA smoke model: corrected AQI peaks at 110/);
      assert.match(smoke.reason, new RegExp(`AirNow PM2\\.5 reads ${officialAqi}`));
      assert.equal(smoke.reason.includes(`peaks at ${officialAqi}`), false);
    }

    const ozoneIssued = "2026-07-15T18:00:00.000Z";
    const ozoneFirst = "2026-07-15T20:00:00.000Z";
    for (const officialAqi of [180, 200]) {
      const ozone = ozoneRule({
        hours: hoursOf(ozoneIssued, ozoneFirst, 4, 110, "later", "O3"),
        official: { observedAt: ozoneFirst, officialAqi, parameter: "O3" },
        asOf: ozoneFirst,
        timeZone: ZONE,
      });
      assert.equal(ozone.fired, true);
      assert.equal(ozone.source, "noaa_aqf");
      assert.equal(ozone.confidence, "model");
      assert.equal(ozone.severity, "elevated");
      assert.match(ozone.reason, /NOAA's air quality forecast: corrected AQI peaks at 110/);
      assert.match(ozone.reason, new RegExp(`AirNow ozone reads ${officialAqi}`));
      assert.equal(ozone.reason.includes(`peaks at ${officialAqi}`), false);
    }
  });

  it("keeps the forecast peak when a mixed 80 and 140 run meets a higher AirNow reading", () => {
    const issuedAt = "2026-01-15T12:00:00.000Z";
    const first = "2026-01-15T16:00:00.000Z";
    const smokeHours = [80, 140, 140, 80].map((aqi, index) =>
      pmHour(issuedAt, at(first, index), aqi),
    );
    const ozoneIssued = "2026-07-15T18:00:00.000Z";
    const ozoneFirst = "2026-07-15T20:00:00.000Z";
    const ozoneHours = [80, 140, 140, 80].map((aqi, index) =>
      pmHour(ozoneIssued, at(ozoneFirst, index), aqi, "later", "O3"),
    );
    for (const officialAqi of [140, 180, 200]) {
      const smoke = smokeRule({
        hours: smokeHours,
        official: { observedAt: first, officialAqi, parameter: "PM2.5" },
        asOf: first,
      });
      assert.equal(smoke.fired, true, `smoke ${officialAqi}`);
      assert.equal(smoke.source, "noaa_smoke", `smoke ${officialAqi}`);
      assert.equal(smoke.confidence, "valley", `smoke ${officialAqi}`);
      assert.equal(smoke.severity, "elevated", `smoke ${officialAqi}`);
      assert.match(smoke.reason, /corrected AQI peaks at 140/, `smoke ${officialAqi}`);
      assert.match(
        smoke.reason,
        new RegExp(`AirNow PM2\\.5 reads ${officialAqi}`),
        `smoke ${officialAqi}`,
      );
      assert.equal(smoke.reason.includes("latest AirNow"), false, `smoke ${officialAqi}`);

      const ozone = ozoneRule({
        hours: ozoneHours,
        official: { observedAt: ozoneFirst, officialAqi, parameter: "O3" },
        asOf: ozoneFirst,
        timeZone: ZONE,
      });
      assert.equal(ozone.fired, true, `ozone ${officialAqi}`);
      assert.equal(ozone.source, "noaa_aqf", `ozone ${officialAqi}`);
      assert.equal(ozone.confidence, "model", `ozone ${officialAqi}`);
      assert.equal(ozone.severity, "elevated", `ozone ${officialAqi}`);
      assert.match(ozone.reason, /corrected AQI peaks at 140/, `ozone ${officialAqi}`);
      assert.match(
        ozone.reason,
        new RegExp(`AirNow ozone reads ${officialAqi}`),
        `ozone ${officialAqi}`,
      );
      assert.equal(ozone.reason.includes("latest AirNow"), false, `ozone ${officialAqi}`);
    }
  });

  it("publishes the corrected peak per alert kind and leaves an AirNow alert without one", () => {
    const smokeIssued = "2026-01-15T12:00:00.000Z";
    const smokeFirst = "2026-01-15T16:00:00.000Z";
    const smokeHours = [120, 155, 130, 110].map((aqi, index) =>
      pmHour(smokeIssued, at(smokeFirst, index), aqi),
    );
    const smoke = smokeRule({ hours: smokeHours, official: null, asOf: smokeFirst });
    assert.equal(smoke.peakAqi, 155);
    assert.equal(smoke.source, "noaa_smoke");
    assert.equal(
      smoke.reason,
      "Smoke alert from the NOAA smoke model: corrected AQI peaks at 155, valley confidence, across 4 hours.",
    );

    const smokeHeadsIssued = "2026-01-10T12:00:00.000Z";
    const smokeHeadsFirst = "2026-01-13T18:00:00.000Z";
    const smokeHeads = smokeRule({
      hours: [101, 118, 109].map((aqi, index) =>
        pmHour(smokeHeadsIssued, at(smokeHeadsFirst, index), aqi, "later"),
      ),
      official: null,
      asOf: smokeHeadsIssued,
    });
    assert.equal(smokeHeads.severity, "heads_up");
    assert.equal(smokeHeads.peakAqi, 118);
    assert.equal(
      smokeHeads.reason,
      "Heads up only: NOAA's air quality forecast has PM2.5 corrected AQI 118 on days 3-7, low confidence, across 3 hours.",
    );

    const smokeQuiet = smokeRule({
      hours: hoursOf(smokeIssued, smokeFirst, 4, 100),
      official: null,
      asOf: smokeIssued,
    });
    assert.equal(smokeQuiet.fired, false);
    assert.equal(smokeQuiet.peakAqi, null);
    assert.equal(
      smokeQuiet.reason,
      "No smoke alert. The stored forecast never holds PM2.5 at or above 101 for 3 hours.",
    );

    const smokeAirNow = smokeRule({
      hours: hoursOf(smokeIssued, smokeFirst, 4, 80),
      official: { observedAt: smokeFirst, officialAqi: 160, parameter: "PM2.5" },
      asOf: smokeFirst,
    });
    assert.equal(smokeAirNow.fired, true);
    assert.equal(smokeAirNow.source, "airnow");
    assert.equal(smokeAirNow.peakAqi, null);
    assert.equal(
      smokeAirNow.reason,
      "Smoke alert from the latest AirNow PM2.5 reading: AQI 160, valley confidence, across 4 hours.",
    );

    const smokeCited = smokeRule({
      hours: hoursOf(smokeIssued, smokeFirst, 4, 110),
      official: { observedAt: smokeFirst, officialAqi: 200, parameter: "PM2.5" },
      asOf: smokeFirst,
    });
    assert.equal(smokeCited.source, "noaa_smoke");
    assert.equal(smokeCited.peakAqi, 110);
    assert.equal(
      smokeCited.reason,
      "Smoke alert from the NOAA smoke model: corrected AQI peaks at 110, valley confidence, across 4 hours. AirNow PM2.5 reads 200.",
    );

    const ozoneIssued = "2026-07-15T18:00:00.000Z";
    const ozoneFirst = "2026-07-15T20:00:00.000Z";
    const ozone = ozoneRule({
      hours: [111, 128, 104, 120].map((aqi, index) =>
        pmHour(ozoneIssued, at(ozoneFirst, index), aqi, "later", "O3"),
      ),
      official: null,
      asOf: ozoneFirst,
      timeZone: ZONE,
    });
    assert.equal(ozone.peakAqi, 128);
    assert.equal(ozone.source, "noaa_aqf");
    assert.equal(
      ozone.reason,
      "Ozone alert from NOAA's air quality forecast: corrected AQI peaks at 128, model confidence, across 4 hours.",
    );

    const ozoneHeadsIssued = "2026-07-10T12:00:00.000Z";
    const ozoneHeadsFirst = "2026-07-13T18:00:00.000Z";
    const ozoneHeads = ozoneRule({
      hours: [101, 132, 118].map((aqi, index) =>
        pmHour(ozoneHeadsIssued, at(ozoneHeadsFirst, index), aqi, "later", "O3"),
      ),
      official: null,
      asOf: ozoneHeadsIssued,
      timeZone: ZONE,
    });
    assert.equal(ozoneHeads.severity, "heads_up");
    assert.equal(ozoneHeads.peakAqi, 132);
    assert.equal(
      ozoneHeads.reason,
      "Heads up only: NOAA's air quality forecast has ozone corrected AQI 132 on days 3-7, low confidence, across 3 hours.",
    );

    const ozoneWinter = ozoneRule({
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
    assert.equal(ozoneWinter.fired, false);
    assert.equal(ozoneWinter.peakAqi, null);
    assert.equal(
      ozoneWinter.reason,
      "No ozone alert. Summer ozone needs corrected AQI at or above 101 for 3 hours in May through September.",
    );

    const ozoneAirNow = ozoneRule({
      hours: hoursOf(ozoneIssued, ozoneFirst, 4, 80, "later", "O3"),
      official: { observedAt: ozoneFirst, officialAqi: 160, parameter: "O3" },
      asOf: ozoneFirst,
      timeZone: ZONE,
    });
    assert.equal(ozoneAirNow.source, "airnow");
    assert.equal(ozoneAirNow.peakAqi, null);
    assert.equal(
      ozoneAirNow.reason,
      "Ozone alert from the latest AirNow ozone reading: AQI 160, valley confidence, across 4 hours.",
    );

    const inversionIssued = "2026-01-15T12:00:00.000Z";
    const inversionFirst = "2026-01-15T16:00:00.000Z";
    const inversionAqis = [120, 143, 101, 110];
    const inversion = inversionRule({
      hours: inversionAqis.map((aqi, index) =>
        pmHour(inversionIssued, at(inversionFirst, index), aqi),
      ),
      stability: inversionAqis.map((_, index) => ({
        issuedAt: inversionIssued,
        validFor: at(inversionFirst, index),
        tmp2mK: 270,
        hpblM: 180,
        wind10mMs: 1.2,
      })),
      asOf: inversionFirst,
      timeZone: ZONE,
    });
    assert.equal(inversion.peakAqi, 143);
    assert.equal(inversion.source, "noaa_hrrr");
    assert.equal(
      inversion.reason,
      "Winter inversion across 4 hours: mixing height is 180 m, wind is 1.2 m/s, and PM2.5 corrected AQI peaks at 143.",
    );

    const inversionHeadsIssued = "2026-01-10T12:00:00.000Z";
    const inversionHeadsFirst = "2026-01-13T18:00:00.000Z";
    const inversionHeadsAqis = [110, 121, 104];
    const inversionHeads = inversionRule({
      hours: inversionHeadsAqis.map((aqi, index) =>
        pmHour(inversionHeadsIssued, at(inversionHeadsFirst, index), aqi, "later"),
      ),
      stability: inversionHeadsAqis.map((_, index) => ({
        issuedAt: inversionHeadsIssued,
        validFor: at(inversionHeadsFirst, index),
        tmp2mK: 268,
        hpblM: 90,
        wind10mMs: 0.8,
      })),
      asOf: inversionHeadsIssued,
      timeZone: ZONE,
    });
    assert.equal(inversionHeads.severity, "heads_up");
    assert.equal(inversionHeads.peakAqi, 121);
    assert.equal(
      inversionHeads.reason,
      "Heads up only: winter inversion on days 3-7, low confidence, across 3 hours. Mixing height is 90 m, wind is 0.8 m/s, and PM2.5 corrected AQI peaks at 121.",
    );

    const inversionQuiet = inversionRule({
      hours: hoursOf(inversionIssued, inversionFirst, 4, 140),
      stability: hoursOf(inversionIssued, inversionFirst, 4, 140).map((hour) => ({
        issuedAt: inversionIssued,
        validFor: hour.validFor,
        tmp2mK: 274,
        hpblM: 1600,
        wind10mMs: 1.4,
      })),
      asOf: inversionFirst,
      timeZone: ZONE,
    });
    assert.equal(inversionQuiet.fired, false);
    assert.equal(inversionQuiet.peakAqi, null);
    assert.equal(
      inversionQuiet.reason,
      "No inversion alert. A winter inversion needs mixing height at or under 400 m, wind at or under 2 m/s, and PM2.5 at or above 101 for 3 hours.",
    );
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

  it("stays quiet on the recorded Boise inversion days", () => {
    const { cell, hours } = recorded.boise;
    assert.equal(cell.index, cell.j * cell.nx + cell.i);
    assert.equal(cell.i, 399);
    assert.equal(cell.j, 770);
    assert.equal(hours.length, 65);
    const dates = ["2026-01-13", "2026-01-14", "2026-01-15", "2025-12-17", "2025-12-24"];
    for (const date of dates) {
      const day = hours.filter((hour) => hour.localDate === date);
      assert.equal(day.length, 13, date);
      for (const hour of day) {
        assert.ok(
          Math.abs(hour.wind10mMs - Math.hypot(hour.ugrd10m, hour.vgrd10m)) < 1e-6,
          hour.utc,
        );
        const decision = recordedDecision(day, hour.utc);
        assert.equal(decision.fired, false, hour.utc);
        assert.equal(decision.status, "quiet", hour.utc);
        assert.equal(decision.peakAqi, null, hour.utc);
        assert.match(decision.reason, /No inversion alert/, hour.utc);
      }
    }
    const onDate = (date: string) => hours.filter((hour) => hour.localDate === date);
    for (const date of ["2026-01-13", "2026-01-14", "2026-01-15"]) {
      const day = onDate(date);
      assert.ok(
        day.every((hour) => hour.kind === "inversion" && hour.correctedAqi === 0),
        date,
      );
      assert.ok(metStreak(day) >= 6, date);
    }
    const december17 = onDate("2025-12-17");
    assert.equal(Math.max(...december17.map((hour) => hour.correctedAqi)), 2);
    assert.equal(metStreak(december17), 2);
    const december24 = onDate("2025-12-24");
    assert.equal(Math.max(...december24.map((hour) => hour.correctedAqi)), 1);
    assert.equal(metStreak(december24), 0);
    assert.ok(december24.every((hour) => hour.hpblM > INVERSION_HPBL_M));
    assert.ok(december24.every((hour) => hour.wind10mMs > INVERSION_WIND_MS));
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

  it("holds the inversion threshold at 400 m and 2 m/s", () => {
    const issuedAt = "2026-01-15T12:00:00.000Z";
    const first = "2026-01-15T16:00:00.000Z";
    const run = (hpblM: number, wind10mMs: number, correctedAqi: number) => {
      const hours: AlertForecastHour[] = [];
      const stability: StabilitySample[] = [];
      for (let i = 0; i < 3; i += 1) {
        const validFor = at(first, i);
        hours.push(pmHour(issuedAt, validFor, correctedAqi));
        stability.push({ issuedAt, validFor, tmp2mK: 270, hpblM, wind10mMs });
      }
      return inversionRule({ hours, stability, asOf: first, timeZone: ZONE });
    };
    assert.equal(run(INVERSION_HPBL_M, 2, 101).fired, true);
    assert.equal(run(INVERSION_HPBL_M + 1, 2, 101).fired, false);
    assert.equal(run(INVERSION_HPBL_M, 2.1, 101).fired, false);
    assert.equal(run(INVERSION_HPBL_M, 2, 100).fired, false);
  });

  it("reads a HRRR filter extract and builds keyless URLs", async () => {
    const sample = stabilitySampleFromGrib(stabilityF00, stabilityIssuedAt);
    assert.equal(sample.issuedAt, stabilityIssuedAt);
    assert.equal(sample.validFor, stabilityIssuedAt);
    assert.ok(Math.abs(sample.tmp2mK - 277.9340515136719) < 1e-6);
    assert.ok(Math.abs(sample.hpblM - 44.11328887939453) < 1e-6);
    assert.ok(Math.abs(sample.wind10mMs - 0.815236) < 1e-4);
    assert.ok(sample.tmp2mK > 277);

    const later = stabilitySampleFromGrib(stabilityF06, stabilityIssuedAt);
    assert.equal(later.validFor, "2026-10-30T18:00:00.000Z");
    assert.ok(later.hpblM >= 0 && later.hpblM <= 20_000);
    assert.ok(later.wind10mMs >= 0);

    const copied = (validFor: string): StabilitySample => ({
      issuedAt: stabilityIssuedAt,
      validFor,
      tmp2mK: sample.tmp2mK,
      hpblM: sample.hpblM,
      wind10mMs: sample.wind10mMs,
    });
    const octoberHours = hoursOf(stabilityIssuedAt, stabilityIssuedAt, 3, 160);
    const october = inversionRule({
      hours: octoberHours,
      stability: octoberHours.map((hour) => copied(hour.validFor)),
      asOf: stabilityIssuedAt,
      timeZone: ZONE,
    });
    assert.equal(october.fired, false);

    const januaryStart = "2026-01-15T16:00:00.000Z";
    const januaryHours = hoursOf("2026-01-15T12:00:00.000Z", januaryStart, 3, 160);
    const january = inversionRule({
      hours: januaryHours,
      stability: januaryHours.map((hour) => copied(hour.validFor)),
      asOf: januaryStart,
      timeZone: ZONE,
    });
    assert.equal(january.fired, true);
    assert.equal(january.severity, "high");
    assert.match(january.reason, /mixing height is 44 m/);

    const urls = hrrrStabilityFilterUrls({
      cycleUtc: stabilityIssuedAt,
      hourStart: 0,
      hourEnd: 6,
      ...boiseBox,
    });
    assert.equal(urls.length, 7);
    assert.match(urls[0] ?? "", /\/cgi-bin\/filter_hrrr_2d\.pl\?/);
    assert.match(urls[0] ?? "", /file=hrrr\.t12z\.wrfsfcf00\.grib2/);
    assert.match(urls[6] ?? "", /file=hrrr\.t12z\.wrfsfcf06\.grib2/);
    assert.match(urls[0] ?? "", /var_TMP=on/);
    assert.match(urls[0] ?? "", /var_UGRD=on/);
    assert.match(urls[0] ?? "", /var_VGRD=on/);
    assert.match(urls[0] ?? "", /var_HPBL=on/);
    assert.match(urls[0] ?? "", /lev_2_m_above_ground=on/);
    assert.match(urls[0] ?? "", /lev_10_m_above_ground=on/);
    assert.match(urls[0] ?? "", /lev_surface=on/);
    assert.equal((urls[0] ?? "").includes("var_WIND"), false);
    for (const url of urls) {
      assert.equal(url.includes("api_key"), false);
      assert.equal(url.includes("API_KEY"), false);
    }
    assert.throws(
      () =>
        hrrrStabilityFilterUrls({
          cycleUtc: stabilityIssuedAt,
          hourStart: 0,
          hourEnd: 49,
          ...boiseBox,
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "noaa_hour",
    );
    assert.throws(
      () =>
        hrrrStabilityFilterUrls({
          cycleUtc: stabilityIssuedAt,
          hourStart: 0,
          hourEnd: 1,
          south: 43,
          north: 44,
          west: -117,
          east: -116,
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "noaa_grid",
    );
    assert.throws(
      () => stabilitySampleFromGrib(new TextEncoder().encode("<!doctype html>"), stabilityIssuedAt),
      (err: unknown) => err instanceof V1RuleError && err.code === "noaa_stability_parse",
    );
    assert.throws(
      () => stabilitySampleFromGrib(stabilityF00, "2026-10-30T18:00:00.000Z"),
      (err: unknown) => err instanceof V1RuleError && err.code === "noaa_stability_parse",
    );

    let requested = "";
    const fetched = await fetchNoaaGrib(urls[0] ?? "", async (url) => {
      requested = String(url);
      return new Response(stabilityF00);
    });
    assert.equal(requested, urls[0]);
    assert.equal(stabilitySampleFromGrib(fetched, stabilityIssuedAt).validFor, stabilityIssuedAt);
    await assert.rejects(
      () => fetchNoaaGrib("https://api.open-meteo.com/v1/forecast", async () => new Response()),
      (err: unknown) => err instanceof V1RuleError && err.code === "open_meteo_not_for_launch",
    );
  });

  it("stores a recorded HRRR stability extract", async () => {
    const sql = await openDb();
    const place = await addSavedPlace(sql, "user-a", {
      name: "Boise",
      latitude: 43.615,
      longitude: -116.2023,
      valley: "Treasure Valley",
      alertAt: null,
    });
    const stored = await ingestRecordedStability(sql, "user-a", {
      placeId: place.id,
      issuedAt: stabilityIssuedAt,
      grib: stabilityF00,
    });
    assert.equal(stored.validFor, stabilityIssuedAt);
    assert.ok(stored.hpblM < INVERSION_HPBL_M);
    assert.ok(stored.wind10mMs <= 2);
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
        hpblM: 180,
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
        hpblM: 220,
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
    assert.equal(body.alerts[0]?.peakAqi, 148);
    assert.equal(inversion.peakAqi, 148);
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

    await sql.query(
      `insert into entitlement (user_id, tier, product, source, expires_at, state)
       values ('user-a', 'pro', 'yearly', 'storekit', '2099-01-01T00:00:00.000Z', 'active')`,
    );
    const path = `/api/v1/places/${place.id}/alerts?asOf=${encodeURIComponent(asOf)}&timeZone=${encodeURIComponent(ZONE)}`;
    const call = (method: string, url: string, userId = "user-a") =>
      handleV1(new Request(`http://localhost${url}`, { method }), { sql, userId, sender });
    const ok = await call("GET", path);
    assert.equal(ok.status, 200);
    const served = (await ok.json()) as AlertsResponse;
    assert.equal(served.alerts.length, 2);
    assert.equal(served.alerts[0]?.kind, "smoke");
    assert.equal(served.alerts[0]?.peakAqi, 148);
    assert.equal(served.alerts[1]?.kind, "inversion");
    assert.equal(served.alerts[1]?.peakAqi, 148);

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
    assert.equal(body.alerts[0]?.peakAqi, 132);

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

  it("keeps a stored PM2.5 alert when a newer clean ozone row shares the hour", async () => {
    const sql = await openDb();
    const place = await addSavedPlace(sql, "user-a", {
      name: "Boise",
      latitude: 43.615,
      longitude: -116.2023,
      valley: "Treasure Valley",
      alertAt: null,
    });
    const issuedAt = "2026-01-15T12:00:00.000Z";
    const newer = "2026-01-15T14:00:00.000Z";
    const first = "2026-01-15T16:00:00.000Z";
    for (let i = 0; i < 4; i += 1) {
      const validFor = at(first, i);
      await issueForecast(sql, "user-a", {
        placeId: place.id,
        source: "noaa_smoke",
        issuedAt,
        validFor,
        horizon: "day_1_2_valley",
        spatialScale: "valley",
        confidence: "valley",
        correctedAqi: 180,
        pollutant: "PM2.5",
      });
      await issueForecast(sql, "user-a", {
        placeId: place.id,
        source: "noaa_smoke",
        issuedAt: newer,
        validFor,
        horizon: "day_1_2_valley",
        spatialScale: "valley",
        confidence: "valley",
        correctedAqi: 12,
        pollutant: "O3",
      });
    }
    const body = await readAlerts(sql, "user-a", place.id, first, ZONE);
    assert.equal(body.alerts.length, 1);
    assert.equal(body.alerts[0]?.kind, "smoke");
    assert.equal(body.alerts[0]?.severity, "high");
    assert.equal(body.alerts[0]?.source, "noaa_smoke");
    assert.equal(body.alerts[0]?.peakAqi, 180);
    assert.match(body.alerts[0]?.reason ?? "", /peaks at 180/);
  });

  it("keeps a stored ozone alert when a newer PM2.5 row shares the hour", async () => {
    const sql = await openDb();
    const place = await addSavedPlace(sql, "user-a", {
      name: "Boise",
      latitude: 43.615,
      longitude: -116.2023,
      valley: "Treasure Valley",
      alertAt: null,
    });
    const issuedAt = "2026-07-15T12:00:00.000Z";
    const newer = "2026-07-15T14:00:00.000Z";
    const first = "2026-07-15T16:00:00.000Z";
    for (let i = 0; i < 4; i += 1) {
      const validFor = at(first, i);
      await issueForecast(sql, "user-a", {
        placeId: place.id,
        source: "noaa_smoke",
        issuedAt,
        validFor,
        horizon: "day_1_2_valley",
        spatialScale: "valley",
        confidence: "valley",
        correctedAqi: 160,
        pollutant: "O3",
      });
      await issueForecast(sql, "user-a", {
        placeId: place.id,
        source: "noaa_smoke",
        issuedAt: newer,
        validFor,
        horizon: "day_1_2_valley",
        spatialScale: "valley",
        confidence: "valley",
        correctedAqi: 40,
        pollutant: "PM2.5",
      });
    }
    const body = await readAlerts(sql, "user-a", place.id, first, ZONE);
    assert.equal(body.alerts.length, 1);
    assert.equal(body.alerts[0]?.kind, "ozone");
    assert.equal(body.alerts[0]?.severity, "high");
    assert.equal(body.alerts[0]?.source, "noaa_smoke");
    assert.equal(body.alerts[0]?.peakAqi, 160);
    assert.match(body.alerts[0]?.reason ?? "", /160/);
    assert.equal((body.alerts[0]?.reason ?? "").includes("40"), false);
  });

  it("stays quiet when a stored newer issue uses an equivalent pollutant label", async () => {
    const sql = await openDb();
    const place = await addSavedPlace(sql, "user-a", {
      name: "Boise",
      latitude: 43.615,
      longitude: -116.2023,
      valley: "Treasure Valley",
      alertAt: null,
    });
    const issueRun = async (
      issuedAt: string,
      first: string,
      correctedAqi: number,
      pollutant: string | null,
    ) => {
      for (let i = 0; i < 4; i += 1) {
        await issueForecast(sql, "user-a", {
          placeId: place.id,
          source: "noaa_smoke",
          issuedAt,
          validFor: at(first, i),
          horizon: "day_1_2_valley",
          spatialScale: "valley",
          confidence: "valley",
          correctedAqi,
          pollutant,
        });
      }
    };

    const smokeFirst = "2026-01-15T16:00:00.000Z";
    await issueRun("2026-01-15T12:00:00.000Z", smokeFirst, 180, null);
    await issueRun("2026-01-15T14:00:00.000Z", smokeFirst, 12, "PM2.5");
    const smokeSwapped = "2026-01-20T16:00:00.000Z";
    await issueRun("2026-01-20T12:00:00.000Z", smokeSwapped, 180, "PM2.5");
    await issueRun("2026-01-20T14:00:00.000Z", smokeSwapped, 12, null);
    const january = await readAlerts(sql, "user-a", place.id, smokeFirst, ZONE);
    assert.equal(
      january.alerts.some((alert) => alert.kind === "smoke"),
      false,
    );

    const ozoneFirst = "2026-07-15T16:00:00.000Z";
    await issueRun("2026-07-15T12:00:00.000Z", ozoneFirst, 180, "O3");
    await issueRun("2026-07-15T14:00:00.000Z", ozoneFirst, 12, "ozone");
    const ozoneSwapped = "2026-07-20T16:00:00.000Z";
    await issueRun("2026-07-20T12:00:00.000Z", ozoneSwapped, 180, "ozone");
    await issueRun("2026-07-20T14:00:00.000Z", ozoneSwapped, 12, "O3");
    const july = await readAlerts(sql, "user-a", place.id, ozoneFirst, ZONE);
    assert.equal(
      july.alerts.some((alert) => alert.kind === "ozone"),
      false,
    );
  });
});

/** Local 16:00Z in Boise. April-October 2026 is MDT. January is MST. */
function boiseHour(date: string): {
  utc: string;
  issuedAt: string;
  hour: number;
  zone: "MST" | "MDT";
} {
  const month = Number(date.slice(5, 7));
  const mdt = month >= 4 && month <= 10;
  return {
    utc: `${date}T16:00:00.000Z`,
    issuedAt: `${date}T12:00:00.000Z`,
    hour: mdt ? 10 : 9,
    zone: mdt ? "MDT" : "MST",
  };
}

function airNowFixture(overrides: {
  DateObserved?: string;
  HourObserved?: number;
  LocalTimeZone?: string;
  ParameterName?: string;
  AQI?: number;
}): string {
  const rows = JSON.parse(readFileSync(join(root, "fixtures/v1/airnow-current.json"), "utf8")) as Record<
    string,
    unknown
  >[];
  const row = rows[0];
  if (!row) throw new Error("airnow fixture is empty");
  return JSON.stringify([{ ...row, ...overrides }]);
}

async function boisePlace(sql: Queryable, userId: string) {
  return addSavedPlace(sql, userId, {
    name: "Boise",
    latitude: 43.615,
    longitude: -116.2023,
    valley: "Treasure Valley",
    alertAt: null,
  });
}

async function issueValley(
  sql: Queryable,
  userId: string,
  placeId: string,
  issuedAt: string,
  first: string,
  correctedAqi: number,
  pollutant: string,
): Promise<AlertForecastHour[]> {
  const hours: AlertForecastHour[] = [];
  for (let i = 0; i < 4; i += 1) {
    const validFor = at(first, i);
    hours.push({
      source: "noaa_smoke",
      issuedAt,
      validFor,
      confidence: "valley",
      correctedAqi,
      pollutant,
    });
    await issueForecast(sql, userId, {
      placeId,
      source: "noaa_smoke",
      issuedAt,
      validFor,
      horizon: "day_1_2_valley",
      spatialScale: "valley",
      confidence: "valley",
      correctedAqi,
      pollutant,
    });
  }
  return hours;
}

async function storedParameter(sql: Queryable, placeId: string): Promise<string | null> {
  const rows = await sql.query<{ parameter: string | null }>(
    "select parameter from official_reading where place_id = $1",
    [placeId],
  );
  assert.equal(rows.length, 1);
  return rows[0]?.parameter ?? null;
}

describe("v1 AirNow parameter", () => {
  it("promotes a days 1-2 smoke hour from a stored PM2.5 row at 51 when AirNow is 101", async () => {
    const sql = await openDb();
    const date = "2026-01-15";
    const stamp = boiseHour(date);
    const cases = [
      { name: "promote", forecast: 51, airnow: 101, fires: true },
      { name: "forecast-50", forecast: 50, airnow: 101, fires: false },
      { name: "airnow-100", forecast: 51, airnow: 100, fires: false },
    ] as const;
    for (const item of cases) {
      const userId = `user-${item.name}`;
      const place = await boisePlace(sql, userId);
      await issueValley(sql, userId, place.id, stamp.issuedAt, stamp.utc, item.forecast, "PM2.5");
      const stored = await ingestRecordedAirNow(
        sql,
        userId,
        place.id,
        airNowFixture({
          DateObserved: date,
          HourObserved: stamp.hour,
          LocalTimeZone: stamp.zone,
          ParameterName: "PM2.5",
          AQI: item.airnow,
        }),
      );
      assert.equal(stored.observedAt, stamp.utc, item.name);
      assert.equal(stored.parameter, "PM2.5", item.name);
      assert.equal(await storedParameter(sql, place.id), "PM2.5", item.name);
      const body = await readAlerts(sql, userId, place.id, stamp.utc, ZONE);
      const smoke = body.alerts.find((alert) => alert.kind === "smoke");
      if (!item.fires) {
        assert.equal(smoke, undefined, item.name);
        assert.equal(
          body.alerts.some((alert) => alert.kind === "ozone"),
          false,
          item.name,
        );
        continue;
      }
      assert.equal(smoke?.fired, true, item.name);
      assert.equal(smoke?.status, "active", item.name);
      assert.equal(smoke?.source, "airnow", item.name);
      assert.equal(smoke?.confidence, "valley", item.name);
      assert.equal(smoke?.severity, "elevated", item.name);
      assert.equal(smoke?.peakAqi, null, item.name);
      assert.equal(smoke?.start, stamp.utc, item.name);
      assert.equal(smoke?.end, at(stamp.utc, 4), item.name);
      assert.equal(
        smoke?.reason,
        "Smoke alert from the latest AirNow PM2.5 reading: AQI 101, valley confidence, across 4 hours.",
        item.name,
      );
      assert.equal(
        body.alerts.some((alert) => alert.kind === "ozone"),
        false,
        item.name,
      );
    }
  });

  it("promotes ozone from a stored O3 row only in May through September", async () => {
    const sql = await openDb();
    const months = [
      { date: "2026-01-15", promotes: false },
      { date: "2026-04-15", promotes: false },
      { date: "2026-05-15", promotes: true },
      { date: "2026-07-15", promotes: true },
      { date: "2026-09-15", promotes: true },
      { date: "2026-10-15", promotes: false },
    ] as const;
    for (const month of months) {
      const userId = `user-${month.date}`;
      const stamp = boiseHour(month.date);
      const place = await boisePlace(sql, userId);
      await issueValley(sql, userId, place.id, stamp.issuedAt, stamp.utc, 51, "O3");
      const stored = await ingestRecordedAirNow(
        sql,
        userId,
        place.id,
        airNowFixture({
          DateObserved: month.date,
          HourObserved: stamp.hour,
          LocalTimeZone: stamp.zone,
          ParameterName: "O3",
          AQI: 101,
        }),
      );
      assert.equal(stored.parameter, "O3", month.date);
      assert.equal(await storedParameter(sql, place.id), "O3", month.date);
      const body = await readAlerts(sql, userId, place.id, stamp.utc, ZONE);
      const ozone = body.alerts.find((alert) => alert.kind === "ozone");
      assert.equal(
        body.alerts.some((alert) => alert.kind === "smoke"),
        false,
        month.date,
      );
      if (!month.promotes) {
        assert.equal(ozone, undefined, month.date);
        continue;
      }
      assert.equal(ozone?.source, "airnow", month.date);
      assert.equal(ozone?.confidence, "valley", month.date);
      assert.equal(ozone?.severity, "elevated", month.date);
      assert.equal(ozone?.peakAqi, null, month.date);
      assert.equal(ozone?.start, stamp.utc, month.date);
      assert.equal(
        ozone?.reason,
        "Ozone alert from the latest AirNow ozone reading: AQI 101, valley confidence, across 4 hours.",
        month.date,
      );
    }
  });

  it("leaves a null parameter as unknown and does not promote", async () => {
    const sql = await openDb();
    const january = boiseHour("2026-01-15");
    const july = boiseHour("2026-07-15");

    const moderate = await boisePlace(sql, "user-moderate");
    const moderateHours = await issueValley(
      sql,
      "user-moderate",
      moderate.id,
      january.issuedAt,
      january.utc,
      51,
      "PM2.5",
    );
    await recordOfficial(sql, "user-moderate", {
      placeId: moderate.id,
      observedAt: january.utc,
      officialAqi: 101,
      officialRaw: "101",
      preliminary: true,
      attribution: AIRNOW_ATTRIBUTION,
      source: "airnow",
    });
    assert.equal(await storedParameter(sql, moderate.id), null);
    const moderateOfficial: AlertOfficial = {
      observedAt: january.utc,
      officialAqi: 101,
      parameter: "unknown",
    };
    const moderateRule = smokeRule({
      hours: moderateHours,
      official: moderateOfficial,
      asOf: january.utc,
    });
    const moderateBody = await readAlerts(sql, "user-moderate", moderate.id, january.utc, ZONE);
    assert.equal(moderateRule.fired, false);
    assert.deepEqual(
      moderateBody.alerts.filter((alert) => alert.kind === "smoke"),
      [],
    );

    const alreadyOn = await boisePlace(sql, "user-on");
    const onHours = await issueValley(
      sql,
      "user-on",
      alreadyOn.id,
      january.issuedAt,
      january.utc,
      110,
      "PM2.5",
    );
    await recordOfficial(sql, "user-on", {
      placeId: alreadyOn.id,
      observedAt: january.utc,
      officialAqi: 180,
      officialRaw: "180",
      preliminary: true,
      attribution: AIRNOW_ATTRIBUTION,
      source: "airnow",
    });
    assert.equal(await storedParameter(sql, alreadyOn.id), null);
    const onOfficial: AlertOfficial = {
      observedAt: january.utc,
      officialAqi: 180,
      parameter: "unknown",
    };
    const onRule = smokeRule({ hours: onHours, official: onOfficial, asOf: january.utc });
    const onBody = await readAlerts(sql, "user-on", alreadyOn.id, january.utc, ZONE);
    assert.equal(onRule.fired, true);
    assert.equal(onRule.source, "noaa_smoke");
    assert.equal(onRule.peakAqi, 110);
    assert.equal(onRule.reason.includes("AirNow"), false);
    assert.deepEqual(
      onBody.alerts.filter((alert) => alert.kind === "smoke"),
      [onRule],
    );

    const summer = await boisePlace(sql, "user-summer");
    const ozoneHours = await issueValley(
      sql,
      "user-summer",
      summer.id,
      july.issuedAt,
      july.utc,
      51,
      "O3",
    );
    await recordOfficial(sql, "user-summer", {
      placeId: summer.id,
      observedAt: july.utc,
      officialAqi: 101,
      officialRaw: "101",
      preliminary: true,
      attribution: AIRNOW_ATTRIBUTION,
      source: "airnow",
    });
    assert.equal(await storedParameter(sql, summer.id), null);
    const ozoneOfficial: AlertOfficial = {
      observedAt: july.utc,
      officialAqi: 101,
      parameter: "unknown",
    };
    const ozoneUnknown = ozoneRule({
      hours: ozoneHours,
      official: ozoneOfficial,
      asOf: july.utc,
      timeZone: ZONE,
    });
    const ozoneNamed = ozoneRule({
      hours: ozoneHours,
      official: { ...ozoneOfficial, parameter: "O3" },
      asOf: july.utc,
      timeZone: ZONE,
    });
    const summerBody = await readAlerts(sql, "user-summer", summer.id, july.utc, ZONE);
    assert.equal(ozoneUnknown.fired, false);
    assert.equal(ozoneNamed.fired, true);
    assert.equal(ozoneNamed.source, "airnow");
    assert.deepEqual(
      summerBody.alerts.filter((alert) => alert.kind === "ozone"),
      [],
    );
  });

  it("stores PM10 and any other ParameterName as null", async () => {
    const current = parseAirNowCurrent(
      readFileSync(join(root, "fixtures/v1/airnow-current.json"), "utf8"),
    );
    assert.equal(current.ok, true);
    if (current.ok) assert.equal(current.reading.parameter, "PM2.5");

    const spaced = parseAirNowCurrent(
      airNowFixture({ ParameterName: " PM2.5 ", AQI: 48 }),
    );
    assert.equal(spaced.ok, true);
    if (spaced.ok) assert.equal(spaced.reading.parameter, "PM2.5");

    for (const name of ["PM10", "Ozone", "SO2", ""]) {
      const parsed = parseAirNowCurrent(airNowFixture({ ParameterName: name, AQI: 40 }));
      assert.equal(parsed.ok, true, name);
      if (parsed.ok) assert.equal(parsed.reading.parameter, null, name);
    }

    const pm10 = readFileSync(join(root, "fixtures/v1/airnow-current.json"), "utf8")
      .replaceAll('"ParameterName": "PM2.5"', '"ParameterName": "PM10"')
      .replaceAll('"ParameterName": "O3"', '"ParameterName": "PM10"');
    const parsed = parseAirNowCurrent(pm10);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.reading.aqi, 48);
      assert.equal(parsed.reading.parameter, null);
    }

    const sql = await openDb();
    const column = await sql.query<{ is_nullable: string; column_default: string | null }>(
      `select is_nullable, column_default
         from information_schema.columns
        where table_name = 'official_reading' and column_name = 'parameter'`,
    );
    assert.equal(column[0]?.is_nullable, "YES");
    assert.equal(column[0]?.column_default, null);

    const place = await boisePlace(sql, "user-a");
    const stored = await ingestRecordedAirNow(sql, "user-a", place.id, pm10);
    assert.equal(stored.officialAqi, 48);
    assert.equal(stored.parameter, null);
    assert.equal(await storedParameter(sql, place.id), null);

    await assert.rejects(
      () =>
        recordOfficial(sql, "user-a", {
          placeId: place.id,
          observedAt: "2026-11-01T18:00:00.000Z",
          officialAqi: 40,
          officialRaw: "40",
          preliminary: true,
          attribution: AIRNOW_ATTRIBUTION,
          source: "airnow",
          parameter: "PM10",
        }),
      (err: unknown) => err instanceof V1RuleError && err.code === "invalid_field",
    );
    await assert.rejects(
      () =>
        sql.query(
          `insert into official_reading
             (id, place_id, user_id, observed_at, official_aqi, official_raw, preliminary, attribution, parameter)
           values ('pm10-row', $1, 'user-a', '2026-11-01T19:00:00.000Z', 40, '40', true, $2, 'PM10')`,
          [place.id, AIRNOW_ATTRIBUTION],
        ),
      (err: unknown) => {
        const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
        return code === "23514";
      },
    );
    const rows = await sql.query<{ n: number }>(
      "select count(*)::int as n from official_reading",
    );
    assert.equal(rows[0]?.n, 1);
  });
});
