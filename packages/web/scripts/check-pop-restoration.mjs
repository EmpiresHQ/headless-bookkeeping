#!/usr/bin/env node
/**
 * Browser regression check for issue #370: history traversals that arrive
 * while a refused Back/Forward is still being restored (e.g. two
 * `history.back()` calls in one task while a Sheet, a dirty form or a save
 * guards the route) must leave the browser address, `history.state`
 * (idx/key/usr) and React Router's location on the SAME entry — and a
 * PUSH/REPLACE requested meanwhile must be written at the router's entry,
 * never over or after a wrong one.
 *
 * Real Chromium history, 390×844 touch. Opens /books/expenses/12, then the
 * app's own Settings and Books links (three same-document entries), then
 * drives each case. Every case checks: same document, address = router
 * path, history key = router key, history idx = navigation entry index; most
 * also walk the whole trail Back to the first entry and Forward to the top,
 * comparing every entry's key/usr/path with the recorded trail.
 *
 * Every /api, /admin and /health request is answered from in-script
 * fixtures. The only write allowed is POST /api/expenses (the New expense
 * save, optionally held); any other write gets a 409 and fails the run.
 *
 *   BASE_URL=http://127.0.0.1:4173 \
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
 *   OUT_DIR=/tmp/pop-370 \
 *   node packages/web/scripts/check-pop-restoration.mjs
 *
 * ONLY=<regex> limits the cases by key. Exits non-zero on any failure.
 * Traversals are programmatic (`history.back()` etc. from page script), not
 * physical/system Back; cases marked "synthetic" also click or patch from
 * page script at fixed ms (`history.go` dropped: a stand-in for a browser
 * that drops traversals). The router is read from React's fiber tree for
 * the assertions only. Chromium aborts a request in flight during a
 * same-task double Back (net::ERR_ABORTED, also without this fix): the
 * pending case accepts either outcome and checks it is truthful.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:4173').replace(/\/$/, '');
const PW = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
const OUT_DIR = process.env.OUT_DIR ?? '';
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const { chromium } = await import(PW);
if (OUT_DIR) await fs.mkdir(OUT_DIR, { recursive: true });

const expense = (id, extra = {}) => ({
  id, document_id: null, supplier_id: 1, category: 'office', gross_amount: 12345, vat_amount: 2226,
  currency: 'EUR', tax_point_date: '2026-09-10', due_date: null, status: 'draft', voucher_id: null,
  supplier_invoice_number: 'SUP-370', claimant_id: null, company_addressed_receipt: null,
  ai_confidence: null, ai_document_type: null, ai_kind: null, asset_name: null,
  asset_useful_life_years: null, asset_residual_value_minor: null, created_at: 1790000000,
  updated_at: 1790000000, reconciled: false, ...extra,
});
const ORGANIZATION = {
  id: 1, name: 'Fixture OÜ', country: 'EE', org_type: 'company', base_currency: 'EUR', vat_registered: true,
  vat_registration_kind: 'ordinary', input_vat_entitlement: 'full', input_vat_deduction_permille: null,
  created_at: 1790000000, vat_registration_number: null, registry_code: null, iban: null,
};
const ENTITIES = [
  { id: 1, role: 'supplier', name: 'Fixture supplier', country: 'EE', goods_vs_services: 'services', tax_status: 'taxable_business' },
];

async function setup(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(() => localStorage.setItem('bk_api_token', 'pop-370-fixture'));
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const origin = new URL(BASE_URL).origin;
  const f = { context, page, posts: [], hold: false, releases: [], created: null, unexpected: [], unhandled: [] };
  f.release = () => { f.hold = false; f.releases.splice(0).forEach((r) => r()); };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin !== origin) return route.abort();
    if (!/^\/(api|admin|health)(\/|$)/.test(u.pathname)) return route.continue();
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const p = u.pathname;
    if (req.method() === 'POST' && p === '/api/expenses') {
      f.posts.push(req.postDataJSON());
      if (f.hold) await new Promise((r) => f.releases.push(r));
      f.created = expense(24, { ...req.postDataJSON(), id: 24 });
      return send(f.created).catch(() => undefined); // the page may have aborted it
    }
    if (req.method() !== 'GET') {
      f.unexpected.push(`${req.method()} ${p}`);
      return send({ message: '#370 check: writes are refused' }, 409);
    }
    if (p === '/api/expenses/12') return send(expense(12));
    if (p === '/api/expenses/24' && f.created) return send(f.created);
    if (p === '/api/expenses') return send({ expenses: f.created ? [f.created] : [] });
    if (p === '/api/organization') return send(ORGANIZATION);
    if (p === '/api/categories') return send({ categories: [{ key: 'office', label: 'Office expenses' }, { key: 'software', label: 'Software' }] });
    if (p === '/api/entities') return send({ entities: ENTITIES });
    if (p === '/api/approvals' || p === '/api/approvals/pending') return send({ approvals: [] });
    if (p === '/api/triage/needs-triage') return send({ items: [] });
    if (p === '/api/documents') return send({ documents: [] });
    if (p === '/api/sales-invoices') return send({ invoices: [] });
    if (p === '/api/credit-notes') return send({ credit_notes: [] });
    if (p === '/api/reporting-periods') return send({ reportingPeriods: [] });
    if (p === '/api/mailbox/connectors') return send([]);
    f.unhandled.push(p);
    return send({ message: 'No fixture' }, 404);
  });
  await page.goto(`${BASE_URL}/books/expenses/12`);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.waitForURL('**/settings');
  await page.getByRole('link', { name: 'Books', exact: true }).click();
  await page.waitForURL('**/books');
  await page.evaluate(() => {
    window.marker = 'same-document-370';
    const root = document.getElementById('root');
    const stack = [root[Object.keys(root).find((k) => k.startsWith('__reactContainer$'))]];
    const seen = new Set();
    while (stack.length) {
      const n = stack.pop();
      if (!n || seen.has(n)) continue;
      seen.add(n);
      if (n.memoizedProps?.router?.navigate) { window.__router = n.memoizedProps.router; break; }
      stack.push(n.child, n.sibling);
    }
  });
  // The trail as the router wrote it: each entry's history.state, walked.
  f.trail = [];
  for (let i = 2; i >= 0; i--) {
    if (i < 2) await traverse(page, 'history.back()');
    const e = await entry(page);
    f.trail[e.idx] = { key: e.key, usr: e.usr, path: e.path };
  }
  await traverse(page, 'history.go(2)');
  assert.equal((await entry(page)).idx, 2, 'setup: back on /books');
  return f;
}

