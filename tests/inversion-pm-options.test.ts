import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALERT_AQI_ON,
  ALERT_AQI_PROMOTE,
  INVERSION_HPBL_M,
  INVERSION_WIND_MS,
  inversionRule,
} from "../src/lib/v1/alerts.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATES = ["2026-01-13", "2026-01-14", "2026-01-15", "2025-12-17", "2025-12-24"] as const;

const OPTIONS = ["hrrr-101", "airnow-101", "airnow-51", "met-only"] as const;
type PmOption = (typeof OPTIONS)[number];

interface AirHour {
  utc: string;
  localHour: number;
  ugM3: number;
  reportedAqi: number;
}

interface HrrrHour {
  localDate: string;
  kind: "inversion" | "control";
  utc: string;
  localHour: number;
  tmp2mK: number;
  hpblM: number;
  wind10mMs: number;
  correctedAqi: number;
}

interface RecordedFixture {
  timeZone: string;
  selection: { inversion: string[]; control: string[] };
  days: {
    localDate: string;
    kind: "inversion" | "control";
    airnow: { hours: AirHour[] };
  }[];
  boise: { hours: HrrrHour[] };
}

interface Sample {
  localHour: number;
  hpblM: number;
  wind10mMs: number;
  correctedAqi: number;
  ugM3: number | null;
  reportedAqi: number | null;
}

interface DayView {
  localDate: string;
  kind: "inversion" | "control";
  hrrrCorrectedAqi: number;
  pm25UgM3: number;
  reportedAqiAtPeak: number;
  maxReportedAqi: number;
  metLocalHours: number[];
  samples: Sample[];
}

interface PmOptions {
  days: DayView[];
  firedOn: Record<PmOption, string[]>;
  starts: Record<PmOption, Record<string, number[]>>;
}

function metLine(hour: { hpblM: number; wind10mMs: number }): boolean {
  return (
    hour.hpblM >= 0 &&
    hour.hpblM <= INVERSION_HPBL_M &&
    hour.wind10mMs >= 0 &&
    hour.wind10mMs <= INVERSION_WIND_MS
  );
}

/**
 * inversionRule still requires corrected AQI >= 101.
 * airnow-51 passes 101 only when the reported AQI is >= 51.
 * met-only passes 101 on every hour, so only the met lines remain.
 */
function correctedAqiForOption(
  option: PmOption,
  hrrrAqi: number,
  reportedAqi: number | null,
): number {
  if (option === "hrrr-101") return hrrrAqi;
  if (option === "met-only") return ALERT_AQI_ON;
  if (reportedAqi == null) return 0;
  if (option === "airnow-101") return reportedAqi;
  return reportedAqi >= ALERT_AQI_PROMOTE ? ALERT_AQI_ON : 0;
}

function episodeStarts(
  hours: readonly HrrrHour[],
  airByUtc: ReadonlyMap<string, AirHour>,
  timeZone: string,
  option: PmOption,
): number[] {
  const forecast = hours.map((hour) => ({
    source: "noaa_smoke" as const,
    issuedAt: hour.utc,
    validFor: hour.utc,
    confidence: "valley" as const,
    correctedAqi: correctedAqiForOption(
      option,
      hour.correctedAqi,
      airByUtc.get(hour.utc)?.reportedAqi ?? null,
    ),
    pollutant: "PM2.5",
  }));
  const stability = hours.map((hour) => ({
    issuedAt: hour.utc,
    validFor: hour.utc,
    tmp2mK: hour.tmp2mK,
    hpblM: hour.hpblM,
    wind10mMs: hour.wind10mMs,
  }));
  const starts = new Set<string>();
  for (const hour of hours) {
    const decision = inversionRule({ hours: forecast, stability, asOf: hour.utc, timeZone });
    if (decision.fired && decision.start) starts.add(decision.start);
  }
  return [...starts]
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .map((start) => {
      const match = hours.find((hour) => Date.parse(hour.utc) === Date.parse(start));
      if (!match) throw new Error(`episode start ${start} is not a sampled hour`);
      return match.localHour;
    });
}

