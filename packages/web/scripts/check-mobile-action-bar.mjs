#!/usr/bin/env node
/**
 * Browser regression check for UI-001 (issue #245): the sticky tx-screen
 * action bars (TxCandidates, TxCreateExpense, TxMatched, IncomingOpen) must
 * never sit under the mobile TabBar / safe area, and must receive taps.
 *
 * Every /api, /admin and /health request is answered from in-script fixtures
 * (writes get a 503 and are recorded) — nothing reaches the Vite proxy or a
 * backend. Playwright is NOT a repo dependency; point at any install:
 *
 *   BASE_URL=http://127.0.0.1:5173 \
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
 *   OUT_DIR=/tmp/ui-001 \
 *   node packages/web/scripts/check-mobile-action-bar.mjs
 *
 * Exits non-zero on any failed assertion. Emulation only: Chromium mobile
 * viewports + touch, safe-area insets via CDP (falls back to overriding
 * --safe-bottom when the CDP override is unavailable) — not a real device.
 */
import fs from 'node:fs/promises';

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '');
const PW = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
const OUT_DIR = process.env.OUT_DIR ?? '';
const { chromium } = await import(PW);
if (OUT_DIR) await fs.mkdir(OUT_DIR, { recursive: true });

const name = 'Very Long Supplier International Services Estonia OÜ';
const baseTx = {
  id: 1,
  transaction_date: '2026-09-22',
  description: name,
  amount: -120000,
  currency: 'EUR',
  counterparty_descriptor: name,
  counterparty_iban: null,
  reference: 'INV-2026-000000042',
  status: 'open',
};
const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));

const SCENARIOS = [
  {
    key: 'candidates',
    tx: baseTx,
    candidates: many(16, (i) => ({
      voucherId: i + 1,
      objectType: 'expense',
      objectId: i + 1,
      objectLabel: `Invoice ${i + 1} · ${name}`,
      counterpartyName: name,
      voucherRemaining: 7500,
    })),
    matches: [],
    prepare: (page) => page.getByRole('checkbox').first().click(),
    buttons: [/^Match /],
    // Tapping Match must reach the button: it posts a manual match (mocked).
    tapExpect: { request: /\/match$/ },
  },
  {
    // Deliberate load error: match-candidates fails (500) until Retry is
    // tapped — Retry must be reachable above the tab bar, and the recovered
    // screen must pass the same geometry checks.
    key: 'candidates-load-error',
    tx: baseTx,
    candidates: 'SEE candidates',
    matches: [],
    loadErrorUntilRetry: true,
    prepare: (page) => page.getByRole('checkbox').first().click(),
    buttons: [/^Match /],
    tapExpect: { request: /\/match$/ },
  },
  {
    // Deliberate pending + write error: POST /match is held, then fails.
    // While pending the bar stays in place (busy); after the error the
    // selection (user context) must survive and the button re-enable.
    key: 'candidates-write-error',
    tx: baseTx,
    candidates: 'SEE candidates',
    matches: [],
    writeDelayMs: 1200,
    prepare: (page) => page.getByRole('checkbox').first().click(),
    buttons: [/^Match /],
    tapExpect: { request: /\/match$/, pendingThenError: true },
  },
  {
    key: 'create',
    tx: baseTx,
    candidates: [],
    matches: [],
    buttons: [/^Create & match/],
    tapExpect: {}, // disabled until valid: the tap must simply not hit the nav
  },
  {
    key: 'matched',
    tx: baseTx,
    candidates: [],
    matches: many(16, (i) => ({
      id: i + 1,
      bankTransactionId: 1,
      status: i === 0 ? 'draft' : 'active',
      amountMatched: 7500,
      objectLabel: `Invoice ${i + 1} · ${name}`,
      counterpartyName: name,
    })),
    buttons: [/^Confirm match$/, /^Unmatch$/],
    tapExpect: { request: /\/matches\/\d+$|\/match/ },
  },
  {
    key: 'incoming-open',
    tx: { ...baseTx, amount: 120000 },
    candidates: [],
    matches: [],
    buttons: [/^Record prepayment/],
    tapExpect: { dialog: true },
  },
];

for (const sc of SCENARIOS)
  if (sc.candidates === 'SEE candidates') sc.candidates = SCENARIOS[0].candidates;

