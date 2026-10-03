// QA-002 (#295) re-run: keyboard / viewport-resize PROXY matrix on a
// production build. Route-mocked data (common.mjs, from the #305 harness);
// every write is refused by the mock and counted. NOT a soft-keyboard test.
//
// Stimuli, labelled per step:
//  (V) visualViewport stub: VisualViewport.prototype.height -> innerHeight-Δ
//      plus a 'resize' event. innerHeight is unchanged (what iOS Safari and
//      Android Chrome's default resizes-visual mode do for a keyboard), but
//      there is no OS keyboard, no occlusion and no visual pan.
//  (L) layout resize: page.setViewportSize — window shrink / rotation /
//      split-screen proxy; innerHeight and visualViewport change together.
import fs from 'node:fs/promises';
import { base, launch, setup, frames } from './common.mjs';

const OUT = process.env.OUT_DIR ?? new URL('./out/', import.meta.url).pathname;
await fs.mkdir(OUT, { recursive: true });

// ---------- page helpers ----------
const vvSet = (page, delta) =>
  page.evaluate((d) => {
    if (!window.__realVVH) window.__realVVH = Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'height');
    if (d === 0) Object.defineProperty(VisualViewport.prototype, 'height', window.__realVVH);
    else Object.defineProperty(VisualViewport.prototype, 'height', { configurable: true, get: () => innerHeight - d });
    visualViewport.dispatchEvent(new Event('resize'));
  }, delta);

// Orientation-aware keyboard stub: Δ follows the current orientation, so
// the events a rotation fires see a coherent innerHeight/visualViewport pair.
const vvOrient = (page, port, land) =>
  page.evaluate(({ port, land }) => {
    if (!window.__realVVH) window.__realVVH = Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'height');
    Object.defineProperty(VisualViewport.prototype, 'height', { configurable: true, get: () => innerHeight - (innerWidth > innerHeight ? land : port) });
    visualViewport.dispatchEvent(new Event('resize'));
  }, { port, land });

const settle = async (page, ms = 250) => { await page.waitForTimeout(ms); await frames(page, 2); };

function measure(page, extra = {}) {
  return page.evaluate(({ cta: ctaName }) => {
    const R = (el) => {
      if (!el || el === document.body || el === document.documentElement) return null;
      const b = el.getBoundingClientRect();
      return { y: Math.round(b.y), bottom: Math.round(b.bottom), h: Math.round(b.height), x: Math.round(b.x), w: Math.round(b.width) };
    };
    const sheet = document.querySelector('[data-vaul-drawer][data-state="open"]');
    const a = document.activeElement;
    const labelOf = (el) => el?.getAttribute('aria-label') || el?.closest('label')?.querySelector('span span, span')?.textContent?.trim() || el?.getAttribute('placeholder') || el?.textContent?.trim().slice(0, 40) || el?.tagName;
    const scope = sheet ?? document;
    const cta = ctaName ? [...scope.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(ctaName)) : null;
    const vvH = visualViewport.height;
    const band = [0, Math.min(innerHeight, vvH)];
    const hit = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      if (cy < band[0] || cy > band[1]) return false;
      const h = document.elementFromPoint(cx, cy);
      return !!h && el.contains(h);
    };
    const inBand = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return b.top >= band[0] - 0.5 && b.bottom <= band[1] + 0.5; };
    const alert = document.querySelector('[role="alertdialog"]');
    return {
      inner: [innerWidth, innerHeight], vvH: Math.round(vvH),
      sheet: R(sheet), sheetInline: sheet ? sheet.style.height + '|' + sheet.style.bottom : null,
      closeBtnInBand: sheet ? inBand(sheet.querySelector('button[aria-label="Close"]')) : null,
      active: { tag: a?.tagName, type: a?.type ?? null, label: labelOf(a), inSheet: !!sheet && sheet.contains(a), rect: R(a), inBand: a && a !== document.body ? inBand(a) : null },
      cta: R(cta), ctaInBand: inBand(cta), ctaHit: hit(cta), ctaDisabled: cta?.disabled ?? null,
      alert: alert ? { rect: R(alert), inBand: inBand(alert), buttonsHit: [...alert.querySelectorAll('button')].map((b) => [b.textContent.trim(), hit(b)]) } : null,
      bodyStyle: document.body.style.cssText, htmlScrollY: Math.round(scrollY), path: location.pathname,
    };
  }, extra);
}

