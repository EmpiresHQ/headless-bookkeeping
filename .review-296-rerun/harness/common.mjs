// QA-003 (#296) re-run: fixtures copied from the #295 re-run harness (base port 5496).
// Route-mocked JSON, in-page preview/image mock (inpage.js), node-generated PDF.
import { readFileSync } from 'node:fs';
import { chromium } from '/tmp/hbk-browser-check/node_modules/playwright/index.mjs';

export const base = process.env.REVIEW_BASE || 'http://localhost:5496';
export const launch = () => chromium.launch({ headless: true, args: ['--no-sandbox'] });
const INPAGE = readFileSync(new URL('./inpage.js', import.meta.url), 'utf8');
const NOW = Math.floor(Date.parse('2026-09-24T09:00:00Z') / 1000);

// ---------- bank fixtures ----------
export const STMT = 1;
const longDesc = 'SEPA KAARDIMAKSE Tallinna Kinnisvarahalduse ja Hoolduse Teenuste Osaühing Filiaal Lasnamäe 4411';
export const TX = {
  create: 501, // outgoing, no candidates  -> TxCreateExpense
  matched: 502, // 14 active matches       -> TxMatched (Unmatch)
  staged: 503, // 3 staged + 9 active     -> TxMatched (Confirm + Unmatch)
  incoming: 504, // incoming, no candidates -> IncomingOpen
  candidates: 505, // 16 candidates        -> TxCandidates (M1 control)
};
export function bankData() {
  const tx = (id, amount, status = 'open', description = longDesc) => ({ id, transaction_date: '2026-09-18', description, amount, currency: 'EUR', counterparty_iban: 'EE38 2200 2210 2014 5685', counterparty_descriptor: 'Põhja-Eesti Logistika OÜ', reference: '1234567', status });
  const txs = [tx(501, -12345), tx(502, -986543), tx(503, -455000), tx(504, 50000, 'open', 'Laekumine klient Nordic Consulting Oy arve 2026-00077 ettemaks'), tx(505, -250000)];
  const matches = [];
  let mid = 7000;
  for (let i = 0; i < 14; i++) matches.push({ id: ++mid, bankTransactionId: 502, status: 'active', amountMatched: 70467, objectLabel: `Expense #${1100 + i}`, counterpartyName: i % 4 === 0 ? 'Tallinna Kinnisvarahalduse ja Hoolduse Teenuste Osaühing Filiaal' : 'Põhja-Eesti Logistika OÜ' });
  for (let i = 0; i < 12; i++) matches.push({ id: ++mid, bankTransactionId: 503, status: i < 3 ? 'draft' : 'active', amountMatched: 37916, objectLabel: `Expense #${1200 + i}`, counterpartyName: 'Baltic Transport SIA' });
  const recon = txs.map((t) => {
    const sum = matches.filter((m) => m.bankTransactionId === t.id).reduce((a, m) => a + m.amountMatched, 0);
    const base = Math.abs(t.amount);
    return { bankTransactionId: t.id, amountBase: base, matchedSum: sum, remaining: base - sum, reconStatus: sum >= base ? 'matched' : sum > 0 ? 'partial' : 'open' };
  });
  const candidates = [];
  for (let i = 0; i < 16; i++) candidates.push({ voucherId: 8800 + i, objectType: 'expense', objectId: 1300 + i, objectLabel: `Expense #${1300 + i}`, counterpartyName: 'Põhja-Eesti Logistika OÜ', voucherRemaining: 15625 });
  return { txs, matches, recon, candidates };
}

// ---------- inbox fixtures ----------
export const DOCS = { a4: 31001, receipt: 31002, wide: 31003, pdf: 31004, photo: 31005 };
export const triage = [];
for (let i = 0; i < 40; i++) {
  const id = 31001 + i;
  triage.push({ id, filename: `qa305_${id}_${['a4', 'receipt', 'wide', 'multipage', 'photo'][i] ?? 'scan'}.pdf`, created_at: NOW - 3600 * (i + 2), reason: `Fixture reason ${id}`, reason_type: i % 2 ? 'category_unresolved' : 'low_confidence' });
}

