// QA-011 re-run (#304) fixtures. Every /api and /admin request is answered by a route mock except
// /preview, which inpage.js answers inside the page. The only writes are mocked POST .../complete.
import fs from 'node:fs';
import { chromium } from '/tmp/hbk-browser-check/node_modules/playwright/index.mjs';
export const base = process.env.REVIEW_BASE || 'http://127.0.0.1:5374';
export const launch = () => chromium.launch({ headless: true, args: ['--no-sandbox'] });
const INPAGE = fs.readFileSync(new URL('./inpage.js', import.meta.url), 'utf8');
const T1 = Math.floor(Date.parse('2026-09-24T09:30:00Z') / 1000);
export const TRIAGE_IDS = [31001, 31002, 31003, 31004, 31005, 31006];
export const ARCHIVE_IDS = [32001, 32002, 32003];
export const fname = (id) => `qa-doc-${id}.pdf`;

export async function setup(browser, { width, height, mobile = false, triageCount = 6 }) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: mobile ? 3 : 1, isMobile: mobile, hasTouch: mobile,
  });
  await context.addInitScript(() => localStorage.setItem('bk_api_token', 'qa-304-fixture'));
  await context.addInitScript(INPAGE);
  const page = await context.newPage();
  const triage = Array.from({ length: triageCount }, (_, i) => 31001 + i).map((id, i) => ({ id, filename: fname(id), created_at: T1 - i * 3600, reason: 'QA fixture: low confidence', reason_type: i % 2 ? 'category_unresolved' : 'low_confidence' }));
  const docs = ARCHIVE_IDS.map((id, i) => ({ id, status: 'processed', expense_id: null, sales_invoice_id: null, filename: fname(id), created_at: T1 - i * 5400, channel: 'upload', supplier_name: 'QA Supplier OÜ', claimant_name: null, reason_type: null, reason: null, preview_path: `p/${id}.png`, mime_type: 'application/pdf', size_bytes: 120000, expense_status: null }));
  const log = { unhandled: [], writes: [], pageErrors: [], consoleErrors: [], routePreview: 0 };
  page.on('pageerror', (e) => log.pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') log.consoleErrors.push(m.text().slice(0, 160)); });
  await page.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    if (url.origin !== base) return route.abort();
    if (!/^\/(api|admin)(\/|$)/.test(p)) return route.continue();
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    let m;
    if (req.method() !== 'GET') {
      if ((m = p.match(/^\/api\/documents\/(\d+)\/complete$/)) && req.method() === 'POST') {
        log.writes.push(`POST ${p}`);
        const i = triage.findIndex((t) => t.id === +m[1]); if (i >= 0) triage.splice(i, 1);
        return send({ id: +m[1], status: 'processed' });
      }
      log.writes.push(`HELD ${req.method()} ${p}`); return; // never answered
    }
    if (/\/preview$/.test(p)) { log.routePreview++; return send({ message: 'route layer must not see previews' }, 599); }
    if (p === '/api/triage/needs-triage') return send({ items: triage });
    if (p === '/api/triage/pending') return send({ pending: [] });
    if (p === '/api/approvals/pending') return send({ approvals: [] });
    if (p === '/api/approvals') return send({ approvals: [] });
    if ((m = p.match(/^\/api\/documents\/(\d+)\/details$/))) return send({ document_id: +m[1], ocr: { ok: true, markdown: 'QA OCR text.' }, classification: null });
    if ((m = p.match(/^\/api\/documents\/(\d+)$/))) return send(docs.find((d) => d.id === +m[1]) ?? { ...triage.find((d) => d.id === +m[1]), status: 'needs_triage' });
    if (p === '/api/documents') return send({ documents: docs });
    if (p === '/api/entities') return send({ entities: [] });
    if (p === '/api/categories') return send({ categories: [{ key: 'office', label: 'Office' }] });
    if (p === '/api/organization') return send({ id: 1, country: 'EE', org_type: 'company', base_currency: 'EUR', vat_registered: true, vat_registration_kind: 'ordinary', input_vat_entitlement: 'full', name: 'QA Fixture OÜ' });
    if (p === '/api/organization/period-config') return send({});
    if (p === '/api/reporting-periods') return send({ reportingPeriods: [] });
    if (p === '/api/mailbox/connectors') return send([]);
    if (p === '/api/expenses') return send({ expenses: [] });
    if (p === '/api/sales-invoices') return send({ invoices: [] });
    if (p === '/api/credit-notes') return send({ credit_notes: [] });
    if (p === '/api/bank-statements') return send([]);
    log.unhandled.push(p + url.search);
    return send({ message: 'No QA fixture' }, 503);
  });
  return { context, page, log };
}

export const qa = (page, fn, arg) => page.evaluate(fn, arg);
export const plan = (page, key, steps) => page.evaluate(([k, s]) => { (window.__qa.plans[k] ||= []).push(...s); }, [key, steps]);
export const release = (page, gate) => page.evaluate((g) => window.__qa.release(g), gate);
export const waitGate = (page, gate) => page.waitForFunction((g) => g in window.__qa.gates, gate, { timeout: 8000 });
export const counters = (page) => page.evaluate(() => { const q = window.__qa; const urls = Object.values(q.urls); return { created: q.created, revoked: q.revoked, live: urls.filter((u) => u.revoked === null).length, fails: q.fails.length, broken: q.broken.length, brokenDom: q.brokenDom, frames: q.frames, samples: q.samples, domChecks: q.domChecks, reqs: q.reqs.length }; });
// Plans for requests fired during the first load (before page.evaluate can reach the page).
export const prePlan = (context, plans) => context.addInitScript((p) => { window.__qaPre = p; }, plans);
