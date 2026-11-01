import { V1RuleError } from "./errors.ts";

/**
 * GRIB2 simple-packing reader for a small NOMADS filter extract.
 * Full CONUS files use complex packing. The filter rewrites a tiny box as grid_simple.
 */

export interface SimpleGribField {
  /** Section 1 reference time, UTC. */
  referenceTime: string;
  /** Forecast lead in hours. Analysis is 0. */
  forecastHour: number;
  category: number;
  parameter: number;
  /** GRIB type of the first fixed surface. 1 is the ground, 103 is meters above ground. */
  surfaceType: number;
  level: number;
  values: number[];
}

const MAX_BYTES = 256 * 1024;
const MAX_MESSAGES = 32;
const MAX_POINTS = 16;
const MAX_BITS = 32;

function fail(message: string, code = "noaa_stability_parse"): never {
  throw new V1RuleError(code, message);
}

function readUint(
  bytes: Uint8Array,
  offset: number,
  size: number,
  code = "noaa_stability_parse",
): number {
  if (offset < 0 || size < 1 || offset + size > bytes.length)
    fail("GRIB2 message is truncated.", code);
  let value = 0;
  for (let i = 0; i < size; i += 1) {
    value = value * 256 + (bytes[offset + i] ?? 0);
  }
  if (!Number.isSafeInteger(value)) fail("GRIB2 field is too large to read.", code);
  return value;
}

/** GRIB signed integers use a sign bit, not two's complement. */
function signMag(value: number, bits: number): number {
  const sign = 2 ** (bits - 1);
  if (value >= sign) return -(value - sign);
  return value;
}

function referenceTime(section: Uint8Array, code = "noaa_stability_parse"): string {
  if (readUint(section, 5, 2, code) !== 7) fail("GRIB2 center is not NCEP.", code);
  const year = readUint(section, 12, 2);
  const month = section[14] ?? 0;
  const day = section[15] ?? 0;
  const hour = section[16] ?? 0;
  const minute = section[17] ?? 0;
  const second = section[18] ?? 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    fail("GRIB2 reference time is not a real UTC hour.", code);
  }
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    fail("GRIB2 reference time is not a real UTC hour.", code);
  }
  return parsed.toISOString();
}

function unpack(data: Uint8Array, count: number, bits: number): number[] {
  if (bits === 0) return Array.from({ length: count }, () => 0);
  if (data.length * 8 < count * bits) fail("GRIB2 data section is shorter than its grid.");
  const values: number[] = [];
  let bit = 0;
  for (let i = 0; i < count; i += 1) {
    let packed = 0;
    for (let b = 0; b < bits; b += 1) {
      const byte = data[bit >> 3] ?? 0;
      packed = packed * 2 + ((byte >> (7 - (bit & 7))) & 1);
      bit += 1;
    }
    values.push(packed);
  }
  return values;
}

