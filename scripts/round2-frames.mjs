#!/usr/bin/env node
/**
 * Serves design/ on loopback and screenshots a Good → Hazardous → Good scrub.
 * Also drives the timeline, pollutant chips, and Review controls once.
 */
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";

const designDir = resolve("design");
const frameDir = resolve("design/round2-frames");
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function safeFile(urlPath) {
  const rel = decodeURIComponent(urlPath.split("?")[0]);
  const abs = normalize(join(designDir, rel));
  const root = designDir.endsWith(sep) ? designDir : designDir + sep;
  if (abs !== designDir && !abs.startsWith(root)) return null;
  if (!types[extname(abs)]) return null;
  return abs;
}

const server = createServer(async (req, res) => {
  const file = safeFile(req.url || "/");
  if (!file) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const port = server.address().port;
mkdirSync(frameDir, { recursive: true });

const frames = [
  [7, "01-thu-7am-good.png"],
  [8, "02-thu-8am-moderate.png"],
  [10, "03-thu-10am-usg.png"],
  [12, "04-thu-12pm-unhealthy.png"],
  [14, "05-thu-2pm-very.png"],
  [16, "06-thu-4pm-hazardous.png"],
  [18, "07-thu-6pm-peak.png"],
  [20, "08-thu-8pm-very.png"],
  [21, "09-thu-9pm-unhealthy.png"],
  [23, "10-thu-11pm-usg.png"],
  [7, "11-back-to-now-good.png"],
];

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const live = checkedUrl(`http://127.0.0.1:${port}/round2.html`);
  await page.goto(live, { waitUntil: "load" });
  await page.waitForFunction(() => window.__round2 && window.__round2.ready);
  const box = await page.locator("#timeline").boundingBox();
  if (!box) throw new Error("timeline has no box");
  await page.mouse.move(box.x + 12, box.y + box.height / 2);
  await page.mouse.down();
  // Hour 18 (the hazardous peak) sits about 78% across Thursday, not at the right edge.
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 24 });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const text = document.getElementById("timeline").getAttribute("aria-valuetext") || "";
    return /AQI [23]\d\d/.test(text);
  });
  await page.locator('[data-poll="o3"]').click();
  const dash = await page.locator("#sub .line").getAttribute("stroke-dasharray");
  if (dash !== "5 4") throw new Error(`O3 chart dash was ${dash}`);
  await page.locator("#open-review").click();
  await page.locator('[data-dir="ribbon"]').click();
  await page.locator("#opt-type").click();
  const ribbon = await page.evaluate(() => document.body.classList.contains("dir-ribbon"));
  const ax5 = await page.evaluate(() => document.body.classList.contains("ax5"));
  if (!ribbon || !ax5) throw new Error("Review controls did not apply Ribbon and AX5");
  const advice = await page.locator("#advice").boundingBox();
  if (!advice || advice.y + advice.height > 844) throw new Error("advice falls outside the 844px phone");
  await page.locator("#review-close").click();
  await page.locator("#open-widgets").click();
  await page.locator("#w-small").click();

  for (const [hour, name] of frames) {
    const url = checkedUrl(`http://127.0.0.1:${port}/round2.html?frame=1&hour=${hour}&dir=field`);
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(() => window.__round2 && window.__round2.ready);
    await page.waitForTimeout(80);
    const out = checkedOutputPath(join(frameDir, name), [frameDir]);
    await page.screenshot({ path: out });
    console.log(name);
  }
  if (pageErrors.length) throw new Error(pageErrors.join("\n"));
  console.log("frames ok", frames.length);
} finally {
  await browser.close();
  server.close();
}
