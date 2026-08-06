import { webkit } from 'playwright';

const browser = await webkit.launch();
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e}`));
page.on('requestfailed', (r) => logs.push(`fail: ${r.url()} ${r.failure()?.errorText}`));

await page.goto('https://aether-aqi.vercel.app', { waitUntil: 'networkidle', timeout: 60000 });
await page.evaluate(() => {
  localStorage.setItem('aether-locations-v1', JSON.stringify({
    state: {
      locations: [
        { id: 'boise-id', name: 'Boise, Idaho', latitude: 43.615, longitude: -116.202, alertAt: 100 },
      ],
      selectedId: null,
    },
    version: 0,
  }));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(5000);

const info = await page.evaluate(async () => {
  // Direct fetch from page context
  let direct = null;
  try {
    const res = await fetch('https://air-quality-api.open-meteo.com/v1/air-quality?latitude=43.615&longitude=-116.202&current=us_aqi,pm2_5&hourly=us_aqi&forecast_days=1&timezone=auto');
    direct = { ok: res.ok, status: res.status, body: await res.json() };
  } catch (e) {
    direct = { error: String(e) };
  }
  return {
    direct,
    text: document.body.innerText.slice(0, 500),
    hasNumber: /\b\d{1,3}\b/.test(document.body.innerText) && document.body.innerText.includes('Boise'),
  };
});

console.log(JSON.stringify(info, null, 2));
console.log('LOGS', logs.slice(0, 40));
await browser.close();