// ---------- multipage PDF (deterministic) ----------
export const PDF_PAGES = 12;
export function makePdf(n = PDF_PAGES) {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const catalog = add(null); const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (let k = 1; k <= n; k++) {
    const land = k === 7; // one landscape page
    const [W, H] = land ? [842, 595] : [595, 842];
    let s = `q 0.8 0 0 RG 6 w 10 10 ${W - 20} ${H - 20} re S Q\n`;
    s += `q 0 0.6 0 rg ${W - 70} 20 50 50 re f Q\n`; // green corner marker
    s += `BT /F1 48 Tf 40 ${H - 90} Td (Page ${k} of ${n}) Tj ET\n`;
    s += `BT /F1 14 Tf 40 ${H - 120} Td (QA-305 multipage fixture ${land ? 'landscape' : 'portrait'} ${W}x${H}pt) Tj ET\n`;
    for (let y = H - 150, r = 1; y > 90; y -= 11, r++) s += `BT /F1 6 Tf 40 ${y} Td (${String(r).padStart(3, '0')} Rida kirjeldus ${k}.${r}  1,00 x 12,34 EUR  KM 24%  ................................................................ ${k * 100 + r}) Tj ET\n`;
    const content = add(`<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}endstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${n} >>`;
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const PDF = makePdf();

// ---------- context ----------
export async function setup(browser, vp) {
  const mobile = vp.width < 1024;
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr ?? (mobile ? 2 : 1), isMobile: mobile, hasTouch: mobile, ...(vp.userAgent ? { userAgent: vp.userAgent } : {}) });
  await context.addInitScript(INPAGE);
  // QA-003 standalone proxy: a JS-level matchMedia stub for display-mode
  // (CDP media emulation ignores display-mode in this Chromium). CSS media
  // queries are NOT affected; the app ships none for display-mode.
  if (vp.standalone) await context.addInitScript(() => {
    const mm = window.matchMedia.bind(window);
    window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: true, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false } : mm(q));
  });
  const page = await context.newPage();
  const errors = [], writes = [], unhandled = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/503|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text().slice(0, 200)); });
  const b = bankData();
  await page.route('**/*', async (route) => {
    const req = route.request(); const url = new URL(req.url()); const p = url.pathname; const m = req.method();
    if (url.origin !== base) return route.abort();
    if (!/^\/(api|admin)(\/|$)/.test(p)) return route.continue();
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    let mm;
    if (m === 'POST' && /^\/api\/bank-statements\/\d+\/propose-matches$/.test(p)) return send([]);
    if (m !== 'GET') {
      // Every financial/network write is REFUSED by the mock: the harness
      // only proves the tap/keypress reached the action.
      writes.push({ method: m, path: p, t: Date.now() });
      return send({ message: 'QA-305 fixture: write refused (mock)' }, 503);
    }
    if ((mm = /^\/api\/documents\/(\d+)\/file$/.exec(p)) && +mm[1] === DOCS.pdf) return route.fulfill({ status: 200, contentType: 'application/pdf', headers: { 'content-disposition': `attachment; filename="multipage_${mm[1]}.pdf"` }, body: PDF }).catch(() => {});
    if (/\/(preview|file)$/.test(p)) { unhandled.push('network ' + p); return send({ message: 'must be answered in-page' }, 599); }
    if (p === '/api/organization') return send({ id: 1, country: 'EE', base_currency: 'EUR', vat_registered: true, vat_registration_kind: 'ordinary', input_vat_entitlement: 'full', input_vat_deduction_permille: null, org_type: 'company', created_at: NOW - 9e7, name: 'Fixture Mobile OÜ', vat_registration_number: null, registry_code: null, iban: null });
    if (p === '/api/entities') return send({ entities: [{ id: 1, role: 'supplier', name: 'Põhja-Eesti Logistika OÜ', country: 'EE', goods_vs_services: 'services', tax_status: 'taxable_business' }, { id: 2, role: 'customer', name: 'Nordic Consulting Oy', country: 'FI', goods_vs_services: 'services', tax_status: 'taxable_business' }] });
    if (p === '/api/categories') return send({ categories: ['office', 'software', 'travel', 'rent', 'fuel', 'bank fee'].map((key) => ({ key, label: key[0].toUpperCase() + key.slice(1) })) });
    // QA-003: an optional long Books list, so a sheet can open over a scrolled page.
    if (p === '/api/expenses') return send({ expenses: vp.expenses ? Array.from({ length: vp.expenses }, (_, i) => ({ id: 4000 + i, supplier_id: 1, category: 'office', gross_amount: 1234 + i * 101, vat_amount: 239, currency: 'EUR', tax_point_date: '2026-09-' + String(1 + (i % 28)).padStart(2, '0'), supplier_invoice_number: 'INV-' + (4000 + i), status: 'posted', reconciled: i % 3 === 0 })) : [] });
    if (p === '/api/sales-invoices') return send({ invoices: [] });
    if (p === '/api/credit-notes') return send({ credit_notes: [] });
    if (p === '/api/documents') return send({ documents: [] });
    if (p === '/api/triage/needs-triage') return send({ items: triage });
    if (p === '/api/triage/pending') return send({ pending: [] });
    if (p === '/api/approvals/pending') return send({ approvals: vp.approvals ? b.matches.filter((x) => x.status === 'draft').map((x, i) => ({ id: 96001 + i, object_type: 'reconciliation_match', object_id: x.id, status: 'pending', requested_by: 'system:policy', approved_by: null, rejected_reason: null, policy_reason: 'review', superseded_by: null, created_at: NOW - 3600, resolved_at: null })) : [] });
    if (p === '/api/approvals') return send({ approvals: [] });
    if ((mm = /^\/api\/documents\/(\d+)\/details$/.exec(p))) return send({ document_id: +mm[1], ocr: { ok: true, markdown: 'Fixture OCR text' }, classification: null });
    if ((mm = /^\/api\/documents\/(\d+)\/pending-draft$/.exec(p))) return send({ available: false, reason: 'No draft' });
    if ((mm = /^\/api\/documents\/(\d+)$/.exec(p))) { const t = triage.find((x) => x.id === +mm[1]); return t ? send({ mime_type: 'application/pdf', size_bytes: 123456, status: 'needs_review', processing_since: null, preview_path: 'p', channel: 'upload', ...t }) : send({ message: 'Not found' }, 404); }
    if (p === '/api/mailbox/connectors') return send([]);
    if (p === '/api/reporting-periods') return send({ reportingPeriods: [] });
    if (p === '/api/bank-statements') return send([{ id: STMT, start_date: '2026-09-01', end_date: '2026-09-30', uploaded_at: NOW - 86400 }]);
    if ((mm = /^\/api\/bank-statements\/(\d+)\/(transactions|reconciliation|matches)$/.exec(p))) return send(mm[2] === 'transactions' ? b.txs : mm[2] === 'reconciliation' ? b.recon : b.matches);
    if (/^\/api\/bank-statements\/\d+\/match-candidates$/.test(p)) { const txId = +url.searchParams.get('bankTransactionId'); const rc = b.recon.find((x) => x.bankTransactionId === txId); return send({ bankTransactionId: txId, lineRemaining: rc?.remaining ?? 0, candidates: txId === TX.candidates ? b.candidates : [] }); }
    if (p === '/api/prepayments/advance-vat-treatments') return send({ treatments: [{ vat_code: 'EE-24', rate_permille: 240 }] });
    unhandled.push('GET ' + p + url.search);
    return send({ message: 'No fixture' }, 503);
  });
  const cdp = mobile ? await context.newCDPSession(page) : null;
  return { context, page, errors, writes, unhandled, cdp };
}

