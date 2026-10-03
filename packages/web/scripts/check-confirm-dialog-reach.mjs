#!/usr/bin/env node
/**
 * Browser regression check for issue #366: a ConfirmDialog whose warning is
 * long (an accepted, unbounded entity name) or whose text is enlarged must
 * stay inside the viewport, keep the whole title, warning and BOTH actions
 * reachable (wheel, keyboard, pointer) and never spill text sideways — while
 * a short dialog at normal size keeps its old look (one row, two equal
 * buttons, no scrolling).
 *
 * Drives the Entity "Delete entity…" confirm at 320×568 and 844×390, normal
 * and synthetic 200 % text, for a short, a 678-char spaced and two unbroken
 * names. Every /api, /admin and /health request is answered from in-script
 * fixtures; any write gets a 409 and fails the run. Delete is only ever
 * trial-clicked (hit-tested), never pressed; Cancel is pressed.
 *
 *   BASE_URL=http://127.0.0.1:5173 \
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
 *   OUT_DIR=/tmp/confirm-366 \
 *   node packages/web/scripts/check-confirm-dialog-reach.mjs
 *
 * ONLY=<regex> limits the cases by key. Exits non-zero on any failure.
 * "Synthetic 200 %" doubles the computed font-size / line-height of every
 * element in the dialog subtree after it opens (html, rem and layout sizes
 * unchanged). It is NOT a browser or OS text-size setting — Chromium's CDP
 * OS text scale had no effect on this app (docs/qa/2026-09-24-…) — and
 * nothing here is a device result.
 */
import fs from 'node:fs/promises';

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '');
const PW = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
const OUT_DIR = process.env.OUT_DIR ?? '';
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const { chromium } = await import(PW);
if (OUT_DIR) await fs.mkdir(OUT_DIR, { recursive: true });

const stem =
  'Northern European Maritime Logistics and Industrial Equipment Maintenance Research Development Procurement and International Distribution Services Holding Company Tallinn Regional Operations Estonia Limited Liability Company';
const NAMES = {
  short: 'Fixture supplier OÜ',
  long: Array(3).fill(stem).join(' — '), // 678 chars
  unbroken: 'VeryLongSupplierLegalNameWithoutAnySpacesOrBreakOpportunities-Holding-International-Tallinn-OÜ',
  unbroken184: 'NorthernEuropeanMaritime'.repeat(8),
};
const VIEWPORTS = [
  [320, 568],
  [844, 390],
];
const TEXT = ['normal', 'synthetic200'];

const entity = (name) => ({
  id: 7,
  name,
  role: 'supplier',
  country: 'EE',
  goods_vs_services: 'services',
  tax_status: 'taxable_business',
  identifiers: [],
});

function fixture(name, p) {
  if (p === '/api/entities/7') return entity(name);
  if (p === '/api/entities') return { entities: [entity(name)] };
  if (p === '/api/entities/7/aliases') return { aliases: [] };
  if (p === '/api/organization')
    return { id: 1, country: 'EE', base_currency: 'EUR', vat_registered: true, vat_registration_kind: 'ordinary', input_vat_entitlement: 'full', input_vat_deduction_permille: null, org_type: 'company', created_at: 1790000000, name: 'Fixture OÜ', vat_registration_number: null, registry_code: null, iban: null };
  if (p === '/api/categories') return { categories: [] };
  if (p === '/api/approvals/pending') return { approvals: [] };
  if (p === '/api/triage/needs-triage') return { items: [] };
  if (p === '/api/documents') return { documents: [] };
  if (p === '/api/expenses') return { expenses: [] };
  if (p === '/api/sales-invoices') return { invoices: [] };
  return undefined;
}

