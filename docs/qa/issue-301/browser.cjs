// #301 real SPA and isolated real domain APIs. No mocked API responses.
const { chromium } = require('../../../.qa-tools/node_modules/playwright');
const jsQR = require('../../../.qa-tools/node_modules/jsqr');
const fs = require('node:fs'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict');
const fixtures = require('./fixtures.json'),
  out = __dirname,
  base = 'http://127.0.0.1:5301',
  token = 'synthetic-301-only';
const results = {
  synthetic: true,
  started: new Date().toISOString(),
  node: process.version,
  cases: [],
};
const save = () =>
  fs.writeFileSync(
    out + '/' + (process.env.REPORT || 'results.json'),
    JSON.stringify(results, null, 2) + '\n',
  );
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
async function api(path, method = 'GET', body, auth = token) {
  const r = await fetch(base + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + auth,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
async function stable(locator) {
  await locator.waitFor();
  let prev;
  for (let i = 0; i < 12; i++) {
    const b = await locator.boundingBox();
    const s = JSON.stringify(b);
    if (s === prev) return b;
    prev = s;
    await locator.page().waitForTimeout(80);
  }
  return locator.boundingBox();
}
async function geometry(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  await stable(locator);
  return locator.evaluate((e) => {
    const r = e.getBoundingClientRect(),
      hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      width: r.width,
      height: r.height,
      x: r.x,
      y: r.y,
      bottom: r.bottom,
      inViewport:
        r.x >= 0 &&
        r.y >= 0 &&
        r.right <= innerWidth &&
        r.bottom <= innerHeight,
      centerHit: !!hit && e.contains(hit),
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  results.browser = browser.version();
  try {
    for (const [index, width] of [320, 390].entries()) {
      if (process.env.WIDTH && Number(process.env.WIDTH) !== width) continue;
      const f = fixtures.periods[index];
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 1,
        acceptDownloads: true,
      });
      await context.addInitScript(
        (t) => localStorage.setItem('bk_api_token', t),
        token,
      );
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const events = {
        errors: [],
        requests: [],
        httpErrors: [],
        externalBlocked: [],
      };
      page.on('pageerror', (e) => events.errors.push(e.message));
      page.on('request', (req) => {
        const u = new URL(req.url());
        if (['/api/', '/admin/'].some((s) => u.pathname.startsWith(s)))
          events.requests.push({
            method: req.method(),
            path: u.pathname + u.search,
          });
      });
      page.on('response', (r) => {
        if (r.status() >= 400)
          events.httpErrors.push({
            status: r.status(),
            path: new URL(r.url()).pathname,
          });
      });
      await page.route('**/*', (route) => {
        const u = new URL(route.request().url());
        if (!['http:', 'https:'].includes(u.protocol) || u.origin === base)
          return route.continue();
        events.externalBlocked.push(u.origin);
        return route.abort();
      });
      const run = async (name, fn) => {
        if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name))
          return;
        const r = {
          name,
          width,
          height: 844,
          started: new Date().toISOString(),
        };
        results.cases.push(r);
        const a = events.requests.length,
          b = events.httpErrors.length;
        try {
          r.details = await fn();
          r.ok = true;
        } catch (e) {
          r.ok = false;
          r.error = e.stack;
          await page
            .screenshot({ path: out + `/${width}-${name}-failure.png` })
            .catch(() => {});
        } finally {
          r.requests = events.requests.slice(a);
          r.httpErrors = events.httpErrors.slice(b);
          r.pageErrors = [...events.errors];
          save();
          console.log(width, name, r.ok);
        }
      };
      const download = async (format, phase) => {
        const button = page.getByRole('button', {
          name: 'Download ' + format.toUpperCase(),
          exact: true,
        });
        const g = await geometry(page, button);
        assert(g.inViewport && g.centerHit && !g.pageOverflow);
        const promise = page.waitForEvent('download');
        await button.click();
        const d = await promise;
        assert.equal(await d.failure(), null);
        const filename = d.suggestedFilename();
        assert.equal(filename, `kmd-${f.name}.${format}`);
        const file = out + `/${width}-${phase}.${format}`;
        await d.saveAs(file);
        const bytes = fs.readFileSync(file),
          text = bytes.toString('utf8');
        assert(text.includes((f.vatCents / 100).toFixed(2)));
        if (format === 'xml') {
          assert(text.includes('17499653'));
          const check = await page.evaluate((xml) => {
            const d = new DOMParser().parseFromString(xml, 'application/xml');
            return {
              root: d.documentElement.nodeName,
              parserError: !!d.querySelector('parsererror'),
            };
          }, text);
          assert.equal(check.parserError, false);
        }
        return {
          format,
          phase,
          filename,
          bytes: bytes.length,
          sha256: hash(bytes),
          button: g,
        };
      };
      await run('reports', async () => {
        await page.goto(base + '/reports');
        await page
          .getByRole('link', {
            name: new RegExp(
              f.name.endsWith('08') ? 'August 2026' : 'September 2026',
            ),
          })
          .click();
        await page.waitForURL(new RegExp(`/reports/periods/${f.id}$`));
        const number = `SYNTHETIC301-${f.name}-INV-001`;
        let saveGeometry = null;
        const priorExpense = (await api('/api/expenses/' + f.expenseId)).body;
        if (priorExpense.supplier_invoice_number !== number) {
          await page
            .getByText('INF annex — invoice numbers to add', { exact: true })
            .waitFor();
          await page
            .getByRole('button', {
              name: /SYNTHETIC 301 Supplier.*no invoice number/,
            })
            .click();
          const sheet = page.getByRole('dialog', {
            name: 'SYNTHETIC 301 Supplier OÜ',
            exact: true,
          });
          await sheet
            .getByRole('textbox', { name: 'Supplier invoice number' })
            .fill('  ' + number + '  ');
          const saveNumber = sheet.getByRole('button', {
            name: 'Save number',
            exact: true,
          });
          saveGeometry = await geometry(page, saveNumber);
          await saveNumber.click();
          await sheet.waitFor({ state: 'hidden' });
        }
        await page
          .getByText(
            'INF annex — no supplier invoice numbers missing in this period.',
            { exact: true },
          )
          .waitFor();
        const expense = await api('/api/expenses/' + f.expenseId);
        assert.equal(expense.body.supplier_invoice_number, number);
        assert.equal(expense.body.status, 'posted');
        assert.equal(expense.body.voucher_id, f.voucherId);
        const downloads = [
          await download('xml', 'draft'),
          await download('csv', 'draft'),
        ];
        let earlierClosedViaUI = null;
        if (
          index === 0 &&
          (await api('/api/reporting-periods/1')).body.status === 'open'
        ) {
          assert.equal(
            await page.getByRole('button', { name: /Close period/ }).count(),
            0,
          );
          await page.getByText(/File Q1 2024 first/).waitFor();
          await page.screenshot({
            path: out + `/${width}-earlier-period-gate.png`,
          });
          await page.goto(base + '/reports/periods/1');
          await page.getByRole('button', { name: /Close period/ }).click();
          const earlierSheet = page.getByRole('dialog', { name: /^Close / });
          await earlierSheet
            .getByRole('textbox', { name: 'Type 2024-Q1 to confirm' })
            .fill('2024-Q1');
          const earlierButton = earlierSheet.getByRole('button', {
            name: /Close & freeze/,
          });
          await expectEnabled(earlierButton);
          await earlierButton.click();
          await earlierSheet.waitFor({ state: 'hidden' });
          earlierClosedViaUI = (await api('/api/reporting-periods/1')).body;
          assert.equal(earlierClosedViaUI.status, 'locked');
          await page.goto(base + `/reports/periods/${f.id}`);
        }
        let failedProof = null;
        const warningUrl = base + `/api/reporting-periods/${f.id}/warnings`;
        if (index === 0)
          await page.route(warningUrl, (route) =>
            route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({
                message: 'SYNTHETIC QA301 injected unavailable warning read',
              }),
            }),
          );
        await page.getByRole('button', { name: /Close period/ }).click();
        const lock = page.getByRole('dialog', { name: /^Close / });
        const typed = lock.getByRole('textbox', {
          name: `Type ${f.name} to confirm`,
        });
        await typed.fill(f.name);
        const close = lock.getByRole('button', { name: /Close & freeze/ });
        if (index === 0) {
          const retry = lock.getByRole('button', {
            name: 'Retry undecided items',
            exact: true,
          });
          await retry.waitFor();
          assert(await close.isDisabled());
          const ack = lock.getByRole('checkbox');
          assert.equal(await ack.count(), 1);
          assert.equal(await ack.isChecked(), false);
          failedProof = {
            injectedWarningStatus: 503,
            closeDisabled: true,
            acknowledgementOffered: true,
            acknowledged: false,
            inputRetained: await typed.inputValue(),
          };
          await page.screenshot({
            path: out + `/${width}-incomplete-proof-gate.png`,
          });
          await page.unroute(warningUrl);
          await retry.click();
        }
        await expectEnabled(close);
        const closeGeometry = await geometry(page, close);
        await close.click();
        await lock.waitFor({ state: 'hidden' });
        await page.getByText(/Frozen — closed/).waitFor();
        const period = (await api('/api/reporting-periods/' + f.id)).body;
        assert.equal(period.status, 'locked');
        assert(period.vat_report_snapshot_id);
        assert.equal(
          await page.getByRole('button', { name: /Close period/ }).count(),
          0,
        );
        downloads.push(
          await download('xml', 'frozen'),
          await download('csv', 'frozen'),
        );
        const repeat = await download('xml', 'frozen-repeat');
        assert.equal(
          repeat.sha256,
          downloads.find((d) => d.format === 'xml' && d.phase === 'frozen')
            .sha256,
        );
        downloads.push(repeat);
        await page.screenshot({ path: out + `/${width}-period-frozen.png` });
        return {
          fixture: f,
          numberSaved: number,
          numberCorrectionPreviouslyCompleted: saveGeometry === null,
          saveGeometry,
          closeGeometry,
          earlierClosedViaUI,
          failedProof,
          period,
          downloads,
          proofReads: events.requests.filter(
            (r) =>
              r.method === 'GET' &&
              r.path.includes(`/reporting-periods/${f.id}/`),
          ),
        };
      });
      await run('organization-counterparty', async () => {
        await page.goto(base + '/settings/organization');
        const name = page.getByRole('textbox', { name: 'Name', exact: true });
        await name.fill(`SYNTHETIC QA301 saved organization ${width}`);
        const save = page.getByRole('button', {
          name: 'Save organization',
          exact: true,
        });
        const g = await geometry(page, save);
        await save.click();
        await page.waitForFunction(
          () => !document.querySelector('button[aria-busy=true]'),
        );
        await page.reload();
        await page
          .getByRole('textbox', { name: 'Name', exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByRole('textbox', { name: 'Name', exact: true })
            .inputValue(),
          `SYNTHETIC QA301 saved organization ${width}`,
        );
        assert.equal(
          (await api('/api/organization')).body.name,
          `SYNTHETIC QA301 saved organization ${width}`,
        );
        await page.goto(base + '/settings/entities');
        await page.getByRole('button', { name: /Add/ }).click();
        const add = page.getByRole('dialog', {
          name: 'Add entity',
          exact: true,
        });
        await add
          .getByRole('textbox', { name: 'Name', exact: true })
          .fill(`SYNTHETIC QA301 Counterparty ${width}`);
        await add
          .getByRole('textbox', { name: 'Country', exact: true })
          .fill('ee');
        await add
          .getByRole('textbox', { name: 'Registration key', exact: true })
          .fill(`SYNTHETIC301-${width}-REG`);
        await add
          .getByRole('combobox', { name: 'Goods or services' })
          .selectOption('services');
        await add
          .getByRole('combobox', { name: 'Tax status' })
          .selectOption('taxable_business');
        const submit = add.getByRole('button', {
          name: 'Add supplier',
          exact: true,
        });
        const c = await geometry(page, submit);
        await submit.click();
        await page.waitForURL(/\/settings\/entities\/\d+$/);
        const id = Number(page.url().split('/').pop());
        const entity = await api('/api/entities/' + id);
        assert.equal(entity.body.country, 'EE');
        assert.equal(entity.body.name, `SYNTHETIC QA301 Counterparty ${width}`);
        await page.screenshot({ path: out + `/${width}-entity-created.png` });
        return {
          organizationSave: g,
          entityButton: c,
          entityId: id,
          entity: entity.body,
        };
      });
      await run('settings-device', async () => {
        await page.goto(base + '/settings/enroll');
        const existing = await api('/admin/settings/public_api_url');
        if (existing.body.value !== null) {
          await page
            .getByRole('button', { name: 'Clear Public API URL', exact: true })
            .click();
          await page.getByText(/^Stored value removed\./).waitFor();
          await page
            .getByRole('button', { name: 'Regenerate', exact: true })
            .click();
        }
        await page
          .getByText('The QR cannot be generated yet', { exact: true })
          .waitFor();
        const field = page.getByRole('textbox', {
          name: 'Public API URL',
          exact: true,
        });
        await field.fill('http://127.0.0.1:5301');
        await page
          .getByText(/Unsaved edit — Save stores this field only/)
          .waitFor();
        const save = page.getByRole('button', {
          name: 'Save Public API URL',
          exact: true,
        });
        const saveG = await geometry(page, save);
        await save.click();
        await page.getByText(/^Saved\. Clear deletes/).waitFor();
        const stored = await api('/admin/settings/public_api_url');
        assert.equal(stored.body.value, base);
        const exchanges = [];
        for (const label of ['Try again', 'Regenerate']) {
          const previousSrc = await page
            .getByRole('img', { name: 'Enrollment QR code' })
            .getAttribute('src')
            .catch(() => null);
          const createdPromise = page.waitForResponse(
            (r) =>
              r.request().method() === 'POST' &&
              r.url().endsWith('/api/device-enrollments') &&
              r.status() === 201,
          );
          await page.getByRole('button', { name: label, exact: true }).click();
          const created = await (await createdPromise).json();
          const img = page.getByRole('img', { name: 'Enrollment QR code' });
          await img.waitFor();
          await page.waitForFunction((previous) => {
            const i = document.querySelector('img[alt="Enrollment QR code"]');
            return i && i.getAttribute('src') !== previous;
          }, previousSrc);
          const imgData = await img.evaluate(async (img) => {
            await img.decode();
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            const cx = c.getContext('2d');
            cx.drawImage(img, 0, 0);
            return {
              w: c.width,
              h: c.height,
              data: Array.from(cx.getImageData(0, 0, c.width, c.height).data),
            };
          });
          const decoded = jsQR(
            new Uint8ClampedArray(imgData.data),
            imgData.w,
            imgData.h,
          );
          assert(decoded);
          const qr = JSON.parse(decoded.data);
          assert.equal(qr.v, 1);
          assert.equal(qr.api, base);
          assert.equal(qr.enroll, created.enrollmentToken);
          const session = await api(
            '/api/mobile/sessions',
            'POST',
            { deviceName: `SYNTHETIC QA301 protocol-only ${width}` },
            qr.enroll,
          );
          assert.equal(session.status, 201);
          const replay = await api(
            '/api/mobile/sessions',
            'POST',
            { deviceName: 'SYNTHETIC replay' },
            qr.enroll,
          );
          assert.equal(replay.status, 401);
          const read = await api(
            '/api/organization',
            'GET',
            undefined,
            session.body.accessToken,
          );
          assert.equal(read.status, 200);
          const revoke = await api(
            '/api/mobile/sessions/revoke',
            'POST',
            {},
            session.body.accessToken,
          );
          assert.equal(revoke.status, 204);
          const denied = await api(
            '/api/organization',
            'GET',
            undefined,
            session.body.accessToken,
          );
          assert.equal(denied.status, 401);
          exchanges.push({
            v: qr.v,
            api: qr.api,
            enrollmentSha256: hash(qr.enroll),
            exchangeStatus: session.status,
            replayStatus: replay.status,
            sessionReadStatus: read.status,
            revokeStatus: revoke.status,
            revokedReadStatus: denied.status,
            qrGeometry: await geometry(page, img),
          });
        }
        await page.screenshot({
          path: out + `/${width}-enrollment-consumed-qr.png`,
        });
        const clear = page.getByRole('button', {
          name: 'Clear Public API URL',
          exact: true,
        });
        const clearG = await geometry(page, clear);
        await clear.click();
        await page.getByText(/^Stored value removed\./).waitFor();
        const cleared = await api('/admin/settings/public_api_url');
        assert.equal(cleared.status, 200);
        assert.equal(cleared.body.value, null);
        await page
          .getByRole('button', { name: 'Regenerate', exact: true })
          .click();
        await page
          .getByText('The QR cannot be generated yet', { exact: true })
          .waitFor();
        await page.screenshot({
          path: out + `/${width}-enrollment-cleared.png`,
        });
        return {
          saveGeometry: saveG,
          clearGeometry: clearG,
          storedBeforeClear: stored.body.value,
          exchanges,
          qrPhysicallyScanned: false,
        };
      });
      await run('mailbox', async () => {
        await page.goto(base + '/settings/mailbox');
        await page
          .getByRole('button', { name: 'Connect Gmail', exact: true })
          .click();
        await page
          .getByText(/not configured|Missing|not set/i)
          .last()
          .waitFor();
        assert(page.url().includes('/settings/mailbox'));
        const oauthAvailable = false;
        await page.getByRole('button', { name: /Add IMAP mailbox/ }).click();
        const add = page.getByRole('dialog', {
          name: 'Add IMAP mailbox',
          exact: true,
        });
        await add.getByRole('textbox', { name: 'IMAP host' }).fill('127.0.0.1');
        const port = add.getByRole('spinbutton', { name: 'Port' });
        await port.fill('');
        assert(
          await add
            .getByRole('button', { name: 'Add mailbox', exact: true })
            .isDisabled(),
        );
        await port.fill('14301');
        await add
          .getByRole('textbox', { name: 'Username' })
          .fill(`synthetic-${width}@fixture.invalid`);
        await add
          .getByRole('textbox', { name: 'App password' })
          .fill('SYNTHETIC-FAKE-301');
        const submit = add.getByRole('button', {
          name: 'Add mailbox',
          exact: true,
        });
        const g = await geometry(page, submit);
        await submit.click();
        await add.waitFor({ state: 'hidden' });
        await page
          .getByRole('button', {
            name: `Sync synthetic-${width}@fixture.invalid`,
            exact: true,
          })
          .waitFor();
        const list = (await api('/api/mailbox/connectors')).body;
        const conn = list.find(
          (c) => c.username === `synthetic-${width}@fixture.invalid`,
        );
        assert(conn);
        const sync = page.getByRole('button', {
          name: `Sync ${conn.username}`,
          exact: true,
        });
        await sync.click();
        await page.getByText('Sync finished', { exact: true }).waitFor();
        const after = (await api('/api/mailbox/connectors')).body.find(
          (c) => c.id === conn.id,
        );
        assert.equal(after.status, 'connected');
        assert(after.last_synced_at);
        assert.equal(after.last_error, null);
        assert(!(await page.content()).includes('SYNTHETIC-FAKE-301'));
        await page.screenshot({
          path: out + `/${width}-mailbox-local-connected.png`,
        });
        return {
          fakeExternalService:
            'empty TLS IMAP on127.0.0.1:14301 with own trusted self-signed test CA',
          oauthAvailable,
          providerOAuthRoundTrip: false,
          button: g,
          connectorId: after.id,
          status: after.status,
          lastSyncedAt: after.last_synced_at,
          lastError: after.last_error,
          realMailboxConnected: false,
        };
      });
      results['events' + width] = {
        pageErrors: events.errors,
        httpErrors: events.httpErrors,
        externalBlocked: events.externalBlocked,
      };
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
async function expectEnabled(locator) {
  for (let i = 0; i < 60; i++) {
    if (await locator.isEnabled()) return;
    await locator.page().waitForTimeout(100);
  }
  throw Error('control did not become enabled');
}
