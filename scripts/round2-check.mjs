#!/usr/bin/env node
/**
 * Checks the round 2 scale: contrast, hue ban, and the Boise smoke-day story.
 * Reads the model embedded in design/round2.html so the page stays one file.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const htmlPath = new URL("../design/round2.html", import.meta.url);
const sheetPath = new URL("../design/round2-tokens.html", import.meta.url);
const html = readFileSync(htmlPath, "utf8");
const failures = [];

function fail(message) {
  failures.push(message);
}

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
if (scripts.length < 2) fail("expected the model script and the UI script");
scripts.forEach((src, i) => {
  const path = join(tmpdir(), `round2-script-${i}.js`);
  writeFileSync(path, src);
  execFileSync(process.execPath, ["--check", path], { stdio: "inherit" });
});

const model = html.match(/\/\/ MODEL-START\n([\s\S]*?)\/\/ MODEL-END/);
if (!model) fail("model markers missing");
const Round2 = model ? new Function(`${model[1]}\nreturn Round2;`)() : null;

function srgbToOklch(r, g, b) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b2 = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  let H = (Math.atan2(b2, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C: Math.hypot(a, b2), H };
}

function scanHex(file, text) {
  const found = text.match(/#[0-9A-Fa-f]{6}\b/g) || [];
  for (const hex of found) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const { C, H } = srgbToOklch(r, g, b);
    if (C > 0.02 && H >= 250 && H <= 345) {
      fail(`${file} ${hex} sits in the violet/magenta hue range (${H.toFixed(0)}°)`);
    }
  }
}

if (Round2) {
  scanHex("design/round2.html", html);
  let sheet = "";
  try {
    sheet = readFileSync(sheetPath, "utf8");
    scanHex("design/round2-tokens.html", sheet);
  } catch {
    fail("design/round2-tokens.html is missing");
  }

  let worst = { ratio: 99, soft: 99 };
  let flip = null;
  let prevInk = null;
  for (let aqi = 0; aqi <= 500; aqi += 0.25) {
    const paint = Round2.paintAqi(aqi, 4.7);
    if (paint.H < 20 || paint.H > 175) fail(`AQI ${aqi} hue ${paint.H.toFixed(1)} leaves the teal-to-oxblood path`);
    if (paint.ratio < 4.5) fail(`AQI ${aqi} text contrast ${paint.ratio.toFixed(2)} on ${paint.hex}`);
    if (paint.softRatio < 4.5) fail(`AQI ${aqi} secondary contrast ${paint.softRatio.toFixed(2)}`);
    if (paint.ratio < worst.ratio) worst = { ...paint, aqi, soft: paint.softRatio };
    if (paint.ink !== prevInk) {
      flip = { aqi, ink: paint.ink, hex: paint.hex, ratio: paint.ratio };
      prevInk = paint.ink;
    }
  }

  const now = Round2.aqiAt(Round2.NOW);
  if (Math.round(now) !== 48) fail(`now AQI is ${now}, expected 48`);
  if (Round2.category(now) !== "good") fail("now should be Good");
  const peak = Round2.aqiAt(18);
  if (Round2.category(peak) !== "hazardous") fail(`Thu 6 PM should be Hazardous, got ${Round2.category(peak)} (${peak})`);
  if (Round2.dominant(18) !== "PM2.5") fail(`Thu 6 PM dominant is ${Round2.dominant(18)}`);
  if (Round2.outlook(7) !== "Peaks around 6 PM") fail(`outlook at 7 AM: ${Round2.outlook(7)}`);
  if (Round2.outlook(18) !== "Improves around Fri 4 PM") fail(`outlook at 6 PM: ${Round2.outlook(18)}`);
  const win = Round2.bestWindow(0);
  if (win.start !== 2 || win.end !== 4) fail(`Thursday best window ${win.start}–${win.end}`);
  if (Round2.dominant(13 + 72) !== "O3") fail("Sunday afternoon should be ozone, not smoke");
  if (Round2.smokeAt(18) <= peak) fail("smoke index should rise above the composite at the peak");
  if (Round2.o3At(13) <= Round2.o3At(18)) fail("ozone should peak in the afternoon, not the evening");
  const anchors = [0, 50, 100, 150, 175, 200, 300, 500];
  console.log("worst", worst.ratio.toFixed(2), "at AQI", worst.aqi, worst.hex, "ink", worst.inkHex);
  console.log("flip", flip);
  for (const aqi of anchors) {
    const paint = Round2.paintAqi(aqi, 4.7);
    const line = `${aqi}\t${paint.hex}\t${paint.oklch}\t${paint.inkHex}\t${paint.ratio.toFixed(2)}\t${paint.softHex}\t${paint.softRatio.toFixed(2)}`;
    console.log(line);
    if (sheet && !sheet.toUpperCase().includes(paint.hex)) {
      fail(`token sheet is missing ${paint.hex} for AQI ${aqi}`);
    }
  }
  if (html.includes("<script src")) fail("prototype must stay a single file");
}

if (failures.length) {
  for (const message of failures) console.error("FAIL", message);
  process.exit(1);
}
console.log("round2 check ok");