function inversionPmOptions(fixture: RecordedFixture): PmOptions {
  const dates = [...fixture.selection.inversion, ...fixture.selection.control];
  const days = dates.map((localDate): DayView => {
    const day = fixture.days.find((item) => item.localDate === localDate);
    if (!day) throw new Error(`missing day ${localDate}`);
    const hours = fixture.boise.hours
      .filter((hour) => hour.localDate === localDate)
      .sort((a, b) => Date.parse(a.utc) - Date.parse(b.utc));
    if (hours.some((hour) => hour.kind !== day.kind)) {
      throw new Error(`kind mismatch ${localDate}`);
    }
    const airByUtc = new Map(day.airnow.hours.map((hour) => [hour.utc, hour]));
    const peak = [...day.airnow.hours]
      .sort((a, b) => Date.parse(a.utc) - Date.parse(b.utc))
      .reduce((best, hour) => (hour.ugM3 > best.ugM3 ? hour : best));
    const samples = hours.map((hour) => {
      const air = airByUtc.get(hour.utc);
      return {
        localHour: hour.localHour,
        hpblM: hour.hpblM,
        wind10mMs: hour.wind10mMs,
        correctedAqi: hour.correctedAqi,
        ugM3: air ? air.ugM3 : null,
        reportedAqi: air ? air.reportedAqi : null,
      };
    });
    return {
      localDate,
      kind: day.kind,
      hrrrCorrectedAqi: Math.max(...hours.map((hour) => hour.correctedAqi)),
      pm25UgM3: peak.ugM3,
      reportedAqiAtPeak: peak.reportedAqi,
      maxReportedAqi: Math.max(...day.airnow.hours.map((hour) => hour.reportedAqi)),
      metLocalHours: samples.filter((hour) => metLine(hour)).map((hour) => hour.localHour),
      samples,
    };
  });

  const starts = Object.fromEntries(
    OPTIONS.map((option) => {
      const byDate: Record<string, number[]> = {};
      for (const localDate of dates) {
        const day = fixture.days.find((item) => item.localDate === localDate);
        if (!day) throw new Error(`missing day ${localDate}`);
        const hours = fixture.boise.hours
          .filter((hour) => hour.localDate === localDate)
          .sort((a, b) => Date.parse(a.utc) - Date.parse(b.utc));
        const airByUtc = new Map(day.airnow.hours.map((hour) => [hour.utc, hour]));
        byDate[localDate] = episodeStarts(hours, airByUtc, fixture.timeZone, option);
      }
      return [option, byDate];
    }),
  ) as Record<PmOption, Record<string, number[]>>;

  const firedOn = Object.fromEntries(
    OPTIONS.map((option) => [
      option,
      dates.filter((localDate) => (starts[option][localDate]?.length ?? 0) > 0),
    ]),
  ) as Record<PmOption, string[]>;

  return { days, firedOn, starts };
}

const recorded = JSON.parse(
  readFileSync(join(root, "fixtures/v1/inversion-recorded.json"), "utf8"),
) as RecordedFixture;

function day(result: PmOptions, localDate: string): DayView {
  const found = result.days.find((item) => item.localDate === localDate);
  assert.ok(found, localDate);
  return found;
}

function at(view: DayView, localHour: number): Sample {
  const found = view.samples.find((item) => item.localHour === localHour);
  assert.ok(found, `${view.localDate} local ${localHour}`);
  return found;
}

function reported(view: DayView, localHours: readonly number[]): Array<number | null> {
  return localHours.map((localHour) => at(view, localHour).reportedAqi);
}