function readMessage(message: Uint8Array): SimpleGribField | null {
  if (message[6] !== 0 || message[7] !== 2) fail("Stability extract is not GRIB2 discipline 0.");
  if (
    message.length < 20 ||
    String.fromCharCode(...message.subarray(message.length - 4)) !== "7777"
  ) {
    fail("GRIB2 message is missing its end section.");
  }
  const sections = new Map<number, Uint8Array>();
  let cursor = 16;
  while (cursor + 4 < message.length) {
    const length = readUint(message, cursor, 4);
    if (length < 5 || cursor + length > message.length) fail("GRIB2 section length is wrong.");
    const number = message[cursor + 4] ?? 0;
    sections.set(number, message.subarray(cursor, cursor + length));
    cursor += length;
  }
  const sec1 = sections.get(1);
  const sec4 = sections.get(4);
  const sec5 = sections.get(5);
  const sec6 = sections.get(6);
  const sec7 = sections.get(7);
  if (!sec1 || !sec4 || !sec5 || !sec6 || !sec7) fail("GRIB2 message is missing a section.");
  if (sec4.length < 34 || readUint(sec4, 7, 2) !== 0) return null;
  if ((sec6[5] ?? 0) !== 255) fail("GRIB2 bitmap is not used for this extract.");
  if (sec5.length < 21 || readUint(sec5, 9, 2) !== 0) {
    fail("NOAA stability grid is not simple packing.");
  }
  const count = readUint(sec5, 5, 4);
  if (count < 1 || count > MAX_POINTS) {
    throw new V1RuleError("noaa_grid", "Stability extract must stay inside 16 grid cells.");
  }
  const bits = sec5[19] ?? 0;
  if (bits > MAX_BITS) fail("GRIB2 simple packing is wider than 32 bits.");
  const view = new DataView(sec5.buffer, sec5.byteOffset, sec5.byteLength);
  const reference = view.getFloat32(11, false);
  const binaryScale = signMag(readUint(sec5, 15, 2), 16);
  const decimalScale = signMag(readUint(sec5, 17, 2), 16);
  const scale = signMag(sec4[23] ?? 0, 8);
  const level = signMag(readUint(sec4, 24, 4), 32) / 10 ** scale;
  const unit = sec4[17] ?? 0;
  if (unit !== 1) fail("GRIB2 forecast time is not in hours.");
  const forecastHour = readUint(sec4, 18, 4);
  const values = unpack(sec7.subarray(5), count, bits).map(
    (packed) => (reference + packed * 2 ** binaryScale) * 10 ** -decimalScale,
  );
  if (!values.every((value) => Number.isFinite(value))) fail("GRIB2 value is not a finite number.");
  return {
    referenceTime: referenceTime(sec1),
    forecastHour,
    category: sec4[9] ?? 0,
    parameter: sec4[10] ?? 0,
    surfaceType: sec4[22] ?? 0,
    level,
    values,
  };
}

/** Messages that are not instantaneous simple-packed fields are skipped. */
export function readSimpleGribFields(bytes: Uint8Array): SimpleGribField[] {
  if (bytes.length < 16 || bytes.length > MAX_BYTES)
    fail("NOAA stability response is not a GRIB2 file.");
  const fields: SimpleGribField[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    if (fields.length >= MAX_MESSAGES) fail("GRIB2 extract has too many messages.");
    if (
      bytes[cursor] !== 0x47 ||
      bytes[cursor + 1] !== 0x52 ||
      bytes[cursor + 2] !== 0x49 ||
      bytes[cursor + 3] !== 0x42
    ) {
      fail("NOAA stability response is not a GRIB2 file.");
    }
    const length = readUint(bytes, cursor + 8, 8);
    if (length < 16 || cursor + length > bytes.length) fail("GRIB2 message is truncated.");
    const field = readMessage(bytes.subarray(cursor, cursor + length));
    if (field) fields.push(field);
    cursor += length;
  }
  if (fields.length === 0) fail("GRIB2 extract has no simple-packed fields.");
  return fields;
}

/** One decoded grid point from a template 5.3 Lambert field. */
export interface LambertPoint {
  referenceTime: string;
  forecastHour: number;
  category: number;
  parameter: number;
  surfaceType: number;
  level: number;
  /** Physical value after the GRIB reference, binary scale, and decimal scale. */
  value: number;
}

const MAX_LAMBERT_BYTES = 8 * 1024 * 1024;

interface BitWindow {
  data: Uint8Array;
  bytePos: number;
  buf: bigint;
  bufBits: number;
  code: string;
}

function readWindowBits(window: BitWindow, nbits: number): number {
  if (nbits < 0 || nbits > 32) fail("GRIB2 packed field is wider than 32 bits.", window.code);
  while (window.bufBits < nbits) {
    const next = window.data[window.bytePos];
    if (next == null) fail("GRIB2 data section is shorter than its grid.", window.code);
    window.buf = (window.buf << 8n) | BigInt(next);
    window.bytePos += 1;
    window.bufBits += 8;
  }
  const shift = BigInt(window.bufBits - nbits);
  const value = Number((window.buf >> shift) & ((1n << BigInt(nbits)) - 1n));
  window.bufBits -= nbits;
  window.buf &= (1n << BigInt(window.bufBits)) - 1n;
  return value;
}