// Scroll the focused element (or the CTA) into the visible band the way a
// browser does on focus — the harness cannot rely on Chromium doing it for a
// stubbed visual viewport, so this checks REACHABILITY, not auto-scroll.
const reveal = (page, what, ctaName) =>
  page.evaluate(({ what, ctaName }) => {
    const sheet = document.querySelector('[data-vaul-drawer][data-state="open"]');
    const el = what === 'active' ? document.activeElement : [...(sheet ?? document).querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(ctaName));
    el?.scrollIntoView({ block: 'nearest' });
  }, { what, ctaName });

// ---------- scenario plumbing ----------
const results = [];
let s; // current setup
const log = [];
function check(res, name, ok, detail) {
  res.checks.push({ name, ok: !!ok, detail });
  if (!ok) res.fail = true;
}
async function run(name, vp, fn) {
  const browser = await launch();
  s = await setup(browser, vp);
  const res = { name, viewport: [vp.width, vp.height], steps: [], checks: [] };
  const step = async (label, cta) => { const m = await measure(s.page, { cta }); res.steps.push({ label, ...m }); return m; };
  try {
    await fn({ page: s.page, res, step });
  } catch (e) {
    res.error = String(e).slice(0, 400);
    res.fail = true;
    await s.page.screenshot({ path: OUT + name + '-ERROR.jpg', type: 'jpeg', quality: 60 }).catch(() => {});
  }
  const allowed = (u) => /reconciliation\/matches\/\d+/.test(u); // approval facts: optional panel, see report
  res.fixture = { writes: s.writes, unhandled: [...new Set(s.unhandled)], unexpectedUnhandled: [...new Set(s.unhandled)].filter((u) => !allowed(u)), errors: s.errors };
  check(res, 'no writes reached the mock', s.writes.length === 0, s.writes);
  check(res, 'no page errors', s.errors.length === 0, s.errors);
  const line = `${res.fail ? 'FAIL' : 'ok  '} ${name} ${vp.width}x${vp.height}` + (res.error ? ' ERROR ' + res.error : '') + res.checks.filter((c) => !c.ok).map((c) => `\n     ✗ ${c.name} ${JSON.stringify(c.detail)}`).join('');
  console.log(line); log.push(line);
  results.push(res);
  await browser.close();
}

const openBooksCreate = async (page, which) => {
  // In-app navigation first, so Back has an app entry to go to (layers
  // never write history, lib/modalLayers).
  await page.goto(base + '/settings');
  await page.waitForLoadState('networkidle');
  await page.getByRole('link', { name: 'Books' }).last().click();
  await page.waitForURL('**/books');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Add to the books', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(which) }).click();
  const d = page.getByRole('dialog', { name: which, exact: true });
  await d.waitFor();
  await settle(page, 700);
  return d;
};
const openVerify = async (page) => {
  await page.goto(base + '/inbox/doc/31001');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Review extracted data' }).click();
  const d = page.getByRole('dialog').last();
  await d.waitFor();
  await settle(page, 900);
  return d;
};
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
const FILTER = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const want = (n) => !FILTER || FILTER.test(n);

