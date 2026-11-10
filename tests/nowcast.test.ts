import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { V1RuleError } from "../src/lib/v1/errors.ts";
import { nowcastPm25, nowcastPm25Aqi } from "../src/lib/v1/nowcast.ts";
import { pm25TenthsToAqi } from "../src/lib/v1/pm25-aqi.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOUR_MS = 3_600_000;
const DATES = ["2026-01-13", "2026-01-14", "2026-01-15"] as const;

/**
 * utc, local hour, hourly µg/m³, NowCast µg/m³, NowCast AQI.
 * Null NowCast means fewer than 2 of the 3 newest hours were in the window.
 */
type NowcastRow = readonly [string, number, number, number | null, number | null];

interface AirHour {
  utc: string;
  localHour: number;
  ugM3: number;
  reportedAqi: number;
}

interface RecordedFixture {
  days: {
    localDate: string;
    airnow: { missingLocalHours: number[]; hours: AirHour[] };
  }[];
}

const recorded = JSON.parse(
  readFileSync(join(root, "fixtures/v1/inversion-recorded.json"), "utf8"),
) as RecordedFixture;

function clockWindow(byUtc: ReadonlyMap<string, number>, utc: string): (number | null)[] {
  const end = Date.parse(utc);
  const hours: (number | null)[] = [];
  for (let age = 0; age < 12; age += 1) {
    const key = new Date(end - age * HOUR_MS).toISOString().replace(".000Z", "Z");
    hours.push(byUtc.get(key) ?? null);
  }
  return hours;
}

