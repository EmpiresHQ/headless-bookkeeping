const { chromium } = require('../../../.qa-tools/node_modules/playwright'),
  fs = require('node:fs');
(async () => {
  const b = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const [width, height] of [
      [1440, 900],
      [1920, 1080],
    ]) {
      const c = await b.newContext({ viewport: { width, height } });
      await c.addInitScript(() => {
        localStorage.setItem('bk_api_token', 'synthetic-303-local-only');
        const push = history.pushState.bind(history);
        history.pushState = (...args) => {
          const e = document.activeElement;
          window.__qaLeave = e?.matches('[data-position-row]')
            ? {
                href: e.getAttribute('href'),
                top: e.getBoundingClientRect().top,
                y: scrollY,
              }
            : null;
          return push(...args);
        };
      });
      const p = await c.newPage();
      await p.goto('http://127.0.0.1:5303/inbox');
      await p.waitForFunction(
        () =>
          document.querySelectorAll('main a[data-position-row]').length ===
          1000,
      );
      for (const index of [5, 500, 990]) {
        const row = p.locator('main a[data-position-row]').nth(index - 1);
        await row.scrollIntoViewIfNeeded();
        const href = await row.getAttribute('href'),
          before = (await row.boundingBox()).y;
        const t = performance.now();
        await row.click();
        await p.waitForURL(/\/inbox\/(doc|approval)\/\d+/);
        const leave = await p.evaluate(() => window.__qaLeave);
        await p.getByRole('button', { name: /Back/ }).waitFor();
        const opened = performance.now();
        await p.goBack();
        await p.waitForFunction(
          () =>
            document.querySelectorAll('main a[data-position-row]').length ===
            1000,
        );
        await p.waitForFunction(
          (href) => document.activeElement?.getAttribute('href') === href,
          href,
        );
        await p.waitForTimeout(250);
        const after = await p
          .locator(`main a[data-position-row][href="${href}"]`)
          .boundingBox();
        results.push({
          width,
          height,
          index,
          href,
          before,
          leave,
          after: after.y,
          deltaFromBefore: after.y - before,
          deltaFromLeave: leave ? after.y - leave.top : null,
          openMs: Math.round(opened - t),
          returnMsIncluding250msSettle: Math.round(performance.now() - opened),
        });
      }
      await c.close();
    }
  } finally {
    await b.close();
    fs.writeFileSync(
      __dirname + '/inbox-return-results.json',
      JSON.stringify(results, null, 2),
    );
    console.log(results);
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
