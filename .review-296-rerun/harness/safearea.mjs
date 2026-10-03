// QA-003 (#296) re-run: safe-area / landscape / standalone-proxy matrix.
// Chromium proxy only: CDP Emulation.setSafeAreaInsetsOverride feeds
// env(safe-area-inset-*); nothing is drawn over the "unsafe" bands, so a
// hit-test inside a band still passes. A control is FLAGGED when its rect
// overlaps a band (px per side). All data is route-mocked; every write is
// refused (503) and counted.
import { writeFileSync } from 'node:fs';
import { base, launch, setup, frames } from './common.mjs';

const OUT = process.env.OUT_DIR ?? '';
const FILTER = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
// iPhone 14-class safe-area values (Apple's published layout: portrait
// top 47 / bottom 34; landscape left = right 47, bottom 21). A model, not
// a measurement from a device.
const P = { w: 390, h: 844, forced: { top: 47, right: 0, bottom: 34, left: 0 } };
const L = { w: 844, h: 390, forced: { top: 0, right: 47, bottom: 21, left: 47 } };
const NONE = { top: 0, right: 0, bottom: 0, left: 0 };
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const setInsets = (s, i) => s.cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: i.top, topMax: i.top, right: i.right, rightMax: i.right, bottom: i.bottom, bottomMax: i.bottom, left: i.left, leftMax: i.left } });
const settle = async (page, ms = 300) => { await page.waitForTimeout(ms); await frames(page); };

// Rect + band overlap + centre hit-test of every named surface on screen.
const measure = (page, insets) => page.evaluate((ins) => {
  const vw = innerWidth, vh = innerHeight;
  const q = (sel, root = document) => root.querySelector(sel);
  const byText = (root, re) => [...root.querySelectorAll('button,a')].find((b) => re.test(b.textContent.trim()) && b.offsetParent);
  const probe = document.getElementById('__env') ?? Object.assign(document.body.appendChild(document.createElement('div')), { id: '__env' });
  probe.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
  const pc = getComputedStyle(probe);
  const env = [pc.paddingTop, pc.paddingRight, pc.paddingBottom, pc.paddingLeft].map(parseFloat);
  const ctaOf = (sh) => [...sh.querySelectorAll('button')].filter((b) => b.offsetParent && (b.type === 'submit' || /^Create /.test(b.textContent.trim()) || b.textContent.trim() === 'Create expense')).at(-1);
  const sheet = q('[data-vaul-drawer][data-state="open"]');
  const lb = [...document.querySelectorAll('[role=dialog]')].find((d) => q('[aria-label="Close preview"]', d));
  const alert = q('[role=alertdialog]');
  const tab = q('[data-tabbar]');
  const T = {}; const containers = new Set(['tabbar', 'sheet', 'alert', 'lbImg', 'actionbar']);
  // Page chrome only while no modal layer covers it (the overlay is meant to).
  const modal = sheet || lb || alert;
  if (!modal && tab && getComputedStyle(tab).display !== 'none') { T.tabbar = tab; for (const a of tab.querySelectorAll('a')) T['tab:' + a.textContent.trim()] = a; }
  if (!modal) {
    if (scrollY === 0) { T.h1 = q('main h1'); T['header+'] = q('[aria-label="Add to the books"]'); }
    const ab = byText(document, /^Create & match/); if (ab) { T['actionbar CTA'] = ab; T.actionbar = ab.closest('.sticky'); }
  }
  if (sheet) { T.sheet = sheet; T['sheet Close'] = q('button[aria-label="Close"]', sheet); T['sheet CTA'] = ctaOf(sheet); }
  if (lb) { T['lb Close preview'] = q('[aria-label="Close preview"]', lb); T['lb Open original'] = byText(lb, /Open original/); T.lbImg = q('img', lb); }
  if (alert) { T.alert = alert; for (const b of alert.querySelectorAll('button')) T['alert ' + b.textContent.trim()] = b; }
  const out = {};
  for (const [k, el] of Object.entries(T)) {
    if (!el) { out[k] = null; continue; }
    const r = el.getBoundingClientRect();
    const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
    const band = {
      t: ins.top ? ov(r.top, r.bottom, -1e4, ins.top) : 0,
      r: ins.right ? ov(r.left, r.right, vw - ins.right, 1e4) : 0,
      b: ins.bottom ? ov(r.top, r.bottom, vh - ins.bottom, 1e4) : 0,
      l: ins.left ? ov(r.left, r.right, -1e4, ins.left) : 0,
    };
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const h = document.elementFromPoint(cx, cy);
    out[k] = {
      rect: [r.left, r.right, r.top, r.bottom].map((v) => Math.round(v * 10) / 10),
      band: Object.fromEntries(Object.entries(band).filter(([, v]) => v > 0).map(([s, v]) => [s, Math.round(v * 10) / 10])),
      offscreen: r.top < -0.5 || r.left < -0.5 || r.bottom > vh + 0.5 || r.right > vw + 0.5,
      hit: containers.has(k) ? undefined : !!h && el.contains(h),
      container: containers.has(k) || undefined,
    };
  }
  if (sheet) out['sheet style'] = { pb: getComputedStyle(sheet).paddingBottom, inline: sheet.style.height + '|' + sheet.style.bottom };
  if (tab) out['tabbar pb'] = getComputedStyle(tab).paddingBottom;
  return { vp: [vw, vh], env: env.join('/'), scrollY: Math.round(scrollY), maxScroll: Math.max(0, document.documentElement.scrollHeight - vh), body: { position: document.body.style.position, top: document.body.style.top }, targets: out };
}, insets);