const categories = many(16, (i) => ({
  key: `cat-${i}`,
  label: `Category ${i + 1} with a longish label`,
  accountCode: `4${String(i).padStart(3, '0')}`,
}));

function fixture(sc, u) {
  const p = u.pathname;
  if (p === '/api/categories') return { categories };
  if (p === '/api/organization')
    return { id: 1, country: 'EE', base_currency: 'EUR', vat_registered: true, vat_registration_kind: 'ordinary', input_vat_entitlement: 'full', input_vat_deduction_permille: null, org_type: 'OU', created_at: 1790000000, name: 'Fixture OÜ', vat_registration_number: null, registry_code: null, iban: null };
  if (p === '/api/entities') return { entities: [{ id: 1, name, role: 'supplier', country: 'EE' }] };
  if (p === '/api/bank-statements')
    return [{ id: 1, start_date: '2026-09-01', end_date: '2026-09-30', uploaded_at: 1790000000 }];
  if (p.endsWith('/transactions')) return [sc.tx];
  if (p.endsWith('/matches')) return sc.matches;
  if (p.endsWith('/reconciliation'))
    return [{ bankTransactionId: 1, amountBase: Math.abs(sc.tx.amount), matchedSum: 0, remaining: Math.abs(sc.tx.amount), reconStatus: sc.matches.length ? 'matched' : 'open' }];
  if (p.endsWith('/match-candidates')) return { lineRemaining: Math.abs(sc.tx.amount), candidates: sc.candidates };
  if (p === '/api/prepayments/advance-vat-treatments') return { treatments: [{ vat_code: 'VAT24', rate_permille: 240 }] };
  if (p === '/api/approvals/pending') return { approvals: [] };
  if (p === '/api/triage/needs-triage') return { items: [] };
  if (p === '/api/documents') return { documents: [] };
  return undefined;
}

const MODES = [
  ...[320, 390, 430].flatMap((width) => [
    { label: `${width}x844`, width, height: 844, mobile: true, safe: 0 },
    { label: `${width}x844+safe34`, width, height: 844, mobile: true, safe: 34 },
  ]),
  { label: 'desktop-1280x800', width: 1280, height: 800, mobile: false, safe: 0 },
];

const failures = [];
const report = [];
const fail = (ctx, msg, data) => failures.push({ ...ctx, msg, ...(data ? { data } : {}) });

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const origin = new URL(BASE_URL).origin;