// ===== S1: expense sheet, full keyboard lifecycle under (V) =====
for (const vp of [{ width: 390, height: 844, kb: 336, qt: 380 }, { width: 320, height: 568, kb: 260, qt: 300 }]) {
  const nm = `S1-expense-vv-lifecycle`;
  if (!want(nm)) continue;
  await run(nm, vp, async ({ page, res, step }) => {
    const d = await openBooksCreate(page, 'New expense');
    const m0 = await step('opened', 'Create expense');
    check(res, 'opens with focus on Close (no keyboard pop)', m0.active.label === 'Close', m0.active.label);
    check(res, 'no inline Vaul height at open', m0.sheetInline === '|', m0.sheetInline);
    await d.getByRole('combobox', { name: /^Category/ }).selectOption('office');
    const gross = d.getByLabel('Gross (€)', { exact: true });
    await gross.tap(); await page.keyboard.type('45.67');
    await vvSet(page, vp.kb); await settle(page);
    const m1 = await step('(V) kb open, Gross focused', 'Create expense');
    check(res, 'kb open: sheet lifted to bottom=Δ', m1.sheetInline.endsWith(`|${vp.kb}px`), m1.sheetInline);
    check(res, 'kb open: sheet inside visible band', m1.sheet.y >= 0 && m1.sheet.bottom <= m1.vvH + 1, [m1.sheet, m1.vvH]);
    check(res, 'kb open: Close button visible', m1.closeBtnInBand, null);
    await reveal(page, 'active'); await settle(page, 100);
    const m1b = await step('(V) Gross revealed', 'Create expense');
    check(res, 'kb open: Gross reachable in band', m1b.active.inBand, m1b.active.rect);
    // Focus change with the keyboard up (Next/Tab): no new resize event.
    await page.keyboard.press('Tab'); await settle(page, 150);
    const m2 = await step('(V) Tab -> VAT', 'Create expense');
    check(res, 'Tab moves to VAT', /VAT/.test(m2.active.label), m2.active.label);
    check(res, 'VAT field in band after focus move', m2.active.inBand, m2.active.rect);
    // Keyboard grows by < 60px (QuickType / autofill bar): Vaul must not flip state.
    await vvSet(page, vp.qt); await settle(page);
    const m3 = await step('(V) kb grows (suggestion bar)', 'Create expense');
    check(res, 'kb grows: bottom follows', m3.sheetInline.endsWith(`|${vp.qt}px`), m3.sheetInline);
    check(res, 'kb grows: sheet inside band', m3.sheet.y >= 0 && m3.sheet.bottom <= m3.vvH + 1, [m3.sheet, m3.vvH]);
    await reveal(page, 'active'); await settle(page, 100);
    check(res, 'kb grows: VAT still reachable', (await step('(V) VAT revealed', 'Create expense')).active.inBand, null);
    // Move to a picker control: keyboard goes away, a picker shows instead.
    await d.getByRole('combobox', { name: /^Category/ }).focus();
    await vvSet(page, 0); await settle(page);
    const m4 = await step('(V) focus select, kb gone', 'Create expense');
    check(res, 'picker focus: inline height/bottom cleared', m4.sheetInline === '|', m4.sheetInline);
    check(res, 'picker focus: sheet back to open height', near(m4.sheet.h, m0.sheet.h), [m4.sheet.h, m0.sheet.h]);
    // Date input counts as isInput in Vaul even though phones show a picker.
    await d.getByLabel('Tax point date', { exact: true }).focus();
    await vvSet(page, vp.kb); await settle(page);
    const m5 = await step('(V) date focused, kb-like Δ', 'Create expense');
    check(res, 'date: sheet lifted', m5.sheetInline.endsWith(`|${vp.kb}px`), m5.sheetInline);
    // Hide keyboard while focus stays (iOS Done / Android back arrow).
    await vvSet(page, 0); await settle(page);
    const m6 = await step('(V) kb hidden, focus kept', 'Create expense');
    check(res, 'hide w/ focus kept: inline cleared', m6.sheetInline === '|', m6.sheetInline);
    check(res, 'hide w/ focus kept: open height restored', near(m6.sheet.h, m0.sheet.h), [m6.sheet.h, m0.sheet.h]);
    check(res, 'hide w/ focus kept: sheet bottom at viewport bottom', near(m6.sheet.bottom, m6.inner[1]), m6.sheet);
    // Second cycle behaves like the first.
    await gross.focus(); await vvSet(page, vp.kb); await settle(page);
    const m7 = await step('(V) 2nd kb open', 'Create expense');
    check(res, '2nd open: lifted again', m7.sheetInline.endsWith(`|${vp.kb}px`) && m7.sheet.bottom <= m7.vvH + 1, m7.sheetInline);
    await reveal(page, 'cta', 'Create expense'); await settle(page, 100);
    const m7c = await step('(V) CTA revealed', 'Create expense');
    check(res, 'kb open: CTA hit-testable after scroll (not tapped)', m7c.ctaHit, m7c.cta);
    // Dismiss a DIRTY sheet with Escape while the keyboard is up.
    await gross.focus();
    await page.keyboard.press('Escape'); await settle(page, 300);
    const m8 = await step('(V) Escape on dirty sheet');
    check(res, 'dirty Escape asks to discard', !!m8.alert, null);
    // Focus left the input for the dialog -> a real keyboard would hide.
    check(res, 'discard dialog takes focus off the input (a real keyboard hides)', m8.active.tag === 'BUTTON' && !m8.active.inSheet, m8.active);
    res.record = { discardButtonsWithStubStillUp: m8.alert?.buttonsHit }; // proxy-only state: see report
    await vvSet(page, 0); await settle(page);
    const m8b = await step('(V) kb hidden under dialog');
    check(res, 'discard dialog buttons tappable after kb hides', m8b.alert?.buttonsHit.every(([, h]) => h), m8b.alert?.buttonsHit);
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await d.waitFor({ state: 'hidden' }); await settle(page, 400);
    const m9 = await step('discarded');
    check(res, 'after discard: route kept, body unlocked, focus on opener', m9.path === '/books' && !/pointer-events|position|overflow/.test(m9.bodyStyle) && /Add to the books/.test(m9.active.label ?? ''), [m9.path, m9.bodyStyle, m9.active.label]);
    // Reopen: fresh sheet, no stale Vaul size.
    await page.getByRole('button', { name: 'Add to the books', exact: true }).click();
    await page.getByRole('button', { name: /New expense/ }).click();
    const d2 = page.getByRole('dialog', { name: 'New expense', exact: true });
    await d2.waitFor(); await settle(page, 700);
    const m10 = await step('reopened', 'Create expense');
    check(res, 'reopen: no stale inline size, same height, empty form', m10.sheetInline === '|' && near(m10.sheet.h, m0.sheet.h) && (await d2.getByLabel('Gross (€)', { exact: true }).inputValue()) === '', [m10.sheetInline, m10.sheet.h]);
    await d2.getByLabel('Gross (€)', { exact: true }).focus(); await vvSet(page, vp.kb); await settle(page);
    const m11 = await step('(V) reopened kb open', 'Create expense');
    check(res, 'reopen: kb handling works', m11.sheetInline.endsWith(`|${vp.kb}px`) && m11.sheet.bottom <= m11.vvH + 1, m11.sheetInline);
    await page.screenshot({ path: `${OUT}S1-kb-open-${vp.width}x${vp.height}.jpg`, type: 'jpeg', quality: 60 });
  });
}