/** Geometry of the open dialog, all in viewport px. */
function measure(el) {
  const box = (r) => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height });
  const textRects = (node) => {
    const rg = document.createRange();
    rg.selectNodeContents(node);
    return [...rg.getClientRects()].filter((r) => r.width > 0).map(box);
  };
  const d = el.getBoundingClientRect();
  const title = document.getElementById(el.getAttribute('aria-labelledby'));
  const desc = document.getElementById(el.getAttribute('aria-describedby'));
  const buttons = [...el.querySelectorAll('button')].map((b) => {
    const r = b.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const at = document.elementFromPoint(cx, cy);
    return {
      name: b.textContent,
      rect: box(r),
      hit: !!at && b.contains(at),
      overflowX: b.scrollWidth > b.clientWidth + 1,
      text: textRects(b),
      focused: document.activeElement === b,
      font: getComputedStyle(b).fontSize,
    };
  });
  return {
    viewport: { w: innerWidth, h: innerHeight },
    dialog: box(d),
    scroll: { top: el.scrollTop, max: el.scrollHeight - el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth },
    title: { rect: box(title.getBoundingClientRect()), text: textRects(title), sw: title.scrollWidth, cw: title.clientWidth },
    desc: { rect: box(desc.getBoundingClientRect()), text: textRects(desc), sw: desc.scrollWidth, cw: desc.clientWidth, font: getComputedStyle(desc).fontSize },
    buttons,
    focused: document.activeElement?.textContent ?? null,
  };
}

/** A box is visible when it lies inside both the viewport and the dialog's
 *  own (scrolling) box. */
const inside = (r, m) =>
  r.y >= Math.max(0, m.dialog.y) - 0.5 &&
  r.bottom <= Math.min(m.viewport.h, m.dialog.bottom) + 0.5 &&
  r.x >= Math.max(0, m.dialog.x) - 0.5 &&
  r.right <= Math.min(m.viewport.w, m.dialog.right) + 0.5;

const failures = [];
const report = [];
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const origin = new URL(BASE_URL).origin;

