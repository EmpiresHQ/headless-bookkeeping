// Rotation with the keyboard up, CONSISTENT stub: Δ is a function of the
// current orientation, so every event (window + visualViewport) sees a
// coherent innerHeight / visualViewport.height pair.
import { base, launch, setup, frames } from './common.mjs';
const DPORT = +(process.env.DPORT ?? 336), DLAND = +(process.env.DLAND ?? 190);
const which = process.env.WHICH ?? 'New expense';
const [W, H] = (process.env.VP ?? '390x844').split('x').map(Number);
const b = await launch();
const s = await setup(b, { width: W, height: H });
const { page } = s;
const m = (label) => page.evaluate((label) => {
  const el = document.querySelector('[data-vaul-drawer][data-state="open"]');
  const r = el.getBoundingClientRect();
  const sc = el.querySelector('[data-sheet-pane="form"]') ?? el.querySelector(':scope > .overflow-y-auto');
  const sr = sc.getBoundingClientRect();
  const first = sc.querySelector('input,select,textarea');
  const close = el.querySelector('button[aria-label="Close"]').getBoundingClientRect();
  return { label, inner: [innerWidth, innerHeight], vvH: Math.round(visualViewport.height), top: Math.round(r.top), h: Math.round(r.height), bottom: Math.round(innerHeight - r.bottom), inline: el.style.height + '|' + el.style.bottom, closeTop: Math.round(close.top), scroller: [Math.round(sr.top), Math.round(sr.bottom)], active: document.activeElement.getAttribute('aria-label') || document.activeElement.closest('label')?.textContent.slice(0, 20) };
}, label);
let d;
if (which === 'verify') {
  await page.goto(base + '/inbox/doc/31001'); await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Review extracted data' }).click();
  d = page.getByRole('dialog').last(); await d.waitFor(); await page.waitForTimeout(900);
} else {
  await page.goto(base + '/books'); await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Add to the books', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(which) }).click();
  d = page.getByRole('dialog', { name: which, exact: true }); await d.waitFor(); await page.waitForTimeout(700);
}
const out = [await m('opened')];
if (which === 'verify') { await d.locator('[data-sheet-pane="form"] input[inputmode="decimal"]').first().tap(); } else { await d.getByLabel('Gross (€)', { exact: true }).tap(); }
await page.keyboard.type('1');
await page.evaluate(({ DPORT, DLAND }) => {
  window.__real = Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'height');
  window.__kb = true;
  Object.defineProperty(VisualViewport.prototype, 'height', { configurable: true, get() { return window.__kb ? innerHeight - (innerWidth > innerHeight ? DLAND : DPORT) : window.__real.get.call(this); } });
  visualViewport.dispatchEvent(new Event('resize'));
}, { DPORT, DLAND });
await page.waitForTimeout(300); out.push(await m('kb up portrait'));
await page.setViewportSize({ width: H, height: W }); await page.waitForTimeout(500); await frames(page);
out.push(await m('rotated landscape, kb up'));
// Can the first field of the form be brought into the visible band?
await page.evaluate(() => { const el = document.querySelector('[data-vaul-drawer][data-state="open"]'); el.querySelector('input,select,textarea').scrollIntoView({ block: 'nearest' }); });
await page.waitForTimeout(150);
out.push({ ...(await m('first field revealed')), firstFieldTop: await page.evaluate(() => Math.round(document.querySelector('[data-vaul-drawer][data-state="open"]').querySelector('input,select,textarea').getBoundingClientRect().top)) });
if (process.env.OUT_DIR) await page.screenshot({ path: `${process.env.OUT_DIR}rotate-${W}x${H}-${DPORT}-${DLAND}.jpg`, type: 'jpeg', quality: 60 });
await page.setViewportSize({ width: W, height: H }); await page.waitForTimeout(500);
out.push(await m('rotated back portrait, kb up'));
await page.evaluate(() => { window.__kb = false; visualViewport.dispatchEvent(new Event('resize')); }); await page.waitForTimeout(300);
out.push(await m('kb hidden'));
for (const o of out) console.log(JSON.stringify(o));
console.log('writes', s.writes.length, 'errors', s.errors);
await b.close();