// ===== S2: every dismissal path with the keyboard up (clean form) =====
for (const how of ['close-button', 'escape', 'back', 'backdrop']) {
  const nm = `S2-dismiss-kb-up-${how}`;
  if (!want(nm)) continue;
  await run(nm, { width: 390, height: 844 }, async ({ page, res, step }) => {
    const d = await openBooksCreate(page, 'New expense');
    await d.getByLabel('Gross (€)', { exact: true }).focus();
    await vvSet(page, 336); await settle(page);
    const m1 = await step('(V) kb up, clean form');
    if (how === 'close-button') await d.getByRole('button', { name: 'Close', exact: true }).click();
    if (how === 'escape') await page.keyboard.press('Escape');
    if (how === 'back') await page.goBack();
    if (how === 'backdrop') await page.mouse.click(195, Math.max(5, m1.sheet.y - 20));
    await settle(page, 150);
    const mBlur = await step('dismiss requested');
    // The keyboard hides after (or while) the panel leaves.
    await vvSet(page, 0);
    await d.waitFor({ state: 'hidden', timeout: 3000 }); await settle(page, 400);
    const m2 = await step('closed + kb hidden');
    check(res, 'clean form closes without a question', !mBlur.alert, null);
    check(res, 'input no longer focused (keyboard would hide)', mBlur.active.tag !== 'INPUT', mBlur.active);
    check(res, 'route stays /books', m2.path === '/books', m2.path);
    check(res, 'body unlocked', !/pointer-events: none|position: fixed|overflow: hidden/.test(m2.bodyStyle), m2.bodyStyle);
    check(res, 'focus returned to opener', /Add to the books/.test(m2.active.label ?? ''), m2.active.label);
    check(res, 'page not left scrolled', m2.htmlScrollY === 0, m2.htmlScrollY);
  });
}

