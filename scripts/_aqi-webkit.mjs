import { webkit } from 'playwright';

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
const failed = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push('console: ' + msg.text());
});
page.on('response', async (res) => {
  if (!res.ok()) failed.push(res.status() + ' ' + res.url());
});

await page.goto('https://aether-aqi.vercel.app', { waitUntil: 'networkidle', timeout: 60000 });
await page.evaluate(() => {
  localStorage.setItem('aether-locations-v1', JSON.stringify({
    state: {
      locations: [
        { id: 'boise-id', name: 'Boise, Idaho', latitude: 43.615, longitude: -116.202, alertAt: 100 },
        { id: 'slc-ut', name: 'Salt Lake City, Utah', latitude: 40.761, longitude: -111.891, alertAt: 100 },
      ],
      selectedId: null,
    },
    version: 0,
  }));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

const info = await page.evaluate(() => {
  const sheet = [...document.styleSheets];
  let sheetInfo = [];
  for (const s of sheet) {
    try {
      sheetInfo.push({ href: s.href, rules: s.cssRules?.length ?? -1 });
    } catch (e) {
      sheetInfo.push({ href: s.href, error: String(e) });
    }
  }
  const card = document.querySelector('[data-location-id]');
  const surface = card?.querySelector('[role="button"]');
  const section = document.querySelector('section');
  const addBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Add location'));
  const cs = (el) => {
    if (!el) return null;
    const c = getComputedStyle(el);
    return { display: c.display, width: c.width, background: c.backgroundColor, transform: c.transform, flexDirection: c.flexDirection, gridTemplateColumns: c.gridTemplateColumns };
  };
  // Check if flex utility actually applies
  const probe = document.createElement('div');
  probe.className = 'flex w-full bg-surface p-5';
  document.body.appendChild(probe);
  const probeCs = getComputedStyle(probe);
  const probeInfo = { display: probeCs.display, width: probeCs.width, background: probeCs.backgroundColor, padding: probeCs.padding };
  probe.remove();
  return {
    sheets: sheetInfo,
    card: cs(card),
    surface: cs(surface),
    section: cs(section),
    addText: addBtn?.innerText,
    headerText: document.querySelector('h1')?.innerText,
    probeInfo,
    bodyTextSample: document.body.innerText.slice(0, 350),
  };
});

await page.screenshot({ path: '/tmp/aqi-webkit.png', fullPage: true });
console.log(JSON.stringify(info, null, 2));
console.log('ERRORS', errors);
console.log('FAILED', failed);
await browser.close();
