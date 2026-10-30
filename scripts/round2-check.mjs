#!/usr/bin/env node
/**
 * Checks the round 2 scale: contrast, the no-purple sky ramp, and the Boise smoke-day story.
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
    if (paint.C > 0.02 && paint.H >= 250 && paint.H <= 345) {
      fail(`AQI ${aqi} hue ${paint.H.toFixed(1)} is violet or magenta`);
    }
    if (aqi <= 200 && paint.C < 0.09) {
      fail(`AQI ${aqi} chroma ${paint.C.toFixed(3)} drops out of the ramp into gray`);
    }
    if (aqi >= 220 && (paint.H < 18 || paint.H > 36)) {
      fail(`AQI ${aqi} hue ${paint.H.toFixed(1)} leaves ember-to-oxblood`);
    }
    if (paint.ratio < 4.5) fail(`AQI ${aqi} text contrast ${paint.ratio.toFixed(2)} on ${paint.hex}`);
    if (paint.softRatio < 4.5) fail(`AQI ${aqi} secondary contrast ${paint.softRatio.toFixed(2)}`);
    const sky = Round2.skyAt(aqi);
    if (sky.topRatio < 4.5 || sky.botRatio < 4.5) {
      fail(
        `AQI ${aqi} sky contrast ${sky.topRatio.toFixed(2)} / ${sky.botRatio.toFixed(2)}`,
      );
    }
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
  if (Round2.DAY_NAMES.length !== 7) fail("the scrub curve is 7 days");
  if (Round2.HORIZON !== 120) fail("the 5-day horizon stays at hour 120");
  let prevHue = 400;
  for (const aqi of [0, 50, 100, 150, 200, 300, 500]) {
    const paint = Round2.paintAqi(aqi, 4.7);
    if (paint.H > prevHue + 0.4) {
      fail(`hue leaves the green-to-maroon path at AQI ${aqi} (${paint.H.toFixed(1)} after ${prevHue.toFixed(1)})`);
    }
    prevHue = paint.H;
  }
  const goodAir = Round2.paintAqi(0, 4.7);
  if (goodAir.L < 0.58 || goodAir.L > 0.72 || goodAir.C < 0.11 || goodAir.C > 0.16 || goodAir.H < 145 || goodAir.H > 165) {
    fail(
      `good air ${goodAir.hex} L${goodAir.L.toFixed(3)} C${goodAir.C.toFixed(3)} H${goodAir.H.toFixed(0)} should be a deep green, not a pastel or a blue`,
    );
  }
  const endOfGood = Round2.paintAqi(50, 4.7);
  if (endOfGood.C < 0.11 || endOfGood.H < 135 || endOfGood.H > 155) {
    fail(`AQI 50 ${endOfGood.hex} should still be green`);
  }
  const yellow = Round2.paintAqi(100, 4.7);
  if (yellow.C < 0.11 || yellow.H < 88 || yellow.H > 110) {
    fail(`AQI 100 ${yellow.hex} should be yellow`);
  }
  const orange = Round2.paintAqi(150, 4.7);
  if (orange.C < 0.11 || orange.H < 50 || orange.H > 72) {
    fail(`AQI 150 ${orange.hex} should be orange`);
  }
  const goodSky = Round2.skyAt(0);
  if (goodSky.top.L > 0.78 || goodSky.top.C < 0.08) {
    fail(`good-air sky top ${goodSky.top.hex} is still a pastel wash`);
  }
  const haz = Round2.paintAqi(500, 4.7);
  if (haz.L > 0.22 || haz.H > 30) fail(`hazardous ${haz.hex} is not near-black red`);
  if (Round2.skyAt(0).amp < 0.08) fail("good-air sky gradient is flat");
  if (Round2.skyAt(500).amp < 0.08) fail("hazardous sky gradient is flat");
  const lead = Round2.forecastLead();
  if (!lead.body.includes("outdoor window")) fail(`forecast lead: ${lead.body}`);
  if (!/\.advice \{[^}]*white-space:\s*nowrap/.test(html)) fail("advice should stay one line");
  if (lead.title !== "Hazardous by 6 PM") fail(`forecast title: ${lead.title}`);
  const wins = Round2.decisionWindows();
  if (wins.length !== 2 || wins[0].hour !== 15 || wins[1].hour !== 40) {
    fail(`decision windows ${JSON.stringify(wins)}`);
  }
  if (Round2.dayPeak(7) !== 18) fail(`Thursday peak is ${Round2.dayPeak(7)}`);
  const story = Round2.pollutantStory("pm", 18);
  if (!/smoke/i.test(story.why) || !story.trend) fail(`pollutant story: ${story.why}`);
  for (let h = 0; h <= 167; h++) {
    const line = Round2.personal(h);
    if (/Sensitive groups should|Everyone should limit|Emergency\. Stay/.test(line)) {
      fail(`boilerplate at hour ${h}: ${line}`);
    }
  }
  if (!/valley|smoke/i.test(Round2.personal(18))) fail("Thursday evening copy should name the smoke");
  if (Round2.aqiAt(144) > 50) fail("Tuesday, past the horizon, should stay Good");
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
  const levels = Object.keys(Round2.LEVEL_TINT);
  let crossWorst = { ratio: 99, held: "", dest: "", hex: "" };
  for (const held of levels) {
    const tint = Round2.bytesFromHex(Round2.LEVEL_TINT[held]).map((v) => v / 255);
    const pill = tint.map((v) => v * 0.92 + 0.08);
    for (const dest of levels) {
      const accent = Round2.levelAccent(dest, Round2.LEVEL_TINT[held]);
      const ratio = Round2.contrast(
        accent.rgb.map((v) => v / 255),
        pill,
      );
      if (ratio < crossWorst.ratio) crossWorst = { ratio, held, dest, hex: accent.hex };
      if (ratio < 4.5) {
        fail(
          `${dest} on held ${held} pill is ${ratio.toFixed(2)}:1 (${accent.hex} on ${Round2.LEVEL_TINT[held]})`,
        );
      }
    }
  }
  console.log(
    "cross tint",
    crossWorst.ratio.toFixed(2),
    crossWorst.dest,
    "on held",
    crossWorst.held,
    crossWorst.hex,
  );
  if (!/const fieldColor = fieldNow\(\)/.test(html)) {
    fail("pill accent should use the field's actual color through the 600ms fade");
  }
  if (/tintHold \? fieldNow\(\)/.test(html)) {
    fail("the moving fade still tunes the pill to the destination tint");
  }
  if (!html.includes("R.soften(fieldBytes, [255, 255, 255], 4.7)")) {
    fail("secondary text should soften against the actual field color");
  }
  const fadeEnds = ["#000000", ...levels.map((id) => Round2.LEVEL_TINT[id])];
  const fadeSeen = new Set();
  let fadeWorst = { ratio: 99, dest: "", css: "", hex: "", ms: 0 };
  function pillOf(bytes) {
    return bytes.map((v) => v / 255).map((v) => v * 0.92 + 0.08);
  }
  function checkField(css, bytes, ms) {
    const parsed = Round2.bytesFromColor(css);
    if (!parsed || parsed.join(",") !== bytes.join(",")) {
      fail(`${css} parsed as ${parsed && parsed.join(",")}, expected ${bytes.join(",")}`);
      return;
    }
    const pill = pillOf(bytes);
    let worst = { ratio: 99, dest: "", hex: "" };
    for (const dest of levels) {
      const accent = Round2.levelAccent(dest, css);
      const ratio = Round2.contrast(
        accent.rgb.map((v) => v / 255),
        pill,
      );
      if (ratio < worst.ratio) worst = { ratio, dest, hex: accent.hex };
      if (ratio < fadeWorst.ratio) fadeWorst = { ratio, dest, css, hex: accent.hex, ms };
      if (ratio < 4.5) fail(`${dest} at ${ms}ms on ${css} is ${ratio.toFixed(2)}:1 (${accent.hex})`);
    }
    const soft = Round2.soften(bytes, [255, 255, 255], 4.7);
    const softRatio = Round2.contrast(
      bytes.map((v) => v / 255),
      soft.bytes.map((v) => v / 255),
    );
    if (softRatio < 4.5) fail(`secondary at ${ms}ms on ${css} is ${softRatio.toFixed(2)}:1`);
    return worst;
  }
  for (let i = 0; i < fadeEnds.length; i++) {
    const from = Round2.bytesFromHex(fadeEnds[i]);
    for (let j = 0; j < fadeEnds.length; j++) {
      if (i === j) continue;
      const to = Round2.bytesFromHex(fadeEnds[j]);
      for (let ms = 0; ms <= 600; ms += 10) {
        const t = ms / 600;
        const bytes = from.map((v, channel) => Math.round(v + (to[channel] - v) * t));
        const key = bytes.join(",");
        if (fadeSeen.has(key)) continue;
        fadeSeen.add(key);
        checkField(`rgb(${bytes[0]}, ${bytes[1]}, ${bytes[2]})`, bytes, ms);
      }
    }
  }
  // Moderate → hazardous at 80ms. Tuned to the hazardous tint, Unhealthy was 3.93:1 here.
  const at80 = Round2.bytesFromHex(Round2.LEVEL_TINT.moderate).map((v, channel) => {
    const to = Round2.bytesFromHex(Round2.LEVEL_TINT.hazardous);
    return Math.round(v + (to[channel] - v) * (80 / 600));
  });
  const fade80 = checkField(`rgb(${at80[0]}, ${at80[1]}, ${at80[2]})`, at80, 80);
  console.log(
    "80ms moderate→hazardous",
    fade80.ratio.toFixed(2),
    fade80.dest,
    fade80.hex,
    `rgb(${at80[0]}, ${at80[1]}, ${at80[2]})`,
  );
  const midFade = [22, 16, 11];
  checkField("rgb(22, 16, 11)", midFade, 300);
  checkField("rgb(22 16 11)", midFade, 300);
  checkField("rgba(22, 16, 11, 1)", midFade, 300);
  checkField("rgb(22 16 11 / 1)", midFade, 300);
  checkField(`color(srgb ${22 / 255} ${16 / 255} ${11 / 255})`, midFade, 300);
  for (const held of levels) {
    const bytes = Round2.bytesFromHex(Round2.LEVEL_TINT[held]);
    const css = `rgb(${bytes[0]}, ${bytes[1]}, ${bytes[2]})`;
    for (const dest of levels) {
      const fromHex = Round2.levelAccent(dest, Round2.LEVEL_TINT[held]).hex;
      const fromRgb = Round2.levelAccent(dest, css).hex;
      if (fromHex !== fromRgb) fail(`${dest} on ${held} rgb() ${fromRgb} drifted from ${fromHex}`);
    }
  }
  console.log(
    "fade",
    fadeWorst.ratio.toFixed(2),
    fadeWorst.dest,
    "at",
    `${fadeWorst.ms}ms`,
    fadeWorst.css,
    fadeWorst.hex,
  );
  if (html.includes("<script src")) fail("prototype must stay a single file");
  if (!html.includes('id="win-avoid"') || !html.includes('id="win-best"')) {
    fail("verdict windows missing");
  }
  if (!html.includes("font-variation-settings")) fail("variable weight missing");
  if (!html.includes('url("fonts/source-serif-4-latin.woff2")') || !html.includes('"opsz" 60')) {
    fail("the hero face should be Source Serif 4 at the display optical size");
  }
  if (!html.includes('url("fonts/source-sans-3-latin.woff2")')) {
    fail("UI text should be Source Sans 3");
  }
  if (html.includes('local(".New York")') || html.includes("Aether Display")) {
    fail("New York is still standing in for the hero");
  }
  if (!html.includes('font-feature-settings: "lnum" 1, "tnum" 1')) {
    fail("the hero 1 should be a lining tabular figure");
  }
  if (html.includes("SF Pro Display") || html.includes("SF Pro Text")) {
    fail("SF Pro is still on the prototype");
  }
  try {
    const serif = readFileSync(new URL("../design/fonts/source-serif-4-latin.woff2", import.meta.url));
    const sans = readFileSync(new URL("../design/fonts/source-sans-3-latin.woff2", import.meta.url));
    if (serif.length < 20000) fail("Source Serif 4 file is missing its latin cut");
    if (sans.length < 8000) fail("Source Sans 3 file is missing its latin cut");
  } catch {
    fail("the hero and UI font files are missing");
  }
  if (!html.includes("--breath")) fail("breathing pace missing");
  if (html.includes("data-dir=")) fail("direction switch is still in the prototype");
  if (html.includes('class="chips"') || html.includes('class="ribbon"')) {
    fail("pills or the 5-day bars are still in the prototype");
  }
  if (html.includes("feGaussianBlur") && !html.includes('filter="url(#')) {
    fail("blur filters are unused");
  }
  if (html.includes("-diag") || html.includes("-grid") || html.includes("bandFill")) {
    fail("vertical hatching is still on the curve");
  }
  if (!html.includes("forecast-band")) fail("faint forecast band missing");
  if (!html.includes("scrub-aqi")) fail("scrub-point AQI readout missing");
  if (html.includes('id="range-week"') || html.includes('id="range-day"') || html.includes('id="range-hour"')) {
    fail("week/day/hour toggles duplicate the pinch");
  }
  if (!html.includes("body:not(.view-detail) #pollutant-row")) {
    fail("pollutant chips should fold into the detail screen");
  }
  const visible = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  if (!visible.includes(">5-day</text>")) fail("5-day horizon mark missing");
  if (!/state\.range === "week"[\s\S]{0,900}>5-day<\/text>/.test(visible)) {
    fail("5-day horizon mark missing on the week view");
  }
  const hourDrags = html.match(/data-drag="hour"/g) || [];
  if (hourDrags.length < 8) fail(`hour drag surfaces: ${hourDrags.length}`);
  if (!html.includes('data-drag="pollutant"')) fail("pollutant drag missing");
  if (!html.includes("function beginHour")) fail("shared hour drag missing");
  if (/still open|or one that warns him/.test(html)) fail("check-or-warn is still an open question");
  if (!html.includes("Both, equally.")) fail("the brief should call check-it and warns-you equal");
  if (!html.includes("interactive timeline is the hallmark")) {
    fail("the home hallmark should stay the interactive timeline");
  }
  if (!html.includes("Alerts are first-class")) fail("alerts should be first-class in the brief");
  if (!html.includes("This pass does not design the notification.")) {
    fail("this pass should not start the notification design");
  }
  if (!html.includes("body.scrubbing #headline")) fail("scrub should hide the essay");
  if (!html.includes("body.scrubbing .windows { visibility: hidden; }")) {
    fail("scrub should keep the windows row in place so the level band stays put");
  }
  if (/body\.scrubbing \.windows,/.test(html)) fail("scrub must not drop the windows row out of flow");
  if (!html.includes('classList.toggle("scrubbing", scrubbed)')) fail("scrub state should quiet the home screen");
  if (!html.includes('els.headline.textContent = atLead ? lead.title : ""')) {
    fail("the drag should keep the forecast headline only at rest");
  }
  if (!html.includes("While you drag, keep the number, the level word, and the time.")) {
    fail("the brief should name the three drag essentials");
  }
  if (!html.includes("stroke-width: 5")) fail("the chart line is still thin");
  if (!html.includes(".line[stroke-dasharray] { stroke-linecap: butt; }")) {
    fail("dashed pollutant lines should keep an open gap");
  }
  if (!html.includes('class="chart-field"')) fail("chart ground should be a tint of the level");
  if (!html.includes('fill="var(--chart)"')) fail("chart ground should follow the AQI color");
  if (html.includes("-dots") || html.includes("patternUnits")) fail("the dot grid is back on the chart");
  if (!html.includes("Its ground is a solid tint of the current level, with no dot grid.")) {
    fail("the brief should drop the dot grid");
  }
}

if (failures.length) {
  for (const message of failures) console.error("FAIL", message);
  process.exit(1);
}
console.log("round2 check ok");