// ===== S3: layout resize (#362 regression) — phone shrink/rotate =====
for (const c of [
  { nm: 'S3-expense-L-shrink', which: 'New expense', field: 'Gross (€)', cta: 'Create expense', vp: { width: 390, height: 844 }, to: [390, 430] },
  { nm: 'S3-invoice-L-shrink', which: 'New sales invoice', field: 'Gross (€)', cta: 'Create invoice', vp: { width: 320, height: 844 }, to: [320, 430] },
  { nm: 'S3-expense-L-rotate+kb', which: 'New expense', field: 'Gross (€)', cta: 'Create expense', vp: { width: 390, height: 844 }, to: [844, 390], kbLand: 190, kbPort: 336 },
]) {
  if (!want(c.nm)) continue;
  await run(c.nm, c.vp, async ({ page, res, step }) => {
    const d = await openBooksCreate(page, c.which);
    const m0 = await step('opened', c.cta);
    await d.getByLabel(c.field, { exact: true }).tap(); await page.keyboard.type('120.50');
    let lift = null;
    if (c.kbPort) { await vvOrient(page, c.kbPort, c.kbLand); await settle(page); lift = await step('(V) kb up portrait', c.cta); }
    await page.setViewportSize({ width: c.to[0], height: c.to[1] }); await settle(page, 400);
    const m1 = await step(c.kbLand ? '(L) rotated + (V) kb' : '(L) shrunk', c.cta);
    check(res, 'shrunk: sheet within visible band, Close visible', m1.sheet.y >= -1 && m1.sheet.bottom <= m1.vvH + 1 && m1.closeBtnInBand, [m1.sheet, m1.vvH]);
    if (c.kbLand) {
      // The FIRST field of the form (not the focused one) must be reachable.
      await page.evaluate(() => document.querySelector('[data-vaul-drawer][data-state="open"] :is(input,select,textarea)').scrollIntoView({ block: 'nearest' }));
      await settle(page, 100);
      const top = await page.evaluate(() => document.querySelector('[data-vaul-drawer][data-state="open"] :is(input,select,textarea)').getBoundingClientRect().top);
      check(res, 'rotated, kb up: first field reachable', top >= 0, Math.round(top));
      await page.screenshot({ path: `${OUT}S3-rotate-kb-${process.env.SUFFIX ?? ''}.jpg`, type: 'jpeg', quality: 60 });
    }
    check(res, 'shrunk: focus + value kept', m1.active.label?.startsWith(c.field) && (await d.getByLabel(c.field, { exact: true }).inputValue()) === '120.50', m1.active.label);
    await reveal(page, 'active'); await settle(page, 100);
    check(res, 'shrunk: field reachable', (await step('field revealed', c.cta)).active.inBand, null);
    await reveal(page, 'cta', c.cta); await settle(page, 100);
    const mc = await step('cta revealed', c.cta);
    check(res, 'shrunk: CTA hit-testable (not tapped)', mc.ctaHit, mc.cta);
    await page.setViewportSize({ width: c.vp.width, height: c.vp.height }); await settle(page, 400);
    if (c.kbPort) {
      const mb = await step('(L) rotated back + (V) kb', c.cta);
      check(res, 'rotated back, kb up: sheet inside band', mb.sheet.y >= -1 && mb.sheet.bottom <= mb.vvH + 1 && mb.closeBtnInBand, [mb.sheet, mb.vvH]);
      check(res, 'rotated back, kb up: as tall as the first lift', mb.sheet.h >= lift.sheet.h - 2, [mb.sheet.h, lift.sheet.h]);
      await vvSet(page, 0); await settle(page);
    }
    const m2 = await step('(L) restored', c.cta);
    check(res, '#362: inline size released after restore', m2.sheetInline === '|', m2.sheetInline);
    check(res, '#362: sheet back to its opened height', near(m2.sheet.h, m0.sheet.h), [m2.sheet.h, m0.sheet.h]);
    check(res, 'restored: sheet bottom at viewport bottom', near(m2.sheet.bottom, m2.inner[1]), m2.sheet);
  });
}

