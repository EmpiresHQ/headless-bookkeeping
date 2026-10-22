// Real production SPA + isolated backend. GETs are real HTTP; UI writes are
// deliberately held and rejected by Playwright, never forwarded to backend.
const { chromium } = require('../../../.qa-tools/node_modules/playwright');
const fs = require('node:fs'),
  assert = require('node:assert/strict');
const base = 'http://127.0.0.1:5297',
  out = __dirname;
const results = {
  synthetic: true,
  node: process.version,
  started: new Date().toISOString(),
  cases: [],
};
const save = () =>
  fs.writeFileSync(
    out + '/' + (process.env.REPORT || 'results.json'),
    JSON.stringify(results, null, 2) + '\n',
  );
async function scale(root) {
  return root.evaluate((root) => {
    const es = [root, ...root.querySelectorAll('*')],
      before = es.map((e) => {
        const c = getComputedStyle(e);
        return { font: parseFloat(c.fontSize), line: c.lineHeight };
      });
    es.forEach((e, i) => {
      e.style.setProperty('font-size', before[i].font * 2 + 'px', 'important');
      if (before[i].line.endsWith('px'))
        e.style.setProperty(
          'line-height',
          parseFloat(before[i].line) * 2 + 'px',
          'important',
        );
    });
    return {
      kind: 'SYNTHETIC scoped computed font-size and px line-height x2; no transform, root/rem boxes unchanged',
      elements: es.length,
      rootFont: getComputedStyle(document.documentElement).fontSize,
      before: before[0].font,
      after: parseFloat(getComputedStyle(root).fontSize),
    };
  });
}
async function measure(root) {
  return root.evaluate((d) => {
    const rect = (e) => {
      const r = e.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        right: r.right,
        bottom: r.bottom,
      };
    };
    const boxes = [d, ...d.querySelectorAll('*')].filter(
      (e) =>
        e.clientWidth > 0 &&
        getComputedStyle(e).display !== 'inline' &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName),
    );
    const textNodes = [...d.querySelectorAll('button')];
    return {
      dialog: rect(d),
      scrollTop: d.scrollTop,
      scrollHeight: d.scrollHeight,
      clientHeight: d.clientHeight,
      overflowY: getComputedStyle(d).overflowY,
      fontSize: getComputedStyle(d).fontSize,
      documentOverflow: document.documentElement.scrollWidth > innerWidth,
      overflowElements: boxes
        .filter((e) => e.scrollWidth > e.clientWidth + 1)
        .map((e) => ({
          tag: e.tagName,
          text: e.textContent.slice(0, 100),
          clientWidth: e.clientWidth,
          scrollWidth: e.scrollWidth,
        })),
      buttons: textNodes.map((b) => {
        const r = rect(b),
          hit = document.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2);
        return {
          label: b.textContent.trim(),
          ...r,
          inView:
            r.x >= 0 &&
            r.y >= 0 &&
            r.right <= innerWidth &&
            r.bottom <= innerHeight,
          hit: !!hit && b.contains(hit),
          disabled: b.disabled,
          busy: b.getAttribute('aria-busy'),
          focused: document.activeElement === b,
          scrollWidth: b.scrollWidth,
          clientWidth: b.clientWidth,
        };
      }),
    };
  });
}
async function focusSnapshot(page) {
  return page.evaluate(() => {
    const e = document.activeElement,
      r = e.getBoundingClientRect();
    return {
      label: e.textContent.trim().slice(0, 80),
      role: e.tagName,
      top: r.top,
      bottom: r.bottom,
      inView: r.top >= 0 && r.bottom <= innerHeight,
      inside: !!e.closest('[role=alertdialog],[role=dialog]'),
    };
  });
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  results.browser = browser.version();
  try {
    for (const [width, height] of [
      [320, 568],
      [844, 390],
    ])
      for (const mode of ['normal', 'synthetic200']) {
        const cases = [
          ['expense-confirm', '/books/expenses/297', /^Delete draft/, 'Delete'],
          [
            'entity-long',
            '/settings/entities/1',
            /^Delete entity/,
            'Delete entity',
          ],
          [
            'entity-stress',
            '/settings/entities/2',
            /^Delete entity/,
            'Delete entity',
          ],
          [
            'entity-unbroken',
            '/settings/entities/3',
            /^Delete entity/,
            'Delete entity',
          ],
          ['create-expense', '/books', null, /^Create expense/],
          ['create-invoice', '/books', null, /^Create invoice/],
          ['expense-facts', '/books/expenses/297', null, null],
        ];
        for (const [name, path, trigger, label] of cases) {
          if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name))
            continue;
          const r = {
            name,
            width,
            height,
            mode,
            errors: [],
            httpErrors: [],
            interceptedWrites: [],
          };
          results.cases.push(r);
          const ctx = await browser.newContext({
            viewport: { width, height },
            isMobile: true,
            hasTouch: true,
            deviceScaleFactor: 1,
          });
          await ctx.addInitScript(() =>
            localStorage.setItem('bk_api_token', 'synthetic-297-only'),
          );
          const p = await ctx.newPage();
          p.setDefaultTimeout(12000);
          const held = [];
          p.on('pageerror', (e) => r.errors.push(e.message));
          p.on('response', (res) => {
            if (res.status() >= 400)
              r.httpErrors.push({
                url: new URL(res.url()).pathname,
                status: res.status(),
              });
          });
          await p.route(/\/(api|admin)\//, (route) => {
            const req = route.request();
            if (req.method() === 'GET') return route.continue();
            r.interceptedWrites.push({
              method: req.method(),
              path: new URL(req.url()).pathname,
              forwarded: false,
            });
            held.push(route);
          });
          try {
            await p.goto(base + path);
            await p.waitForLoadState('networkidle');
            let root;
            if (name === 'expense-facts') {
              root = p.locator('main');
              if (mode === 'synthetic200') r.textScale = await scale(root);
              r.geometry = await measure(root);
              const text = await root.innerText();
              assert(
                text.includes(
                  'SYNTHETIC-INVOICE-297-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-LONG-MEANINGFUL-SUFFIX',
                ),
              );
              assert(text.includes('9999999.99'));
              assert(text.includes('USD'));
              r.containsFullIdentifier = true;
              r.geometryNoHorizontalOverflow =
                !r.geometry.documentOverflow &&
                r.geometry.overflowElements.length === 0;
              await p.screenshot({
                path: out + `/${width}-${mode}-${name}.png`,
              });
              r.ok = r.geometryNoHorizontalOverflow;
              continue;
            }
            if (name.startsWith('create-')) {
              await p.getByRole('button', { name: 'Add to the books' }).click();
              await p
                .getByRole('button', {
                  name:
                    name === 'create-expense'
                      ? /^New expense/
                      : /^New sales invoice/,
                })
                .click();
              root = p.getByRole('dialog', {
                name:
                  name === 'create-expense'
                    ? 'New expense'
                    : 'New sales invoice',
                exact: true,
              });
              await root.waitFor();
              if (name === 'create-expense')
                await root
                  .getByRole('combobox', { name: /^Category/ })
                  .selectOption('software');
              else
                await root
                  .getByLabel('Invoice number', { exact: true })
                  .fill(
                    'SYNTHETIC-INVOICE-297-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-LONG-MEANINGFUL-SUFFIX',
                  );
              await root
                .getByLabel('Gross (€)', { exact: true })
                .fill('9999999.99');
              await root.getByLabel('VAT (€)', { exact: true }).fill('0');
              await root
                .getByLabel('Tax point date', { exact: true })
                .fill('2026-10-22');
            } else {
              await p.getByRole('button', { name: trigger }).click();
              root = p.getByRole('alertdialog');
              await root.waitFor();
            }
            if (mode === 'synthetic200') r.textScale = await scale(root);
            if (name === 'create-invoice') {
              const input = root.getByLabel('Invoice number', { exact: true });
              const snap = () =>
                input.evaluate((e) => ({
                  value: e.value,
                  clientWidth: e.clientWidth,
                  scrollWidth: e.scrollWidth,
                  scrollLeft: e.scrollLeft,
                  caret: e.selectionStart,
                }));
              await input.press('End');
              r.numberInputEnd = await snap();
              await input.press('Home');
              r.numberInputHome = await snap();
              assert.equal(r.numberInputEnd.value, r.numberInputHome.value);
              assert.equal(
                r.numberInputEnd.caret,
                r.numberInputEnd.value.length,
              );
              assert.equal(r.numberInputHome.caret, 0);
            }
            const button = root.getByRole('button', {
              name: label,
              exact: typeof label === 'string',
            });
            r.initial = await measure(root);
            // Real wheel reachability: move over dialog, not the scroll-locked backdrop.
            const box = await root.boundingBox();
            await p.mouse.move(
              box.x + box.width / 2,
              Math.min(height - 25, box.y + box.height / 2),
            );
            const wheels = [];
            for (let i = 0; i < 16; i++) {
              const rect = await button.boundingBox();
              if (rect && rect.y >= 0 && rect.y + rect.height <= height) break;
              await p.mouse.wheel(0, 300);
              await p.waitForTimeout(70);
              wheels.push(300);
            }
            r.wheelSteps = wheels.length;
            r.afterWheel = await measure(root);
            // Keyboard reachability, including focus-trap wrap on long confirms.
            const walk = [];
            for (let i = 0; i < (name.startsWith('create-') ? 14 : 4); i++) {
              await p.keyboard.press('Tab');
              await p.waitForTimeout(20);
              const a = await focusSnapshot(p);
              walk.push(a);
              if (
                name.startsWith('create-') &&
                a.label.startsWith(
                  name === 'create-expense'
                    ? 'Create expense'
                    : 'Create invoice',
                )
              )
                break;
            }
            r.keyboard = walk;
            if (!name.startsWith('create-')) {
              const cancel = root.getByRole('button', {
                name: 'Cancel',
                exact: true,
              });
              await cancel.click();
              await root.waitFor({ state: 'hidden' });
              r.pointerCancelClosed = true;
              r.focusReturned = await p
                .getByRole('button', { name: trigger })
                .evaluate((e) => e === document.activeElement);
              await p.getByRole('button', { name: trigger }).click();
              root = p.getByRole('alertdialog');
              if (mode === 'synthetic200') await scale(root);
              // Initial Cancel is focused without scrolling; Tab brings Confirm into view.
              await p.keyboard.press('Tab');
              r.confirmFocused = await button.evaluate(
                (e) => e === document.activeElement,
              );
            } else {
              await button.focus();
            }
            const before = await measure(root);
            const beforeButton = before.buttons.find((b) =>
              typeof label === 'string'
                ? b.label === label
                : label.test(b.label),
            );
            r.beforeBusy = beforeButton;
            await p.keyboard.press('Enter');
            await p.waitForFunction(
              () => !!document.querySelector('[aria-busy=true]'),
            );
            await p.waitForTimeout(150);
            const busy = await measure(root);
            const busyButton = busy.buttons.find(
              (b) => b.label === beforeButton.label,
            );
            r.busy = busyButton;
            r.pendingStatus = await p.getByRole('status').allTextContents();
            r.busyGeometryStable =
              !!busyButton &&
              Math.abs(busyButton.w - beforeButton.w) < 0.1 &&
              Math.abs(busyButton.h - beforeButton.h) < 0.1 &&
              busyButton.disabled &&
              busyButton.busy === 'true';
            await p.screenshot({
              path: out + `/${width}-${mode}-${name}-busy.png`,
            });
            for (const h of held.splice(0))
              await h.fulfill({
                status: 409,
                contentType: 'application/json',
                body: JSON.stringify({
                  message: 'SYNTHETIC QA: write rejected, never forwarded',
                }),
              });
            await p.waitForFunction(
              () => !document.querySelector('[aria-busy=true]'),
            );
            const targetGeometry = r.afterWheel.buttons.find((b) =>
              typeof label === 'string'
                ? b.label === label
                : label.test(b.label),
            );
            r.pointerReachable = targetGeometry?.inView && targetGeometry?.hit;
            r.keyboardReachable = name.startsWith('create-')
              ? walk.some(
                  (a) =>
                    a.label.startsWith(
                      name === 'create-expense'
                        ? 'Create expense'
                        : 'Create invoice',
                    ) && a.inView,
                )
              : walk.some((a) => a.label === 'Cancel' && a.inView) &&
                walk.some((a) => a.label === label && a.inView);
            r.ok =
              !!r.pointerReachable &&
              r.keyboardReachable &&
              r.busyGeometryStable &&
              !r.afterWheel.documentOverflow &&
              r.afterWheel.overflowElements.length === 0;
          } catch (e) {
            r.ok = false;
            r.failure = e.stack;
            await p
              .screenshot({
                path: out + `/${width}-${mode}-${name}-failure.png`,
              })
              .catch(() => {});
          } finally {
            for (const h of held) await h.abort().catch(() => {});
            await ctx.close();
            save();
            console.log(width, mode, name, r.ok);
          }
        }
      }
    // Native control: measure actual text before/after the CDP OS text-scale request.
    if (!process.env.ONLY)
      for (const [width, height] of [
        [320, 568],
        [844, 390],
      ]) {
        const ctx = await browser.newContext({
          viewport: { width, height },
          isMobile: true,
          hasTouch: true,
        });
        await ctx.addInitScript(() =>
          localStorage.setItem('bk_api_token', 'synthetic-297-only'),
        );
        const p = await ctx.newPage();
        await p.goto(base + '/settings/entities/1');
        await p.getByRole('button', { name: /^Delete entity/ }).click();
        const probe = () =>
          p.getByRole('alertdialog').evaluate((d) => {
            const t = d.querySelector('h2'),
              desc = document.getElementById(
                d.getAttribute('aria-describedby'),
              );
            const f = (e) => {
              const r = document.createRange();
              r.selectNodeContents(e);
              const b = r.getBoundingClientRect();
              return {
                font: getComputedStyle(e).fontSize,
                lineHeight: getComputedStyle(e).lineHeight,
                rangeWidth: b.width,
                rangeHeight: b.height,
              };
            };
            return {
              title: f(t),
              body: f(desc),
              rootFont: getComputedStyle(document.documentElement).fontSize,
              visualScale: visualViewport.scale,
            };
          });
        const before = await probe();
        const cdp = await ctx.newCDPSession(p);
        let command;
        try {
          await cdp.send('Emulation.setEmulatedOSTextScale', { scale: 2 });
          command = 'accepted';
        } catch (e) {
          command = e.message;
        }
        const after = await probe();
        (results.nativeControl ??= []).push({
          width,
          height,
          command,
          before,
          after,
          measurableEffect: JSON.stringify(before) !== JSON.stringify(after),
        });
        await ctx.close();
        save();
      }
  } finally {
    await browser.close();
    save();
    if (results.cases.some((c) => !c.ok)) process.exitCode = 1;
  }
})().catch((e) => {
  results.fatal = e.stack;
  save();
  console.error(e);
  process.exitCode = 1;
});
