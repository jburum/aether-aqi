import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { FORECAST_HORIZON_HOURS } from "../src/lib/v1/rules.ts";
import type { Queryable } from "../src/lib/v1/types.ts";
import {
  DRY_RUN_BOISE,
  dryRunPlaceIngest,
  formatDryRun,
  parseDryRunArgs,
  type DryRunHour,
  type DryRunResult,
} from "../scripts/ingest-dry-run.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CYCLE = "2026-10-30T12:00:00.000Z";
const BOISE = { latitude: DRY_RUN_BOISE.latitude, longitude: DRY_RUN_BOISE.longitude };

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

async function counts(sql: Queryable): Promise<{
  forecast: number;
  official: number;
  upstream: number;
  places: number;
}> {
  const rows = await sql.query<{
    forecast: number;
    official: number;
    upstream: number;
    places: number;
  }>(
    `select
       (select count(*)::int from forecast_issued) as forecast,
       (select count(*)::int from official_reading) as official,
       (select count(*)::int from upstream_call) as upstream,
       (select count(*)::int from saved_place) as places`,
  );
  const row = rows[0];
  if (!row) throw new Error("count query returned no row");
  return {
    forecast: Number(row.forecast),
    official: Number(row.official),
    upstream: Number(row.upstream),
    places: Number(row.places),
  };
}

function putSignMag(view: DataView, offset: number, micro: number): void {
  const rounded = Math.round(micro);
  const abs = Math.abs(rounded);
  view.setUint32(offset, (rounded < 0 ? 0x80000000 : 0) + abs);
}

