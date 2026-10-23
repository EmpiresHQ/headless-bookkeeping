// Bounded desktop automation / CDP touch emulation. Never physical device QA.
const { chromium } = require(
  process.env.QA_PLAYWRIGHT_MODULE ||
    '/tmp/hbk-397-browser/node_modules/playwright',
);
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const base = 'http://127.0.0.1:5299',
  out = 'docs/qa/issue-299';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const ctl = async (name, body) =>
  (
    await fetch(
      `${base}/__qa/${name}`,
      body ? { method: 'POST', body: JSON.stringify(body) } : undefined,
    )
  ).json();
const file = process.env.QA_RESULTS || path.join(out, 'results.json');
const results = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, 'utf8'))
  : {
      base: '940648810402abd58390c28610629d206cfed73b',
      synthetic: true,
      cases: [],
    };
const drawer = '[data-vaul-drawer][data-state="open"]';
async function snap(p) {
  return p.evaluate(() => {
    const d = document.querySelector('[data-vaul-drawer][data-state="open"]');
    const sc = d?.querySelector('.overflow-y-auto');
    const vv = visualViewport;
    return {
      url: location.href,
      historyState: history.state,
      heading: document.querySelector('main h1')?.textContent,
      drawers: document.querySelectorAll(
        '[data-vaul-drawer][data-state="open"]',
      ).length,
      questions: document.querySelectorAll(
        '[role="alertdialog"][data-state="open"]',
      ).length,
      gross: document.querySelector('input[inputmode="decimal"]')?.value,
      scroll: sc
        ? {
            top: sc.scrollTop,
            max: sc.scrollHeight - sc.clientHeight,
            client: sc.clientHeight,
          }
        : null,
      transform: d
        ? new DOMMatrixReadOnly(getComputedStyle(d).transform).m42
        : null,
      bodyPointerEvents: document.body.style.pointerEvents,
      active: {
        tag: document.activeElement?.tagName,
        label: document.activeElement?.getAttribute('aria-label'),
      },
      viewport: {
        innerHeight,
        innerWidth,
        visualHeight: vv?.height,
        visualWidth: vv?.width,
        scale: vv?.scale,
        offsetTop: vv?.offsetTop,
      },
      events: window.__qa299,
    };
  });
}
async function scrollBottom(p) {
  await p
    .locator(drawer)
    .locator('.overflow-y-auto')
    .evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  await pause(80);
}
async function consistent(p, idx) {
  const s = await snap(p);
  assert.equal(new URL(s.url).pathname, '/books');
  assert.equal(s.heading, 'Books');
  assert.equal(s.historyState.idx, idx);
  return s;
}
async function open(p, state) {
  await p.goto(`${base}/books?seg=expenses`);
  await p.getByRole('link', { name: 'Settings', exact: true }).click();
  await p.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await p.getByRole('link', { name: 'Books', exact: true }).click();
  await p.getByRole('heading', { name: 'Books', exact: true }).waitFor();
  await p
    .getByRole('button', { name: 'Add to the books', exact: true })
    .click();
  await p.getByRole('button', { name: /New expense/ }).click();
  await p
    .getByLabel('Category', { exact: true })
    .selectOption(state === 'pending' ? 'software' : '');
  if (state !== 'clean') {
    await p
      .getByLabel('Gross (€)', { exact: true })
      .fill(state === 'pending' ? '45.67' : '12.34');
  }
  if (state === 'pending') {
    await p.getByLabel('VAT (€)', { exact: true }).fill('0');
    await p.getByLabel('Tax point date', { exact: true }).fill('2026-09-10');
    await ctl('arm', { path: '^/api/expenses$', mode: 'hold-after' });
    await p.getByRole('button', { name: /^Create expense/ }).click();
    for (let i = 0; i < 40 && (await ctl('state')).held === 0; i++)
      await pause(100);
    assert.equal((await ctl('state')).held, 1);
  }
  await pause(700);
  await scrollBottom(p);
  await pause(550);
  const s = await snap(p);
  assert.ok(s.scroll.max > 100, 'fixture must be a genuinely scrolling form');
  return s;
}
async function browserBack(p, kind = 'browser') {
  if (kind === 'same-task')
    await p.evaluate(() => {
      history.back();
      history.back();
    });
  else if (kind === '100ms') {
    await p.evaluate(() => history.back());
    await pause(100);
    await p.evaluate(() => history.back());
  } else
    await p.goBack().catch((e) => {
      if (!e.message.includes('Timeout')) throw e;
    });
  await pause(650);
}
async function drag(p, cd, where) {
  const geometry = await p.locator(drawer).evaluate((d, where) => {
    const r = d.getBoundingClientRect();
    const sc = d.querySelector('.overflow-y-auto');
    const sr = sc.getBoundingClientRect();
    return {
      height: r.height,
      x: r.left + r.width / 2,
      y: where === 'handle' ? r.top + 12 : sr.top + Math.min(80, sr.height / 2),
      scroll: sc.scrollTop,
    };
  }, where);
  const end = Math.min(
      await p.evaluate(() => innerHeight - 8),
      geometry.y + 320,
    ),
    motion = [];
  await cd.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: geometry.x, y: geometry.y }],
  });
  for (let i = 1; i <= 15; i++) {
    await cd.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: geometry.x, y: geometry.y + ((end - geometry.y) * i) / 15 },
      ],
    });
    motion.push(await snap(p));
    await pause(25);
  }
  await cd.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await pause(650);
  return {
    where,
    geometry,
    end,
    travel: end - geometry.y,
    motion,
    peak: Math.max(0, ...motion.map((m) => m.transform || 0)),
  };
}
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      '/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
  });
  results.browser = await browser.version();
  async function run(id, state, action, landscape = false) {
    if (process.env.QA_CASES && !process.env.QA_CASES.split(',').includes(id))
      return;
    if (
      !process.env.QA_RERUN &&
      results.cases.some((c) => c.id === id && c.harnessPass)
    )
      return;
    const viewport = landscape
      ? { width: 844, height: 390 }
      : { width: 390, height: 844 };
    const context = await browser.newContext({
      viewport,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
    });
    await context.addInitScript(() => {
      localStorage.setItem('bk_api_token', 'synthetic-299-local-only');
      window.__qa299 = { pop: [], touch: [] };
      addEventListener(
        'popstate',
        (e) =>
          window.__qa299.pop.push({
            at: performance.now(),
            url: location.href,
            state: e.state,
          }),
        true,
      );
      for (const type of [
        'pointerdown',
        'pointermove',
        'pointerup',
        'pointercancel',
        'touchstart',
        'touchmove',
        'touchend',
      ])
        document.addEventListener(
          type,
          (e) =>
            window.__qa299.touch.push({
              type,
              pointerType: e.pointerType,
              x: e.clientX,
              y: e.clientY,
            }),
          true,
        );
    });
    context.setDefaultTimeout(10000);
    context.setDefaultNavigationTimeout(10000);
    const p = await context.newPage(),
      cd = await context.newCDPSession(p),
      errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    const network = [];
    p.on('requestfailed', (r) =>
      network.push({ at: Date.now(), url: r.url(), failure: r.failure() }),
    );
    const before = await ctl('state');
    const rec = {
      id,
      state,
      action,
      viewport,
      syntheticTouch: true,
      before: before.snapshot,
      pageErrors: errors,
      networkFailures: network,
    };
    try {
      rec.open = await open(p, state);
      rec.openText = await p.locator('body').innerText();
      rec.history = await cd.send('Page.getNavigationHistory');
      const idx = rec.open.historyState.idx;
      if (action === 'touch-handle' || action === 'touch-content')
        rec.drag = await drag(
          p,
          cd,
          action === 'touch-handle' ? 'handle' : 'content',
        );
      else if (action === 'double-close')
        await p
          .getByRole('button', { name: 'Close', exact: true })
          .dblclick({ force: true });
      else if (action === 'none') await pause(650);
      else await browserBack(p, action);
      await pause(100);
      rec.afterAction = await snap(p);
      await consistent(p, idx);
      if (
        action === 'touch-content' &&
        rec.afterAction.questions === 0 &&
        rec.afterAction.drawers === 1
      ) {
        rec.verdict =
          'UNVERIFIED: scrolling consumed the emulated gesture; drawer guard was not exercised';
      } else if (state === 'clean') {
        assert.equal(rec.afterAction.drawers, 0);
        if (rec.drag)
          assert.ok(
            rec.afterAction.events.touch.some((e) => e.pointerType === 'touch'),
            'CDP touch must have reached the page',
          );
        rec.verdict =
          'PASS: bounded clean dismissal and route/history consistency';
        await browserBack(p);
        assert.equal(new URL(p.url()).pathname, '/settings');
        assert.equal((await snap(p)).heading, 'Settings');
      } else if (state === 'dirty') {
        if (action === '100ms') {
          assert.equal(rec.afterAction.questions, 0);
          assert.equal(rec.afterAction.drawers, 1);
          await p.getByRole('button', { name: 'Close', exact: true }).click();
          await pause(200);
        }
        assert.equal((await snap(p)).questions, 1);
        assert.equal(rec.afterAction.gross, '12.34');
        assert.equal(rec.afterAction.scroll.top, rec.open.scroll.top);
        await p.screenshot({
          path: path.join(out, `${id}-question.png`),
          fullPage: true,
        });
        if (action === 'browser') {
          await browserBack(p);
          assert.equal((await snap(p)).questions, 0);
          assert.equal((await snap(p)).drawers, 1);
          await consistent(p, idx);
          await browserBack(p);
          assert.equal((await snap(p)).questions, 1);
        }
        await p
          .getByRole('button', { name: 'Keep editing', exact: true })
          .click();
        await pause(150);
        assert.equal((await snap(p)).gross, '12.34');
        await consistent(p, idx);
        await p.getByRole('button', { name: 'Close', exact: true }).click();
        await p.getByRole('button', { name: 'Discard', exact: true }).click();
        await pause(500);
        assert.equal((await snap(p)).drawers, 0);
        await consistent(p, idx);
        await browserBack(p);
        assert.equal(new URL(p.url()).pathname, '/settings');
        rec.verdict =
          'PASS: dirty dismissal veto, one question, retained values/scroll and explicit discard';
      } else if (
        network.some(
          (n) =>
            n.url.endsWith('/api/expenses') &&
            n.failure?.errorText === 'net::ERR_ABORTED',
        )
      ) {
        assert.equal(rec.afterAction.drawers, 1);
        assert.ok(rec.afterAction.questions <= 1);
        assert.equal(rec.afterAction.gross, '45.67');
        if (rec.afterAction.questions === 1)
          await p
            .getByRole('button', { name: 'Keep editing', exact: true })
            .click();
        rec.pendingText = await p.locator('body').innerText();
        assert.ok(rec.pendingText.includes('Creation was not confirmed'));
        assert.equal(
          await p.getByLabel('Gross (€)', { exact: true }).isDisabled(),
          true,
        );
        await p.screenshot({
          path: path.join(out, `${id}-unconfirmed.png`),
          fullPage: true,
        });
        await ctl('release', {});
        await p.getByRole('button', { name: /^Create expense/ }).click();
        await p.waitForURL(/\/books\/expenses\/\d+$/);
        await p.locator('main h1').filter({ hasText: 'Expense' }).waitFor();
        rec.retryAfterAbort = true;
        rec.verdict =
          'PASS: unknown-outcome contract retains form/key/facts; explicit retry recovers exactly one Expense; browser transport survival remains a limitation';
      } else {
        assert.equal(rec.afterAction.questions, 0);
        assert.equal(rec.afterAction.drawers, 1);
        assert.equal(rec.afterAction.gross, '45.67');
        assert.equal(rec.afterAction.scroll.top, rec.open.scroll.top);
        assert.ok(Math.abs(rec.afterAction.transform) < 1);
        assert.equal(
          await p
            .getByRole('button', { name: 'Close', exact: true })
            .isDisabled(),
          true,
        );
        assert.equal(
          (await ctl('state')).snapshot.expense.length,
          before.snapshot.expense.length + 1,
        );
        rec.pendingText = await p.locator('body').innerText();
        await p.screenshot({
          path: path.join(out, `${id}-pending.png`),
          fullPage: true,
        });
        await ctl('release', {});
        await p.waitForURL(/\/books\/expenses\/\d+$/);
        await p.locator('main h1').filter({ hasText: 'Expense' }).waitFor();
        const target = p.url();
        await pause(400);
        assert.equal(p.url(), target);
        rec.verdict =
          'PASS: pending dismissal refused; one actual create; original completion navigates once';
      }
      assert.equal(errors.length, 0);
      rec.harnessPass = true;
    } catch (e) {
      rec.harnessPass = false;
      rec.verdict = 'FAIL: browser/driver assertion';
      rec.error = e.stack;
      console.error(id, e);
    }
    await ctl('release', {});
    rec.final = await snap(p);
    rec.uiText = await p.locator('body').innerText();
    await p
      .screenshot({ path: path.join(out, `${id}.png`), fullPage: true })
      .catch(() => {});
    const after = await ctl('state');
    rec.after = after.snapshot;
    rec.events = after.events.slice(before.events.length);
    const creates = rec.events.filter(
      (e) =>
        e.event === 'server-response' &&
        e.method === 'POST' &&
        e.url === '/api/expenses',
    );
    rec.createRequests = creates.length;
    if (rec.harnessPass) {
      assert.equal(
        creates.length,
        state === 'pending' ? (rec.retryAfterAbort ? 2 : 1) : 0,
      );
      if (rec.retryAfterAbort)
        assert.equal(creates[0].operationKey, creates[1].operationKey);
      assert.equal(
        after.snapshot.expense.length - before.snapshot.expense.length,
        state === 'pending' ? 1 : 0,
      );
    }
    results.cases.push(rec);
    fs.writeFileSync(file, JSON.stringify(results, null, 2) + '\n');
    console.log(id, rec.verdict);
    await context.close();
  }
  await run('H1-clean-browser-back', 'clean', 'browser');
  await run('H2-dirty-browser-back', 'dirty', 'browser');
  await run('H3-dirty-same-task-double-back', 'dirty', 'same-task');
  await run('H4-pending-same-task-double-back', 'pending', 'same-task');
  await run('H8-pending-browser-back', 'pending', 'browser');
  await run('H9-pending-no-navigation-control', 'pending', 'none');
  await run('H5-clean-double-close', 'clean', 'double-close');
  await run('H6-dirty-double-close', 'dirty', 'double-close');
  await run('H7-dirty-100ms-double-back', 'dirty', '100ms');
  for (const landscape of [false, true])
    for (const state of ['clean', 'dirty', 'pending'])
      await run(
        `T-${landscape ? 'landscape' : 'portrait'}-${state}`,
        state,
        'touch-handle',
        landscape,
      );
  await run('C-landscape-clean-content', 'clean', 'touch-content', true);
  await run('C-landscape-dirty-content', 'dirty', 'touch-content', true);
  await browser.close();
  if (results.cases.some((c) => !c.harnessPass)) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
