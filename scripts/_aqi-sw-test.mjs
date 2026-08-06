import { webkit } from 'playwright';

const browser = await webkit.launch();
const context = await browser.newContext();
const page = await context.newPage();

// Visit thrice to engage SW
for (let i = 0; i < 3; i++) {
  await page.goto('https://aether-aqi.vercel.app', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
}

const sw = await page.evaluate(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  return regs.map(r => ({ scope: r.scope, scriptURL: r.active?.scriptURL, state: r.active?.state }));
});

// Offline reload to see if SW breaks CSS
await context.setOffline(true);
try {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
} catch (e) {
  console.log('offline reload error', String(e).slice(0, 200));
}
await page.waitForTimeout(1000);
const offlineInfo = await page.evaluate(() => {
  const sheets = [...document.styleSheets].map(s => {
    try { return { href: s.href, rules: s.cssRules?.length }; }
    catch (e) { return { href: s.href, error: String(e) }; }
  });
  const probe = document.createElement('div');
  probe.className = 'flex bg-surface';
  document.body.appendChild(probe);
  const d = getComputedStyle(probe).display;
  probe.remove();
  return { sheets, flexDisplay: d, text: document.body.innerText.slice(0, 200) };
});
await context.setOffline(false);

console.log('SW', JSON.stringify(sw, null, 2));
console.log('OFFLINE', JSON.stringify(offlineInfo, null, 2));
await browser.close();