describe("inversion PM input options", () => {
  const result = inversionPmOptions(recorded);

  it("keeps the rule lines that the four options are measured against", () => {
    assert.equal(ALERT_AQI_ON, 101);
    assert.equal(ALERT_AQI_PROMOTE, 51);
    assert.equal(INVERSION_HPBL_M, 400);
    assert.equal(INVERSION_WIND_MS, 2);
    assert.deepEqual([...recorded.selection.inversion, ...recorded.selection.control], [...DATES]);
  });

  it("matches the five-day table", () => {
    assert.deepEqual(
      result.days.map((item) => ({
        localDate: item.localDate,
        kind: item.kind,
        hrrrCorrectedAqi: item.hrrrCorrectedAqi,
        pm25UgM3: item.pm25UgM3,
        reportedAqiAtPeak: item.reportedAqiAtPeak,
        maxReportedAqi: item.maxReportedAqi,
        metLocalHours: item.metLocalHours,
        samples: item.samples.length,
      })),
      [
        {
          localDate: "2026-01-13",
          kind: "inversion",
          hrrrCorrectedAqi: 0,
          pm25UgM3: 31,
          reportedAqiAtPeak: 86,
          maxReportedAqi: 86,
          metLocalHours: [5, 6, 7, 8, 9, 10, 17, 18, 19, 20, 21, 22],
          samples: 13,
        },
        {
          localDate: "2026-01-14",
          kind: "inversion",
          hrrrCorrectedAqi: 0,
          pm25UgM3: 37,
          reportedAqiAtPeak: 94,
          maxReportedAqi: 94,
          metLocalHours: [5, 6, 7, 8, 9, 10, 17, 19, 20, 21, 22],
          samples: 13,
        },
        {
          localDate: "2026-01-15",
          kind: "inversion",
          hrrrCorrectedAqi: 0,
          pm25UgM3: 38,
          reportedAqiAtPeak: 98,
          maxReportedAqi: 98,
          metLocalHours: [5, 6, 7, 8, 9, 10, 16, 17, 18, 19, 20, 21, 22],
          samples: 13,
        },
        {
          localDate: "2025-12-17",
          kind: "control",
          hrrrCorrectedAqi: 2,
          pm25UgM3: 7,
          reportedAqiAtPeak: 21,
          maxReportedAqi: 24,
          metLocalHours: [21, 22],
          samples: 13,
        },
        {
          localDate: "2025-12-24",
          kind: "control",
          hrrrCorrectedAqi: 1,
          pm25UgM3: 3,
          reportedAqiAtPeak: 28,
          maxReportedAqi: 28,
          metLocalHours: [],
          samples: 13,
        },
      ],
    );

    for (const localDate of recorded.selection.inversion) {
      assert.ok(
        day(result, localDate).samples.every((hour) => hour.correctedAqi === 0),
        localDate,
      );
    }

    const jan13 = day(result, "2026-01-13");
    const jan13Late = at(jan13, 16);
    assert.equal(Math.round(jan13Late.hpblM), 403);
    assert.equal(Math.round(jan13Late.wind10mMs * 10) / 10, 2.1);
    assert.equal(at(jan13, 5).ugM3, 11);
    assert.deepEqual(reported(jan13, [5, 6, 7, 8, 9, 10]), [53, 52, 52, 52, 49, 52]);

    const jan14 = day(result, "2026-01-14");
    assert.equal(Math.round(at(jan14, 16).hpblM), 431);
    assert.equal(Math.round(at(jan14, 18).wind10mMs * 100) / 100, 2.04);
    assert.deepEqual(reported(jan14, [5, 6, 7, 8, 9, 10]), [55, 52, 49, 52, 48, 35]);
    assert.deepEqual(reported(jan14, [19, 20, 21, 22]), [80, 86, 94, 94]);

    const jan15 = day(result, "2026-01-15");
    assert.ok(jan15.samples.every((hour) => (hour.reportedAqi ?? 0) >= 63));
    const jan15Peak = recorded.days
      .find((item) => item.localDate === "2026-01-15")
      ?.airnow.hours.find((hour) => hour.ugM3 === 38);
    assert.equal(jan15Peak?.localHour, 3);
    assert.equal(jan15Peak?.reportedAqi, 98);

    const dec24 = day(result, "2025-12-24");
    assert.equal(Math.round(Math.min(...dec24.samples.map((hour) => hour.hpblM))), 422);
    assert.equal(
      Math.round(Math.min(...dec24.samples.map((hour) => hour.wind10mMs)) * 10) / 10,
      3.7,
    );
    assert.ok(dec24.samples.every((hour) => hour.hpblM > INVERSION_HPBL_M));
    assert.ok(dec24.samples.every((hour) => hour.wind10mMs > INVERSION_WIND_MS));
  });

  it("fires the four options on the days named in the doc", () => {
    assert.deepEqual(result.firedOn, {
      "hrrr-101": [],
      "airnow-101": [],
      "airnow-51": ["2026-01-13", "2026-01-14", "2026-01-15"],
      "met-only": ["2026-01-13", "2026-01-14", "2026-01-15"],
    });
    assert.deepEqual(result.starts, {
      "hrrr-101": {
        "2026-01-13": [],
        "2026-01-14": [],
        "2026-01-15": [],
        "2025-12-17": [],
        "2025-12-24": [],
      },
      "airnow-101": {
        "2026-01-13": [],
        "2026-01-14": [],
        "2026-01-15": [],
        "2025-12-17": [],
        "2025-12-24": [],
      },
      "airnow-51": {
        "2026-01-13": [5, 17],
        "2026-01-14": [19],
        "2026-01-15": [5, 16],
        "2025-12-17": [],
        "2025-12-24": [],
      },
      "met-only": {
        "2026-01-13": [5, 17],
        "2026-01-14": [5, 19],
        "2026-01-15": [5, 16],
        "2025-12-17": [],
        "2025-12-24": [],
      },
    });
    for (const option of OPTIONS) {
      for (const localDate of result.firedOn[option]) {
        assert.equal(day(result, localDate).kind, "inversion", `${option} ${localDate}`);
      }
    }
  });
});
