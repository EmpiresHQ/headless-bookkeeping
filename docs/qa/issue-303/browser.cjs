// Real Chromium + real backend. No route interception or response fixtures.
const { chromium } = require(
  process.env.PLAYWRIGHT_PATH || '../../../.qa-tools/node_modules/playwright',
);
const fs = require('node:fs'),
  assert = require('node:assert/strict');
const out = __dirname;
const base = 'http://127.0.0.1:5303';
const token = 'synthetic-303-local-only';
const result = {
  synthetic: true,
  started: new Date().toISOString(),
  node: process.version,
  viewports: [],
};
const save = () =>
  fs.writeFileSync(out + '/results.json', JSON.stringify(result, null, 2));
(async () => {
  const browser = await chromium.launch({ headless: true });
  result.browser = browser.version();
  try {
    for (const [width, height] of [
      [1440, 900],
      [1920, 1080],
    ]) {
      const r = {
        width,
        height,
        cases: [],
        pageErrors: [],
        httpErrors: [],
        requests: {},
      };
      result.viewports.push(r);
      const ctx = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
      });
      await ctx.addInitScript((t) => {
        if (location.origin === 'http://127.0.0.1:5303')
          localStorage.setItem('bk_api_token', t);
      }, token);
      const p = await ctx.newPage();
      p.setDefaultTimeout(30000);
      p.on('pageerror', (e) => r.pageErrors.push(e.message));
      p.on('response', (res) => {
        if (res.status() >= 400)
          r.httpErrors.push({
            url: res.url().replace(base, ''),
            status: res.status(),
          });
      });
      p.on('request', (req) => {
        const u = new URL(req.url());
        const k =
          req.method() +
          ' ' +
          (u.protocol === 'blob:'
            ? 'blob:preview'
            : u.pathname.replace(/\/\d+/g, '/:id'));
        r.requests[k] = (r.requests[k] || 0) + 1;
      });
      const test = async (name, fn) => {
        const start = performance.now();
        try {
          const detail = await fn();
          r.cases.push({
            name,
            ok: true,
            ms: Math.round(performance.now() - start),
            ...detail,
          });
        } catch (e) {
          r.cases.push({
            name,
            ok: false,
            ms: Math.round(performance.now() - start),
            error: e.message,
            diagnostic: await p
              .evaluate(() => ({
                url: location.href,
                scrollY,
                focused: document.activeElement?.outerHTML?.slice(0, 500),
                rows: document.querySelectorAll('[data-position-row]').length,
              }))
              .catch(() => null),
            iteration: r.activeIteration,
          });
          await p
            .screenshot({
              path: out + `/${width}-failure-${r.cases.length}.png`,
            })
            .catch(() => {});
        }
        save();
        console.log(width, name, r.cases.at(-1).ok);
      };
      const count = async (sel, n) => {
        await p.waitForFunction(
          ({ sel, n }) => document.querySelectorAll(sel).length === n,
          { sel, n },
        );
      };
      const goto = async (path, sel, n) => {
        await p.goto(base + path, { waitUntil: 'domcontentloaded' });
        await count(sel, n);
        await p.waitForLoadState('networkidle');
      };
      const expense = 'main a[href^="/books/expenses/"]',
        inbox = 'main a[data-position-row]',
        bank = 'main [data-position-row]';
      const geom = async (sel) =>
        p.locator(sel).evaluateAll((els) => ({
          rows: els.length,
          overflowRows: els.filter((e) => e.scrollWidth > e.clientWidth + 1)
            .length,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
          mainWidth: document.querySelector('main').getBoundingClientRect()
            .width,
        }));
      await test('Books cold complete list', async () => {
        await goto('/books', expense, 1200);
        await p.screenshot({ path: out + `/${width}-books.png` });
        return { geometry: await geom(expense) };
      });
      await test('Books search and fast typing', async () => {
        const q = 'SYNTHETIC-INVOICE-303-000617';
        await p.getByRole('searchbox').pressSequentially(q, { delay: 40 });
        await count(expense, 1);
        assert.equal(await p.getByRole('searchbox').inputValue(), q);
        assert.equal(new URL(p.url()).searchParams.get('q'), q);
        assert.match(await p.locator(expense).getAttribute('href'), /617$/);
        return { expected: 1, actual: 1, query: q, typingDelayMs: 40 };
      });
      await test('Books date range and largest ordering', async () => {
        await goto('/books', expense, 1200);
        await p.getByText('Dates & order', { exact: true }).click();
        await p.getByLabel('From', { exact: true }).fill('2026-01-01');
        await p.getByLabel('From', { exact: true }).blur();
        await p.waitForURL((u) => u.searchParams.get('from') === '2026-01-01');
        await count(expense, 600);
        await p.getByLabel('To', { exact: true }).fill('2026-12-31');
        await p.getByLabel('To', { exact: true }).blur();
        await p.waitForURL((u) => u.searchParams.get('to') === '2026-12-31');
        await p.getByRole('combobox').selectOption('largest');
        await p.waitForURL((u) => u.searchParams.get('sort') === 'largest');
        await p.waitForFunction(
          () =>
            document
              .querySelector('main a[href^="/books/expenses/"]')
              ?.getAttribute('href') === '/books/expenses/1198',
        );
        await count(expense, 600);
        const ids = await p
          .locator(expense)
          .evaluateAll((es) =>
            es.map((e) => Number(e.getAttribute('href').split('/').pop())),
          );
        assert.equal(ids.length, 600);
        assert(ids.every((id) => id % 2 === 0));
        const eur = ids.filter((id) => id % 20 !== 0),
          usd = ids.filter((id) => id % 20 === 0);
        assert.deepEqual(
          eur,
          [...eur].sort((a, b) => b - a),
        );
        assert.deepEqual(
          usd,
          [...usd].sort((a, b) => b - a),
        );
        return {
          expected: 600,
          actual: ids.length,
          url: p.url().replace(base, ''),
          currencyGroups: { EUR: eur.length, USD: usd.length },
          summary: (await p.locator('main').innerText()).slice(0, 1100),
        };
      });
      await test('Books status filter', async () => {
        await goto('/books', expense, 1200);
        await p.getByRole('button', { name: /^Draft \d+$/ }).click();
        await count(expense, 770);
        return { expected: 770, actual: await p.locator(expense).count() };
      });
      for (const [path, sel, n, ids] of [
        ['/books', expense, 1200, [5, 600, 1150, 5, 600]],
        ['/inbox', inbox, 1000, [5, 500, 990]],
        ['/bank/statements/3', bank, 1004, [5, 500, 990]],
      ]) {
        await test(path + ' deep open and return', async () => {
          await goto(path, sel, n);
          const values = [];
          for (const index of ids) {
            const row = p.locator(sel).nth(index - 1);
            await row.evaluate((e) =>
              e.scrollIntoView({ block: 'center', behavior: 'instant' }),
            );
            await p.evaluate(
              () =>
                new Promise((r) =>
                  requestAnimationFrame(() => requestAnimationFrame(r)),
                ),
            );
            const href = await row.getAttribute('href'),
              key = await row.getAttribute('data-position-row');
            const before = await row.boundingBox();
            r.activeIteration = { path, index, href, key, before };
            const url = p.url();
            let t = performance.now();
            await row.click();
            await p.waitForURL((u) => u.href !== url);
            await p.getByRole('button', { name: /Back/ }).first().waitFor();
            const openMs = Math.round(performance.now() - t);
            t = performance.now();
            await p.goBack();
            await count(sel, n);
            const target = href
              ? p.locator(`main a[href="${href}"][data-position-row]`).first()
              : p.locator(`[data-position-row="${key}"]`).first();
            await p.waitForFunction(
              ({ href, key, top }) => {
                const e = href
                  ? document.querySelector(
                      `main a[href="${href}"][data-position-row]`,
                    )
                  : document.querySelector(`[data-position-row="${key}"]`);
                return (
                  e &&
                  Math.abs(e.getBoundingClientRect().top - top) < 1 &&
                  document.activeElement === e
                );
              },
              { href, key, top: before.y },
            );
            const after = await target.boundingBox();
            assert.equal(p.url(), url);
            values.push({
              index,
              href,
              key,
              openMs,
              backMs: Math.round(performance.now() - t),
              deltaTop: after.y - before.y,
              focused: await target.evaluate(
                (e) => document.activeElement === e,
              ),
            });
          }
          delete r.activeIteration;
          return {
            iterations: values,
            actionsPerIteration: [
              'scroll target into view',
              'click row',
              'browser Back',
            ],
          };
        });
      }
      await test('Inbox search', async () => {
        await goto('/inbox', inbox, 1000);
        await p.getByRole('searchbox').fill('SYNTHETIC-517-');
        await count(inbox, 1);
        return { expected: 1, actual: 1 };
      });
      await test('Bank counts search selection', async () => {
        await goto('/bank/statements/3', bank, 1004);
        const text = await p.locator('main').innerText();
        await p.getByRole('searchbox').fill('SYNTHETIC-BANK-REF-000999');
        await count(bank, 1);
        const rowText = await p.locator(bank).innerText();
        assert.match(rowText, /999/);
        await p.screenshot({ path: out + `/${width}-bank-search.png` });
        await p.getByRole('searchbox').fill('');
        await count(bank, 1004);
        const checks = p.getByRole('checkbox');
        const checkCount = await checks.count();
        let selection = null;
        if (checkCount) {
          const chosen = await checks.evaluateAll(
            (es) =>
              es.filter((e) => e.getAttribute('aria-checked') === 'true')
                .length,
          );
          let t = performance.now();
          await checks.first().click();
          const after = await checks.evaluateAll(
            (es) =>
              es.filter((e) => e.getAttribute('aria-checked') === 'true')
                .length,
          );
          assert.equal(Math.abs(chosen - after), 1);
          selection = {
            chosen,
            after,
            toggleMs: Math.round(performance.now() - t),
          };
        }
        return {
          counts: text.slice(0, 450),
          proposalCheckboxes: checkCount,
          selection,
          searchMatches: 1,
        };
      });
      await test('Repeated sidebar navigation', async () => {
        const rounds = [];
        for (let i = 0; i < 3; i++) {
          const v = {};
          for (const [name, sel, n] of [
            ['Books', expense, 1200],
            ['Inbox', inbox, 1000],
            ['Bank', 'main a[href^="/bank/statements/"]', 24],
          ]) {
            const t = performance.now();
            await p
              .getByRole('navigation', { name: 'Primary' })
              .locator(`a[href="/${name.toLowerCase()}"]`)
              .click();
            await count(sel, n);
            v[name] = Math.round(performance.now() - t);
          }
          rounds.push(v);
        }
        return { rounds };
      });
      await ctx.close();
      save();
    }
  } finally {
    await browser.close();
    save();
  }
})().catch((e) => {
  result.fatal = e.stack;
  save();
  console.error(e);
  process.exitCode = 1;
});
