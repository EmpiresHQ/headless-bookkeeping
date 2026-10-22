const { chromium } = require('../../../.qa-tools/node_modules/playwright');
const fs = require('node:fs');
(async () => {
  const b = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const [width, height] of [
      [1440, 900],
      [1920, 1080],
    ]) {
      const c = await b.newContext({ viewport: { width, height } });
      await c.addInitScript(() =>
        localStorage.setItem('bk_api_token', 'synthetic-303-local-only'),
      );
      const p = await c.newPage();
      p.setDefaultTimeout(15000);
      await p.goto('http://127.0.0.1:5303/bank/statements/3');
      await p.waitForFunction(
        () => document.querySelectorAll('[role=checkbox]').length === 45,
      );
      const checkbox = p.getByRole('checkbox').first();
      const label = await checkbox.getAttribute('aria-label');
      await checkbox.click();
      await p.waitForFunction(
        (label) =>
          document
            .querySelector(`[aria-label="${label}"]`)
            ?.getAttribute('aria-checked') === 'true',
        label,
      );
      await p.screenshot({
        path: __dirname + `/${width}-selection-before.png`,
      });
      const row = checkbox.locator('..').locator('[data-position-row]');
      const key = await row.getAttribute('data-position-row');
      await row.click();
      await p.waitForURL(/\/tx\/\d+/);
      await p.getByRole('button', { name: /Back/ }).click();
      await p.waitForFunction(
        () => document.querySelectorAll('[role=checkbox]').length === 45,
      );
      const restored = p
        .locator(`[data-position-row="${key}"]`)
        .locator('..')
        .getByRole('checkbox');
      const selected = await restored.getAttribute('aria-checked');
      await p.screenshot({ path: __dirname + `/${width}-selection-after.png` });
      results.push({
        width,
        height,
        label,
        before: 'true',
        after: selected,
        retained: selected === 'true',
        url: p.url(),
      });
      await c.close();
    }
  } finally {
    await b.close();
    fs.writeFileSync(
      __dirname + '/selection-results.json',
      JSON.stringify(results, null, 2),
    );
    console.log(results);
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
