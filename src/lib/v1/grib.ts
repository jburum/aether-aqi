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

function fail(message: string): never {
  throw new V1RuleError("noaa_stability_parse", message);
}

function readUint(bytes: Uint8Array, offset: number, size: number): number {
  if (offset < 0 || size < 1 || offset + size > bytes.length) fail("GRIB2 message is truncated.");
  let value = 0;
  for (let i = 0; i < size; i += 1) {
    value = value * 256 + (bytes[offset + i] ?? 0);
  }
  if (!Number.isSafeInteger(value)) fail("GRIB2 field is too large to read.");
  return value;
}

/** GRIB signed integers use a sign bit, not two's complement. */
function signMag(value: number, bits: number): number {
  const sign = 2 ** (bits - 1);
  if (value >= sign) return -(value - sign);
  return value;
}

function referenceTime(section: Uint8Array): string {
  if (readUint(section, 5, 2) !== 7) fail("GRIB2 center is not NCEP.");
  const year = readUint(section, 12, 2);
  const month = section[14] ?? 0;
  const day = section[15] ?? 0;
  const hour = section[16] ?? 0;
  const minute = section[17] ?? 0;
  const second = section[18] ?? 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    fail("GRIB2 reference time is not a real UTC hour.");
  }
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    fail("GRIB2 reference time is not a real UTC hour.");
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