/** Constant template 5.3 field. (0, 0) is Boise. Every cell is `tenths` × 10⁻¹⁰ kg/m³. */
function encodeConstantSmoke(input: { cycle: string; lead: number; tenths: number }): Uint8Array {
  const when = new Date(input.cycle);
  const nx = 24;
  const ny = 64;
  const npts = nx * ny;
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
  sec3View.setUint32(30, nx);
  sec3View.setUint32(34, ny);
  const lonEast = BOISE.longitude < 0 ? BOISE.longitude + 360 : BOISE.longitude;
  putSignMag(sec3View, 38, BOISE.latitude * 1e6);
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

/** Constant template 4.8 surface PM2.5. Physical value is `tenths` / 10 µg/m³. */
function encodeAqmHour(input: { cycle: string; lead: number; tenths: number }): Uint8Array {
  const latitude = 41.5;
  const longitude = -118;
  const nx = 200;
  const ny = 200;
  const when = new Date(input.cycle);
  const npts = nx * ny;
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
  sec3View.setUint32(30, nx);
  sec3View.setUint32(34, ny);
  const lonEast = longitude < 0 ? longitude + 360 : longitude;
  putSignMag(sec3View, 38, latitude * 1e6);
  putSignMag(sec3View, 42, lonEast * 1e6);
  putSignMag(sec3View, 47, 38.5 * 1e6);
  putSignMag(sec3View, 51, 262.5 * 1e6);
  sec3View.setUint32(55, 3_000_000);
  sec3View.setUint32(59, 3_000_000);
  sec3[64] = 64;
  putSignMag(sec3View, 65, 38.5 * 1e6);
  putSignMag(sec3View, 69, 38.5 * 1e6);
  const sec4 = new Uint8Array(58);
  const sec4View = new DataView(sec4.buffer);
  sec4View.setUint32(0, 58);
  sec4[4] = 4;
  sec4View.setUint16(7, 8);
  sec4[9] = 13;
  sec4[10] = 193;
  sec4[11] = 2;
  sec4[17] = 1;
  sec4View.setUint32(18, input.lead - 1);
  sec4[22] = 104;
  sec4[23] = 4;
  sec4View.setUint32(24, 10_000);
  sec4[28] = 255;
  const end = new Date(when.getTime() + input.lead * 3_600_000);
  sec4View.setUint16(34, end.getUTCFullYear());
  sec4[36] = end.getUTCMonth() + 1;
  sec4[37] = end.getUTCDate();
  sec4[38] = end.getUTCHours();
  sec4[41] = 1;
  const sec5 = new Uint8Array(49);
  const sec5View = new DataView(sec5.buffer);
  sec5View.setUint32(0, 49);
  sec5[4] = 5;
  sec5View.setUint32(5, npts);
  sec5View.setUint16(9, 3);
  sec5View.setFloat32(11, 0);
  sec5View.setUint16(17, 1);
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

function concatMessages(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
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

function aqmCycleFromUrl(url: string): string {
  const match = /\/aqm\.(\d{4})(\d{2})(\d{2})\/\d{2}\/aqm\.t(\d{2})z/.exec(url);
  if (!match) throw new Error("aqm url has no cycle");
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:00:00.000Z`;
}

function respondRange(bytes: Uint8Array, init?: RequestInit): Response {
  const header = new Headers(init?.headers).get("range") ?? "";
  const match = /^bytes=(\d+)-(\d+)$/.exec(header);
  if (!match) return new Response("range required", { status: 400 });
  const start = Number(match[1]);
  const endInclusive = Number(match[2]);
  if (endInclusive < start || endInclusive >= bytes.length) {
    return new Response("range", { status: 416 });
  }
  const slice = bytes.subarray(start, endInclusive + 1);
  return new Response(Buffer.from(slice), {
    status: 206,
    headers: { "content-range": `bytes ${start}-${endInclusive}/${bytes.length}` },
  });
}

const SMOKE_TENTHS = new Map<number, number>([
  [0, 48],
  [24, 155],
  [48, 612],
]);

function cutFetch(): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const aqmLeads = [48, 49, 72, 73];
  const aqmTenths = new Map<number, number>([
    [48, 990],
    [49, 120],
    [72, 355],
    [73, 100],
  ]);
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    if (
      url.includes("purpleair") ||
      url.includes("open-meteo") ||
      url.includes("openmeteo") ||
      url.includes("airnow")
    ) {
      throw new Error(`refused host ${url}`);
    }
    if (url.includes("noaa-hrrr-bdp-pds") && url.includes("wrfsfcf")) {
      const lead = Number(/wrfsfcf(\d{2})/.exec(url)?.[1]);
      const tenths = SMOKE_TENTHS.get(lead);
      if (tenths == null) return new Response("missing", { status: 404 });
      const cycle = cycleFromAwsUrl(url);
      const message = encodeConstantSmoke({ cycle, lead, tenths });
      if (url.endsWith(".idx"))
        return new Response(smokeIndex(message.length, cycle), { status: 200 });
      return new Response(Buffer.from(message), {
        status: 206,
        headers: { "content-range": `bytes 0-${message.length - 1}/${message.length}` },
      });
    }
    if (url.includes("/com/aqm/prod/") && url.includes("ave_1hr_pm25_bc")) {
      const cycle = aqmCycleFromUrl(url);
      const file = concatMessages(
        aqmLeads.map((lead) => encodeAqmHour({ cycle, lead, tenths: aqmTenths.get(lead) ?? 0 })),
      );
      return respondRange(file, init);
    }
    if (url.includes("/com/aqm/prod/")) return new Response("missing", { status: 404 });
    throw new Error(`unexpected host ${url}`);
  };
  return { fetchImpl, urls };
}

function hour(result: DryRunResult, lead: number): DryRunHour {
  const row = result.hours.find((item) => item.lead === lead);
  assert.ok(row, `lead ${lead}`);
  return row;
}

describe("place ingest dry run", { concurrency: 1 }, () => {
  it("writes nothing and keeps the 48/49 cut", async () => {
    const base = await openDb();
    let queries = 0;
    const sql: Queryable = {
      query: async (text, params) => {
        queries += 1;
        return base.query(text, params);
      },
    };
    const before = await counts(sql);
    const mark = queries;
    const fake = cutFetch();
    const previousKey = process.env.AIRNOW_API_KEY;
    delete process.env.AIRNOW_API_KEY;
    let result: DryRunResult;
    try {
      result = await dryRunPlaceIngest({
        ...BOISE,
        name: "Boise",
        cycleUtc: CYCLE,
        fetchImpl: fake.fetchImpl,
        sql,
      });
    } finally {
      if (previousKey === undefined) delete process.env.AIRNOW_API_KEY;
      else process.env.AIRNOW_API_KEY = previousKey;
    }
    assert.equal(queries, mark);
    assert.deepEqual(await counts(sql), before);
    assert.deepEqual(before, { forecast: 0, official: 0, upstream: 0, places: 0 });

    assert.equal(result.cycleUtc, CYCLE);
    assert.equal(result.aqmCycleUtc, CYCLE);
    assert.deepEqual(result.hrrr, { latIndex: 755, lonIndex: 440 });
    assert.deepEqual(result.aqm, { latIndex: 182, lonIndex: 115 });
    assert.equal(result.hours.length, FORECAST_HORIZON_HOURS + 1);
    assert.equal(result.stored, 5);
    assert.equal(result.skipped, 0);
    assert.equal(result.conflicts, 0);
    assert.equal(result.unavailable, 96);
    assert.equal(result.missing, 68);
    assert.equal(result.aqfError, null);
    assert.equal(result.airnowError, "airnow_api_key_missing");
    assert.equal(result.airnowRequests, 0);
    assert.deepEqual(result.hosts, ["noaa-hrrr-bdp-pds.s3.amazonaws.com", "nomads.ncep.noaa.gov"]);
    assert.ok(result.timings.requests > 0);
    assert.equal(result.timings.smokeMs >= 0 && result.timings.aqmMs >= 0, true);

    assert.deepEqual(hour(result, 0), {
      lead: 0,
      source: "noaa_smoke",
      horizon: "day_1_2_valley",
      correctedAqi: 27,
      outcome: "stored",
    });
    assert.deepEqual(hour(result, 24), {
      lead: 24,
      source: "noaa_smoke",
      horizon: "day_1_2_valley",
      correctedAqi: 63,
      outcome: "stored",
    });
    assert.deepEqual(hour(result, 48), {
      lead: 48,
      source: "noaa_smoke",
      horizon: "day_1_2_valley",
      correctedAqi: 155,
      outcome: "stored",
    });
    assert.deepEqual(hour(result, 49), {
      lead: 49,
      source: "noaa_aqf",
      horizon: "day_3_7_noaa_aqf",
      correctedAqi: 56,
      outcome: "stored",
    });
    assert.deepEqual(hour(result, 72), {
      lead: 72,
      source: "noaa_aqf",
      horizon: "day_3_7_noaa_aqf",
      correctedAqi: 101,
      outcome: "stored",
    });
    assert.equal(
      result.hours.some((row) => row.correctedAqi === 181),
      false,
    );
    assert.equal(
      result.hours.some((row) => row.source === "noaa_smoke" && row.lead > 48),
      false,
    );
    assert.equal(
      result.hours.some((row) => row.source === "noaa_aqf" && row.lead <= 48),
      false,
    );
    assert.equal(
      fake.urls.some((url) => /wrfsfcf(?:49|5\d|6\d|7\d)/.test(url)),
      false,
    );
    assert.equal(
      fake.urls.some((url) => url.includes("airnow")),
      false,
    );
    assert.equal(
      fake.urls.some((url) => url.includes("purpleair")),
      false,
    );
    assert.equal(
      fake.urls.some((url) => url.includes("open-meteo")),
      false,
    );

    const unavailable = result.hours.filter((row) => row.outcome === "unavailable");
    assert.equal(unavailable.length, 96);
    assert.deepEqual(
      unavailable.map((row) => row.lead),
      result.unavailableHours,
    );
    assert.equal(result.unavailableHours[0], 73);
    assert.equal(result.unavailableHours.at(-1), 168);
    for (const lead of [73, 96, 168]) {
      assert.deepEqual(hour(result, lead), {
        lead,
        source: null,
        horizon: null,
        correctedAqi: null,
        outcome: "unavailable",
      });
    }

    const text = formatDryRun(result);
    assert.match(text, /cycle: 2026-10-30T12:00:00\.000Z/);
    assert.match(text, /counts: stored=5 skipped=0 conflicts=0 unavailable=96 missing=68/);
    assert.match(text, /48 noaa_smoke day_1_2_valley 155 stored/);
    assert.match(text, /49 noaa_aqf day_3_7_noaa_aqf 56 stored/);
    assert.match(text, /73 - - - unavailable/);
    assert.match(text, /168 - - - unavailable/);
    assert.match(text, /airnow: airnow_api_key_missing/);
    assert.match(text, /airnowRequests: 0/);
  });

  it("picks the latest cycle and does not call AirNow when a key is present", async () => {
    const base = await openDb();
    let queries = 0;
    const sql: Queryable = {
      query: async (text, params) => {
        queries += 1;
        return base.query(text, params);
      },
    };
    const before = await counts(sql);
    const mark = queries;
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("airnow") || url.includes("purpleair") || url.includes("open-meteo")) {
        throw new Error(`refused host ${url}`);
      }
      return new Response("missing", { status: 404 });
    };
    const previousKey = process.env.AIRNOW_API_KEY;
    process.env.AIRNOW_API_KEY = "dry-run-test-key";
    let result: DryRunResult;
    try {
      result = await dryRunPlaceIngest({
        ...BOISE,
        now: new Date("2026-11-01T05:59:00.000Z"),
        fetchImpl,
        sql,
      });
      assert.equal(process.env.AIRNOW_API_KEY, "dry-run-test-key");
    } finally {
      if (previousKey === undefined) delete process.env.AIRNOW_API_KEY;
      else process.env.AIRNOW_API_KEY = previousKey;
    }
    assert.equal(queries, mark);
    assert.deepEqual(await counts(sql), before);
    assert.equal(result.cycleUtc, "2026-11-01T00:00:00.000Z");
    assert.equal(result.aqmCycleUtc, "2026-10-31T12:00:00.000Z");
    assert.equal(result.stored, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.unavailable, FORECAST_HORIZON_HOURS - 72);
    assert.equal(result.airnowError, "airnow_api_key_missing");
    assert.equal(result.airnowRequests, 0);
    assert.equal(
      urls.some((url) => url.includes("airnow")),
      false,
    );
    assert.equal(urls.length > 0, true);
    assert.equal(
      urls.every(
        (url) =>
          url.includes("noaa-hrrr-bdp-pds.s3.amazonaws.com") ||
          url.includes("nomads.ncep.noaa.gov"),
      ),
      true,
    );
  });

  it("defaults the flags to Boise", () => {
    assert.deepEqual(parseDryRunArgs([]), {
      latitude: 43.615,
      longitude: -116.202,
      name: "Boise",
      cycleUtc: undefined,
    });
    assert.deepEqual(
      parseDryRunArgs(["--lat", "44.911", "--lon", "-116.099", "--name", "McCall"]),
      {
        latitude: 44.911,
        longitude: -116.099,
        name: "McCall",
        cycleUtc: undefined,
      },
    );
  });
});
