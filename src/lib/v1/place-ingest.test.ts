import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { V1RuleError } from "./errors.ts";
import { readLambertPoint } from "./grib.ts";
import { hrrrSmokeCellCenter, resolveModelCells } from "./grid.ts";
import { handleV1 } from "./http.ts";
import { AIRNOW_HOURLY_LIMIT } from "./monitoring.ts";
import {
  MAX_HRRR_FIELD_BYTES,
  aqfAsciiUrl,
  fetchHrrrSmokeField,
  hrrrSmokeByteRange,
  hrrrSmokeGribUrl,
  parseHrrrSmoke,
} from "./noaa.ts";
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
  ranges: string[];
}

const SMOKE_ORIGIN = hrrrSmokeCellCenter(resolveModelCells(BOISE.latitude, BOISE.longitude).hrrr);

function putSignMag(view: DataView, offset: number, micro: number): void {
  const rounded = Math.round(micro);
  const abs = Math.abs(rounded);
  view.setUint32(offset, (rounded < 0 ? 0x80000000 : 0) + abs);
}

/** Constant template 5.3 field. (0, 0) is `latitude`/`longitude`. Every cell is `tenths` × 10⁻¹⁰ kg/m³. */
function encodeConstantSmoke(input: {
  cycle: string;
  lead: number;
  tenths: number;
  nx: number;
  ny: number;
  latitude: number;
  longitude: number;
}): Uint8Array {
  const when = new Date(input.cycle);
  const npts = input.nx * input.ny;
  const sec1 = new Uint8Array(21);
  const sec1View = new DataView(sec1.buffer);
  sec1View.setUint32(0, 21);
  sec1[4] = 1;
  sec1View.setUint16(5, 7);
  sec1[9] = 2;
  sec1[10] = 1;
  sec1[11] = 1;
  sec1View.setUint16(12, when.getUTCFullYear());
  sec1[14] = when.getUTCMonth() + 1;
  sec1[15] = when.getUTCDate();
  sec1[16] = when.getUTCHours();
  sec1[20] = 1;
  const sec3 = new Uint8Array(81);
  const sec3View = new DataView(sec3.buffer);
  sec3View.setUint32(0, 81);
  sec3[4] = 3;
  sec3View.setUint32(6, npts);
  sec3View.setUint16(12, 30);
  sec3[14] = 6;
  sec3View.setUint32(30, input.nx);
  sec3View.setUint32(34, input.ny);
  const lonEast = input.longitude < 0 ? input.longitude + 360 : input.longitude;
  putSignMag(sec3View, 38, input.latitude * 1e6);
  putSignMag(sec3View, 42, lonEast * 1e6);
  putSignMag(sec3View, 47, 38.5 * 1e6);
  putSignMag(sec3View, 51, 262.5 * 1e6);
  sec3View.setUint32(55, 3_000_000);
  sec3View.setUint32(59, 3_000_000);
  sec3[64] = 64;
  putSignMag(sec3View, 65, 38.5 * 1e6);
  putSignMag(sec3View, 69, 38.5 * 1e6);
  const sec4 = new Uint8Array(34);
  const sec4View = new DataView(sec4.buffer);
  sec4View.setUint32(0, 34);
  sec4[4] = 4;
  sec4[9] = 20;
  sec4[10] = 0;
  sec4[11] = 2;
  sec4[17] = 1;
  sec4View.setUint32(18, input.lead);
  sec4[22] = 103;
  sec4View.setUint32(24, 8);
  sec4[28] = 255;
  const sec5 = new Uint8Array(49);
  const sec5View = new DataView(sec5.buffer);
  sec5View.setUint32(0, 49);
  sec5[4] = 5;
  sec5View.setUint32(5, npts);
  sec5View.setUint16(9, 3);
  sec5View.setFloat32(11, 0);
  sec5View.setUint16(17, 10);
  sec5[19] = 8;
  sec5[21] = 1;
  sec5View.setUint32(31, 1);
  sec5View.setUint32(37, 1);
  sec5[41] = 1;
  sec5View.setUint32(42, npts);
  sec5[47] = 2;
  sec5[48] = 2;
  const sec6 = Uint8Array.from([0x00, 0x00, 0x00, 0x06, 0x06, 0xff]);
  const packed = new Uint8Array(7);
  const packedView = new DataView(packed.buffer);
  packedView.setUint16(0, input.tenths);
  packedView.setUint16(2, input.tenths);
  const sec7 = new Uint8Array(12);
  const sec7View = new DataView(sec7.buffer);
  sec7View.setUint32(0, 12);
  sec7[4] = 7;
  sec7.set(packed, 5);
  const sections = [sec1, sec3, sec4, sec5, sec6, sec7];
  const sectionBytes = sections.reduce((sum, part) => sum + part.length, 0);
  const total = 16 + sectionBytes + 4;
  const out = new Uint8Array(total);
  out.set([0x47, 0x52, 0x49, 0x42, 0x00, 0x00, 0x00, 0x02], 0);
  new DataView(out.buffer).setUint32(12, total);
  let offset = 16;
  for (const part of sections) {
    out.set(part, offset);
    offset += part.length;
  }
  out.set([0x37, 0x37, 0x37, 0x37], offset);
  return out;
}

