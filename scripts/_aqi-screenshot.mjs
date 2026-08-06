import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const errors = [];
const failed = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push('console: ' + msg.text());
});
page.on('response', (res) => {
  if (!res.ok()) failed.push(res.status() + ' ' + res.url());
});

await page.goto('https://aether-aqi.vercel.app', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2000);

// Seed localStorage with locations so cards render
await page.evaluate(() => {
  const data = {
    state: {
      locations: [
        { id: 'boise-id', name: 'Boise, Idaho', latitude: 43.615, longitude: -116.202, alertAt: 100 },
        { id: 'slc-ut', name: 'Salt Lake City, Utah', latitude: 40.761, longitude: -111.891, alertAt: 100 },
      ],
      selectedId: null,
    },
    version: 0,
  };
  localStorage.setItem('aether-locations-v1', JSON.stringify(data));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

const info = await page.evaluate(() => {
  const body = document.body;
  const sheet = [...document.styleSheets];
  let sheetInfo = [];
  for (const s of sheet) {
    try {
      sheetInfo.push({ href: s.href, rules: s.cssRules?.length ?? -1 });
    } catch (e) {
      sheetInfo.push({ href: s.href, error: String(e) });
    }
  }
  const app = document.querySelector('[class*="max-w-5xl"]') || document.body;
  const card = document.querySelector('[data-location-id]');
  const surface = card?.querySelector('[role="button"]');
  const addBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Add location'));
  const cs = (el) => {
    if (!el) return null;
    const c = getComputedStyle(el);
    return {
      display: c.display,
      width: c.width,
      background: c.backgroundColor,
      transform: c.transform,
      position: c.position,
      flexDirection: c.flexDirection,
      gridTemplateColumns: c.gridTemplateColumns,
    };
  };
  return {
    title: document.title,
    bodyBg: getComputedStyle(body).backgroundColor,
    sheets: sheetInfo,
    linkCount: document.querySelectorAll('link[rel=stylesheet]').length,
    hasWatchlist: !!document.body.innerText.includes('Watchlist'),
    cardCount: document.querySelectorAll('[data-location-id]').length,
    card: cs(card),
    surface: cs(surface),
    addBtn: cs(addBtn),
    addText: addBtn?.innerText,
    section: cs(document.querySelector('section')),
    headerText: document.querySelector('h1')?.innerText,
    bodyTextSample: document.body.innerText.slice(0, 400),
  };
});

await page.screenshot({ path: '/tmp/aqi-live.png', fullPage: true });
console.log(JSON.stringify(info, null, 2));
console.log('ERRORS', errors);
console.log('FAILED', failed);
await browser.close();