describe("PM2.5 NowCast", () => {
  it("works EPA's published 12-hour example", () => {
    // Newest first. min = 16, max = 27, so the weight is 16/27 and stays above 0.5.
    // Truncation is toward zero at 0.1 µg/m³. Holding the weight at 0.5 would give 26.0.
    const hours = [27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16];
    assert.equal(nowcastPm25(hours), 25.5);
    assert.equal(nowcastPm25Aqi(hours), pm25TenthsToAqi(255));
    assert.equal(nowcastPm25Aqi(hours), 82);
  });

  it("holds a steady series", () => {
    const steady = Array<number>(12).fill(12);
    assert.equal(nowcastPm25(steady), 12);
    assert.equal(nowcastPm25Aqi(steady), 56);
    assert.equal(nowcastPm25([...steady, 0]), 12);
    assert.equal(nowcastPm25(Array<number>(12).fill(0)), 0);
    assert.equal(nowcastPm25Aqi(Array<number>(12).fill(0)), 0);
  });

  it("dampens a sharp spike", () => {
    // The newest hour is 100 and the other eleven are 10. min/max is below 0.5.
    const spike = [100, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
    assert.equal(nowcastPm25(spike), 55);
    assert.equal(nowcastPm25Aqi(spike), 149);
  });

  it("returns null when 2 of the 3 newest hours are missing", () => {
    assert.equal(nowcastPm25([]), null);
    assert.equal(nowcastPm25([10]), null);
    assert.equal(nowcastPm25([10, null, null]), null);
    assert.equal(nowcastPm25([null, 10, null]), null);
    assert.equal(nowcastPm25([null, null, 10]), null);
    assert.equal(nowcastPm25Aqi([10, null, null]), null);
    // One of the three may be missing. A null keeps its age.
    assert.equal(nowcastPm25([null, 20, 10]), 16.6);
    assert.equal(nowcastPm25([20, null, 10]), 18);
    assert.equal(nowcastPm25([12, 12, 12, null, null, null]), 12);
  });

  it("holds the weight factor at 0.5", () => {
    // 10/30 is below 0.5. The unfloored weight 1/3 would truncate to 15.0.
    assert.equal(nowcastPm25([10, 30]), 16.6);
    assert.equal(nowcastPm25Aqi([10, 30]), 65);
  });

  it("rejects a concentration that is not a usable hour", () => {
    assert.throws(
      () => nowcastPm25([10, -1, 10]),
      (err: unknown) => err instanceof V1RuleError && err.code === "pm25_nowcast",
    );
    assert.throws(
      () => nowcastPm25([Number.NaN, 10, 10]),
      (err: unknown) => err instanceof V1RuleError && err.code === "pm25_nowcast",
    );
  });

  it("reports NowCast on the White Pine hours for 13–15 Jan 2026", () => {
    const byUtc = new Map<string, AirHour>();
    for (const day of recorded.days) {
      if (!DATES.includes(day.localDate as (typeof DATES)[number])) continue;
      for (const hour of day.airnow.hours) {
        assert.equal(byUtc.has(hour.utc), false, hour.utc);
        byUtc.set(hour.utc, hour);
      }
    }
    const ugByUtc = new Map([...byUtc].map(([utc, hour]) => [utc, hour.ugM3]));

    let complete = 0;
    let highest: { utc: string; nowcast: number } | null = null;
    for (const [utc, localHour, ugM3, nowcast, aqi] of WHITE_PINE) {
      const hour = byUtc.get(utc);
      assert.ok(hour, utc);
      assert.equal(hour.localHour, localHour, utc);
      assert.equal(hour.ugM3, ugM3, utc);
      const window = clockWindow(ugByUtc, utc);
      assert.equal(nowcastPm25(window), nowcast, utc);
      assert.equal(nowcastPm25Aqi(window), aqi, utc);
      if (window.every((value) => value != null)) {
        complete += 1;
        assert.equal(aqi, hour.reportedAqi, utc);
      }
      if (nowcast != null && (highest == null || nowcast > highest.nowcast)) {
        highest = { utc, nowcast };
      }
    }

    assert.equal(WHITE_PINE.length, 71);
    assert.equal(complete, 49);
    assert.equal(byUtc.has("2026-01-15T18:00:00Z"), false);
    const jan15 = recorded.days.find((day) => day.localDate === "2026-01-15");
    assert.deepEqual(jan15?.airnow.missingLocalHours, [11]);

    // Hourly peaks are 31, 37, and 38 µg/m³. NowCast at those hours is lower.
    assert.deepEqual(peak(byUtc, ugByUtc, "2026-01-14T04:00:00Z"), {
      ugM3: 31,
      nowcast: 27.7,
      aqi: 86,
      reportedAqi: 86,
    });
    assert.deepEqual(peak(byUtc, ugByUtc, "2026-01-15T04:00:00Z"), {
      ugM3: 37,
      nowcast: 32.4,
      aqi: 94,
      reportedAqi: 94,
    });
    assert.deepEqual(peak(byUtc, ugByUtc, "2026-01-15T10:00:00Z"), {
      ugM3: 38,
      nowcast: 34.2,
      aqi: 98,
      reportedAqi: 98,
    });
    // 15 Jan local hour 11 is missing. The next hour keeps that null in the window.
    assert.deepEqual(peak(byUtc, ugByUtc, "2026-01-15T19:00:00Z"), {
      ugM3: 25,
      nowcast: 23.1,
      aqi: 77,
      reportedAqi: 77,
    });
    assert.equal(nowcastPm25(clockWindow(ugByUtc, "2026-01-13T07:00:00Z")), null);
    assert.deepEqual(highest, { utc: "2026-01-15T10:00:00Z", nowcast: 34.2 });
  });
});

function peak(
  byUtc: ReadonlyMap<string, AirHour>,
  ugByUtc: ReadonlyMap<string, number>,
  utc: string,
): { ugM3: number; nowcast: number | null; aqi: number | null; reportedAqi: number } {
  const hour = byUtc.get(utc);
  assert.ok(hour, utc);
  const window = clockWindow(ugByUtc, utc);
  return {
    ugM3: hour.ugM3,
    nowcast: nowcastPm25(window),
    aqi: nowcastPm25Aqi(window),
    reportedAqi: hour.reportedAqi,
  };
}

const WHITE_PINE: readonly NowcastRow[] = [
  ["2026-01-13T07:00:00Z", 0, 10, null, null],
  ["2026-01-13T08:00:00Z", 1, 9, 9.4, 52],
  ["2026-01-13T09:00:00Z", 2, 9, 9.2, 51],
  ["2026-01-13T10:00:00Z", 3, 8, 8.8, 49],
  ["2026-01-13T11:00:00Z", 4, 10, 9.1, 51],
  ["2026-01-13T12:00:00Z", 5, 11, 9.7, 52],
  ["2026-01-13T13:00:00Z", 6, 9, 9.5, 52],
  ["2026-01-13T14:00:00Z", 7, 10, 9.6, 52],
  ["2026-01-13T15:00:00Z", 8, 10, 9.7, 52],
  ["2026-01-13T16:00:00Z", 9, 8, 9.2, 51],
  ["2026-01-13T17:00:00Z", 10, 11, 9.7, 52],
  ["2026-01-13T18:00:00Z", 11, 12, 10.5, 54],
  ["2026-01-13T19:00:00Z", 12, 11, 10.6, 54],
  ["2026-01-13T20:00:00Z", 13, 10, 10.4, 53],
  ["2026-01-13T21:00:00Z", 14, 15, 12.6, 58],
  ["2026-01-13T22:00:00Z", 15, 13, 12.7, 58],
  ["2026-01-13T23:00:00Z", 16, 11, 11.9, 56],
  ["2026-01-14T00:00:00Z", 17, 15, 13.3, 59],
  ["2026-01-14T01:00:00Z", 18, 24, 18.7, 69],
  ["2026-01-14T02:00:00Z", 19, 27, 22.8, 77],
  ["2026-01-14T03:00:00Z", 20, 26, 24.4, 80],
  ["2026-01-14T04:00:00Z", 21, 31, 27.7, 86],
  ["2026-01-14T05:00:00Z", 22, 21, 24.3, 79],
  ["2026-01-14T06:00:00Z", 23, 20, 22.1, 75],
  ["2026-01-14T07:00:00Z", 0, 22, 22, 75],
  ["2026-01-14T08:00:00Z", 1, 22, 22, 75],
  ["2026-01-14T09:00:00Z", 2, 19, 20.5, 72],
  ["2026-01-14T10:00:00Z", 3, 10, 15.2, 62],
  ["2026-01-14T11:00:00Z", 4, 11, 13.1, 58],
  ["2026-01-14T12:00:00Z", 5, 10, 11.5, 55],
  ["2026-01-14T13:00:00Z", 6, 8, 9.7, 52],
  ["2026-01-14T14:00:00Z", 7, 8, 8.8, 49],
  ["2026-01-14T15:00:00Z", 8, 10, 9.4, 52],
  ["2026-01-14T16:00:00Z", 9, 8, 8.7, 48],
  ["2026-01-14T17:00:00Z", 10, 4, 6.3, 35],
  ["2026-01-14T18:00:00Z", 11, 5, 5.6, 31],
  ["2026-01-14T19:00:00Z", 12, 5, 5.3, 29],
  ["2026-01-14T20:00:00Z", 13, 9, 7.1, 39],
  ["2026-01-14T21:00:00Z", 14, 10, 8.5, 47],
  ["2026-01-14T22:00:00Z", 15, 9, 8.7, 48],
  ["2026-01-14T23:00:00Z", 16, 12, 10.3, 53],
  ["2026-01-15T00:00:00Z", 17, 19, 14.6, 61],
  ["2026-01-15T01:00:00Z", 18, 26, 20.3, 72],
  ["2026-01-15T02:00:00Z", 19, 29, 24.6, 80],
  ["2026-01-15T03:00:00Z", 20, 31, 27.8, 86],
  ["2026-01-15T04:00:00Z", 21, 37, 32.4, 94],
  ["2026-01-15T05:00:00Z", 22, 32, 32.2, 94],
  ["2026-01-15T06:00:00Z", 23, 31, 31.6, 93],
  ["2026-01-15T07:00:00Z", 0, 32, 31.8, 93],
  ["2026-01-15T08:00:00Z", 1, 28, 29.9, 90],
  ["2026-01-15T09:00:00Z", 2, 31, 30.4, 91],
  ["2026-01-15T10:00:00Z", 3, 38, 34.2, 98],
  ["2026-01-15T11:00:00Z", 4, 25, 29.6, 89],
  ["2026-01-15T12:00:00Z", 5, 26, 28.8, 88],
  ["2026-01-15T13:00:00Z", 6, 25, 27.5, 85],
  ["2026-01-15T14:00:00Z", 7, 21, 24.1, 79],
  ["2026-01-15T15:00:00Z", 8, 27, 25.4, 81],
  ["2026-01-15T16:00:00Z", 9, 15, 20.1, 71],
  ["2026-01-15T17:00:00Z", 10, 19, 19.5, 70],
  ["2026-01-15T19:00:00Z", 12, 25, 23.1, 77],
  ["2026-01-15T20:00:00Z", 13, 14, 17.9, 67],
  ["2026-01-15T21:00:00Z", 14, 13, 15.3, 63],
  ["2026-01-15T22:00:00Z", 15, 15, 15.1, 62],
  ["2026-01-15T23:00:00Z", 16, 18, 16.5, 65],
  ["2026-01-16T00:00:00Z", 17, 15, 15.7, 63],
  ["2026-01-16T01:00:00Z", 18, 16, 15.8, 63],
  ["2026-01-16T02:00:00Z", 19, 29, 22.4, 76],
  ["2026-01-16T03:00:00Z", 20, 15, 18.7, 69],
  ["2026-01-16T04:00:00Z", 21, 19, 18.8, 69],
  ["2026-01-16T05:00:00Z", 22, 16, 17.4, 66],
  ["2026-01-16T06:00:00Z", 23, 21, 19.2, 70],
];
