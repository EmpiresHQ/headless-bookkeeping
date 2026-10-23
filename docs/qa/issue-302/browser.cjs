// Bounded keyboard + Chromium AX QA; no native screen-reader speech claim.
const { chromium } = require('../../../.qa-tools/node_modules/playwright');
const fs = require('node:fs'),
  assert = require('node:assert/strict');
const f = require('./fixtures.json'),
  out = __dirname,
  base = 'http://127.0.0.1:5302';
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
async function active(page, root) {
  return page.evaluate((sel) => {
    const e = document.activeElement,
      r = e.getBoundingClientRect(),
      d = sel ? document.querySelector(sel) : null;
    return {
      tag: e.tagName,
      role: e.getAttribute('role'),
      text: (e.textContent || '').trim().slice(0, 110),
      ariaLabel: e.getAttribute('aria-label'),
      inside: d ? d.contains(e) : null,
      focusVisible: e.matches(':focus-visible'),
      tabIndex: e.tabIndex,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    };
  }, root);
}
async function walk(page, selector, n = 16) {
  const samples = [];
  for (const key of [...Array(n).fill('Tab'), ...Array(n).fill('Shift+Tab')]) {
    await page.keyboard.press(key);
    const a = await active(page, selector);
    samples.push({ key, ...a });
    assert(a.inside, 'focus escaped ' + selector + ' ' + JSON.stringify(a));
  }
  return samples;
}
async function focused(page, locator) {
  await page.waitForFunction(
    (el) => document.activeElement === el,
    await locator.elementHandle(),
  );
}
async function keyOpen(page, trigger) {
  await trigger.focus();
  await page.keyboard.press('Enter');
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  results.browser = browser.version();
  try {
    for (const [width, height] of [
      [320, 844],
      [390, 844],
      [1280, 844],
    ]) {
      if (process.env.WIDTH && Number(process.env.WIDTH) !== width) continue;
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
        isMobile: width < 1000,
        hasTouch: width < 1000,
      });
      await context.addInitScript(() =>
        localStorage.setItem('bk_api_token', 'synthetic-302-only'),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(16000);
      const cdp = await context.newCDPSession(page);
      const logs = { errors: [], writes: [], httpErrors: [] };
      page.on('pageerror', (e) => logs.errors.push(e.message));
      page.on('request', (r) => {
        if (
          r.method() !== 'GET' &&
          new URL(r.url()).pathname.startsWith('/api/')
        )
          logs.writes.push({
            method: r.method(),
            path: new URL(r.url()).pathname,
          });
      });
      page.on('response', (r) => {
        if (r.status() >= 400)
          logs.httpErrors.push({
            status: r.status(),
            path: new URL(r.url()).pathname,
          });
      });
      let caseName = '';
      const ax = async (label) => {
        const { nodes } = await cdp.send('Accessibility.getFullAXTree');
        const data = nodes
          .filter((n) => !n.ignored)
          .map((n) => ({
            id: n.nodeId,
            role: n.role?.value,
            name: n.name?.value,
            value: n.value?.value,
            description: n.description?.value,
            properties: Object.fromEntries(
              (n.properties || []).map((p) => [p.name, p.value?.value]),
            ),
            children: n.childIds,
          }));
        fs.writeFileSync(
          out +
            `/${width}-${caseName}-${label}${process.env.AX_TAG ? '-' + process.env.AX_TAG : ''}-ax.json`,
          JSON.stringify(data, null, 2) + '\n',
        );
        return data;
      };
      const run = async (name, fn) => {
        if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name))
          return;
        caseName = name;
        const r = { name, width, height };
        results.cases.push(r);
        const start = logs.writes.length;
        try {
          r.details = await fn();
          r.ok = true;
        } catch (e) {
          r.ok = false;
          r.error = e.stack;
          r.active = await active(page).catch(() => null);
          await page
            .screenshot({ path: out + `/${width}-${name}-failure.png` })
            .catch(() => {});
        } finally {
          r.writes = logs.writes.slice(start);
          r.pageErrors = [...logs.errors];
          save();
          console.log(width, name, r.ok);
        }
      };
      await run('search-radios', async () => {
        const checks = [];
        for (const [path, name] of [
          ['/books', 'Search expenses'],
          ['/inbox', 'Search the Inbox'],
          ['/bank/statements/1', 'Search this statement'],
        ]) {
          await page.goto(base + path);
          const search = page.getByRole('searchbox', { name, exact: true });
          await search.waitFor();
          await search.focus();
          await page.keyboard.type('SYNTHETIC', { delay: 30 });
          await page.waitForFunction(
            () => new URL(location.href).searchParams.get('q') === 'SYNTHETIC',
          );
          assert.equal(await search.getAttribute('aria-label'), name);
          const ring = await search.evaluate((e) => ({
            inputFocusVisible: e.matches(':focus-visible'),
            wrapperOutline: getComputedStyle(e.parentElement).outline,
            wrapperOutlineWidth: getComputedStyle(e.parentElement).outlineWidth,
          }));
          assert.equal(ring.wrapperOutlineWidth, '2px');
          const tree = await ax(
            path.startsWith('/bank')
              ? 'bank-search'
              : path.slice(1) + '-search',
          );
          assert(
            tree.some(
              (n) =>
                n.role === 'searchbox' &&
                n.name === name &&
                n.value === 'SYNTHETIC',
            ),
          );
          checks.push({
            path,
            name,
            ring,
            mainCount: await page.locator('main').count(),
          });
          await page.screenshot({
            path:
              out +
              `/${width}-${path.split('/')[1]}-search-focus${process.env.AX_TAG ? '-' + process.env.AX_TAG : ''}.png`,
          });
        }
        await page.goto(base + '/books');
        const group = page.getByRole('radiogroup', {
          name: 'Record type',
          exact: true,
        });
        const exp = group.getByRole('radio', { name: 'Expenses', exact: true });
        await exp.focus();
        await page.keyboard.press('ArrowRight');
        await focused(
          page,
          group.getByRole('radio', { name: 'Invoices', exact: true }),
        );
        assert(
          await group
            .getByRole('radio', { name: 'Invoices', exact: true })
            .isChecked(),
        );
        await page.keyboard.press('ArrowLeft');
        assert(await exp.isChecked());
        await page.keyboard.press('Tab');
        assert.equal(
          await page.locator(':focus').getAttribute('aria-label'),
          'Search expenses',
        );
        await page.keyboard.press('Shift+Tab');
        await focused(page, exp);
        const tree = await ax('record-type');
        assert(
          tree.some((n) => n.role === 'radiogroup' && n.name === 'Record type'),
        );
        assert.equal(
          tree.filter(
            (n) => n.role === 'radio' && n.properties.checked === 'true',
          ).length,
          1,
        );
        return {
          checks,
          nativeRadioLabels: await group
            .getByRole('radio')
            .evaluateAll((es) =>
              es.map((e) => e.parentElement.textContent.trim()),
            ),
          groupName: 'Record type',
          arrowAndTabBehavior: true,
        };
      });
      await run('edit-validation-pending-error', async () => {
        await page.goto(base + '/books/expenses/2');
        const trigger = page.getByRole('button', { name: /Edit draft/ });
        await keyOpen(page, trigger);
        const dialog = page.getByRole('dialog', {
          name: 'Edit draft expense',
          exact: true,
        });
        await dialog.waitFor();
        const initial = await active(page, '[role=dialog]');
        assert.equal(initial.ariaLabel, 'Close');
        const tree = await ax('open');
        assert(
          !tree.some(
            (n) => n.role === 'button' && /^Edit draft…$/.test(n.name),
          ),
        );
        const traversal = await walk(page, '[role=dialog]', 20);
        const gross = dialog.getByRole('textbox', {
          name: 'Gross (EUR)',
          exact: true,
        });
        const original = await gross.inputValue();
        await gross.fill('');
        assert.equal(await gross.getAttribute('aria-invalid'), 'true');
        const described = await gross.evaluate((e) =>
          (e.getAttribute('aria-describedby') || '')
            .split(' ')
            .map((id) => document.getElementById(id)?.textContent || '')
            .join(' '),
        );
        assert(described.length > 0);
        assert(
          await dialog
            .getByRole('button', { name: 'Save draft', exact: true })
            .isDisabled(),
        );
        await gross.fill(original);
        await dialog
          .getByRole('textbox', { name: 'Supplier invoice no.', exact: true })
          .fill(`SYN-302-EDIT-${width}`);
        const held = [];
        const url = base + '/api/expenses/2';
        await page.route(url, (route) =>
          route.request().method() === 'PATCH'
            ? held.push(route)
            : route.continue(),
        );
        const save = dialog.getByRole('button', {
          name: 'Save draft',
          exact: true,
        });
        await save.focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          () =>
            !!document.querySelector('[role=dialog] button[aria-busy=true]'),
        );
        const pending = await active(page, '[role=dialog]');
        assert(pending.inside);
        const pendingWalk = await walk(page, '[role=dialog]', 4);
        await ax('pending');
        const statuses = await page.getByRole('status').allTextContents();
        assert(statuses.some((s) => /Saving|Working/.test(s)));
        assert(await save.isDisabled());
        assert.equal(await save.getAttribute('aria-busy'), 'true');
        assert.equal(held.length, 1);
        await held.shift().fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            message:
              'SYNTHETIC302 Possible duplicate — injected refusal for accessibility QA',
          }),
        });
        const alert = dialog.getByRole('alert');
        await alert.waitFor();
        assert((await alert.innerText()).includes('Your changes are kept'));
        const errorAx = await ax('error');
        assert(errorAx.some((n) => n.role === 'alert'));
        const consent = dialog.getByRole('checkbox', {
          name: /This is a separate purchase/,
        });
        assert(!(await consent.isChecked()));
        await consent.focus();
        await page.keyboard.press('Space');
        assert(await consent.isChecked());
        const checkboxAx = await ax('consent');
        assert(
          checkboxAx.some(
            (n) => n.role === 'checkbox' && n.properties.checked === 'true',
          ),
        );
        await save.focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          () =>
            !!document.querySelector('[role=dialog] button[aria-busy=true]'),
        );
        assert.equal(held.length, 1);
        await held.shift().continue();
        await page.unroute(url);
        await dialog.waitFor({ state: 'hidden' });
        await focused(page, trigger);
        await page.screenshot({ path: out + `/${width}-edit-saved-focus.png` });
        return {
          initial,
          traversal,
          validationDescription: described,
          pending,
          pendingWalk,
          statuses,
          injectedError: 409,
          checkboxName: checkboxAx.find((n) => n.role === 'checkbox')?.name,
          errorRoleExposed: errorAx.some((n) => n.role === 'alert'),
          focusReturned: await trigger.evaluate(
            (e) => e === document.activeElement,
          ),
        };
      });
      await run('confirm-dialog', async () => {
        await page.goto(base + '/books/expenses/2');
        const trigger = page.getByRole('button', { name: /Delete draft/ });
        await keyOpen(page, trigger);
        const d = page.getByRole('alertdialog', {
          name: 'Delete this draft expense?',
          exact: true,
        });
        await d.waitFor();
        const initial = await active(page, '[role=alertdialog]');
        assert.equal(initial.text, 'Cancel');
        const tree = await ax('open');
        assert(
          tree.some(
            (n) =>
              n.role === 'alertdialog' &&
              n.name === 'Delete this draft expense?',
          ),
        );
        assert(
          !tree.some(
            (n) => n.role === 'button' && /Submit for posting/.test(n.name),
          ),
        );
        const traversal = await walk(page, '[role=alertdialog]', 8);
        await d.getByRole('button', { name: 'Cancel', exact: true }).focus();
        await page.keyboard.press('Enter');
        await d.waitFor({ state: 'hidden' });
        await focused(page, trigger);
        await keyOpen(page, trigger);
        await d.waitFor();
        const held = [];
        const url = base + '/api/expenses/2';
        await page.route(url, (route) =>
          route.request().method() === 'DELETE'
            ? held.push(route)
            : route.continue(),
        );
        await d.getByRole('button', { name: 'Delete', exact: true }).focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          () =>
            !!document.querySelector(
              '[role=alertdialog] button[aria-busy=true]',
            ),
        );
        const pending = await active(page, '[role=alertdialog]');
        assert(pending.inside);
        const pendingWalk = await walk(page, '[role=alertdialog]', 4);
        await ax('pending');
        assert.equal(held.length, 1);
        await held[0].fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'SYNTHETIC302 delete refused' }),
        });
        await page.unroute(url);
        await d.waitFor({ state: 'hidden' });
        await focused(page, trigger);
        await page.getByText(/SYNTHETIC302 delete refused/).waitFor();
        const errorAx = await ax('refusal');
        const live = await page.locator('[aria-live]').evaluateAll((es) =>
          es.map((e) => ({
            live: e.getAttribute('aria-live'),
            text: e.textContent.trim(),
          })),
        );
        assert(
          live.some((n) => n.text.includes('SYNTHETIC302 delete refused')),
        );
        return {
          initial,
          traversal,
          pending,
          pendingWalk,
          focusReturned: true,
          errorPresentInAx: errorAx.some((n) =>
            String(n.name).includes('SYNTHETIC302 delete refused'),
          ),
          live,
        };
      });
      await run('preview', async () => {
        await page.goto(base + '/inbox');
        const trigger = page.getByRole('button', {
          name: 'Open document preview',
          exact: true,
        });
        await trigger.waitFor();
        await keyOpen(page, trigger);
        const d = page.getByRole('dialog', {
          name: 'Document preview',
          exact: true,
        });
        await d.waitFor();
        await d
          .getByRole('img', { name: 'Document preview', exact: true })
          .waitFor();
        const initial = await active(page, '[role=dialog]');
        assert(initial.inside);
        const tree = await ax('open');
        assert(
          tree.some(
            (n) =>
              n.role === 'dialog' &&
              n.name === 'Document preview' &&
              n.properties.modal,
          ),
        );
        assert(!tree.some((n) => n.role === 'navigation'));
        const traversal = await walk(page, '[role=dialog]', 16);
        await page.screenshot({ path: out + `/${width}-preview-focus.png` });
        await d
          .getByRole('button', { name: 'Close preview', exact: true })
          .focus();
        await page.keyboard.press('Enter');
        await d.waitFor({ state: 'hidden' });
        await focused(page, trigger);
        return {
          initial,
          traversal,
          backgroundNavigationAbsentFromAx: true,
          focusReturned: true,
          backgroundScrollLock: await page.evaluate(
            () => getComputedStyle(document.body).overflow,
          ),
        };
      });
      await run('inbox-reject', async () => {
        await page.goto(base + '/inbox/approval/' + f.pendingApprovalId);
        const trigger = page.getByRole('button', {
          name: 'Reject…',
          exact: true,
        });
        await keyOpen(page, trigger);
        const d = page.getByRole('dialog');
        await d.waitFor();
        const initial = await active(page, '[role=dialog]');
        const traversal = await walk(page, '[role=dialog]', 8);
        const reason = d.getByRole('textbox', { name: 'Reason', exact: true });
        await reason.fill('SYNTHETIC302 keyboard QA reason');
        const submit = d.getByRole('button', { name: /Reject/ });
        const held = [];
        const url = base + `/api/approvals/${f.pendingApprovalId}/reject`;
        await page.route(url, (route) => held.push(route));
        await submit.focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          () =>
            !!document.querySelector('[role=dialog] button[aria-busy=true]'),
        );
        const pending = await active(page, '[role=dialog]');
        assert(pending.inside);
        const pendingWalk = await walk(page, '[role=dialog]', 4);
        await ax('pending');
        assert.equal(held.length, 1);
        await held[0].fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'SYNTHETIC302 reject refused' }),
        });
        await page.unroute(url);
        await page
          .getByText(/SYNTHETIC302 reject refused/)
          .first()
          .waitFor();
        assert.equal(
          await reason.inputValue(),
          'SYNTHETIC302 keyboard QA reason',
        );
        const tree = await ax('error');
        const errorInAx = tree.some((n) =>
          String(n.name).includes('SYNTHETIC302 reject refused'),
        );
        await page.screenshot({ path: out + `/${width}-reject-error.png` });
        await reason.fill('');
        await d.getByRole('button', { name: 'Close', exact: true }).focus();
        await page.keyboard.press('Enter');
        await d.waitFor({ state: 'hidden' });
        await focused(page, trigger);
        return {
          initial,
          traversal,
          pending,
          pendingWalk,
          errorTextExposedInAx: errorInAx,
          errorSpeechNotTested: true,
          focusReturned: true,
        };
      });
      await run('bank-checkbox-and-correction-radios', async () => {
        await page.goto(base + '/bank/statements/1');
        const checkbox = page.getByRole('checkbox').first();
        await checkbox.waitFor();
        const name = await checkbox.getAttribute('aria-label');
        const before = await checkbox.getAttribute('aria-checked');
        await checkbox.focus();
        await page.keyboard.press('Space');
        const after = await checkbox.getAttribute('aria-checked');
        assert.notEqual(after, before);
        const tree = await ax('bank-checkbox');
        assert(
          tree.some(
            (n) =>
              n.role === 'checkbox' &&
              n.name === name &&
              String(n.properties.checked) === after,
          ),
        );
        await page.keyboard.press('Space');
        assert.equal(await checkbox.getAttribute('aria-checked'), before);
        await page.goto(base + '/books/expenses/1');
        const trigger = page.getByRole('button', {
          name: 'Correct…',
          exact: true,
        });
        await keyOpen(page, trigger);
        const d = page.getByRole('dialog', { name: 'Correct', exact: true });
        await d.waitFor();
        const radios = d.getByRole('radio');
        assert.equal(await radios.count(), 3);
        await radios.nth(0).focus();
        const checked = [];
        for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp']) {
          await page.keyboard.press(key);
          checked.push(
            await radios.evaluateAll((es) => es.map((e) => e.checked)),
          );
        }
        assert.deepEqual(
          checked.map((v) => v.indexOf(true)),
          [1, 2, 1, 0],
        );
        const radioAx = await ax('correction');
        await d.getByRole('button', { name: 'Close', exact: true }).focus();
        await page.keyboard.press('Enter');
        await d.waitFor({ state: 'hidden' });
        await focused(page, trigger);
        return {
          checkboxName: name,
          before,
          after,
          checkedIndices: checked.map((v) => v.indexOf(true)),
          radioNames: radioAx
            .filter((n) => n.role === 'radio')
            .map((n) => n.name),
          groups: radioAx
            .filter((n) => n.role === 'group' || n.role === 'radiogroup')
            .map((n) => ({ role: n.role, name: n.name })),
          focusReturned: true,
        };
      });
      await run('route-changing-success-focus', async () => {
        await page.goto(base + '/books');
        await keyOpen(
          page,
          page.getByRole('button', { name: 'Add to the books', exact: true }),
        );
        await keyOpen(page, page.getByRole('button', { name: /^New expense/ }));
        const d = page.getByRole('dialog', {
          name: 'New expense',
          exact: true,
        });
        await d
          .getByRole('combobox', { name: /^Category/ })
          .selectOption('software');
        await d
          .getByRole('textbox', { name: 'Gross (€)', exact: true })
          .fill('45.67');
        await d
          .getByRole('textbox', { name: 'VAT (€)', exact: true })
          .fill('0');
        await d
          .getByLabel('Tax point date', { exact: true })
          .fill('2026-10-23');
        await d.getByRole('button', { name: /^Create expense/ }).focus();
        await page.keyboard.press('Enter');
        await page.waitForURL(/\/books\/expenses\/\d+$/);
        await page.waitForFunction(() =>
          document.activeElement?.matches('h1[data-screen-title]'),
        );
        const destination = await active(page);
        const tree = await ax('destination');
        assert.equal(await page.getByRole('dialog').count(), 0);
        assert(
          tree.some(
            (n) => n.role === 'heading' && String(n.name).startsWith('Expense'),
          ),
        );
        return {
          route: new URL(page.url()).pathname,
          openerRemoved:
            (await page
              .getByRole('button', { name: /^New expense/ })
              .count()) === 0,
          destination,
          logicalDestinationHeadingFocused: true,
        };
      });
      results['events' + width] = logs;
      await context.close();
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