const results = []; const lines = [];
const flagged = (m) => Object.entries(m.targets).filter(([k, t]) => t && t.rect && !t.container && (Object.keys(t.band).length || t.offscreen || t.hit === false)).map(([k, t]) => `${k}${Object.keys(t.band).length ? ' band' + JSON.stringify(t.band) : ''}${t.offscreen ? ' OFFSCREEN' : ''}${t.hit === false ? ' HIT-FAIL' : ''}`);

async function run(name, opts, fn) {
  if (FILTER && !FILTER.test(name)) return;
  const browser = await launch();
  const s = await setup(browser, { width: opts.o.w, height: opts.o.h, expenses: opts.expenses, userAgent: opts.ua, standalone: opts.standalone });
  const res = { name, steps: [] };
  const step = async (label, insets, extra = {}) => { const m = await measure(s.page, insets); res.steps.push({ label, ...m, ...extra, flagged: flagged(m) }); return m; };
  try {
    await setInsets(s, opts.insets ?? NONE);
    await fn({ s, page: s.page, step, res });
  } catch (e) { res.error = String(e).slice(0, 300); await s.page.screenshot({ path: `${OUT}${name}-ERROR.jpg`, type: 'jpeg', quality: 60 }).catch(() => {}); }
  res.writes = s.writes.length; res.errors = s.errors; res.unhandled = [...new Set(s.unhandled)];
  results.push(res);
  const hdr = `${res.error ? 'ERROR' : 'ran  '} ${name}  writes=${res.writes} errors=${res.errors.length}${res.error ? ' ' + res.error : ''}`;
  lines.push(hdr); console.log(hdr);
  for (const st of res.steps) { const l = `      ${st.label} [${st.vp.join('x')} env ${st.env}${st.body.position ? ' body:' + st.body.position + ' top=' + st.body.top : ''} scrollY=${st.scrollY}] ${st.flagged.length ? 'FLAGGED: ' + st.flagged.join('; ') : 'clear'}${st.note ? ' — ' + st.note : ''}`; lines.push(l); console.log(l); }
  await browser.close();
}