for (const [width, height] of VIEWPORTS)
  for (const [kind, name] of Object.entries(NAMES))
    for (const text of TEXT) {
      const key = `${kind}-${width}x${height}-${text}`;
      if (ONLY && !ONLY.test(key)) continue;
      const r = { key, nameLength: name.length, failures: [] };
      const fail = (msg, data) => r.failures.push(data === undefined ? msg : `${msg} ${JSON.stringify(data)}`);
      const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
      await context.addInitScript(() => localStorage.setItem('bk_api_token', 'confirm-366-fixture'));
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const writes = [];
      const unhandled = [];
      page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
      await page.route('**/*', async (route) => {
        const req = route.request();
        const u = new URL(req.url());
        if (u.origin !== origin) return route.abort();
        if (!/^\/(api|admin|health)(\/|$)/.test(u.pathname)) return route.continue();
        if (req.method() !== 'GET') {
          writes.push(`${req.method()} ${u.pathname}`);
          return route.fulfill({ status: 409, contentType: 'application/json', body: '{"message":"#366 check: writes are refused"}' });
        }
        const body = fixture(name, u.pathname);
        if (body === undefined) {
          unhandled.push(u.pathname);
          return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"No fixture"}' });
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      });
      try {
        await page.goto(`${BASE_URL}/settings/entities/7`);
        const trigger = page.getByRole('button', { name: 'Delete entity…', exact: true });
        await trigger.click();
        const d = page.getByRole('alertdialog', { name: 'Delete this entity?', exact: true });
        await d.waitFor();
        await page.waitForTimeout(300); // open animation
        if (text === 'synthetic200') {
          await d.evaluate((el) => {
            const snap = [el, ...el.querySelectorAll('*')].map((e) => {
              const s = getComputedStyle(e);
              return [e, parseFloat(s.fontSize), parseFloat(s.lineHeight)];
            });
            for (const [e, size, line] of snap) {
              e.style.setProperty('font-size', `${size * 2}px`, 'important');
              if (Number.isFinite(line)) e.style.setProperty('line-height', `${line * 2}px`, 'important');
            }
          });
          await page.waitForTimeout(150);
        }
        const bounded = (m, when) => {
          const { dialog: b, viewport: v } = m;
          if (b.y < -0.5 || b.bottom > v.h + 0.5 || b.x < -0.5 || b.right > v.w + 0.5)
            fail(`${when}: dialog outside the viewport`, { dialog: b, viewport: v });
          if (m.scroll.sw > m.scroll.cw + 1) fail(`${when}: dialog scrolls sideways`, m.scroll);
          for (const [part, t] of [['title', m.title], ['warning', m.desc]]) {
            if (t.sw > t.cw + 1) fail(`${when}: ${part} overflows its box`, { sw: t.sw, cw: t.cw });
            if (t.text.some((g) => g.x < m.dialog.x - 0.5 || g.right > m.dialog.right + 0.5))
              fail(`${when}: ${part} glyphs outside the dialog`);
          }
          for (const b of m.buttons) {
            if (b.overflowX) fail(`${when}: "${b.name}" label overflows the button`);
            if (b.text.some((g) => g.x < b.rect.x - 0.5 || g.right > b.rect.right + 0.5))
              fail(`${when}: "${b.name}" glyphs outside the button`);
            if (b.rect.x < m.dialog.x - 0.5 || b.rect.right > m.dialog.right + 0.5)
              fail(`${when}: "${b.name}" wider than the dialog`, b.rect);
          }
        };
        const buttonsVisible = (m, when) => {
          if (m.buttons.length !== 2) fail(`${when}: expected 2 actions`, m.buttons.length);
          for (const b of m.buttons) {
            if (!inside(b.rect, m)) fail(`${when}: "${b.name}" not fully visible`, b.rect);
            else if (!b.hit) fail(`${when}: "${b.name}" not hit-testable at its centre`);
          }
        };
        const titleVisible = (m, when) => {
          if (!inside(m.title.rect, m)) fail(`${when}: title not fully visible`, m.title.rect);
        };

        // Open: bounded, starting at the top with the question readable.
        r.initial = await d.evaluate(measure);
        bounded(r.initial, 'open');
        titleVisible(r.initial, 'open');
        if (r.initial.scroll.top !== 0) fail('open: not scrolled to the top', r.initial.scroll);
        if (r.initial.focused !== 'Cancel') fail('open: focus did not start on Cancel', r.initial.focused);
        if (kind === 'short' && text === 'normal') {
          // Old look kept: no scroll region in use, one row of equal buttons.
          const [a, b] = r.initial.buttons;
          if (r.initial.scroll.max > 0) fail('short: dialog scrolls', r.initial.scroll);
          if (Math.abs(a.rect.y - b.rect.y) > 0.5 || Math.abs(a.rect.w - b.rect.w) > 1)
            fail('short: actions not one row of equal buttons', [a.rect, b.rect]);
          buttonsVisible(r.initial, 'short open');
        }

        // Wheel (inside the dialog) down to both actions, then back up.
        const c = r.initial.dialog;
        await page.mouse.move(c.x + c.w / 2, Math.max(1, c.y) + Math.min(c.h, height) / 2);
        await page.mouse.wheel(0, 10000);
        await page.waitForTimeout(300);
        r.wheelDown = await d.evaluate(measure);
        buttonsVisible(r.wheelDown, 'wheel down');
        await page.mouse.wheel(0, -10000);
        await page.waitForTimeout(300);
        r.wheelUp = await d.evaluate(measure);
        titleVisible(r.wheelUp, 'wheel up');
        const warnTop = r.wheelUp.desc.text[0];
        if (!warnTop || !inside(warnTop, r.wheelUp)) fail('wheel up: warning start not visible');

        // Keyboard from the top: every trap move (forward, back, wrap) must
        // reveal the focused action.
        r.keys = [];
        for (const k of ['Tab', 'Shift+Tab', 'Shift+Tab', 'Tab', 'Tab']) {
          await page.keyboard.press(k);
          await page.waitForTimeout(120);
          const m = await d.evaluate(measure);
          const f = m.buttons.find((b) => b.focused);
          r.keys.push({ key: k, focused: f?.name ?? null, top: m.scroll.top });
          if (!f) fail(`${k}: focus left the actions`);
          else if (!inside(f.rect, m)) fail(`${k}: focused "${f.name}" not visible`, f.rect);
        }

        // Pointer reachability (trial only for the destructive one).
        r.trials = {};
        for (const label of ['Cancel', 'Delete entity']) {
          try {
            await d.getByRole('button', { name: label, exact: true }).click({ trial: true, timeout: 1500 });
            r.trials[label] = 'reachable';
          } catch {
            r.trials[label] = 'timeout';
            fail(`"${label}" trial click failed`);
          }
        }

        // Height change while open (keyboard/toolbars): still bounded, both
        // actions still reachable, then restored.
        await page.setViewportSize({ width, height: Math.round(height * 0.7) });
        await page.waitForTimeout(250);
        await page.mouse.move(width / 2, Math.round(height * 0.35));
        await page.mouse.wheel(0, 10000);
        await page.waitForTimeout(300);
        r.shrunk = await d.evaluate(measure);
        bounded(r.shrunk, 'shrunk');
        buttonsVisible(r.shrunk, 'shrunk');
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(250);
        r.restored = await d.evaluate(measure);
        bounded(r.restored, 'restored');

        if (OUT_DIR) {
          await page.mouse.wheel(0, -10000);
          await page.waitForTimeout(200);
          await page.screenshot({ path: `${OUT_DIR}/${key}-top.png` });
          await page.mouse.wheel(0, 10000);
          await page.waitForTimeout(200);
          await page.screenshot({ path: `${OUT_DIR}/${key}-bottom.png` });
        }

        // Cancel by a real pointer tap where it is shown; Escape otherwise
        // (baseline) so the run still ends cleanly.
        const cancel = d.getByRole('button', { name: 'Cancel', exact: true });
        if (r.trials.Cancel === 'reachable') {
          await cancel.scrollIntoViewIfNeeded();
          const b = await cancel.boundingBox();
          await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
          r.closedBy = 'Cancel tap';
        } else {
          await page.keyboard.press('Escape');
          r.closedBy = 'Escape';
        }
        await d.waitFor({ state: 'hidden' });
        await page.waitForTimeout(200);
        if (!(await trigger.evaluate((e) => e === document.activeElement))) fail('focus not returned to the trigger');
        if (await page.evaluate(() => document.body.hasAttribute('data-scroll-locked'))) fail('page still scroll-locked');
        if (new URL(page.url()).pathname !== '/settings/entities/7') fail('route changed');
        r.completed = true;
      } catch (e) {
        r.completed = false;
        fail(`harness: ${String(e).split('\n')[0]}`);
      }
      if (writes.length) fail('writes were attempted', writes);
      if (unhandled.length) fail('unhandled API paths', [...new Set(unhandled)]);
      await context.close();
      report.push(r);
      for (const msg of r.failures) failures.push(`${key}: ${msg}`);
      const w = r.wheelDown?.buttons ?? [];
      console.log(
        `${key.padEnd(34)} ${r.failures.length ? `FAIL ${r.failures.length}` : 'ok    '} dialog y=${r.initial?.dialog.y.toFixed(1)}..${r.initial?.dialog.bottom.toFixed(1)} actions@bottom ${w.map((b) => `${b.rect.y.toFixed(0)}..${b.rect.bottom.toFixed(0)}`).join(' ')} closed=${r.closedBy ?? '-'}`,
      );
    }
await browser.close();

if (OUT_DIR) await fs.writeFile(`${OUT_DIR}/results.json`, JSON.stringify({ baseUrl: BASE_URL, runs: report.length, failures, report }, null, 2));
if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S) in ${report.filter((r) => r.failures.length).length}/${report.length} runs:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`\nOK — ${report.length} runs, no failures`);