for (const mode of MODES) {
  for (const sc of SCENARIOS) {
    const ctx = { mode: mode.label, scenario: sc.key };
    const context = await browser.newContext({
      viewport: { width: mode.width, height: mode.height },
      isMobile: mode.mobile,
      hasTouch: mode.mobile,
      deviceScaleFactor: 1,
    });
    await context.addInitScript(() => localStorage.setItem('bk_api_token', 'ui-001-fixture'));
    const page = await context.newPage();
    const writes = [];
    let retried = false;
    const unhandled = [];
    page.on('pageerror', (e) => fail(ctx, `pageerror: ${e.message}`));
    await page.route('**/*', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      if (u.origin !== origin) return route.abort();
      if (!/^\/(api|admin|health)(\/|$)/.test(u.pathname)) return route.continue();
      // propose-matches is a read-like POST the screen issues on load.
      if (u.pathname.endsWith('/propose-matches'))
        return route.fulfill({ contentType: 'application/json', body: '[]' });
      if (sc.loadErrorUntilRetry && !retried && u.pathname.endsWith('/match-candidates'))
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"UI-001 check: deliberate load error"}' });
      if (req.method() !== 'GET') {
        if (sc.writeDelayMs) await new Promise((r) => setTimeout(r, sc.writeDelayMs));
        writes.push(`${req.method()} ${u.pathname}`);
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"UI-001 check: writes are mocked"}' });
      }
      const body = fixture(sc, u);
      if (body === undefined) {
        unhandled.push(u.pathname);
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"No fixture"}' });
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });

    let safeSource = 'none';
    if (mode.safe) {
      try {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: mode.safe } });
        safeSource = 'cdp';
      } catch {
        safeSource = 'css-var';
      }
    }

    const txPath = '/bank/statements/1/tx/1';
    await page.goto(`${BASE_URL}${txPath}`);
    if (sc.loadErrorUntilRetry) {
      const retry = page.getByRole('button', { name: 'Retry' });
      try {
        await retry.waitFor({ timeout: 10000 });
        const r = await retry.boundingBox();
        const navTop = await page.evaluate(() => [...document.querySelectorAll('nav')].find((n) => getComputedStyle(n).position === 'fixed' && n.getBoundingClientRect().height > 0)?.getBoundingClientRect().top ?? innerHeight);
        if (r.y + r.height > navTop) fail(ctx, 'Retry sits under the tab bar', { r, navTop });
        retried = true;
        if (mode.mobile) await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
        else await retry.click();
      } catch (e) {
        fail(ctx, `load-error state not rendered: ${e.message.split('\n')[0]}`);
      }
    }
    const first = page.getByRole('button', { name: sc.buttons[0] });
    try {
      await first.waitFor({ timeout: 10000 });
    } catch {
      fail(ctx, 'action button never rendered', { unhandled });
      await context.close();
      continue;
    }
    if (mode.safe) {
      // env() only reports insets for viewport-fit=cover; verify what the
      // tab bar actually computed and fall back to the CSS token if needed.
      const pad = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('nav.fixed')).paddingBottom));
      if (pad < mode.safe) {
        await page.addStyleTag({ content: `:root{--safe-bottom:${mode.safe}px !important}` });
        safeSource = safeSource === 'cdp' ? 'css-var (cdp override not reflected by env())' : 'css-var';
      }
    }
    if (sc.prepare) await sc.prepare(page);
    await page.waitForTimeout(250);

    const maxScroll = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    const positions = [...new Set([0, 350, Math.round(maxScroll / 4), Math.round(maxScroll / 2), Math.round((3 * maxScroll) / 4), maxScroll].map((y) => Math.max(0, Math.min(y, maxScroll))))];
    const samples = [];
    for (const y of positions) {
      await page.evaluate((y) => window.scrollTo(0, y), y);
      await page.waitForTimeout(80);
      for (const re of sc.buttons) {
        const m = await page.getByRole('button', { name: re }).evaluate((el) => {
          const r = el.getBoundingClientRect();
          const nav = [...document.querySelectorAll('nav')].find((n) => getComputedStyle(n).position === 'fixed' && n.getBoundingClientRect().height > 0);
          const nr = nav?.getBoundingClientRect();
          const bar = el.parentElement.getBoundingClientRect();
          const pts = [
            [r.x + r.width / 2, r.y + r.height / 2],
            // Edge midpoints, inset past the rounded-xl corners.
            [r.x + 4, r.y + r.height / 2],
            [r.right - 4, r.y + r.height / 2],
            [r.x + r.width / 2, r.y + 3],
            [r.x + r.width / 2, r.bottom - 3],
          ];
          const blocked = pts
            .map(([x, y]) => ({ x, y, at: document.elementFromPoint(x, y) }))
            .filter((p) => !el.contains(p.at))
            .map((p) => ({ x: p.x, y: p.y, at: p.at?.outerHTML.slice(0, 120) ?? null }));
          return {
            rect: { y: r.y, bottom: r.bottom, h: r.height },
            barBottom: bar.bottom,
            navTop: nr ? nr.top : null,
            navH: nr ? nr.height : null,
            innerHeight,
            innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            scrollY,
            blocked,
          };
        });
        samples.push({ scroll: y, button: String(re), ...m });
        const limit = m.navTop ?? m.innerHeight;
        if (m.rect.y < 0 || m.rect.bottom > limit + 0.5)
          fail(ctx, `button ${re} not fully visible above ${m.navTop == null ? 'viewport bottom' : 'tab bar'} at scroll ${y}`, m);
        if (m.navTop != null && m.barBottom > m.navTop + 0.5)
          fail(ctx, `action bar overlaps tab bar at scroll ${y}`, m);
        if (m.blocked.length) fail(ctx, `button ${re} hit-test blocked at scroll ${y}`, m.blocked);
        if (m.scrollWidth > m.innerWidth) fail(ctx, `horizontal overflow ${m.scrollWidth}>${m.innerWidth}`);
        if (mode.mobile && m.navTop == null) fail(ctx, 'tab bar not visible on mobile');
        if (!mode.mobile && m.navTop != null) fail(ctx, 'tab bar visible on desktop');
        if (mode.mobile && mode.safe && m.navH != null && m.innerHeight - m.navTop < 47 + mode.safe - 0.5)
          fail(ctx, `tab bar does not reserve safe area (${m.innerHeight - m.navTop}px)`);
      }
    }
    if (OUT_DIR) {
      await page.evaluate((y) => window.scrollTo(0, y), Math.min(350, maxScroll));
      await page.waitForTimeout(80);
      await page.screenshot({ path: `${OUT_DIR}/${mode.label}-${sc.key}.png` });
    }

    // Real tap at the centre of the (first) button, mid-scroll.
    await page.evaluate((y) => window.scrollTo(0, y), Math.min(350, maxScroll));
    await page.waitForTimeout(80);
    const btn = page.getByRole('button', { name: sc.buttons.at(-1) });
    // Busy Buttons render "…", so keep a handle: the name locator would
    // silently wait until the label comes back.
    const handle = await btn.elementHandle();
    const box = await btn.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    if (mode.mobile) await page.touchscreen.tap(cx, cy);
    else await page.mouse.click(cx, cy);
    if (sc.tapExpect.pendingThenError) {
      await page.waitForTimeout(300);
      const pending = await handle.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const nav = [...document.querySelectorAll('nav')].find((n) => getComputedStyle(n).position === 'fixed' && n.getBoundingClientRect().height > 0);
        return { disabled: el.disabled, bottom: r.bottom, navTop: nav?.getBoundingClientRect().top ?? innerHeight };
      });
      if (!pending.disabled) fail(ctx, 'button not busy while the write is pending', pending);
      if (pending.bottom > pending.navTop + 0.5) fail(ctx, 'busy button slid under the tab bar', pending);
      await page.waitForTimeout(sc.writeDelayMs + 300);
      // Short timeouts: if the tap hit the tab bar we are on another route,
      // and that must be reported as a failure, not hang the run.
      const after = {
        checked: await page.getByRole('checkbox').first().getAttribute('aria-checked', { timeout: 2000 }).catch(() => null),
        enabled: await handle.isEnabled().catch(() => false),
        toast: await page.getByText('UI-001 check: writes are mocked').isVisible().catch(() => false),
      };
      if (after.checked !== 'true') fail(ctx, 'selection lost after write error', after);
      if (!after.enabled) fail(ctx, 'button stayed disabled after write error', after);
      if (!after.toast) fail(ctx, 'write error not surfaced as a toast', after);
    }
    await page.waitForTimeout(400);
    const url = new URL(page.url());
    const tap = { url: url.pathname, writes: [...writes] };
    if (url.pathname !== txPath) fail(ctx, `tap navigated to ${url.pathname}`);
    if (sc.tapExpect.request && !writes.some((w) => sc.tapExpect.request.test(w)))
      fail(ctx, 'tap did not reach the button (no mocked write observed)', tap);
    if (sc.tapExpect.dialog && !(await page.getByRole('dialog').isVisible().catch(() => false)))
      fail(ctx, 'tap did not open the prepayment sheet', tap);
    if (unhandled.length) fail(ctx, 'unhandled API paths', unhandled);

    report.push({ ...ctx, safeSource, maxScroll, tap, samples });
    await context.close();
  }
}
await browser.close();

const summary = { baseUrl: BASE_URL, runs: report.length, failures };
if (OUT_DIR) await fs.writeFile(`${OUT_DIR}/results.json`, JSON.stringify({ ...summary, report }, null, 2));
console.log(
  report
    .map((r) => {
      const s = r.samples.filter((x) => x.scroll === Math.min(350, r.maxScroll));
      return `${r.mode.padEnd(18)} ${r.scenario.padEnd(14)} safe=${r.safeSource.padEnd(5)} ${s
        .map((x) => `${x.button.slice(1, 12)} y=${x.rect.y.toFixed(1)}..${x.rect.bottom.toFixed(1)} nav=${x.navTop?.toFixed(1) ?? '-'}`)
        .join(' | ')} tap→${r.tap.url}${r.tap.writes.length ? ` [${r.tap.writes.join(', ')}]` : ''}`;
    })
    .join('\n'),
);
if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S):\n${JSON.stringify(failures, null, 2)}`);
  process.exit(1);
}
console.log(`\nOK — ${report.length} runs, no failures`);