const openNewExpense = async (page) => {
  await page.goto(base + '/books'); await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Add to the books', exact: true }).click();
  await page.getByRole('button', { name: /New expense/ }).click();
  const d = page.getByRole('dialog', { name: 'New expense', exact: true }); await d.waitFor(); await settle(page, 700);
  return d;
};
const openVerify = async (page) => {
  await page.goto(base + '/inbox/doc/31001'); await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Review extracted data' }).click();
  const d = page.getByRole('dialog').last(); await d.waitFor(); await settle(page, 900);
  return d;
};
const openLightbox = async (page) => {
  await page.goto(base + '/inbox/doc/31001'); await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /Source document/ }).first().click();
  await page.getByRole('button', { name: 'Close preview' }).waitFor(); await settle(page, 600);
};
const revealCta = (page) => page.evaluate(() => { const sh = document.querySelector('[data-vaul-drawer][data-state="open"]'); [...sh.querySelectorAll('button')].filter((b) => b.offsetParent && (b.type === 'submit' || /^Create /.test(b.textContent.trim()) || b.textContent.trim() === 'Create expense')).at(-1)?.scrollIntoView({ block: 'nearest' }); });
const shot = (page, n) => OUT && page.screenshot({ path: `${OUT}${n}.jpg`, type: 'jpeg', quality: 60 });

for (const o of [P, L]) for (const mode of ['none', 'forced']) {
  const insets = mode === 'forced' ? o.forced : NONE;
  const tag = `${o === P ? 'P' : 'L'}-${mode}`;
  const opts = { o, insets };
  await run(`A-books-header-tabbar ${tag}`, opts, async ({ page, step }) => {
    await page.goto(base + '/books'); await page.waitForLoadState('networkidle'); await settle(page);
    await step('books top', insets);
    if (mode === 'forced') await shot(page, `A-books-${tag}`);
  });
  await run(`B-bank-actionbar ${tag}`, opts, async ({ page, step }) => {
    await page.goto(base + '/bank/statements/1/tx/501'); await page.waitForLoadState('networkidle'); await settle(page, 400);
    await page.evaluate(() => scrollTo(0, 1e6)); await settle(page);
    await step('tx 501 at max scroll', insets);
  });
  await run(`C-new-expense+confirm ${tag}`, opts, async ({ page, step }) => {
    const d = await openNewExpense(page);
    await step('opened', insets);
    await revealCta(page); await settle(page, 150);
    await step('CTA revealed', insets);
    if (mode === 'forced') await shot(page, `C-new-expense-${tag}`);
    await d.getByLabel('Gross (€)', { exact: true }).fill('45.67');
    await d.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('alertdialog').waitFor(); await settle(page, 400);
    await step('discard ConfirmDialog', insets);
    await page.getByRole('button', { name: 'Keep editing' }).click(); await settle(page, 400);
    const kept = await d.getByLabel('Gross (€)', { exact: true }).inputValue();
    await step('kept editing', insets, { note: `Gross kept = ${kept}` });
  });
  await run(`D-verify-source-sheet ${tag}`, opts, async ({ page, step }) => {
    await openVerify(page);
    await step('opened (Form)', insets);
    await revealCta(page); await settle(page, 150);
    await step('form CTA revealed', insets);
    if (mode === 'forced') await shot(page, `D-verify-${tag}`);
  });
  await run(`E-preview-lightbox ${tag}`, opts, async ({ page, step }) => {
    await openLightbox(page);
    await step('lightbox open', insets);
    if (mode === 'forced') await shot(page, `E-lightbox-${tag}`);
  });
}