/** Group references, widths, and lengths are each padded to the next octet. */
function alignWindow(window: BitWindow): void {
  const extra = window.bufBits & 7;
  if (!extra) return;
  window.bufBits -= extra;
  window.buf &= (1n << BigInt(window.bufBits)) - 1n;
}

interface LambertAxes {
  nx: number;
  ny: number;
  radius: number;
  latin: number;
  lov: number;
  la1: number;
  lo1: number;
  dx: number;
  dy: number;
}

function lambertAxes(sec3: Uint8Array, code: string): LambertAxes {
  if (sec3.length < 81 || readUint(sec3, 12, 2, code) !== 30) {
    fail("GRIB2 place grid is not Lambert conformal.", code);
  }
  // Shape 6 with a zero radius is the NCEP sphere. eccodes reports 6371229 m.
  if ((sec3[14] ?? 0) !== 6) fail("GRIB2 earth radius is not the NCEP sphere.", code);
  const nx = readUint(sec3, 30, 4, code);
  const ny = readUint(sec3, 34, 4, code);
  const points = readUint(sec3, 6, 4, code);
  if (nx < 1 || ny < 1 || nx * ny !== points || points > 5_000_000) {
    fail("GRIB2 grid is an unexpected size.", code);
  }
  const la1 = signMag(readUint(sec3, 38, 4, code), 32) / 1e6;
  const lo1 = signMag(readUint(sec3, 42, 4, code), 32) / 1e6;
  const lad = signMag(readUint(sec3, 47, 4, code), 32) / 1e6;
  const lov = signMag(readUint(sec3, 51, 4, code), 32) / 1e6;
  const dx = readUint(sec3, 55, 4, code) / 1000;
  const dy = readUint(sec3, 59, 4, code) / 1000;
  const latin1 = signMag(readUint(sec3, 65, 4, code), 32) / 1e6;
  const latin2 = signMag(readUint(sec3, 69, 4, code), 32) / 1e6;
  if ((sec3[64] ?? 0) !== 64) fail("GRIB2 scan is not i east and j north.", code);
  if (Math.abs(latin1 - latin2) > 1e-6 || Math.abs(latin1 - lad) > 1e-6) {
    fail("GRIB2 Lambert parallels are not equal.", code);
  }
  if (!(dx > 0) || !(dy > 0)) fail("GRIB2 grid spacing is not positive.", code);
  return { nx, ny, radius: 6_371_229, latin: latin1, lov, la1, lo1, dx, dy };
}

function toEast(longitude: number): number {
  return longitude < 0 ? longitude + 360 : longitude;
}

/** Nearest cell center. i increases east, j north, index is `j * nx + i`. */
function nearestLambertIndex(
  grid: LambertAxes,
  latitude: number,
  longitude: number,
  code: string,
): number {
  const lat1 = (grid.latin * Math.PI) / 180;
  const lon0 = (grid.lov * Math.PI) / 180;
  const n = Math.sin(lat1);
  const tan = (phi: number) => Math.tan(Math.PI / 4 + phi / 2) ** n;
  const rho = (phi: number) => (grid.radius * Math.cos(lat1) * tan(lat1)) / (n * tan(phi));
  const rho0 = rho(lat1);
  const project = (latDeg: number, lonEast: number): [number, number] => {
    const phi = (latDeg * Math.PI) / 180;
    const theta = n * ((lonEast * Math.PI) / 180 - lon0);
    const r = rho(phi);
    return [r * Math.sin(theta), rho0 - r * Math.cos(theta)];
  };
  const [x1, y1] = project(grid.la1, toEast(grid.lo1));
  const [x, y] = project(latitude, toEast(longitude));
  const i = Math.round((x - x1) / grid.dx);
  const j = Math.round((y - y1) / grid.dy);
  if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) {
    fail("Place is outside the HRRR Lambert grid.", code);
  }
  return j * grid.nx + i;
}