const wait = (page, ms) => page.waitForTimeout(ms);
async function traverse(page, script, ms = 350) {
  await page.evaluate(script);
  await wait(page, ms);
}
const entry = (page) =>
  page.evaluate(() => ({
    idx: history.state?.idx,
    key: history.state?.key ?? 'default',
    usr: history.state?.usr ?? null,
    path: location.pathname + location.search,
  }));
const snap = (page) =>
  page.evaluate(() => {
    const r = window.__router;
    return {
      path: location.pathname + location.search,
      idx: history.state?.idx,
      key: history.state?.key ?? 'default',
      usr: history.state?.usr ?? null,
      routerPath: r.state.location.pathname + r.state.location.search,
      routerKey: r.state.location.key,
      entryIndex: navigation.currentEntry.index,
      trail: navigation.entries().map((e) => { const u = new URL(e.url); return u.pathname + u.search; }),
      marker: window.marker,
      sheets: [...document.querySelectorAll('[data-vaul-drawer]')].filter((e) => e.dataset.state === 'open')
        .map((e) => e.querySelector('input[inputmode=decimal]')?.value ?? ''),
      questions: document.querySelectorAll('[role=alertdialog]').length,
    };
  });

/** Browser entry and router agree. */
function agree(s, where) {
  assert.equal(s.marker, 'same-document-370', `${where}: same document`);
  assert.equal(s.path, s.routerPath, `${where}: address = router path`);
  assert.equal(s.key, s.routerKey, `${where}: history key = router key`);
  assert.equal(s.idx, s.entryIndex, `${where}: history idx = entry index`);
}

