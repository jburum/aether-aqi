import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { V1RuleError } from "./errors.ts";
import { readLambertPoint, readSimpleGribFields } from "./grib.ts";

/**
 * Synthetic template 5.3 message in the shape of live HRRR MASSDEN
 * (2026-10-30 12Z f00): data representation template 3, order-2 spatial
 * differencing, 3-octet sign-magnitude descriptors, 17-bit group references,
 * 5-bit widths, 6-bit scaled lengths. The first two packed values are decoys.
 *
 * Scaled integers, index = j * 4 + i:
 *   10, 12, 11, 15, 14, 20, 18, -3
 * h1 = 10, h2 = 12, hmin = -19
 * Packed Y (group ref + delta), groups of 3, 3, and a true last length of 2:
 *   [99, 77, 16] ref 0 width 7
 *   [24, 14, 26] ref 10 width 5
 *   [11, 0] ref 0 width 4
 * The stored scaled length of the last group is 0, which would mean length 1.
 * Physical value is (1 + X * 2^1) * 10^-2. The anchor cell is (0, 0).
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE = join(root, "fixtures/v1/noaa-hrrr-massden-5.3.grib2");
const AQM_FIXTURE = join(root, "fixtures/v1/noaa-aqm-pm25-4.8.grib2");
const STABILITY = join(root, "fixtures/v1/noaa-hrrr-stability-f00.grib2");
const CYCLE = "2026-10-30T12:00:00.000Z";
const ANCHOR = { latitude: 38.5, longitude: -97.5 };
const RADIUS = 6_371_229;
const DX = 3_000;
const DY = 3_000;
const SCALED = [10, 12, 11, 15, 14, 20, 18, -3];

function signMag(value: number, bits: number): number {
  const magnitude = Math.abs(value);
  return (value < 0 ? 2 ** (bits - 1) : 0) + magnitude;
}

function putSignMag(view: DataView, offset: number, micro: number): void {
  const rounded = Math.round(micro);
  view.setUint32(offset, (rounded < 0 ? 0x80000000 : 0) + Math.abs(rounded));
}

class BitWriter {
  private readonly bytes: number[] = [];
  private acc = 0;
  private filled = 0;

  write(value: number, nbits: number): void {
    for (let shift = nbits - 1; shift >= 0; shift -= 1) {
      this.acc = (this.acc << 1) | ((value >> shift) & 1);
      this.filled += 1;
      if (this.filled === 8) {
        this.bytes.push(this.acc);
        this.acc = 0;
        this.filled = 0;
      }
    }
  }

  align(): void {
    if (this.filled === 0) return;
    this.acc <<= 8 - this.filled;
    this.bytes.push(this.acc);
    this.acc = 0;
    this.filled = 0;
  }

  toUint8Array(): Uint8Array {
    this.align();
    return Uint8Array.from(this.bytes);
  }
}

function section1(cycle: string): Uint8Array {
  const when = new Date(cycle);
  const sec = new Uint8Array(21);
  const view = new DataView(sec.buffer);
  view.setUint32(0, 21);
  sec[4] = 1;
  view.setUint16(5, 7);
  sec[9] = 2;
  sec[10] = 1;
  sec[11] = 1;
  view.setUint16(12, when.getUTCFullYear());
  sec[14] = when.getUTCMonth() + 1;
  sec[15] = when.getUTCDate();
  sec[16] = when.getUTCHours();
  sec[20] = 1;
  return sec;
}

function section3(nx: number, ny: number): Uint8Array {
  const sec = new Uint8Array(81);
  const view = new DataView(sec.buffer);
  view.setUint32(0, 81);
  sec[4] = 3;
  view.setUint32(6, nx * ny);
  view.setUint16(12, 30);
  sec[14] = 6;
  view.setUint32(30, nx);
  view.setUint32(34, ny);
  putSignMag(view, 38, ANCHOR.latitude * 1e6);
  putSignMag(view, 42, (ANCHOR.longitude + 360) * 1e6);
  putSignMag(view, 47, 38.5 * 1e6);
  putSignMag(view, 51, 262.5 * 1e6);
  view.setUint32(55, DX * 1_000);
  view.setUint32(59, DY * 1_000);
  sec[64] = 64;
  putSignMag(view, 65, 38.5 * 1e6);
  putSignMag(view, 69, 38.5 * 1e6);
  return sec;
}

/** Template 4.8. The forecast-time field is the interval start, one hour before `leadEnd`. */
function section4Interval(leadEnd: number): Uint8Array {
  const sec = new Uint8Array(58);
  const view = new DataView(sec.buffer);
  view.setUint32(0, 58);
  sec[4] = 4;
  view.setUint16(7, 8);
  sec[9] = 13;
  sec[10] = 193;
  sec[11] = 2;
  sec[17] = 1;
  view.setUint32(18, leadEnd - 1);
  sec[22] = 1;
  sec[28] = 255;
  const end = new Date(Date.parse(CYCLE) + leadEnd * 3_600_000);
  view.setUint16(34, end.getUTCFullYear());
  sec[36] = end.getUTCMonth() + 1;
  sec[37] = end.getUTCDate();
  sec[38] = end.getUTCHours();
  sec[41] = 1;
  sec[46] = 0;
  sec[47] = 2;
  sec[48] = 1;
  view.setUint32(49, 1);
  sec[53] = 1;
  view.setUint32(54, 1);
  return sec;
}