// ===== S4: source (Verify) sheet, h-[92vh], Form/Source switch with kb up =====
for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  const nm = 'S4-verify-source-sheet';
  if (!want(nm)) continue;
  await run(nm, vp, async ({ page, res, step }) => {
    const d = await openVerify(page);
    const m0 = await step('opened');
    check(res, 'opened at 92vh', near(m0.sheet.h, Math.round(vp.height * 0.92), 3), [m0.sheet.h, vp.height]);
    const inputs = await d.locator('[data-sheet-pane="form"] input:not([type=checkbox]):not([type=radio]):not([type=file]), [data-sheet-pane="form"] textarea').all();
    res.fieldCount = inputs.length;
    let target = null;
    for (const i of inputs) if (await i.isVisible()) { target = i; if ((await i.getAttribute('inputmode')) === 'decimal') break; }
    check(res, 'has a text-like field', !!target, inputs.length);
    if (vp.width < 1024) await target.tap(); else await target.click();
    await page.keyboard.press('Control+A'); await page.keyboard.type('12.34');
    const val = await target.inputValue();
    const kb = vp.width < 1024 ? 336 : 0;
    if (kb) {
      await vvSet(page, kb); await settle(page);
      const m1 = await step('(V) kb up');
      check(res, 'kb up: sheet inside band, Close visible', m1.sheet.y >= 0 && m1.sheet.bottom <= m1.vvH + 1 && m1.closeBtnInBand, [m1.sheet, m1.sheetInline]);
      await reveal(page, 'active'); await settle(page, 100);
      check(res, 'kb up: field reachable', (await step('field revealed')).active.inBand, null);
      // Switch to Source and back while the keyboard is up.
      await d.getByRole('radiogroup', { name: 'Sheet view' }).getByText('Source document').click();
      await settle(page, 200);
      const m2 = await step('(V) switched to Source');
      check(res, 'source switch: no text field focused (a real keyboard hides)', !(m2.active.tag === 'TEXTAREA' || (m2.active.tag === 'INPUT' && !['radio', 'checkbox'].includes(m2.active.type))), m2.active);
      await vvSet(page, 0); await settle(page); // focus left the field -> kb hides
      const m3 = await step('(V) kb hidden on Source');
      check(res, 'source: inline released, 92vh again', m3.sheetInline === '|' && near(m3.sheet.h, m0.sheet.h, 2), [m3.sheetInline, m3.sheet.h]);
      await d.getByRole('radiogroup', { name: 'Sheet view' }).getByText('Form', { exact: true }).click();
      await settle(page, 200);
      check(res, 'form value kept across switch', (await target.inputValue()) === val, val);
    }
    // Realistic window shrink: phone split-screen / desktop window resize.
    await target.focus();
    await page.setViewportSize({ width: vp.width, height: vp.width < 1024 ? 430 : 480 }); await settle(page, 400);
    const m4 = await step('(L) shrunk');
    check(res, 'shrunk: sheet within viewport, Close visible', m4.sheet.y >= -1 && m4.sheet.bottom <= m4.inner[1] + 1 && m4.closeBtnInBand, m4.sheet);
    await reveal(page, 'active'); await settle(page, 100);
    check(res, 'shrunk: field reachable', (await step('field revealed')).active.inBand, null);
    await page.setViewportSize({ width: vp.width, height: vp.height }); await settle(page, 400);
    const m5 = await step('(L) restored');
    check(res, '#362: restored to 92vh, no inline size', m5.sheetInline === '|' && near(m5.sheet.h, m0.sheet.h, 2), [m5.sheetInline, m5.sheet.h, m0.sheet.h]);
    await page.screenshot({ path: `${OUT}S4-verify-${vp.width}x${vp.height}.jpg`, type: 'jpeg', quality: 60 });
  });
}

// ===== S5: desktop window shrink with a form sheet open =====
for (const c of [{ vp: { width: 1440, height: 900 }, to: 480 }, { vp: { width: 1024, height: 768 }, to: 400 }, { vp: { width: 768, height: 1024 }, to: 520 }]) {
  const nm = 'S5-desktop-window-shrink';
  if (!want(nm)) continue;
  await run(nm, c.vp, async ({ page, res, step }) => {
    const d = await openBooksCreate(page, 'New sales invoice');
    const m0 = await step('opened', 'Create invoice');
    await d.getByLabel('Invoice number', { exact: true }).click(); await page.keyboard.type('2026-0042');
    await d.getByLabel('Gross (€)', { exact: true }).click(); await page.keyboard.type('1500');
    await page.setViewportSize({ width: c.vp.width, height: c.to }); await settle(page, 400);
    const m1 = await step('(L) window shrunk', 'Create invoice');
    check(res, 'shrunk: sheet top/Close visible', m1.sheet.y >= -1 && m1.closeBtnInBand, m1.sheet);
    check(res, 'shrunk: sheet ≤ 92vh', m1.sheet.h <= Math.ceil(c.to * 0.92) + 1, [m1.sheet.h, c.to]);
    await reveal(page, 'active'); await settle(page, 100);
    check(res, 'shrunk: focused field reachable', (await step('field revealed', 'Create invoice')).active.inBand, null);
    // keyboard Tab through the remaining fields keeps each one reachable
    for (let k = 0; k < 4; k++) {
      await page.keyboard.press('Tab'); await settle(page, 80);
      const mt = await step('Tab ' + k, 'Create invoice');
      check(res, `Tab ${k}: focus in sheet and visible`, mt.active.inSheet && mt.active.inBand, [mt.active.label, mt.active.rect]);
    }
    await reveal(page, 'cta', 'Create invoice'); await settle(page, 100);
    const mc = await step('cta revealed', 'Create invoice');
    check(res, 'shrunk: CTA hit-testable (not clicked)', mc.ctaHit, mc.cta);
    await page.setViewportSize(c.vp); await settle(page, 400);
    const m2 = await step('(L) restored', 'Create invoice');
    check(res, 'restored: same height, no inline size', m2.sheetInline === '|' && near(m2.sheet.h, m0.sheet.h), [m2.sheetInline, m2.sheet.h, m0.sheet.h]);
    check(res, 'values kept', (await d.getByLabel('Invoice number', { exact: true }).inputValue()) === '2026-0042', null);
  });
}