/**
 * Template 5.3 / 7.3, order 2. The first two coded values are unused.
 * h1, h2, and hmin rebuild the scaled integers from the start of the grid,
 * so a point near the middle still walks every group up to that index.
 */
function spatialValueAt(sec5: Uint8Array, sec7: Uint8Array, index: number, code: string): number {
  if (sec5.length < 49) fail("GRIB2 spatial-differencing section is short.", code);
  const nvals = readUint(sec5, 5, 4, code);
  if (index < 0 || index >= nvals)
    fail("GRIB2 sample asks for a point the grid does not have.", code);
  if (readUint(sec5, 9, 2, code) !== 3) fail("GRIB2 smoke field is not complex packing.", code);
  if ((sec5[47] ?? 0) !== 2) fail("GRIB2 spatial differencing is not order 2.", code);
  if ((sec5[21] ?? 0) !== 1 || (sec5[22] ?? 0) !== 0) {
    fail("GRIB2 group packing is not the plain scheme.", code);
  }
  const view = new DataView(sec5.buffer, sec5.byteOffset, sec5.byteLength);
  const reference = view.getFloat32(11, false);
  const binaryScale = signMag(readUint(sec5, 15, 2, code), 16);
  const decimalScale = signMag(readUint(sec5, 17, 2, code), 16);
  const bits = sec5[19] ?? 0;
  const groups = readUint(sec5, 31, 4, code);
  const widthRef = sec5[35] ?? 0;
  const widthBits = sec5[36] ?? 0;
  const lengthRef = readUint(sec5, 37, 4, code);
  const lengthInc = sec5[41] ?? 0;
  const lastLength = readUint(sec5, 42, 4, code);
  const lengthBits = sec5[46] ?? 0;
  const octets = sec5[48] ?? 0;
  if (
    groups < 1 ||
    groups > nvals ||
    octets < 1 ||
    octets > 4 ||
    bits < 1 ||
    bits > 32 ||
    widthBits > 32 ||
    lengthBits > 32
  ) {
    fail("GRIB2 spatial-differencing widths are not readable.", code);
  }
  const window: BitWindow = {
    data: sec7.subarray(5),
    bytePos: 0,
    buf: 0n,
    bufBits: 0,
    code,
  };
  const read = (nbits: number) => readWindowBits(window, nbits);
  const h1 = signMag(read(octets * 8), octets * 8);
  const h2 = signMag(read(octets * 8), octets * 8);
  const hmin = signMag(read(octets * 8), octets * 8);
  alignWindow(window);
  const refs = new Uint32Array(groups);
  for (let i = 0; i < groups; i += 1) refs[i] = read(bits);
  alignWindow(window);
  const widths = new Uint16Array(groups);
  for (let i = 0; i < groups; i += 1) widths[i] = widthRef + read(widthBits);
  alignWindow(window);
  const lengths = new Uint32Array(groups);
  for (let i = 0; i < groups; i += 1) {
    const scaled = read(lengthBits);
    lengths[i] = i === groups - 1 ? lastLength : lengthRef + scaled * lengthInc;
  }
  alignWindow(window);
  const need = index + 1;
  const packed = new Float64Array(need);
  let cursor = 0;
  for (let group = 0; group < groups && cursor < need; group += 1) {
    const width = widths[group] ?? 0;
    const length = lengths[group] ?? 0;
    const groupRef = refs[group] ?? 0;
    const take = Math.min(length, need - cursor);
    if (width === 0) packed.fill(groupRef, cursor, cursor + take);
    else {
      for (let k = 0; k < take; k += 1) packed[cursor + k] = groupRef + read(width);
    }
    cursor += take;
  }
  if (cursor < need) fail("GRIB2 spatial field ended before the sample.", code);
  const power = 2 ** binaryScale;
  const decimal = 10 ** -decimalScale;
  let prev2 = 0;
  let prev1 = 0;
  let value = 0;
  for (let i = 0; i < need; i += 1) {
    const x = i === 0 ? h1 : i === 1 ? h2 : (packed[i] ?? 0) + hmin + 2 * prev1 - prev2;
    prev2 = prev1;
    prev1 = x;
    if (i === index) value = (reference + x * power) * decimal;
  }
  if (!Number.isFinite(value)) fail("GRIB2 value is not a finite number.", code);
  return value;
}