function smokeIndex(byteLength: number, cycle: string): string {
  const when = new Date(cycle);
  const stamp = `${when.getUTCFullYear()}${String(when.getUTCMonth() + 1).padStart(2, "0")}${String(when.getUTCDate()).padStart(2, "0")}${String(when.getUTCHours()).padStart(2, "0")}`;
  return `1:0:d=${stamp}:MASSDEN:8 m above ground:anl:\n2:${byteLength}:d=${stamp}:UGRD:10 m above ground:anl:\n`;
}

function cycleFromAwsUrl(url: string): string {
  const match = /\/hrrr\.(\d{4})(\d{2})(\d{2})\/conus\/hrrr\.t(\d{2})z/.exec(url);
  if (!match) throw new Error("aws url has no cycle");
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:00:00.000Z`;
}

function fakeFetch(bodies: { smoke: string; aqf: string; airnow?: string }): FakeFetch {
  const urls: string[] = [];
  const ranges: string[] = [];
  const byLead = new Map<number, number>();
  for (const hour of parseHrrrSmoke(bodies.smoke)) {
    if (hour.pm25Tenths != null && hour.hour <= 48) byLead.set(hour.hour, hour.pm25Tenths);
  }
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("purpleair") || url.includes("open-meteo") || url.includes("openmeteo")) {
      throw new Error("refused host");
    }
    if (url.includes("noaa-hrrr-bdp-pds") && url.includes("wrfsfcf")) {
      const lead = Number(/wrfsfcf(\d{2})/.exec(url)?.[1]);
      const tenths = byLead.get(lead);
      if (tenths == null) return new Response("missing", { status: 404 });
      const cycle = cycleFromAwsUrl(url);
      const message = encodeConstantSmoke({
        cycle,
        lead,
        tenths,
        nx: 24,
        ny: 64,
        latitude: SMOKE_ORIGIN.latitude,
        longitude: SMOKE_ORIGIN.longitude,
      });
      if (url.endsWith(".idx"))
        return new Response(smokeIndex(message.length, cycle), { status: 200 });
      const range = new Headers(init?.headers).get("range") ?? "";
      ranges.push(range);
      return new Response(Buffer.from(message), {
        status: 206,
        headers: { "content-range": `bytes 0-${message.length - 1}/${message.length}` },
      });
    }
    if (url.includes("pm25sfc")) return new Response(bodies.aqf, { status: 200 });
    if (url.includes("airnowapi.org")) {
      if (bodies.airnow == null) throw new Error("airnow was called");
      return new Response(bodies.airnow, { status: 200 });
    }
    throw new Error(`unexpected host ${url}`);
  };
  return { fetchImpl, urls, ranges };
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
      const smokeUrls = fake.urls.filter((url) => url.includes("noaa-hrrr-bdp-pds"));
      assert.equal(
        smokeUrls.some((url) => url.includes("/dods/")),
        false,
      );
      assert.equal(smokeUrls.filter((url) => url.endsWith("wrfsfcf00.grib2")).length, 1);
      assert.equal(smokeUrls.filter((url) => url.endsWith("wrfsfcf24.grib2")).length, 1);
      assert.equal(smokeUrls.filter((url) => url.endsWith("wrfsfcf48.grib2")).length, 1);
      assert.equal(smokeUrls.filter((url) => url.endsWith(".idx")).length, 49);
      assert.equal(
        fake.urls.find((url) => url.includes("pm25sfc")),
        aqfAsciiUrl({
          cycleUtc: CYCLE,
          latIndex: cells.aqm.latIndex,
          lonIndex: cells.aqm.lonIndex,
          hourStart: 49,
          hourEnd: 168,
        }),
      );
      const airnowUrl = new URL(fake.urls.at(-1) ?? "");
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
      const ledger = await sql.query<{ endpoint_kind: string; outcome: string; n: number }>(
        `select endpoint_kind, outcome, count(*)::int as n
           from upstream_call
          group by endpoint_kind, outcome
          order by endpoint_kind, outcome`,
      );
      assert.deepEqual(ledger, [
        { endpoint_kind: "airnow_current", outcome: "ok", n: 1 },
        { endpoint_kind: "aqf_ascii", outcome: "ok", n: 1 },
        { endpoint_kind: "hrrr_smoke_ascii", outcome: "error", n: 46 },
        { endpoint_kind: "hrrr_smoke_ascii", outcome: "ok", n: 6 },
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

  it("returns the stored official hour when a concurrent insert hits official_hour_unique", async () => {
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
      smoke: readFixture("noaa-hrrr-smoke.ascii"),
      aqf: readFixture("noaa-aqf.ascii"),
      airnow: airNowBody(90),
    });
    let officialSelects = 0;
    let conflicts = 0;
    let releaseBoth: () => void = () => {};
    const bothSawEmpty = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const gate: Queryable = {
      query: async <T>(text: string, params: unknown[] = []) => {
        if (text.includes("select official_aqi") && text.includes("from official_reading")) {
          const rows = await sql.query<T>(text, params);
          officialSelects += 1;
          if (officialSelects === 2) releaseBoth();
          return rows;
        }
        if (text.includes("insert into official_reading")) {
          await bothSawEmpty;
          try {
            return await sql.query<T>(text, params);
          } catch (err) {
            const code =
              typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
            const constraint =
              typeof err === "object" && err !== null && "constraint" in err
                ? String(err.constraint)
                : "";
            if (code === "23505" && constraint === "official_hour_unique") conflicts += 1;
            throw err;
          }
        }
        return sql.query<T>(text, params);
      },
    };
    try {
      const [left, right] = await Promise.all([
        ingestPlaceCycle(gate, "user-a", {
          placeId: place.id,
          cycleUtc: CYCLE,
          fetchImpl: first.fetchImpl,
        }),
        ingestPlaceCycle(gate, "user-a", {
          placeId: place.id,
          cycleUtc: CYCLE,
          fetchImpl: second.fetchImpl,
        }),
      ]);
      assert.equal(conflicts, 1);
      const statuses = [left.officialStatus, right.officialStatus].sort();
      assert.deepEqual(statuses, ["stored", "unchanged"]);
      const official = await sql.query<{ n: number; official_aqi: number }>(
        "select count(*)::int as n, official_aqi from official_reading group by official_aqi",
      );
      assert.equal(official.length, 1);
      assert.equal(official[0]?.n, 1);
      const kept = official[0]?.official_aqi;
      assert.equal(kept === 48 || kept === 90, true);
      assert.equal(left.officialAqi, kept);
      assert.equal(right.officialAqi, kept);
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
        // 46 missing hours, 3 indexes, 3 smoke ranges, and the AQF call.
        { source: "noaa", n: 53 },
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
      assert.equal("lambert" in (body.places[0] ?? {}), false);
      assert.equal(JSON.stringify(body).includes(KEY), false);
      const others = await sql.query<{ n: number }>(
        "select count(*)::int as n from forecast_issued where place_id = $1",
        [tamarack.id],
      );
      assert.equal(others[0]?.n, 0);
      const smokeIdx = fake.urls.filter((url) => url.endsWith("wrfsfcf00.grib2.idx"));
      assert.equal(smokeIdx.length, 2);
      assert.match(smokeIdx[0] ?? "", /^https:\/\/noaa-hrrr-bdp-pds\.s3\.amazonaws\.com\/hrrr\./);
      assert.equal(
        fake.urls.some((url) => url.includes("/dods/hrrr/")),
        false,
      );
      const aqfUrls = fake.urls.filter((url) => url.includes("pm25sfc"));
      assert.equal(aqfUrls.length, 2);
      assert.match(aqfUrls[0] ?? "", /\[49:168\]\[182:182\]\[115:115\]/);
      assert.match(aqfUrls[1] ?? "", /\[49:168\]\[192:192\]\[116:116\]/);
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

  it("reads the Boise smoke cell from the AWS index fixture", async () => {
    const grib = readFileSync(join(root, "fixtures/v1/noaa-hrrr-smoke-f00.grib2"));
    const idx = readFileSync(join(root, "fixtures/v1/noaa-hrrr-smoke-f00.idx"), "utf8");
    const point = readLambertPoint(grib, BOISE.latitude, BOISE.longitude);
    assert.equal(point.referenceTime, CYCLE);
    assert.equal(point.forecastHour, 0);
    assert.equal(point.category, 20);
    assert.equal(point.parameter, 0);
    assert.equal(point.surfaceType, 103);
    assert.equal(point.level, 8);
    assert.ok(Math.abs(point.value - 4.8e-9) < 1e-15);
    const span = hrrrSmokeByteRange(idx);
    assert.equal(span.start, 0);
    assert.equal(span.end, grib.byteLength);

    const previous = process.env.AIRNOW_API_KEY;
    delete process.env.AIRNOW_API_KEY;
    const sql = await openDb();
    const place = await addSavedPlace(sql, "user-a", SAMPLE_PLACE);
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("noaa-hrrr-bdp-pds")) {
        const lead = Number(/wrfsfcf(\d{2})/.exec(url)?.[1]);
        if (lead !== 0) return new Response("missing", { status: 404 });
        if (url.endsWith(".idx")) return new Response(idx, { status: 200 });
        assert.equal(new Headers(init?.headers).get("range"), `bytes=0-${grib.byteLength - 1}`);
        return new Response(grib, {
          status: 206,
          headers: { "content-range": `bytes 0-${grib.byteLength - 1}/${grib.byteLength}` },
        });
      }
      if (url.includes("pm25sfc"))
        return new Response(readFixture("noaa-aqf.ascii"), { status: 200 });
      throw new Error(`unexpected host ${url}`);
    };
    try {
      const stored = await ingestPlaceCycle(sql, "user-a", {
        placeId: place.id,
        cycleUtc: CYCLE,
        fetchImpl,
      });
      assert.deepEqual(stored.hrrr, { latIndex: 755, lonIndex: 440 });
      assert.equal(stored.forecastsStored, 5);
      assert.equal(stored.officialStatus, "skipped");
      const rows = await sql.query<{
        source: string;
        valid_for: string | Date;
        corrected_aqi: number;
      }>(
        "select source, valid_for, corrected_aqi from forecast_issued where source = 'noaa_smoke'",
      );
      assert.equal(rows.length, 1);
      assert.equal(leadHours(CYCLE, rows[0]?.valid_for ?? ""), 0);
      assert.equal(rows[0]?.corrected_aqi, 27);
      assert.equal(
        urls.some((url) => url.includes("/dods/hrrr/")),
        false,
      );
      assert.equal(urls[0], `${hrrrSmokeGribUrl(CYCLE, 0)}.idx`);
      assert.equal(
        urls.find((url) => url.includes("pm25sfc")),
        aqfAsciiUrl({
          cycleUtc: CYCLE,
          latIndex: 182,
          lonIndex: 115,
          hourStart: 49,
          hourEnd: 168,
        }),
      );
    } finally {
      if (previous === undefined) delete process.env.AIRNOW_API_KEY;
      else process.env.AIRNOW_API_KEY = previous;
    }
  });

  // Public HRRR-Smoke, 2026-10-31 18Z f00, MASSDEN at 8 m.
  // noaa-hrrr-bdp-pds hrrr.20261031/conus/hrrr.t18z.wrfsfcf00.grib2
  // idx offsets 42413962:43135923. Ni is 1799, so the packed index is j * 1799 + i.
  // Values are the ecCodes nearest-cell doubles (grib_power decimal scale).
  it("reads named Lambert points from the recorded HRRR MASSDEN message", async () => {
    const grib = readFileSync(join(root, "fixtures/v1/noaa-hrrr-massden-8m.grib2"));
    assert.equal(grib.byteLength, 721_961);
    assert.ok(grib.byteLength < 2 * 1024 * 1024);
    assert.equal(
      createHash("sha256").update(grib).digest("hex"),
      "e1cdef9d663d79345bd240acea6390216cbcef59b45adc5599343ae9a554ef6f",
    );
    const cycle = "2026-10-31T18:00:00.000Z";
    const points = [
      {
        name: "Boise",
        latitude: BOISE.latitude,
        longitude: BOISE.longitude,
        valley: "Treasure Valley",
        i: 399,
        j: 770,
        index: 1_385_629,
        value: 8.00000008846713146464e-11,
        correctedAqi: 0,
      },
      {
        name: "McCall",
        latitude: MCCALL.latitude,
        longitude: MCCALL.longitude,
        valley: MCCALL.valley,
        i: 411,
        j: 817,
        index: 1_470_194,
        value: 6.24000000884671439414e-10,
        correctedAqi: 3,
      },
      {
        name: "Tamarack",
        latitude: TAMARACK.latitude,
        longitude: TAMARACK.longitude,
        valley: TAMARACK.valley,
        i: 409,
        j: 808,
        index: 1_454_001,
        value: 4.16000000884671382205e-10,
        correctedAqi: 2,
      },
    ];
    const previous = process.env.AIRNOW_API_KEY;
    delete process.env.AIRNOW_API_KEY;
    const sql = await openDb();
    const idx = smokeIndex(grib.byteLength, cycle);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("noaa-hrrr-bdp-pds")) {
        const lead = Number(/wrfsfcf(\d{2})/.exec(url)?.[1]);
        if (lead !== 0) return new Response("missing", { status: 404 });
        if (url.endsWith(".idx")) return new Response(idx, { status: 200 });
        assert.equal(new Headers(init?.headers).get("range"), `bytes=0-${grib.byteLength - 1}`);
        return new Response(grib, {
          status: 206,
          headers: { "content-range": `bytes 0-${grib.byteLength - 1}/${grib.byteLength}` },
        });
      }
      if (url.includes("pm25sfc"))
        return new Response(readFixture("noaa-aqf.ascii"), { status: 200 });
      throw new Error(`unexpected host ${url}`);
    };
    try {
      for (const expected of points) {
        const userId = `user-${expected.name}`;
        const place = await addSavedPlace(sql, userId, {
          name: expected.name,
          latitude: expected.latitude,
          longitude: expected.longitude,
          valley: expected.valley,
          alertAt: 100,
        });
        const stored = await ingestPlaceCycle(sql, userId, {
          placeId: place.id,
          cycleUtc: cycle,
          fetchImpl,
        });
        assert.equal(stored.lambert?.i, expected.i, expected.name);
        assert.equal(stored.lambert?.j, expected.j, expected.name);
        assert.equal(
          (stored.lambert?.j ?? 0) * 1799 + (stored.lambert?.i ?? 0),
          expected.index,
          expected.name,
        );
        assert.equal(stored.lambert?.value, expected.value, expected.name);
        const rows = await sql.query<{ corrected_aqi: number }>(
          "select corrected_aqi from forecast_issued where place_id = $1 and source = 'noaa_smoke'",
          [place.id],
        );
        assert.equal(rows.length, 1, expected.name);
        assert.equal(rows[0]?.corrected_aqi, expected.correctedAqi, expected.name);
      }
    } finally {
      if (previous === undefined) delete process.env.AIRNOW_API_KEY;
      else process.env.AIRNOW_API_KEY = previous;
    }
  });

  it("accepts a 206 whose Content-Range matches the index", async () => {
    const body = Uint8Array.from([0x47, 0x52, 0x49, 0x42, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16]);
    const idx = `1:0:d=2026103012:MASSDEN:8 m above ground:anl:\n2:${body.length}:d=2026103012:UGRD:10 m above ground:anl:\n`;
    const message = await fetchHrrrSmokeField(CYCLE, 0, async (url, init) => {
      if (String(url).endsWith(".idx")) return new Response(idx, { status: 200 });
      assert.equal(new Headers(init?.headers).get("range"), `bytes=0-${body.length - 1}`);
      return new Response(body, {
        status: 206,
        headers: { "content-range": `bytes 0-${body.length - 1}/${body.length}` },
      });
    });
    assert.ok(message);
    assert.equal(message.length, body.length);
    assert.equal(message[0], 0x47);
  });

  it("rejects trailing bytes after the recorded HRRR message", async () => {
    const grib = readFileSync(join(root, "fixtures/v1/noaa-hrrr-massden-8m.grib2"));
    assert.equal(grib.byteLength, 721_961);
    const extra = Uint8Array.from([0x00]);
    let step = 0;
    const idx = smokeIndex(grib.byteLength, CYCLE);
    await assert.rejects(
      () =>
        fetchHrrrSmokeField(CYCLE, 0, async (url) => {
          if (String(url).endsWith(".idx")) return new Response(idx, { status: 200 });
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (step === 0) {
                step += 1;
                controller.enqueue(grib);
                return;
              }
              if (step === 1) {
                step += 1;
                controller.enqueue(extra);
                return;
              }
              controller.close();
            },
          });
          return new Response(stream, {
            status: 206,
            headers: { "content-range": `bytes 0-${grib.byteLength - 1}/${grib.byteLength}` },
          });
        }),
      (err: unknown) => {
        assert.ok(err instanceof V1RuleError);
        if (!(err instanceof V1RuleError)) return false;
        assert.equal(err.code, "noaa_smoke_parse");
        assert.match(err.message, /does not match the index/);
        return true;
      },
    );
    assert.equal(step, 2);
  });

  it("rejects a 200 response for an HRRR byte range", async () => {
    const declared = 256 * 1024;
    let pulled = 0;
    const chunk = 16 * 1024;
    const idx =
      "1:0:d=2026103012:MASSDEN:8 m above ground:anl:\n2:16:d=2026103012:UGRD:10 m above ground:anl:\n";
    await assert.rejects(
      () =>
        fetchHrrrSmokeField(CYCLE, 0, async (url) => {
          if (String(url).endsWith(".idx")) return new Response(idx, { status: 200 });
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pulled >= declared) {
                controller.close();
                return;
              }
              const n = Math.min(chunk, declared - pulled);
              pulled += n;
              controller.enqueue(new Uint8Array(n));
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-range": "bytes 0-15/16" },
          });
        }),
      (err: unknown) => {
        assert.ok(err instanceof V1RuleError);
        if (!(err instanceof V1RuleError)) return false;
        assert.equal(err.code, "noaa_fetch_failed");
        assert.match(err.message, /responded 200/);
        return true;
      },
    );
    assert.ok(pulled < declared);
  });

  it("rejects a 206 whose Content-Range misses the index", async () => {
    const declared = 256 * 1024;
    const chunk = 8 * 1024;
    let pulled = 0;
    const idx =
      "1:0:d=2026103012:MASSDEN:8 m above ground:anl:\n2:16:d=2026103012:UGRD:10 m above ground:anl:\n";
    await assert.rejects(
      () =>
        fetchHrrrSmokeField(CYCLE, 0, async (url) => {
          if (String(url).endsWith(".idx")) return new Response(idx, { status: 200 });
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pulled >= declared) {
                controller.close();
                return;
              }
              const n = Math.min(chunk, declared - pulled);
              pulled += n;
              controller.enqueue(new Uint8Array(n));
            },
          });
          return new Response(stream, {
            status: 206,
            headers: { "content-range": `bytes 0-${declared - 1}/*` },
          });
        }),
      (err: unknown) => {
        assert.ok(err instanceof V1RuleError);
        if (!(err instanceof V1RuleError)) return false;
        assert.equal(err.code, "noaa_smoke_parse");
        assert.match(err.message, /does not match the index/);
        return true;
      },
    );
    // The response constructor may enqueue one chunk. The rest of the body stays unread.
    assert.ok(pulled <= chunk);
    assert.ok(pulled < declared);
  });

  it("rejects an over-cap HRRR body before buffering it", async () => {
    const declared = MAX_HRRR_FIELD_BYTES + 64 * 1024;
    let pulled = 0;
    const chunk = 32 * 1024;
    const idx = "1:0:d=2026103012:MASSDEN:8 m above ground:anl:\n";
    await assert.rejects(
      () =>
        fetchHrrrSmokeField(CYCLE, 0, async (url) => {
          if (String(url).endsWith(".idx")) return new Response(idx, { status: 200 });
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pulled >= declared) {
                controller.close();
                return;
              }
              const n = Math.min(chunk, declared - pulled);
              pulled += n;
              controller.enqueue(new Uint8Array(n));
            },
          });
          return new Response(stream, {
            status: 206,
            headers: { "content-range": `bytes 0-${declared - 1}/*` },
          });
        }),
      (err: unknown) => {
        assert.ok(err instanceof V1RuleError);
        if (!(err instanceof V1RuleError)) return false;
        assert.equal(err.code, "noaa_smoke_parse");
        assert.match(err.message, /larger than one message/);
        return true;
      },
    );
    assert.ok(pulled < declared);
    assert.ok(pulled <= MAX_HRRR_FIELD_BYTES);
  });
});