// Rotation (layout resize p↔l with insets swapped per orientation).
await run('F-rotate-new-expense forced', { o: P, insets: P.forced }, async ({ s, page, step }) => {
  const d = await openNewExpense(page);
  await d.getByLabel('Gross (€)', { exact: true }).fill('45.67');
  await page.evaluate(() => document.activeElement.blur());
  await settle(page, 300);
  await step('P fresh', P.forced);
  for (const [k, o] of [[1, L], [2, P], [3, L], [4, P]]) {
    await page.setViewportSize({ width: o.w, height: o.h }); await setInsets(s, o.forced); await settle(page, 600);
    const v = await d.getByLabel('Gross (€)', { exact: true }).inputValue();
    await step(`rotation ${k} → ${o === P ? 'P' : 'L'}`, o.forced, { note: `Gross = ${v}` });
  }
  await revealCta(page); await settle(page, 150);
  await step('P after rotations, CTA revealed', P.forced);
});
await run('G-rotate-lightbox forced', { o: P, insets: P.forced }, async ({ s, page, step }) => {
  await openLightbox(page);
  await step('P', P.forced);
  for (const [k, o] of [[1, L], [2, P]]) {
    await page.setViewportSize({ width: o.w, height: o.h }); await setInsets(s, o.forced); await settle(page, 600);
    await step(`rotation ${k} → ${o === P ? 'P' : 'L'}`, o.forced);
  }
  await page.keyboard.press('Escape'); await settle(page, 400);
  const open = await page.getByRole('button', { name: 'Close preview' }).isVisible().catch(() => false);
  await step('after Escape', P.forced, { note: `lightbox still open = ${open}` });
});
await run('G2-rotate-verify forced', { o: P, insets: P.forced }, async ({ s, page, step }) => {
  await openVerify(page);
  await step('P', P.forced);
  for (const [k, o] of [[1, L], [2, P]]) {
    await page.setViewportSize({ width: o.w, height: o.h }); await setInsets(s, o.forced); await settle(page, 600);
    await step(`rotation ${k} → ${o === P ? 'P' : 'L'}`, o.forced);
  }
});

// Standalone proxy: iOS Safari UA (activates vaul's Safari-only body
// position:fixed path) × display-mode stub, sheet opened over a scrolled
// Books list, closed clean; scroll must come back. The header ＋ is not
// sticky, so the sheet is opened with an in-page click() — a Playwright
// click would first scroll the page back to the top (run 1 artefact).
for (const o of [P, L]) for (const [mode, ua, standalone] of [['chromium-UA', undefined, false], ['safari-tab-UA', IOS_UA, false], ['safari-UA+standalone-stub', IOS_UA, true]]) {
  const tag = `${o === P ? 'P' : 'L'}-${mode}`;
  await run(`H-scrolled-sheet ${tag}`, { o, insets: o.forced, expenses: 40, ua, standalone }, async ({ page, step }) => {
    await page.goto(base + '/books'); await page.waitForLoadState('networkidle'); await settle(page, 400);
    const Y = o === P ? 900 : 600;
    await page.evaluate((y) => scrollTo(0, y), Y); await settle(page);
    const before = await step('scrolled, closed', o.forced, { note: `display-mode stub=${standalone}, matchMedia=${await page.evaluate(() => matchMedia('(display-mode: standalone)').matches)}` });
    await page.evaluate(() => document.querySelector('[aria-label="Add to the books"]').click()); await settle(page, 400);
    await step('chooser open', o.forced);
    await page.getByRole('button', { name: /New expense/ }).click();
    const d = page.getByRole('dialog', { name: 'New expense', exact: true }); await d.waitFor(); await settle(page, 900);
    await step('sheet open', o.forced);
    await d.getByRole('button', { name: 'Close' }).click(); await d.waitFor({ state: 'hidden' }); await settle(page, 900);
    const after = await step('sheet closed', o.forced);
    await step('restore', o.forced, { note: `scrollY ${before.scrollY} → ${after.scrollY}; tabbar ${JSON.stringify(before.targets.tabbar?.rect)} → ${JSON.stringify(after.targets.tabbar?.rect)}` });
  });
}

if (OUT) writeFileSync(`${OUT}safearea.json`, JSON.stringify(results, null, 1));