// ===== S6: textarea (Reject reason) =====
{
  const nm = 'S6-reject-textarea';
  if (want(nm)) await run(nm, { width: 390, height: 844, approvals: true }, async ({ page, res, step }) => {
    await page.goto(base + '/inbox/approval/96001');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: /Reject match/ }).click();
    const d = page.getByRole('dialog').last(); await d.waitFor(); await settle(page, 700);
    const title = await d.getAttribute('aria-labelledby').then((id) => page.locator('#' + CSS_escape(id)).textContent()).catch(() => null);
    const ctaName = (await d.locator('button').last().textContent()).trim();
    res.sheet = { title, ctaName };
    const ta = d.locator('textarea');
    await ta.tap();
    await vvSet(page, 336); await settle(page);
    for (let i = 1; i <= 8; i++) { await page.keyboard.type(`Line ${i} of the rejection reason`); if (i < 8) await page.keyboard.press('Enter'); }
    await settle(page, 150);
    const m1 = await step('(V) 8 lines typed', ctaName);
    check(res, 'Enter inserts newlines, does not submit', (await ta.inputValue()).split('\n').length === 8 && s.writes.length === 0, null);
    check(res, 'kb up: sheet inside band', m1.sheet.y >= 0 && m1.sheet.bottom <= m1.vvH + 1, [m1.sheet, m1.sheetInline]);
    // The caret sits at the end: is the textarea's bottom edge reachable?
    await reveal(page, 'active'); await settle(page, 100);
    const m2 = await step('textarea revealed', ctaName);
    check(res, 'textarea bottom (caret line) reachable', m2.active.rect.bottom <= m2.vvH + 1, [m2.active.rect, m2.vvH]);
    await reveal(page, 'cta', ctaName); await settle(page, 100);
    const m3 = await step('cta revealed', ctaName);
    check(res, 'CTA enabled + hit-testable (not tapped)', m3.ctaHit && !m3.ctaDisabled, [m3.cta, m3.ctaDisabled]);
    await vvSet(page, 0); await settle(page);
    const m4 = await step('(V) kb hidden', ctaName);
    check(res, 'kb hidden: inline released', m4.sheetInline === '|', m4.sheetInline);
    await page.screenshot({ path: `${OUT}S6-reject-textarea.jpg`, type: 'jpeg', quality: 60 });
  });
}
function CSS_escape(id) { return id.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c); }