/** From the current entry Back to the first and Forward to the top: every
 *  entry as expected. */
async function walk(page, expected) {
  const from = (await entry(page)).idx;
  for (let i = from; i > 0; i--) {
    await traverse(page, 'history.back()');
    agree(await snap(page), `walk back to ${i - 1}`);
  }
  for (let i = 0; i < expected.length; i++) {
    const e = await entry(page);
    assert.deepEqual(e, { idx: i, ...expected[i] }, `trail entry ${i}`);
    if (i < expected.length - 1) {
      await traverse(page, 'history.forward()');
      agree(await snap(page), `walk forward to ${i + 1}`);
    }
  }
}

async function openExpense(page) {
  await page.getByRole('button', { name: 'Add to the books', exact: true }).click();
  await page.getByRole('button', { name: /New expense/ }).click();
  const d = page.getByRole('dialog', { name: 'New expense', exact: true });
  await d.waitFor();
  await wait(page, 400);
  return d;
}
const gross = (d) => d.getByLabel('Gross (€)', { exact: true });
async function fillValid(d) {
  await gross(d).fill('45.67');
  await d.getByLabel('Tax point date', { exact: true }).fill('2026-09-21');
  await d.getByRole('combobox', { name: /^Category/ }).selectOption('office');
}
const burst = (page) => page.evaluate(() => { history.back(); history.back(); });
const settle = (page) => wait(page, 900);
/** Synthetic: click a question's button from page script after `ms`. */
const clickLater = (label, ms) =>
  `setTimeout(() => { const b = [...document.querySelectorAll('[role=alertdialog] button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); window.clicked = !!b; b?.click(); }, ${ms})`;

