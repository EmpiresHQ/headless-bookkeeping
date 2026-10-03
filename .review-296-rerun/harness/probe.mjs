// What this Chromium can emulate for QA-003: env(safe-area-inset-*) via CDP,
// whether viewport-fit gates it, and display-mode: standalone via media emulation.
import { base, launch, setup } from './common.mjs';
const b = await launch();
const s = await setup(b, { width: 390, height: 844 });
const { page, cdp } = s;
const env = () => page.evaluate(() => {
  let p = document.getElementById('__probe');
  if (!p) { p = document.createElement('div'); p.id = '__probe'; p.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)'; document.body.append(p); }
  const c = getComputedStyle(p); const tb = document.querySelector('[data-tabbar]') ?? document.querySelector('nav.fixed');
  return { env: [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft].map(parseFloat).join('/'), meta: document.querySelector('meta[name=viewport]').content, standalone: matchMedia('(display-mode: standalone)').matches, browserMode: matchMedia('(display-mode: browser)').matches, navStandalone: navigator.standalone ?? null, tabbar: tb ? [Math.round(tb.getBoundingClientRect().height), getComputedStyle(tb).paddingBottom] : null, vh: [innerHeight, Math.round(visualViewport.height)] };
});
const set = (t, r, bo, l) => cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: t, topMax: t, right: r, rightMax: r, bottom: bo, bottomMax: bo, left: l, leftMax: l } });
const meta = (c) => page.evaluate((c) => { document.querySelector('meta[name=viewport]').content = c; }, c);
await page.goto(base + '/books'); await page.waitForLoadState('networkidle');
const out = [];
out.push(['no override, shipped meta', await env()]);
await set(47, 0, 34, 0); await page.waitForTimeout(150);
out.push(['override 47/0/34/0, shipped meta', await env()]);
await meta('width=device-width, initial-scale=1.0, viewport-fit=cover'); await page.waitForTimeout(150);
out.push(['override + test-only viewport-fit=cover', await env()]);
await meta('width=device-width, initial-scale=1.0, viewport-fit=contain'); await page.waitForTimeout(150);
out.push(['override + test-only viewport-fit=contain', await env()]);
await meta('width=device-width, initial-scale=1.0'); await set(0, 0, 0, 0); await page.waitForTimeout(150);
out.push(['override cleared, meta restored', await env()]);
await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'display-mode', value: 'standalone' }] }); await page.waitForTimeout(150);
out.push(['CDP display-mode=standalone', await env()]);
await page.reload(); await page.waitForLoadState('networkidle');
out.push(['… after reload', await env()]);
await cdp.send('Emulation.setEmulatedMedia', { features: [] });
out.push(['display-mode cleared', await env()]);
out.push(['manifest link', await page.evaluate(() => document.querySelector('link[rel=manifest]')?.href)]);
out.push(['browser', b.version()]);
for (const o of out) console.log(JSON.stringify(o));
console.log('writes', s.writes.length, 'errors', JSON.stringify(s.errors), 'unhandled', JSON.stringify([...new Set(s.unhandled)]));
await b.close();
