import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { V1RuleError } from "./errors.ts";
import {
  AQM_LAT_COUNT,
  AQM_LAT_END,
  AQM_LAT_ORIGIN,
  AQM_LAT_SPACING,
  AQM_LON_COUNT,
  AQM_LON_END,
  AQM_LON_ORIGIN,
  AQM_LON_SPACING,
  HRRR_SMOKE_LAT_COUNT,
  HRRR_SMOKE_LAT_END,
  HRRR_SMOKE_LAT_ORIGIN,
  HRRR_SMOKE_LAT_SPACING,
  HRRR_SMOKE_LON_COUNT,
  HRRR_SMOKE_LON_END,
  HRRR_SMOKE_LON_ORIGIN,
  HRRR_SMOKE_LON_SPACING,
  resolveModelCells,
  toDegreesEast,
} from "./grid.ts";

/** idaho-places.json. The website watchlist uses McCall longitude -116.098. */
const BOISE = { latitude: 43.615, longitude: -116.202 };
const MCCALL = { latitude: 44.911, longitude: -116.099 };
const TAMARACK = { latitude: 44.671, longitude: -116.117 };

describe("v1 model grid", () => {
  it("documents spacing as (end - origin) / (count - 1)", () => {
    assert.equal(
      HRRR_SMOKE_LAT_SPACING,
      (HRRR_SMOKE_LAT_END - HRRR_SMOKE_LAT_ORIGIN) / (HRRR_SMOKE_LAT_COUNT - 1),
    );
    assert.equal(
      HRRR_SMOKE_LON_SPACING,
      (HRRR_SMOKE_LON_END - HRRR_SMOKE_LON_ORIGIN) / (HRRR_SMOKE_LON_COUNT - 1),
    );
    assert.equal(AQM_LAT_SPACING, (AQM_LAT_END - AQM_LAT_ORIGIN) / (AQM_LAT_COUNT - 1));
    assert.equal(AQM_LON_SPACING, (AQM_LON_END - AQM_LON_ORIGIN) / (AQM_LON_COUNT - 1));
    assert.equal(HRRR_SMOKE_LAT_COUNT, 1059);
    assert.equal(HRRR_SMOKE_LON_COUNT, 1799);
    assert.equal(AQM_LAT_COUNT, 265);
    assert.equal(AQM_LON_COUNT, 442);
    assert.equal(toDegreesEast(-116.202), 243.798);
  });

  it("resolves Boise, McCall, and Tamarack to the nearest cells", () => {
    assert.deepEqual(resolveModelCells(BOISE.latitude, BOISE.longitude), {
      hrrr: { latIndex: 755, lonIndex: 440 },
      aqm: { latIndex: 182, lonIndex: 115 },
    });
    assert.deepEqual(resolveModelCells(MCCALL.latitude, MCCALL.longitude), {
      hrrr: { latIndex: 799, lonIndex: 442 },
      aqm: { latIndex: 192, lonIndex: 116 },
    });
    assert.deepEqual(resolveModelCells(MCCALL.latitude, -116.098), {
      hrrr: { latIndex: 799, lonIndex: 442 },
      aqm: { latIndex: 192, lonIndex: 116 },
    });
    assert.deepEqual(resolveModelCells(TAMARACK.latitude, TAMARACK.longitude), {
      hrrr: { latIndex: 791, lonIndex: 442 },
      aqm: { latIndex: 190, lonIndex: 116 },
    });
  });

  it("rounds an exact halfway split to the greater index", () => {
    const halfway = HRRR_SMOKE_LAT_ORIGIN + (755 + 0.5) * HRRR_SMOKE_LAT_SPACING;
    const north = resolveModelCells(halfway, BOISE.longitude);
    assert.equal(north.hrrr.latIndex, 756);
    const south = resolveModelCells(halfway - HRRR_SMOKE_LAT_SPACING * 1e-6, BOISE.longitude);
    assert.equal(south.hrrr.latIndex, 755);
  });

  it("rejects points outside either grid", () => {
    assert.throws(
      () => resolveModelCells(10, BOISE.longitude),
      (err: unknown) =>
        err instanceof V1RuleError &&
        err.code === "outside_model_coverage" &&
        /HRRR-Smoke/.test(err.message) &&
        /latitude/.test(err.message),
    );
    assert.throws(
      () => resolveModelCells(51.507, -0.128),
      (err: unknown) =>
        err instanceof V1RuleError &&
        err.code === "outside_model_coverage" &&
        /HRRR-Smoke/.test(err.message),
    );
    assert.throws(
      () => resolveModelCells(21.3, BOISE.longitude),
      (err: unknown) =>
        err instanceof V1RuleError &&
        err.code === "outside_model_coverage" &&
        /AQM/.test(err.message) &&
        /latitude/.test(err.message),
    );
    assert.throws(
      () => resolveModelCells(Number.NaN, BOISE.longitude),
      (err: unknown) => err instanceof V1RuleError && err.code === "invalid_point",
    );
    assert.throws(
      () => resolveModelCells(43.6, 181),
      (err: unknown) => err instanceof V1RuleError && err.code === "invalid_point",
    );
  });
});