const CASES = {
  // ── the defect: a same-task double Back while a guard refuses the first ──
  'burst clean Sheet: one dismiss, entry kept, trail intact': async ({ page, trail }) => {
    await openExpense(page);
    await burst(page);
    await settle(page);
    const s = await snap(page);
    agree(s, 'after');
    assert.equal(s.idx, 2);
    assert.deepEqual(s.sheets, [], 'the clean sheet closed once');
    await walk(page, trail);
  },
  'burst dirty Sheet: one question; Keep keeps the value on the same entry': async ({ page }) => {
    const d = await openExpense(page);
    await gross(d).fill('12.34');
    await burst(page);
    await settle(page);
    let s = await snap(page);
    agree(s, 'asked');
    assert.equal(s.idx, 2);
    assert.equal(s.questions, 1, 'one discard question');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Keep editing', exact: true }).click();
    await wait(page, 400);
    s = await snap(page);
    agree(s, 'kept');
    assert.deepEqual(s.sheets, ['12.34']);
  },
  'burst dirty Sheet: Discard closes it; route and trail intact': async ({ page, trail }) => {
    const d = await openExpense(page);
    await gross(d).fill('12.34');
    await burst(page);
    await settle(page);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard', exact: true }).click();
    await wait(page, 500);
    const s = await snap(page);
    agree(s, 'discarded');
    assert.equal(s.routerPath, '/books');
    assert.deepEqual(s.sheets, []);
    await walk(page, trail);
  },
  'burst while saving: exactly one POST; truthful outcome on a consistent entry': async (f) => {
    const { page } = f;
    const d = await openExpense(page);
    await fillValid(d);
    f.hold = true;
    await d.getByRole('button', { name: /^Create expense/ }).click();
    await wait(page, 150);
    await burst(page);
    await settle(page);
    agree(await snap(page), 'while saving');
    f.release();
    await wait(page, 1200);
    const s = await snap(page);
    agree(s, 'after the response');
    assert.equal(f.posts.length, 1, 'exactly one POST, never replayed');
    if (s.routerPath === '/books/expenses/24') {
      assert.equal(s.idx, 3);
      return 'created → detail';
    }
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    assert.match(text, /not confirmed/, 'unknown outcome said as such');
    assert.match(text, /input is still in the form/);
    assert.deepEqual(s.sheets, ['45.67'], 'input kept');
    assert.equal(s.routerPath, '/books');
    return 'request aborted by the browser → not confirmed, input kept';
  },
  // ── PUSH/REPLACE requested while the refused Back is being restored ──
  'PUSH 10ms after the first pop is written after the router entry': async ({ page, trail }) => {
    await openExpense(page);
    await page.evaluate(() => {
      addEventListener('popstate', () => setTimeout(() => window.__router.navigate('/inbox'), 10), { once: true });
      history.back(); history.back();
    });
    await settle(page);
    const s = await snap(page);
    agree(s, 'after');
    assert.equal(s.routerPath, '/inbox');
    assert.equal(s.idx, 3);
    await walk(page, [...trail, { key: s.key, usr: s.usr, path: '/inbox' }]);
  },
  'REPLACE 10ms after the first pop replaces only the router entry': async ({ page, trail }) => {
    await openExpense(page);
    await page.evaluate(() => {
      addEventListener('popstate', () => setTimeout(() => window.__router.navigate('/inbox', { replace: true, state: { mark: 370 } }), 10), { once: true });
      history.back(); history.back();
    });
    await settle(page);
    const s = await snap(page);
    agree(s, 'after');
    assert.equal(s.idx, 2);
    assert.deepEqual(s.usr, { mark: 370 });
    await walk(page, [trail[0], trail[1], { key: s.key, usr: { mark: 370 }, path: '/inbox' }]);
  },
  'synthetic: dirty PUSH confirmed (Discard) inside the restoration': async ({ page, trail }) => {
    const d = await openExpense(page);
    await gross(d).fill('12.34');
    await page.evaluate(`history.back(); history.back(); setTimeout(() => window.__router.navigate('/inbox'), 10); ${clickLater('Discard', 30)}`);
    await settle(page);
    assert.equal(await page.evaluate(() => window.clicked), true, 'Discard was clicked inside the window');
    const s = await snap(page);
    agree(s, 'after');
    assert.equal(s.routerPath, '/inbox');
    assert.equal(s.idx, 3);
    await walk(page, [...trail, { key: s.key, usr: s.usr, path: '/inbox' }]);
  },
  'synthetic: inline dirty Back confirmed (Discard) inside the restoration': async ({ page, trail }) => {
    await page.evaluate(() => window.__router.navigate('/settings/organization'));
    const name = page.getByLabel('Name', { exact: true });
    await name.waitFor();
    await wait(page, 300);
    const top = await entry(page);
    await name.fill('Unsaved 370');
    await page.evaluate(`history.back(); history.back(); ${clickLater('Discard', 30)}`);
    await settle(page);
    assert.equal(await page.evaluate(() => window.clicked), true, 'Discard was clicked inside the window');
    const s = await snap(page);
    agree(s, 'after');
    assert.equal(s.routerPath, '/books');
    assert.equal(s.key, trail[2].key);
    await walk(page, [...trail, { key: top.key, usr: top.usr, path: '/settings/organization' }]);
  },
  // ── a browser that drops traversals ──
  "synthetic: the router's own restore dropped: restored anyway": async ({ page }) => {
    await openExpense(page);
    await page.evaluate(() => {
      const go = history.go.bind(history);
      let first = true;
      history.go = (n) => { if (first) { first = false; return; } go(n); };
      history.back();
    });
    await settle(page);
    const s = await snap(page);
    agree(s, 'restored');
    assert.equal(s.idx, 2);
    await traverse(page, 'history.back()', 500);
    const next = await snap(page);
    agree(next, 'next Back');
    assert.equal(next.routerPath, '/settings');
  },
  'synthetic: every restore dropped: nothing written at the wrong entry': async ({ page, trail }) => {
    await openExpense(page);
    await page.evaluate(() => {
      const go = history.go.bind(history);
      window.restoreGo = () => { history.go = go; };
      history.go = () => undefined;
      history.back();
      setTimeout(() => window.__router.navigate('/inbox'), 50); // held, then cancelled
    });
    await wait(page, 1200);
    let s = await snap(page);
    // Unrecoverable while the browser refuses every traversal: said, not hidden.
    assert.equal(s.path, '/settings', 'browser still on the refused entry');
    assert.equal(s.routerPath, '/books', 'router still on its own entry');
    await page.evaluate(() => window.__router.navigate('/inbox', { replace: true })); // refused
    await wait(page, 300);
    s = await snap(page);
    assert.equal(s.routerPath, '/books', 'no navigation while stranded');
    assert.deepEqual(s.trail, trail.map((t) => t.path), 'no entry written or replaced');
    await page.evaluate(() => window.restoreGo());
    await traverse(page, 'history.forward()', 500); // the operator's own traversal onto the router entry
    s = await snap(page);
    agree(s, 'recovered');
    assert.equal(s.key, trail[2].key);
    await walk(page, trail);
  },
  // ── controls: ordinary paced use is unchanged ──
  'control: single Back while saving; the response reaches the detail': async (f) => {
    const { page } = f;
    const d = await openExpense(page);
    await fillValid(d);
    f.hold = true;
    await d.getByRole('button', { name: /^Create expense/ }).click();
    await wait(page, 150);
    await traverse(page, 'history.back()', 900);
    agree(await snap(page), 'while saving');
    f.release();
    await wait(page, 1200);
    const s = await snap(page);
    agree(s, 'after the response');
    assert.equal(s.routerPath, '/books/expenses/24');
    assert.equal(s.idx, 3);
    assert.equal(f.posts.length, 1);
  },
  'control: Backs 20ms apart on a dirty Sheet: ask, then the second answers Keep': async ({ page }) => {
    const d = await openExpense(page);
    await gross(d).fill('12.34');
    await page.evaluate(() => new Promise((r) => { history.back(); setTimeout(() => { history.back(); r(); }, 20); }));
    await settle(page);
    const s = await snap(page);
    agree(s, 'after');
    assert.equal(s.idx, 2);
    assert.equal(s.questions, 0);
    assert.deepEqual(s.sheets, ['12.34']);
  },
  'control: Back and Forward in one task on a clean Sheet': async ({ page, trail }) => {
    await openExpense(page);
    await page.evaluate(() => { history.back(); history.forward(); });
    await settle(page);
    const s = await snap(page);
    agree(s, 'after');
    assert.equal(s.idx, 2);
    await walk(page, trail);
  },
  'control: history.go(-2) on a clean Sheet': async ({ page, trail }) => {
    await openExpense(page);
    await traverse(page, 'history.go(-2)', 900);
    const s = await snap(page);
    agree(s, 'after');
    assert.equal(s.idx, 2);
    assert.deepEqual(s.sheets, []);
    await walk(page, trail);
  },
  'control: double Back with nothing open navigates normally': async ({ page, trail }) => {
    await burst(page);
    await settle(page);
    const s = await snap(page);
    agree(s, 'after');
    assert.equal(s.key, trail[0].key);
  },
};

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const report = [];
for (const [name, run] of Object.entries(CASES)) {
  if (ONLY && !ONLY.test(name)) continue;
  const f = await setup(browser);
  const r = { name };
  try {
    r.note = (await run(f)) ?? null;
    assert.deepEqual(f.unexpected, [], 'no unexpected writes');
    r.ok = true;
  } catch (e) {
    r.ok = false;
    r.error = String(e.message).split('\n').slice(0, 8).join(' | ');
    r.state = await snap(f.page).catch(() => null);
    if (OUT_DIR) await f.page.screenshot({ path: `${OUT_DIR}/${report.length}-failure.png` }).catch(() => undefined);
  } finally {
    r.unhandled = [...new Set(f.unhandled)];
    f.release();
    await f.context.close();
  }
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${name}${r.note ? ` — ${r.note}` : ''}${r.ok ? '' : `\n     ${r.error}`}`);
  report.push(r);
}
const failures = report.filter((r) => !r.ok).length;
if (OUT_DIR) await fs.writeFile(`${OUT_DIR}/results.json`, JSON.stringify({ baseUrl: BASE_URL, browser: browser.version(), runs: report.length, failures, report }, null, 2));
await browser.close();
console.log(`${report.length - failures}/${report.length} passed`);
if (failures > 0) process.exitCode = 1;