function replaceSection4(message: Uint8Array, sec4: Uint8Array): Uint8Array {
  let start = -1;
  let oldLength = 0;
  let cursor = 16;
  while (cursor + 5 < message.length) {
    const length = new DataView(message.buffer, message.byteOffset + cursor, 4).getUint32(0);
    if (message[cursor + 4] === 4) {
      start = cursor;
      oldLength = length;
      break;
    }
    cursor += length;
  }
  if (start < 0) throw new Error("section 4 missing");
  const out = new Uint8Array(message.length - oldLength + sec4.length);
  out.set(message.subarray(0, start), 0);
  out.set(sec4, start);
  out.set(message.subarray(start + oldLength), start + sec4.length);
  new DataView(out.buffer).setUint32(12, out.length);
  return out;
}

/**
 * Template 4.8, applied bitmap, template 5.3. Grid 4 by 2.
 * Bit 0 is masked. Packed values are 1 through 7, so grid index 1 reads packed 0.
 */
export function template48Bitmap(): Uint8Array {
  const sec5 = new Uint8Array(49);
  const view = new DataView(sec5.buffer);
  view.setUint32(0, 49);
  sec5[4] = 5;
  view.setUint32(5, 7);
  view.setUint16(9, 3);
  sec5[21] = 1;
  view.setUint32(31, 1);
  view.setUint32(37, 1);
  sec5[41] = 1;
  view.setUint32(42, 7);
  sec5[47] = 2;
  sec5[48] = 1;
  const bits = new BitWriter();
  bits.write(signMag(1, 8), 8);
  bits.write(signMag(2, 8), 8);
  bits.write(signMag(0, 8), 8);
  const data = bits.toUint8Array();
  const sec7 = new Uint8Array(5 + data.length);
  new DataView(sec7.buffer).setUint32(0, sec7.length);
  sec7[4] = 7;
  sec7.set(data, 5);
  const sec6 = Uint8Array.from([0x00, 0x00, 0x00, 0x07, 0x06, 0x00, 0x7f]);
  return finish([section1(CYCLE), section3(4, 2), section4Interval(49), sec5, sec6, sec7]);
}

function section4(lead = 0): Uint8Array {
  const sec = new Uint8Array(34);
  const view = new DataView(sec.buffer);
  view.setUint32(0, 34);
  sec[4] = 4;
  sec[9] = 20;
  sec[10] = 0;
  sec[11] = 2;
  sec[17] = 1;
  view.setUint32(18, lead);
  sec[22] = 103;
  view.setUint32(24, 8);
  sec[28] = 255;
  return sec;
}

