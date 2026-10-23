// SYNTHETIC real Nest/SQLite HTTP regression; no page.route mocks.
const { chromium } = require(
  process.env.QA_PLAYWRIGHT_MODULE ||
    '/tmp/hbk-397-browser/node_modules/playwright',
);
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const base = 'http://127.0.0.1:5420',
  out = 'docs/qa/issue-420';
if (!process.cwd().endsWith('/issue-420'))
  throw Error('isolated issue-420 required');
const control = async (name, body) =>
  (
    await fetch(
      `${base}/__qa/${name}`,
      body ? { method: 'POST', body: JSON.stringify(body) } : undefined,
    )
  ).json();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const results = fs.existsSync(path.join(out, 'results.json'))
  ? JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'))
  : {
      base: 'eb92556f578f410ad5eed4be0a79d879e6a0b164',
      synthetic: true,
      cases: [],
    };
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      '/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
  });
  results.browser = await browser.version();
  let priorNewKey;
  async function run(id, kind, mode, line) {
    if (results.cases.some((c) => c.id === id && c.verdict === 'PASS')) return;
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    await context.addInitScript(() =>
      localStorage.setItem('bk_api_token', 'synthetic-420-local-only'),
    );
    const p = await context.newPage(),
      errors = [],
      requests = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('request', (q) => {
      if (q.method() === 'POST' && q.url().endsWith('/api/expenses'))
        requests.push({
          key: q.headers()['idempotency-key'],
          body: q.postData(),
        });
    });
    const before = await control('state');
    const rec = {
      buildIndexSha256: require('node:crypto')
        .createHash('sha256')
        .update(fs.readFileSync('packages/web/dist/index.html'))
        .digest('hex'),
      id,
      kind,
      mode,
      viewport: '1440x900 desktop',
      browserRequests: requests,
      before: before.snapshot,
    };
    try {
      if (kind === 'new') {
        await p.goto(`${base}/books?seg=expenses`);
        await p
          .getByRole('button', { name: 'Add to the books', exact: true })
          .click();
        await p.getByRole('button', { name: /New expense/ }).click();
        await p
          .getByLabel('Category', { exact: true })
          .selectOption('software');
        await p.getByLabel('Gross (€)', { exact: true }).fill('43.03');
        await p.getByLabel('VAT (€)', { exact: true }).fill('0');
        await p
          .getByLabel('Tax point date', { exact: true })
          .fill('2026-09-10');
      } else {
        await p.goto(`${base}/bank/statements/1/tx/${line}`);
        await p
          .getByLabel('Category', { exact: true })
          .selectOption('software');
        await p.getByLabel('VAT (EUR)', { exact: true }).fill('0');
      }
      await control('arm', { path: '^/api/expenses$', mode });
      const submit = p.getByRole('button', {
        name: kind === 'new' ? /^Create expense/ : /^Create & match/,
      });
      await submit.click();
      if (mode === 'after') {
        await p
          .getByText(/Creation was not confirmed. Retry/)
          .first()
          .waitFor();
        rec.unknownText = await p.locator('body').innerText();
        assert.equal(
          await p
            .getByLabel(kind === 'new' ? 'Gross (€)' : 'Category', {
              exact: true,
            })
            .isDisabled(),
          true,
        );
        const unknown = await control('state');
        assert.equal(
          unknown.snapshot.expense.length,
          before.snapshot.expense.length + 1,
        );
        assert.equal(
          unknown.snapshot.voucher.length,
          before.snapshot.voucher.length,
        );
        await p.screenshot({
          path: path.join(out, `${id}-unknown.png`),
          fullPage: true,
        });
        await submit.click();
      }
      if (kind === 'new') await p.waitForURL(/\/books\/expenses\/\d+$/);
      else {
        await p.waitForURL(/\/bank\/statements\/1$/);
        await p.goto(`${base}/bank/statements/1/tx/${line}`);
        await p.getByText('Matched', { exact: true }).first().waitFor();
      }
      await pause(150);
      const after = await control('state');
      const events = after.events.slice(before.events.length),
        creates = events.filter(
          (e) =>
            e.method === 'POST' &&
            e.url === '/api/expenses' &&
            e.event === 'server-response',
        );
      assert.equal(
        after.snapshot.expense.length,
        before.snapshot.expense.length + 1,
      );
      assert.equal(
        after.snapshot.expense_create_operation.length,
        before.snapshot.expense_create_operation.length + 1,
      );
      assert.equal(creates.length, 2);
      assert.ok(creates[0].operationKey);
      assert.equal(creates[0].operationKey, creates[1].operationKey);
      assert.deepEqual(
        JSON.parse(creates[0].body),
        JSON.parse(creates[1].body),
      );
      assert.equal(requests.length, mode === 'empty-after' ? 1 : 2);
      for (const q of requests) assert.equal(q.key, creates[0].operationKey);
      if (kind === 'new') {
        assert.equal(
          after.snapshot.voucher.length,
          before.snapshot.voucher.length,
        );
        if (priorNewKey) assert.notEqual(priorNewKey, creates[0].operationKey);
        priorNewKey = creates[0].operationKey;
      } else {
        const matches = after.snapshot.reconciliation_match.filter(
          (m) => m.bank_transaction_id === line,
        );
        assert.equal(matches.length, 1);
        assert.equal(matches[0].status, 'active');
        assert.equal(
          events.filter(
            (e) => e.method === 'POST' && /\/expenses\/\d+\/post$/.test(e.url),
          ).length,
          1,
        );
        assert.equal(
          after.snapshot.voucher.length,
          before.snapshot.voucher.length + 2,
        ); // purchase + settlement
      }
      assert.equal(errors.length, 0);
      rec.verdict = 'PASS';
      rec.after = after.snapshot;
      rec.events = events;
      rec.createResponses = creates;
      rec.uiText = await p.locator('body').innerText();
      await p.screenshot({ path: path.join(out, `${id}.png`), fullPage: true });
    } catch (e) {
      rec.verdict = 'FAIL';
      rec.error = e.stack;
      rec.uiText = await p.locator('body').innerText();
      console.error(id, e);
      await p.screenshot({
        path: path.join(out, `${id}-failure.png`),
        fullPage: true,
      });
    }
    rec.pageErrors = errors;
    results.cases.push(rec);
    fs.writeFileSync(
      path.join(out, 'results.json'),
      JSON.stringify(results, null, 2) + '\n',
    );
    await context.close();
    console.log(id, rec.verdict);
  }
  await run('N1-empty-response', 'new', 'empty-after');
  await run('N2-explicit-retry', 'new', 'after');
  await run('B1-empty-response', 'bank', 'empty-after', 5);
  await run('B2-explicit-retry', 'bank', 'after', 6);
  await browser.close();
  if (results.cases.some((c) => c.verdict !== 'PASS')) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
