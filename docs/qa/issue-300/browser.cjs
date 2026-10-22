// Real browser -> fault proxy -> real isolated accounting services. No page.route mocks.
const { chromium } = require(
  process.env.QA_PLAYWRIGHT_MODULE ||
    '/tmp/hbk-397-browser/node_modules/playwright',
);
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const out = path.resolve('docs/qa/issue-300');
const resultFile = process.env.QA_RESULTS || path.join(out, 'results.json');
const base = 'http://127.0.0.1:5300';
const control = async (name, body) => {
  const r = await fetch(
    `${base}/__qa/${name}`,
    body ? { method: 'POST', body: JSON.stringify(body) } : undefined,
  );
  return r.json();
};
const results = fs.existsSync(resultFile)
  ? JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  : {
      baseCommit: 'bc1cb5af1578ed3a2cf744e630c2342918b2b818',
      synthetic: true,
      cases: [],
    };
const counts = (s) =>
  Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.length]));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      '/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
  });
  results.browser = await browser.version();
  async function run(id, fn, mobile = false) {
    if (process.env.QA_CASES && !process.env.QA_CASES.split(',').includes(id))
      return;
    if (
      !process.env.QA_RERUN &&
      results.cases.some((c) => c.id === id && c.harnessPass)
    )
      return;
    const context = await browser.newContext({
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1440, height: 900 },
      isMobile: mobile,
      hasTouch: mobile,
      deviceScaleFactor: 1,
    });
    await context.addInitScript(() =>
      localStorage.setItem('bk_api_token', 'synthetic-300-local-only'),
    );
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on('request', (q) => {
      if (q.method() === 'POST' && q.url().includes('/api/'))
        requests.push({ method: q.method(), url: q.url() });
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await control('release', {});
    const before = await control('state');
    const rec = {
      id,
      viewport: mobile ? '390x844 emulated touch' : '1440x900 desktop',
      before: counts(before.snapshot),
      pageErrors: errors,
      requests,
    };
    try {
      await fn(page, context, rec);
      assert.equal(errors.length, 0);
      rec.harnessPass = true;
    } catch (e) {
      rec.harnessPass = false;
      rec.error = e.stack;
      console.error(id, e);
    }
    rec.url = page.url();
    rec.text = await page
      .locator('body')
      .innerText()
      .catch(() => '<unavailable>');
    await page
      .screenshot({ path: path.join(out, `${id}.png`), fullPage: true })
      .catch(() => {});
    const after = await control('state');
    rec.after = counts(after.snapshot);
    rec.events = after.events.slice(before.events.length);
    rec.records = {
      documents: after.snapshot.document,
      expenses: after.snapshot.expense,
      matches: after.snapshot.reconciliation_match,
      approvals: after.snapshot.approval,
    };
    results.cases.push(rec);
    fs.writeFileSync(resultFile, JSON.stringify(results, null, 2));
    await control('release', {});
    await context.close();
    console.log(
      `${id}: ${rec.harnessPass ? rec.verdict || 'PASS' : 'HARNESS FAIL'}`,
    );
  }
  async function createForm(page, gross) {
    await page.goto(`${base}/books?seg=expenses`);
    await page.getByRole('link', { name: 'Bank', exact: true }).click();
    await page.getByRole('link', { name: 'Books', exact: true }).click();
    await page
      .getByRole('button', { name: 'Add to the books', exact: true })
      .click();
    await page.getByRole('button', { name: /New expense/ }).click();
    await page.getByLabel('Category', { exact: true }).selectOption('software');
    await page.getByLabel('Gross (€)', { exact: true }).fill(gross);
    await page.getByLabel('VAT (€)', { exact: true }).fill('0');
    await page.getByLabel('Tax point date', { exact: true }).fill('2026-09-10');
  }
  async function resumeCheck(page, context, rec) {
    const before = await control('state');
    await context.setOffline(true);
    await pause(300);
    await context.setOffline(false);
    rec.visibility = await page.evaluate(() => ({
      state: document.visibilityState,
      hidden: document.hidden,
    }));
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await pause(500);
    const after = await control('state');
    rec.resumeWrites = after.events
      .slice(before.events.length)
      .filter((e) => e.event === 'server-response' && e.method === 'POST');
    assert.equal(rec.resumeWrites.length, 0);
  }
  await run('C1-create-before', async (p, c, r) => {
    await createForm(p, '41.01');
    await control('arm', { path: '^/api/expenses$', mode: 'before' });
    await p.getByRole('button', { name: /^Create expense/ }).click();
    await p
      .getByText(/not confirmed/i)
      .first()
      .waitFor();
    assert.equal(
      (await control('state')).snapshot.expense.length,
      r.before.expense,
    );
    await resumeCheck(p, c, r);
    await p.getByRole('button', { name: /^Create expense/ }).click();
    await p.waitForURL(/\/books\/expenses\/\d+$/);
    assert.equal(
      (await control('state')).snapshot.expense.length,
      r.before.expense + 1,
    );
  });
  await run(
    'C2-create-after',
    async (p, c, r) => {
      await createForm(p, '42.02');
      await control('arm', { path: '^/api/expenses$', mode: 'after' });
      await p.getByRole('button', { name: /^Create expense/ }).click();
      await p
        .getByText(/not confirmed/i)
        .first()
        .waitFor();
      assert.equal(
        (await control('state')).snapshot.expense.length,
        r.before.expense + 1,
      );
      await resumeCheck(p, c, r);
      r.afterFaultText = await p.locator('body').innerText();
      await p.getByRole('button', { name: /^Create expense/ }).click();
      await p.waitForURL(/\/books\/expenses\/\d+$/);
      r.explicitRetryAddedDraft =
        (await control('state')).snapshot.expense.length - r.before.expense;
      assert.equal(r.explicitRetryAddedDraft, 2);
    },
    true,
  );

  await run('C3-empty-response', async (p, c, r) => {
    await createForm(p, '43.03');
    await control('arm', { path: '^/api/expenses$', mode: 'empty-after' });
    await p.getByRole('button', { name: /^Create expense/ }).click();
    await pause(2500);
    const state = await control('state');
    r.draftsAfterOneClick = state.snapshot.expense.length - r.before.expense;
    r.verdict =
      r.draftsAfterOneClick > 1
        ? 'FAIL: duplicate draft after one submit'
        : 'PASS';
    r.currentURL = p.url();
    r.uiReportsSuccess = /\/books\/expenses\/\d+$/.test(p.url());
    assert.ok(r.draftsAfterOneClick >= 1);
    await resumeCheck(p, c, r);
  });
  await run('C4-held-navigation', async (p, c, r) => {
    await createForm(p, '44.04');
    await control('arm', { path: '^/api/expenses$', mode: 'hold-after' });
    await p.getByRole('button', { name: /^Create expense/ }).click();
    for (let i = 0; i < 40 && (await control('state')).held === 0; i++)
      await pause(100);
    assert.equal((await control('state')).held, 1);
    await p.keyboard.press('Escape');
    await p.evaluate(() => history.back());
    await pause(200);
    r.pendingText = await p.locator('body').innerText();
    assert.ok(p.url().includes('/books'));
    await resumeCheck(p, c, r);
    await control('release', {});
    await p.waitForURL(/\/books\/expenses\/\d+$/);
    assert.equal(
      (await control('state')).snapshot.expense.length,
      r.before.expense + 1,
    );
  });
  await run('C5-reload-unknown', async (p, c, r) => {
    await createForm(p, '45.05');
    await control('arm', { path: '^/api/expenses$', mode: 'hold-after' });
    await p.getByRole('button', { name: /^Create expense/ }).click();
    for (let i = 0; i < 40 && (await control('state')).held === 0; i++)
      await pause(100);
    assert.equal((await control('state')).held, 1);
    await p.reload();
    await control('release', {});
    await pause(500);
    assert.ok(p.url().includes('/books?'));
    assert.equal(
      (await control('state')).snapshot.expense.length,
      r.before.expense + 1,
    );
    r.afterReloadText = await p.locator('body').innerText();
    await resumeCheck(p, c, r);
  });
  async function uploadForm(p, id) {
    await p.goto(`${base}/books?seg=documents`);
    await p
      .getByRole('button', { name: 'Add to the books', exact: true })
      .click();
    await p.getByRole('button', { name: /Upload a document/ }).click();
    const pixel = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1WQAAAAASUVORK5CYII=',
      'base64',
    );
    await p.locator('input[type=file]').setInputFiles({
      name: `synthetic-${id}.png`,
      mimeType: 'image/png',
      buffer: Buffer.concat([pixel, Buffer.from(id)]),
    });
  }
  for (const [id, mode, stage] of [
    ['U1-upload-before', 'before', 'upload'],
    ['U2-upload-after', 'after', 'upload'],
    ['U3-triage-before', 'before', 'triage'],
    ['U4-triage-after', 'after', 'triage'],
  ]) {
    await run(
      id,
      async (p, c, r) => {
        await uploadForm(p, id);
        await control('arm', {
          path:
            stage === 'upload'
              ? '^/api/documents$'
              : '^/api/documents/\\d+/triage$',
          mode,
        });
        await p
          .getByRole('button', { name: 'Upload & process', exact: true })
          .click();
        await p
          .getByText(/not confirmed/i)
          .first()
          .waitFor();
        r.afterFault = (await control('state')).snapshot;
        r.afterFaultText = await p.locator('body').innerText();
        await resumeCheck(p, c, r);
        await p
          .getByRole('button', {
            name: stage === 'upload' ? 'Upload & process' : 'Retry processing',
            exact: true,
          })
          .click();
        await p.waitForURL(/\/books\/(expenses|documents)\/\d+$/);
        const state = await control('state');
        assert.equal(state.snapshot.document.length, r.before.document + 1);
        assert.equal(state.snapshot.expense.length, r.before.expense + 1);
      },
      id === 'U4-triage-after',
    );
  }
  async function bankForm(p, id) {
    await p.goto(`${base}/bank/statements/1/tx/${id}`);
    await p.getByLabel('Category', { exact: true }).selectOption('software');
    await p.getByLabel('VAT (EUR)', { exact: true }).fill('0');
  }
  // Local synthetic fixture configuration, never ledger writes. The first
  // upload matrix deliberately uses default approval-required policy.
  if (!process.cwd().endsWith('/issue-300'))
    throw Error('isolated fixture only');
  const db = new (require('better-sqlite3'))(
    path.join(process.cwd(), 'data/qa-300/app.sqlite'),
  );
  db.prepare(
    "INSERT INTO policy_config(key,value,updated_at) VALUES ('auto_post_enabled','true',?) ON CONFLICT(key) DO UPDATE SET value='true'",
  ).run(Math.floor(Date.now() / 1000));
  const account = db
    .prepare("SELECT id FROM account WHERE code='BANK_EUR'")
    .get().id;
  db.prepare(
    "INSERT OR IGNORE INTO bank_transaction(id,statement_id,account_id,transaction_date,description,reference,amount,currency,status,created_at) VALUES (9,1,?,'2026-09-10','SYNTHETIC network QA line 9','QA300-9',-12900,'EUR','open',?)",
  ).run(account, Math.floor(Date.now() / 1000));
  db.close();
  for (const [id, line, mode, stage] of [
    ['B1-create-before', 5, 'before', 'create'],
    ['B2-post-after', 6, 'after', 'post'],
    ['B3-match-after', 7, 'after', 'match'],
    ['B4-approve-after', 8, 'after', 'approve'],
    ['B5-match-before', 9, 'before', 'match'],
  ]) {
    await run(
      id,
      async (p, c, r) => {
        await bankForm(p, line);
        const match = {
          create: '^/api/expenses$',
          post: '^/api/expenses/\\d+/post$',
          match: '^/api/bank-statements/1/match$',
          approve: '^/api/approvals/\\d+/approve$',
        };
        await control('arm', { path: match[stage], mode });
        await p.getByRole('button', { name: /^Create & match/ }).click();
        await pause(1200);
        r.afterFaultText = await p.locator('body').innerText();
        r.afterFault = (await control('state')).snapshot;
        await resumeCheck(p, c, r);
        if (stage === 'create') {
          await p.getByRole('button', { name: /^Create & match/ }).click();
          await pause(1000);
        } else if (stage === 'post') {
          await p.reload();
          await pause(500);
        } else if (stage === 'match') {
          if (mode === 'after') {
            await p.getByRole('button', { name: /Confirm match/ }).click();
          } else {
            await p.getByRole('checkbox').first().click();
            await p.getByRole('button', { name: /^Match [0-9]/ }).click();
          }
          await pause(700);
        }
        const state = await control('state');
        assert.equal(state.snapshot.expense.length, r.before.expense + 1);
        r.lineMatches = state.snapshot.reconciliation_match.filter(
          (m) => m.bank_transaction_id === line,
        );
        if (stage !== 'post') {
          assert.equal(r.lineMatches.length, 1);
          assert.equal(r.lineMatches[0].status, 'active');
        } else {
          assert.equal(r.lineMatches.length, 0);
        }
      },
      id === 'B4-approve-after',
    );
    if (stage === 'post') {
      await run('B2-recover-open-item', async (p, c, r) => {
        await p.goto(`${base}/bank/statements/1/tx/6`);
        await p.getByRole('checkbox').first().click();
        await p.getByRole('button', { name: /^Match [0-9]/ }).click();
        await pause(700);
        const state = await control('state');
        r.lineMatches = state.snapshot.reconciliation_match.filter(
          (m) => m.bank_transaction_id === 6,
        );
        assert.equal(r.lineMatches.length, 1);
        assert.equal(r.lineMatches[0].status, 'active');
        assert.equal(state.snapshot.expense.length, r.before.expense);
      });
    }
  }

  await run('C6-offline-before', async (p, c, r) => {
    await createForm(p, '46.06');
    const before = await control('state');
    await c.setOffline(true);
    await p.getByRole('button', { name: /^Create expense/ }).click();
    await p
      .getByText(/not confirmed/i)
      .first()
      .waitFor();
    assert.equal(
      (await control('state')).snapshot.expense.length,
      r.before.expense,
    );
    await c.setOffline(false);
    await pause(500);
    r.reconnectWrites = (await control('state')).events
      .slice(before.events.length)
      .filter((e) => e.method === 'POST');
    assert.equal(r.reconnectWrites.length, 0);
    await p.getByRole('button', { name: /^Create expense/ }).click();
    await p.waitForURL(/\/books\/expenses\/\d+$/);
    assert.equal(
      (await control('state')).snapshot.expense.length,
      r.before.expense + 1,
    );
  });
  await run('C7-bare-fetch-empty-response', async (p, c, r) => {
    await p.goto(`${base}/books`);
    await pause(300);
    await control('arm', { path: '^/api/expenses$', mode: 'empty-after' });
    r.singleFetchResult = await p.evaluate(async () => {
      try {
        const res = await fetch('/api/expenses', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: 'Bearer synthetic-300-local-only',
          },
          body: JSON.stringify({
            category: 'software',
            gross_amount: 4707,
            vat_amount: 0,
            currency: 'EUR',
            tax_point_date: '2026-09-10',
          }),
        });
        return { status: res.status, body: await res.json() };
      } catch (e) {
        return { error: e.message };
      }
    });
    r.draftsAfterOneFetch =
      (await control('state')).snapshot.expense.length - r.before.expense;
    r.verdict =
      r.draftsAfterOneFetch > 1
        ? 'FAIL: duplicate draft from browser transport retry'
        : 'PASS';
    assert.ok(r.draftsAfterOneFetch >= 1);
    if (process.env.QA_ASSERT_IDEMPOTENT === '1')
      assert.equal(
        r.draftsAfterOneFetch,
        1,
        'One fetch created duplicate draft expenses',
      );
  });
  await run('L1-lifecycle-probe', async (p, c, r) => {
    await p.goto(`${base}/books`);
    await p.evaluate(() => {
      window.__qaLife = { ticks: 0, events: [] };
      setInterval(() => window.__qaLife.ticks++, 100);
      for (const type of ['freeze', 'resume', 'visibilitychange'])
        document.addEventListener(type, () =>
          window.__qaLife.events.push({
            type,
            state: document.visibilityState,
          }),
        );
    });
    const cd = await c.newCDPSession(p);
    await cd.send('Page.setWebLifecycleState', { state: 'frozen' });
    await pause(900);
    await cd.send('Page.setWebLifecycleState', { state: 'active' });
    r.cdpProbe = await p.evaluate(() => ({
      ...window.__qaLife,
      state: document.visibilityState,
      hidden: document.hidden,
    }));
    const second = await c.newPage();
    await second.goto('about:blank');
    await second.bringToFront();
    await pause(300);
    r.secondTabProbe = await p.evaluate(() => ({
      state: document.visibilityState,
      hidden: document.hidden,
    }));
    await second.close();
    r.limitation =
      'CDP and headless tab probe only; never a physical mobile suspension';
  });
  await browser.close();
  fs.writeFileSync(resultFile, JSON.stringify(results, null, 2));
  if (results.cases.some((c) => !c.harnessPass)) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
