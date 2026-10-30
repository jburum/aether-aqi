#!/usr/bin/env node
/**
 * Serves design/ on loopback and screenshots a Good → Hazardous → Good scrub.
 * Also drives the timeline, the number, the detail, the widgets, and Review once.
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
  ".woff2": "font/woff2",
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
  [7, "week", "01-week-forecast.png"],
  [7, "day", "02-thu-7am-good.png"],
  [8, "day", "03-thu-8am-moderate.png"],
  [10, "day", "04-thu-10am-usg.png"],
  [12, "day", "05-thu-12pm-unhealthy.png"],
  [14, "day", "06-thu-2pm-very.png"],
  [16, "day", "07-thu-4pm-hazardous.png"],
  [18, "day", "08-thu-6pm-peak.png"],
  [20, "day", "09-thu-8pm-very.png"],
  [22, "day", "10-thu-10pm-unhealthy.png"],
  [40, "day", "11-fri-4pm-window.png"],
  [7, "day", "12-back-to-now.png"],
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
  const finishLayout = () =>
    page.evaluate(() => {
      for (const el of document.querySelectorAll("*")) {
        for (const anim of el.getAnimations()) {
          const iterations = anim.effect?.getTiming?.().iterations;
          if (iterations === Infinity) continue;
          anim.finish();
        }
      }
    });

  const dragAcross = async (selector, x0, x1) => {
    const before = await page.locator("#timeline").getAttribute("aria-valuetext");
    const target = page.locator(selector);
    // #w-horizon lays out near y=877, under the 844 fold, so the pointer misses until it scrolls up.
    await finishLayout();
    await target.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
    const box = await target.boundingBox();
    if (!box || box.width < 8) throw new Error(`${selector} has no box`);
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * x0, y);
    await page.mouse.down();
    // Scrub arms only after the 120ms hold. Move before that and the hour stays put.
    await page.waitForTimeout(180);
    await page.mouse.move(box.x + box.width * x1, y, { steps: 14 });
    await page.mouse.up();
    await page.waitForFunction((prev) => {
      const text = document.getElementById("timeline").getAttribute("aria-valuetext") || "";
      return text !== prev && text.length > 0;
    }, before);
  };

  const lead = await page.locator("#headline").textContent();
  if (!/Hazardous by 6 PM/.test(lead || "")) throw new Error(`home should lead with the forecast, got ${lead}`);
  await page.evaluate(() => window.__round2.setRange("day"));
  const box = await page.locator("#timeline").boundingBox();
  if (!box) throw new Error("timeline has no box");
  await page.mouse.move(box.x + 12, box.y + box.height / 2);
  await page.mouse.down();
  // Hour 18 (the hazardous peak) sits about 78% across Thursday, not at the right edge.
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 24 });
  await page.waitForFunction(() => {
    const scrubbing = document.body.classList.contains("scrubbing");
    const headline = document.getElementById("headline").textContent || "";
    const advice = document.getElementById("advice").textContent || "";
    const cat = document.getElementById("cat").textContent || "";
    const when = document.getElementById("kicker").textContent || "";
    return scrubbing && !headline.trim() && !advice.trim() && cat.trim() && /\d/.test(when);
  });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const text = document.getElementById("timeline").getAttribute("aria-valuetext") || "";
    return /AQI [23]\d\d/.test(text);
  });
  await page.locator("#place").click();
  await page.waitForFunction(() => /smoke/i.test(document.getElementById("detail-why").textContent || ""));
  // The detail curve shrinks on a 600ms flex transition. Finish it before measuring the chips.
  await finishLayout();
  await page.locator('[data-poll="o3"]').click();
  await page.waitForFunction(() => document.querySelector("#hero .line")?.getAttribute("stroke-dasharray") === "5 4");
  const row = await page.locator("#pollutant-row").boundingBox();
  const smoke = await page.locator('[data-poll="smoke"]').boundingBox();
  if (!row || row.y + row.height > 844) throw new Error("pollutant row falls outside the phone");
  if (!smoke) throw new Error("smoke chip has no box");
  await page.mouse.move(row.x + 8, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(smoke.x + smoke.width / 2, smoke.y + smoke.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector("#hero .line")?.getAttribute("stroke-dasharray") === "10 3");
  await dragAcross("#detail", 0.88, 0.08);
  await page.locator("#back").click();
  await dragAcross("#digits", 0.88, 0.08);
  // Digits already left the hour at Thu 12 AM, so this drag has to run the other way.
  await dragAcross("#forecast", 0.08, 0.88);
  await page.locator("#back-now").click();
  await page.waitForFunction(() => !document.body.classList.contains("scrubbing"));
  await page.locator("#win-avoid").click();
  await page.waitForFunction(() => /3 PM/.test(document.getElementById("timeline").getAttribute("aria-valuetext") || ""));
  await page.locator("#back-now").click();
  await page.waitForFunction(() => !document.body.classList.contains("scrubbing"));
  await page.locator("#open-review").click();
  await page.locator("#opt-type").click();
  await page.locator("#opt-motion").click();
  const ax5 = await page.evaluate(() => document.body.classList.contains("ax5"));
  const reduce = await page.evaluate(() => document.body.classList.contains("reduce"));
  if (!ax5 || !reduce) throw new Error("Review controls did not apply AX5 and Reduce Motion");
  for (const id of ["#advice", "#digits", "#windows"]) {
    const region = await page.locator(id).boundingBox();
    if (!region || region.y + region.height > 844) throw new Error(`${id} falls outside the 844px phone`);
  }
  await page.locator("#review-close").click();
  await page.locator("#open-widgets").click();
  await page.locator("#w-small").click();
  await page.waitForFunction(() => (document.getElementById("w-horizon").textContent || "").includes("Thu"));
  await dragAcross("#w-med", 0.08, 0.92);
  await dragAcross("#w-horizon", 0.08, 0.92);
  await dragAcross(".w-lock", 0.08, 0.92);

  for (const [hour, range, name] of frames) {
    const url = checkedUrl(`http://127.0.0.1:${port}/round2.html?frame=1&hour=${hour}&range=${range}`);
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(() => window.__round2 && window.__round2.ready);
    await page.waitForTimeout(80);
    const headline = await page.locator("#headline").textContent();
    const advice = await page.locator("#advice").textContent();
    const scrubbing = await page.evaluate(() => document.body.classList.contains("scrubbing"));
    if (hour === 7) {
      if (scrubbing) throw new Error(`${name} should rest on the forecast`);
      if (!/outdoor window/i.test(advice || "")) throw new Error(`${name} lost the forecast line`);
      if (!/Hazardous by 6 PM/.test(headline || "")) {
        throw new Error(`${name} should lead with the forecast, got ${headline}`);
      }
      const windows = await page.locator("#windows").boundingBox();
      if (!windows || windows.y + windows.height > 844) throw new Error(`${name} verdict windows fall outside the phone`);
    } else {
      if (!scrubbing) throw new Error(`${name} should be the quiet scrub`);
      const cat = (await page.locator("#cat").textContent()) || "";
      const when = (await page.locator("#kicker").textContent()) || "";
      if (!cat.trim()) throw new Error(`${name} lost the level word`);
      if (!/\d/.test(when)) throw new Error(`${name} lost the time`);
      if ((headline || "").trim() || (advice || "").trim()) {
        throw new Error(`${name} still has the essay: ${headline} / ${advice}`);
      }
      const digits = await page.locator("#digits").boundingBox();
      if (!digits || digits.height < 20) throw new Error(`${name} lost the number`);
    }
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