function finish(sections: Uint8Array[]): Uint8Array {
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

/** Live packing shape: order 2, 3-octet descriptors, three groups, decoy head. */
function liveShapeFixture(): Uint8Array {
  const sec5 = new Uint8Array(49);
  const view = new DataView(sec5.buffer);
  view.setUint32(0, 49);
  sec5[4] = 5;
  view.setUint32(5, 8);
  view.setUint16(9, 3);
  view.setFloat32(11, 1);
  view.setUint16(15, signMag(1, 16));
  view.setUint16(17, signMag(2, 16));
  sec5[19] = 17;
  sec5[21] = 1;
  view.setUint32(31, 3);
  sec5[36] = 5;
  view.setUint32(37, 1);
  sec5[41] = 1;
  view.setUint32(42, 2);
  sec5[46] = 6;
  sec5[47] = 2;
  sec5[48] = 3;
  const bits = new BitWriter();
  bits.write(signMag(10, 24), 24);
  bits.write(signMag(12, 24), 24);
  bits.write(signMag(-19, 24), 24);
  bits.align();
  for (const ref of [0, 10, 0]) bits.write(ref, 17);
  bits.align();
  for (const width of [7, 5, 4]) bits.write(width, 5);
  bits.align();
  // Last group's stored scale is 0. The true length is 2, from section 5.
  for (const scaled of [2, 2, 0]) bits.write(scaled, 6);
  bits.align();
  const packed = [
    [99, 77, 16],
    [14, 4, 16],
    [11, 0],
  ];
  const widths = [7, 5, 4];
  for (let group = 0; group < packed.length; group += 1) {
    for (const delta of packed[group] ?? []) bits.write(delta, widths[group] ?? 0);
  }
  const data = bits.toUint8Array();
  const sec7 = new Uint8Array(5 + data.length);
  const sec7View = new DataView(sec7.buffer);
  sec7View.setUint32(0, sec7.length);
  sec7[4] = 7;
  sec7.set(data, 5);
  const sec6 = Uint8Array.from([0x00, 0x00, 0x00, 0x06, 0x06, 0xff]);
  return finish([section1(CYCLE), section3(4, 2), section4(0), sec5, sec6, sec7]);
}

/**
 * Same scaled series as the live-shape fixture, but group references are
 * zero bits wide and are not stored. The two groups still differ.
 * Y = [99, 77, 16, 24, 14, 26, 11, 0], h1 = 10, h2 = 12, hmin = -19.
 */
function zeroBitGroupReferences(): Uint8Array {
  const sec5 = new Uint8Array(49);
  const view = new DataView(sec5.buffer);
  view.setUint32(0, 49);
  sec5[4] = 5;
  view.setUint32(5, 8);
  view.setUint16(9, 3);
  view.setFloat32(11, 1);
  view.setUint16(15, signMag(1, 16));
  view.setUint16(17, signMag(2, 16));
  sec5[19] = 0;
  sec5[21] = 1;
  view.setUint32(31, 2);
  sec5[36] = 3;
  view.setUint32(37, 4);
  sec5[41] = 1;
  view.setUint32(42, 4);
  sec5[46] = 1;
  sec5[47] = 2;
  sec5[48] = 3;
  const bits = new BitWriter();
  bits.write(signMag(10, 24), 24);
  bits.write(signMag(12, 24), 24);
  bits.write(signMag(-19, 24), 24);
  bits.align();
  for (const width of [7, 5]) bits.write(width, 3);
  bits.align();
  for (const scaled of [0, 0]) bits.write(scaled, 1);
  bits.align();
  const packed = [
    [99, 77, 16, 24],
    [14, 26, 11, 0],
  ];
  const widths = [7, 5];
  for (let group = 0; group < packed.length; group += 1) {
    for (const delta of packed[group] ?? []) bits.write(delta, widths[group] ?? 0);
  }
  const data = bits.toUint8Array();
  const sec7 = new Uint8Array(5 + data.length);
  const sec7View = new DataView(sec7.buffer);
  sec7View.setUint32(0, sec7.length);
  sec7[4] = 7;
  sec7.set(data, 5);
  const sec6 = Uint8Array.from([0x00, 0x00, 0x00, 0x06, 0x06, 0xff]);
  return finish([section1(CYCLE), section3(4, 2), section4(0), sec5, sec6, sec7]);
}

/** Constant 17-cell template 5.3. Binary scale -1, so each scaled 4 is physical 2. */
function constantSeventeen(): Uint8Array {
  const sec5 = new Uint8Array(49);
  const view = new DataView(sec5.buffer);
  view.setUint32(0, 49);
  sec5[4] = 5;
  view.setUint32(5, 17);
  view.setUint16(9, 3);
  view.setFloat32(11, 0);
  view.setUint16(15, signMag(-1, 16));
  sec5[19] = 8;
  sec5[21] = 1;
  view.setUint32(31, 1);
  view.setUint32(37, 1);
  sec5[41] = 1;
  view.setUint32(42, 17);
  sec5[47] = 2;
  sec5[48] = 3;
  const bits = new BitWriter();
  bits.write(signMag(4, 24), 24);
  bits.write(signMag(4, 24), 24);
  bits.write(signMag(0, 24), 24);
  bits.align();
  bits.write(0, 8);
  const data = bits.toUint8Array();
  const sec7 = new Uint8Array(5 + data.length);
  new DataView(sec7.buffer).setUint32(0, sec7.length);
  sec7[4] = 7;
  sec7.set(data, 5);
  const sec6 = Uint8Array.from([0x00, 0x00, 0x00, 0x06, 0x06, 0xff]);
  return finish([section1(CYCLE), section3(17, 1), section4(0), sec5, sec6, sec7]);
}

function simpleMessage(count: number, reference: number): Uint8Array {
  const sec5 = new Uint8Array(21);
  const view = new DataView(sec5.buffer);
  view.setUint32(0, 21);
  sec5[4] = 5;
  view.setUint32(5, count);
  view.setFloat32(11, reference);
  const sec7 = Uint8Array.from([0x00, 0x00, 0x00, 0x05, 0x07]);
  const sec6 = Uint8Array.from([0x00, 0x00, 0x00, 0x06, 0x06, 0xff]);
  const sec3 = new Uint8Array(6);
  new DataView(sec3.buffer).setUint32(0, 6);
  sec3[4] = 3;
  return finish([section1(CYCLE), sec3, section4(0), sec5, sec6, sec7]);
}

function padSection7(message: Uint8Array, total: number): Uint8Array {
  const extra = total - message.length;
  const out = new Uint8Array(total);
  out.set(message.subarray(0, message.length - 4), 0);
  out.set([0x37, 0x37, 0x37, 0x37], total - 4);
  const view = new DataView(out.buffer);
  view.setUint32(12, total);
  let cursor = 16;
  while (cursor + 5 < message.length) {
    const length = view.getUint32(cursor);
    if (out[cursor + 4] === 7) {
      view.setUint32(cursor, length + extra);
      break;
    }
    cursor += length;
  }
  return out;
}

function lambert(bytes: Uint8Array, latitude: number, longitude: number, code?: string) {
  const point = readLambertPoint(bytes, latitude, longitude, code);
  assert.ok(point);
  return point;
}

function cellCenter(i: number, j: number): { latitude: number; longitude: number } {
  const lat1 = (38.5 * Math.PI) / 180;
  const lon0 = (262.5 * Math.PI) / 180;
  const n = Math.sin(lat1);
  const tan = (phi: number) => Math.tan(Math.PI / 4 + phi / 2) ** n;
  const rho0 = (RADIUS * Math.cos(lat1) * tan(lat1)) / (n * tan(lat1));
  const x = i * DX;
  const y = j * DY;
  const north = rho0 - y;
  const theta = Math.atan2(x, north);
  const rho = Math.hypot(x, north);
  const powered = (RADIUS * Math.cos(lat1) * tan(lat1)) / (n * rho);
  const phi = 2 * Math.atan(powered ** (1 / n)) - Math.PI / 2;
  return {
    latitude: (phi * 180) / Math.PI,
    longitude: ((lon0 + theta / n) * 180) / Math.PI,
  };
}

function section(message: Uint8Array, number: number): Uint8Array {
  let cursor = 16;
  while (cursor + 5 < message.length) {
    const length = new DataView(message.buffer, message.byteOffset + cursor, 4).getUint32(0);
    if (message[cursor + 4] === number) return message.subarray(cursor, cursor + length);
    cursor += length;
  }
  throw new Error(`section ${number} missing`);
}

describe("v1 grib", () => {
  it("decodes the committed template 5.3 fixture, including a later group", () => {
    const message = readFileSync(FIXTURE);
    assert.ok(message.byteLength < 256 * 1024);
    assert.deepEqual(message, Buffer.from(liveShapeFixture()));
    const sec5 = section(message, 5);
    assert.equal(sec5.length, 49);
    assert.equal(new DataView(sec5.buffer, sec5.byteOffset, sec5.byteLength).getUint16(9), 3);
    assert.equal(sec5[19], 17);
    assert.equal(sec5[36], 5);
    assert.equal(sec5[46], 6);
    assert.equal(sec5[47], 2);
    assert.equal(sec5[48], 3);
    const sec7 = section(message, 7);
    assert.deepEqual(
      [...sec7.subarray(5, 14)],
      [0x00, 0x00, 0x0a, 0x00, 0x00, 0x0c, 0x80, 0x00, 0x13],
    );

    for (let j = 0; j < 2; j += 1) {
      for (let i = 0; i < 4; i += 1) {
        const scaled = SCALED[j * 4 + i] ?? 0;
        const place = i === 0 && j === 0 ? ANCHOR : cellCenter(i, j);
        const point = lambert(message, place.latitude, place.longitude);
        assert.equal(point.referenceTime, CYCLE);
        assert.equal(point.forecastHour, 0);
        assert.equal(point.category, 20);
        assert.equal(point.parameter, 0);
        assert.equal(point.surfaceType, 103);
        assert.equal(point.level, 8);
        assert.ok(Math.abs(point.value - (1 + scaled * 2) * 10 ** -2) < 1e-12);
      }
    }
  });

  it("decodes a nonconstant template 5.3 field with zero-bit group references", () => {
    const message = zeroBitGroupReferences();
    const sec5 = section(message, 5);
    assert.equal(sec5[19], 0);
    const sec7 = section(message, 7);
    assert.deepEqual(
      [...sec7.subarray(5, 16)],
      [0x00, 0x00, 0x0a, 0x00, 0x00, 0x0c, 0x80, 0x00, 0x13, 0xf4, 0x00],
    );
    const values: number[] = [];
    for (let j = 0; j < 2; j += 1) {
      for (let i = 0; i < 4; i += 1) {
        const scaled = SCALED[j * 4 + i] ?? 0;
        const place = i === 0 && j === 0 ? ANCHOR : cellCenter(i, j);
        const point = lambert(message, place.latitude, place.longitude);
        const expected = (1 + scaled * 2) * 10 ** -2;
        assert.ok(Math.abs(point.value - expected) < 1e-12);
        values.push(point.value);
      }
    }
    assert.notEqual(values[0], values[values.length - 1]);
    assert.ok(new Set(values).size > 1);
  });

  it("keeps the simple-packing caps and lets template 5.3 exceed them", () => {
    const stability = readSimpleGribFields(readFileSync(STABILITY));
    assert.equal(stability.length, 5);
    assert.equal(stability[0]?.values.length, 2);
    assert.equal(stability[0]?.values[0], 276.4744873046875);
    const sixteen = readSimpleGribFields(simpleMessage(16, 3.5));
    assert.equal(sixteen.length, 1);
    assert.deepEqual(
      sixteen[0]?.values,
      Array.from({ length: 16 }, () => 3.5),
    );
    assert.throws(
      () => readSimpleGribFields(simpleMessage(17, 3.5)),
      (err: unknown) => err instanceof V1RuleError && err.code === "noaa_grid",
    );
    assert.throws(
      () => readSimpleGribFields(readFileSync(FIXTURE)),
      (err: unknown) => err instanceof V1RuleError && err.code === "noaa_stability_parse",
    );
    assert.throws(
      () => readSimpleGribFields(new Uint8Array(256 * 1024 + 1)),
      (err: unknown) => err instanceof V1RuleError && err.code === "noaa_stability_parse",
    );

    const wide = constantSeventeen();
    assert.equal(lambert(wide, ANCHOR.latitude, ANCHOR.longitude).value, 2);
    const padded = padSection7(readFileSync(FIXTURE), 256 * 1024 + 1);
    const anchor = lambert(padded, ANCHOR.latitude, ANCHOR.longitude);
    assert.ok(Math.abs(anchor.value - 0.21) < 1e-12);

    const jpeg = liveShapeFixture();
    jpeg[section(jpeg, 5).byteOffset - jpeg.byteOffset + 10] = 40;
    assert.throws(
      () => readLambertPoint(jpeg, ANCHOR.latitude, ANCHOR.longitude),
      (err: unknown) => err instanceof V1RuleError && err.code === "noaa_smoke_parse",
    );
  });

  it("refuses a place outside the Lambert grid", () => {
    assert.throws(
      () => readLambertPoint(readFileSync(FIXTURE), 0, 0),
      (err: unknown) => err instanceof V1RuleError && err.code === "noaa_smoke_parse",
    );
  });

  it("uses the template 4.8 interval end as the valid hour", () => {
    const message = replaceSection4(liveShapeFixture(), section4Interval(49));
    const start = section(message, 4);
    assert.equal(new DataView(start.buffer, start.byteOffset, start.byteLength).getUint16(7), 8);
    assert.equal(new DataView(start.buffer, start.byteOffset, start.byteLength).getUint32(18), 48);
    for (let j = 0; j < 2; j += 1) {
      for (let i = 0; i < 4; i += 1) {
        const scaled = SCALED[j * 4 + i] ?? 0;
        const place = i === 0 && j === 0 ? ANCHOR : cellCenter(i, j);
        const point = lambert(message, place.latitude, place.longitude, "noaa_aqf_parse");
        assert.equal(point.forecastHour, 49);
        assert.equal(point.referenceTime, CYCLE);
        assert.ok(Math.abs(point.value - (1 + scaled * 2) * 10 ** -2) < 1e-12);
      }
    }
  });

  it("decodes the recorded template 4.8 bitmap and does not turn a mask into 0", () => {
    const message = readFileSync(AQM_FIXTURE);
    assert.deepEqual(message, Buffer.from(template48Bitmap()));
    const sec4 = section(message, 4);
    assert.equal(new DataView(sec4.buffer, sec4.byteOffset, sec4.byteLength).getUint16(7), 8);
    const sec6 = section(message, 6);
    assert.equal(sec6[5], 0);
    assert.equal(
      readLambertPoint(message, ANCHOR.latitude, ANCHOR.longitude, "noaa_aqf_parse"),
      null,
    );
    const first = lambert(
      message,
      cellCenter(1, 0).latitude,
      cellCenter(1, 0).longitude,
      "noaa_aqf_parse",
    );
    const second = lambert(
      message,
      cellCenter(2, 0).latitude,
      cellCenter(2, 0).longitude,
      "noaa_aqf_parse",
    );
    assert.equal(first.forecastHour, 49);
    assert.equal(first.category, 13);
    assert.equal(first.parameter, 193);
    assert.equal(first.surfaceType, 1);
    assert.equal(first.level, 0);
    assert.equal(first.i, 1);
    assert.equal(first.j, 0);
    assert.equal(first.value, 1);
    assert.notEqual(first.value, 0);
    assert.equal(second.value, 2);
    assert.equal(second.i, 2);
  });
});