export const frames = (page, n = 2) => page.evaluate((k) => new Promise((r) => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

/** Page-level horizontal overflow: scroll widths + unclipped offenders. */
export const overflow = (page) => page.evaluate(() => {
  const vw = innerWidth;
  const clipped = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o !== 'visible') return true; } return false; };
  const off = [];
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.right <= vw + 1) continue;
    if (getComputedStyle(el).position === 'fixed' && r.left >= vw) continue;
    if (clipped(el)) continue;
    off.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} r=${Math.round(r.right)}`);
    if (off.length > 5) break;
  }
  return { vw, docScrollW: document.documentElement.scrollWidth, bodyScrollW: document.body.scrollWidth, scrollX: scrollX, offenders: off };
});

// ---------- touch input through the real pipeline ----------
// Input.synthesizeScrollGesture / synthesizePinchGesture are no-ops in this
// headless shell (probe-pinch.log, dev2-sticky afterGesture), so drags and
// pinches are raw Input.dispatchTouchEvent sequences. A drag holds still for
// ~120 ms before lifting, so no fling adds a non-deterministic distance.
const T = (s, type, pts) => s.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x: Math.round(x), y: Math.round(y), id: i })) });
export async function drag(s, x, y, dx, dy, steps = 16) {
  await T(s, 'touchStart', [[x, y]]);
  for (let k = 1; k <= steps; k++) { await T(s, 'touchMove', [[x + (dx * k) / steps, y + (dy * k) / steps]]); await s.page.waitForTimeout(16); }
  for (let k = 0; k < 8; k++) { await T(s, 'touchMove', [[x + dx, y + dy]]); await s.page.waitForTimeout(16); }
  await T(s, 'touchEnd', []);
  await s.page.waitForTimeout(250);
}
export async function pinch(s, cx, cy, factor, steps = 14) {
  const d0 = factor >= 1 ? 60 : 60 / factor, d1 = d0 * factor;
  await T(s, 'touchStart', [[cx - d0 / 2, cy], [cx + d0 / 2, cy]]);
  for (let k = 1; k <= steps; k++) { const d = d0 + ((d1 - d0) * k) / steps; await T(s, 'touchMove', [[cx - d / 2, cy], [cx + d / 2, cy]]); await s.page.waitForTimeout(16); }
  for (let k = 0; k < 6; k++) { await T(s, 'touchMove', [[cx - d1 / 2, cy], [cx + d1 / 2, cy]]); await s.page.waitForTimeout(16); }
  await T(s, 'touchEnd', []);
  await s.page.waitForTimeout(500);
}