/**
 * One Lambert cell from a template 5.3 message.
 * `latitude` and `longitude` are the place's HRRR cell center, not a Lambert i,j.
 * Simple-packed stability extracts stay on `readSimpleGribFields`.
 */
export function readLambertPoint(
  bytes: Uint8Array,
  latitude: number,
  longitude: number,
  code = "noaa_smoke_parse",
): LambertPoint {
  if (bytes.length < 16 || bytes.length > MAX_LAMBERT_BYTES) {
    fail("NOAA response is not a GRIB2 file.", code);
  }
  if (bytes[0] !== 0x47 || bytes[1] !== 0x52 || bytes[2] !== 0x49 || bytes[3] !== 0x42) {
    fail("NOAA response is not a GRIB2 file.", code);
  }
  if (bytes[6] !== 0 || bytes[7] !== 2) fail("Place extract is not GRIB2 discipline 0.", code);
  const length = readUint(bytes, 8, 8, code);
  if (length !== bytes.length) fail("GRIB2 message is truncated.", code);
  if (String.fromCharCode(...bytes.subarray(bytes.length - 4)) !== "7777") {
    fail("GRIB2 message is missing its end section.", code);
  }
  const sections = new Map<number, Uint8Array>();
  let cursor = 16;
  while (cursor + 4 < bytes.length) {
    const sectionLength = readUint(bytes, cursor, 4, code);
    if (sectionLength < 5 || cursor + sectionLength > bytes.length) {
      fail("GRIB2 section length is wrong.", code);
    }
    const number = bytes[cursor + 4] ?? 0;
    sections.set(number, bytes.subarray(cursor, cursor + sectionLength));
    cursor += sectionLength;
  }
  const sec1 = sections.get(1);
  const sec3 = sections.get(3);
  const sec4 = sections.get(4);
  const sec5 = sections.get(5);
  const sec6 = sections.get(6);
  const sec7 = sections.get(7);
  if (!sec1 || !sec3 || !sec4 || !sec5 || !sec6 || !sec7) {
    fail("GRIB2 message is missing a section.", code);
  }
  if (sec4.length < 34 || readUint(sec4, 7, 2, code) !== 0) {
    fail("HRRR smoke field is not an instantaneous forecast.", code);
  }
  if ((sec4[17] ?? 0) !== 1) fail("GRIB2 forecast time is not in hours.", code);
  if ((sec6[5] ?? 0) !== 255) fail("GRIB2 bitmap is not used for this smoke field.", code);
  const grid = lambertAxes(sec3, code);
  const index = nearestLambertIndex(grid, latitude, longitude, code);
  const scale = signMag(sec4[23] ?? 0, 8);
  const level = signMag(readUint(sec4, 24, 4, code), 32) / 10 ** scale;
  return {
    referenceTime: referenceTime(sec1, code),
    forecastHour: readUint(sec4, 18, 4, code),
    category: sec4[9] ?? 0,
    parameter: sec4[10] ?? 0,
    surfaceType: sec4[22] ?? 0,
    level,
    value: spatialValueAt(sec5, sec7, index, code),
  };
}