// ===== S7: full pages with sticky ActionBar / TabBar =====
for (const c of [
  { nm: 'S7-bank-create-actionbar', route: '/bank/statements/1/tx/501', cta: 'Create & match', vp: { width: 390, height: 844 } },
  { nm: 'S7-bank-create-actionbar', route: '/bank/statements/1/tx/501', cta: 'Create & match', vp: { width: 320, height: 568 } },
  { nm: 'S7-organization-page', route: '/settings/organization', cta: 'Save organization', vp: { width: 390, height: 844 } },
]) {
  if (!want(c.nm)) continue;
  await run(c.nm, c.vp, async ({ page, res, step }) => {
    await page.goto(base + c.route); await page.waitForLoadState('networkidle'); await settle(page, 400);
    const fields = await page.locator('main input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]), main textarea').all();
    res.fieldCount = fields.length;
    check(res, 'has text-like fields', fields.length > 0, fields.length);
    // Tab through every text-like field; after each focus the browser's own
    // focus scroll must leave it clear of the ActionBar and TabBar.
    const obscured = await page.evaluate(() => {
      const out = [];
      const bars = [...document.querySelectorAll('nav, [data-actionbar], .sticky, .fixed')].filter((e) => { const p = getComputedStyle(e).position; return (p === 'fixed' || p === 'sticky') && e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < innerHeight / 2; });
      const els = [...document.querySelectorAll('main input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]), main textarea, main select')];
      for (const el of els) {
        el.focus();
        const r = el.getBoundingClientRect();
        const cover = bars.filter((b) => !b.contains(el)).map((b) => b.getBoundingClientRect()).filter((b) => b.top < r.bottom && b.bottom > r.top && b.left < r.right && b.right > r.left && b.top > r.top - 1);
        if (r.top < 0 || r.bottom > innerHeight || cover.length) out.push({ label: el.getAttribute('aria-label') || el.closest('label')?.textContent?.trim().slice(0, 30), top: Math.round(r.top), bottom: Math.round(r.bottom), covered: cover.length });
      }
      return out;
    });
    check(res, 'programmatic focus scroll: no text field under a sticky bar', obscured.length === 0, obscured);
    // (L) window shrink with the last field focused.
    const last = fields.at(-1);
    await last.focus();
    await page.setViewportSize({ width: c.vp.width, height: Math.round(c.vp.height * 0.6) }); await settle(page, 400);
    await last.evaluate((el) => el.focus()); await reveal(page, 'active'); await settle(page, 100);
    const m1 = await step('(L) shrunk, last field revealed', c.cta);
    check(res, '(L) last field visible', m1.active.inBand, m1.active.rect);
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight)); await settle(page, 150);
    const m2 = await step('(L) scrolled to end', c.cta);
    check(res, '(L) CTA hit-testable at end of scroll (not tapped)', m2.ctaHit, m2.cta);
    await page.setViewportSize(c.vp); await settle(page, 300);
    // (V) keyboard stub: no listener on full pages; record only.
    await last.focus(); await vvSet(page, Math.round(c.vp.height * 0.4)); await settle(page);
    res.vvRecord = await step('(V) kb stub on full page (record only)', c.cta);
    await vvSet(page, 0);
  });
}

// ===== S8: IMAP sheet — number + password (port validation from #376) =====
{
  const nm = 'S8-imap-number-password';
  if (want(nm)) await run(nm, { width: 390, height: 844 }, async ({ page, res, step }) => {
    await page.goto(base + '/settings/mailbox'); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: /Add IMAP mailbox/ }).click();
    const d = page.getByRole('dialog', { name: 'Add IMAP mailbox', exact: true }); await d.waitFor(); await settle(page, 700);
    await d.getByLabel('IMAP host', { exact: true }).tap(); await page.keyboard.type('imap.example.com');
    await vvSet(page, 336); await settle(page);
    const port = d.getByLabel('Port', { exact: true });
    await port.tap(); await page.keyboard.press('Control+A'); await page.keyboard.type('993');
    const m1 = await step('(V) port focused', 'Add mailbox');
    res.portAttrs = await port.evaluate((el) => ({ type: el.type, inputMode: el.inputMode, fontPx: getComputedStyle(el).fontSize }));
    await reveal(page, 'active'); await settle(page, 100);
    check(res, 'port reachable with kb up', (await step('port revealed', 'Add mailbox')).active.inBand, m1.active.rect);
    await d.getByLabel('Username', { exact: true }).tap(); await page.keyboard.type('me@example.com');
    await vvSet(page, 380); await settle(page); // password autofill bar
    await d.getByLabel('App password', { exact: true }).tap(); await page.keyboard.type('fixture-app-pw');
    await reveal(page, 'active'); await settle(page, 100);
    const m2 = await step('(V) password + autofill bar', 'Add mailbox');
    check(res, 'password reachable above autofill bar', m2.active.inBand && m2.sheet.bottom <= m2.vvH + 1, [m2.active.rect, m2.vvH]);
    await reveal(page, 'cta', 'Add mailbox'); await settle(page, 100);
    const m3 = await step('cta revealed', 'Add mailbox');
    check(res, 'CTA hit-testable (not tapped)', m3.ctaHit, [m3.cta, m3.ctaDisabled]);
    await vvSet(page, 0); await settle(page);
    const m4 = await step('(V) kb hidden', 'Add mailbox');
    check(res, 'kb hidden: inline released', m4.sheetInline === '|', m4.sheetInline);
  });
}

await fs.writeFile(OUT + 'kb-results' + (process.env.SUFFIX ?? '') + '.json', JSON.stringify(results, null, 1));
await fs.writeFile(OUT + 'kb' + (process.env.SUFFIX ?? '') + '.log', log.join('\n') + '\n');
console.log(`${results.filter((r) => !r.fail).length}/${results.length} scenarios passed`);
