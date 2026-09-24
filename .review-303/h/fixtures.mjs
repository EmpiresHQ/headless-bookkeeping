// QA-010 (#303) re-run fixtures: deterministic realistic data (seed 303), generated in memory.
// Every /api and /admin request is answered in-page. Non-GET: propose-matches answered;
// everything else is HELD (never answered) and recorded — no request leaves the page.
import { chromium } from '/tmp/hbk-browser-check/node_modules/playwright/index.mjs';
export const base = process.env.REVIEW_BASE || 'http://127.0.0.1:5373';
export const launch = () => chromium.launch({ headless: true, args: ['--no-sandbox', '--js-flags=--expose-gc', '--enable-precise-memory-info'] });

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const day = (d) => Math.floor(Date.parse(d + 'T09:30:00Z') / 1000);
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);

const STEMS = ['Põhja-Eesti Kinnisvara', 'Rīgas Ūdens', 'Łódź Logistyka', 'Müller & Söhne Maschinenbau', 'Kalamaja Kohvik', 'Vilniaus Šviesa', 'Tartu Ülikooli Kliinikum', 'Pärnu Sadam', 'Kaunas Žalgiris Prekyba', 'Hansa Büroo', 'Telia Eesti', 'Elisa Eesti', 'Bolt Operations', 'Wolt Enterprises', 'Rimi Eesti Food', 'Circle K Eesti', 'Neste Eesti', 'Alexela', 'Ülemiste Keskus', 'Kraków Druk'];
const FORMS = ['OÜ', 'AS', 'SIA', 'UAB', 'Sp. z o.o.', 'GmbH', 'MTÜ'];
const CATS = ['office', 'software', 'travel', 'fuel', 'rent', 'telecom', 'meals', 'consulting'];
const STATUSES = [['draft', 0.165], ['pending', 0.085], ['posted', 0.705], ['reversed', 0.045]];
const REASONS = ['supplier_unresolved', 'low_confidence', 'category_unresolved', 'ocr_failed', 'possible_duplicate', 'outgoing_invoice', 'non_postable_document'];
// Heavy-tailed amount in cents: 0.01 € … ~12 M €.
const amount = (r) => Math.max(1, Math.round(Math.exp(r() * r() * 21)));

export function buildData({ seed = 303, small = false } = {}) {
  const r = rng(seed), n = (k) => (small ? Math.min(k, 20) : k);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const entities = Array.from({ length: 450 }, (_, i) => {
    let name = `${pick(STEMS)} ${pick(FORMS)}`;
    if (i % 37 === 5) name = `${pick(STEMS)} ja Partnerid — Rahvusvaheline Logistika- ja Konsultatsiooniteenuste ${pick(FORMS)}`;
    if (i % 53 === 0) name = `Kalamaja ${name}`;
    return { id: i + 1, role: i < 300 ? 'supplier' : 'customer', name: `${name} #${i + 1}`, country: pick(['EE', 'LV', 'LT', 'PL', 'DE']), goods_vs_services: 'services', tax_status: 'taxable_business' };
  });
  const t0 = day('2025-01-01'), t1 = day('2026-09-24');
  const status = () => { let x = r(); for (const [s, p] of STATUSES) { if ((x -= p) < 0) return s; } return 'posted'; };
  const expenses = Array.from({ length: n(1200) }, (_, i) => {
    const g = amount(r), date = iso(t0 + Math.floor(r() * (t1 - t0)));
    return { id: 10000 + i, supplier_id: 1 + Math.floor(r() * 300), category: pick(CATS), gross_amount: g, vat_amount: Math.round(g * 0.22 / 1.22), currency: r() < 0.05 ? 'USD' : 'EUR', tax_point_date: date, supplier_invoice_number: r() < 0.2 ? null : `${pick(['INV', 'ARVE', 'FV', 'RE'])}-${2025 + Math.floor(r() * 2)}/${String(1 + Math.floor(r() * 99999)).padStart(5, '0')}`, status: status(), reconciled: r() < 0.3, created_at: day(date), document_id: null, ai_confidence: null, claimant_id: null };
  });
  const invoices = Array.from({ length: n(1000) }, (_, i) => {
    const g = amount(r), date = iso(t0 + Math.floor(r() * (t1 - t0)));
    return { id: 30000 + i, customer_id: 301 + Math.floor(r() * 150), invoice_number: `2026-${String(i + 1).padStart(5, '0')}`, gross_amount: g, vat_amount: Math.round(g * 0.22 / 1.22), currency: 'EUR', tax_point_date: date, due_date: date, document_id: null, status: status() === 'pending' ? 'draft' : status(), sent_at: null, supply_type: 'services' };
  });
  const docs = Array.from({ length: n(1000) }, (_, i) => ({ id: 50000 + i, status: 'processed', expense_id: i < 800 ? 10000 + (i % 1200) : null, sales_invoice_id: null, filename: i % 41 === 3 ? `Skannitud_arve_${i}_Põhja-Eesti_Kinnisvara_OÜ_rendileping_ja_kõrvalkulud_2026_september_lõplik_versioon.pdf` : `arve-${50000 + i}.pdf`, created_at: t1 - i * 5400, channel: pick(['upload', 'email', 'telegram']), supplier_name: entities[i % 300].name, claimant_name: null, reason_type: null, reason: null, preview_path: null, mime_type: 'application/pdf', size_bytes: 120000, expense_status: 'posted' }));
  const triage = Array.from({ length: n(600) }, (_, i) => { const rt = REASONS[i % REASONS.length]; return { id: 70000 + i, filename: i % 29 === 1 ? `IMG_${4000 + i}_Kalamaja_Kohvik_kassatšekk_lõunasöök_klientidega_Tallinn_2026-09.jpg` : `scan-${70000 + i}.pdf`, created_at: t1 - i * 3600, reason: `QA fixture reason: ${rt.replace(/_/g, ' ')}`, reason_type: rt }; });
  const approvals = Array.from({ length: n(400) }, (_, i) => ({ id: 90000 + i, object_type: 'expense', object_id: 10000 + ((i * 3) % 1200), status: 'pending', requested_by: 'agent', approved_by: null, rejected_reason: null, policy_reason: pick(['Amount above auto-approve limit', 'New supplier', 'Foreign currency']), superseded_by: null, created_at: t1 - i * 7200, resolved_at: null }));
  const statements = Array.from({ length: 24 }, (_, i) => ({ id: i + 1, start_date: `20${24 + Math.floor(i / 12)}-${String(1 + (i % 12)).padStart(2, '0')}-01`, end_date: `20${24 + Math.floor(i / 12)}-${String(1 + (i % 12)).padStart(2, '0')}-28`, uploaded_at: t1 - i * 86400 * 30 }));
  statements[2] = { id: 3, start_date: '2026-01-01', end_date: '2026-09-30', uploaded_at: t1 };
  const txs = Array.from({ length: n(1000) }, (_, i) => { const e = entities[i % 300]; const a = amount(r); return { id: 100000 + i, transaction_date: iso(day('2026-01-01') + Math.floor(i * 0.27 * 86400)), description: `${e.name} ${pick(['makse', 'arve tasumine', 'kaardimakse', 'SEPA'])}`, amount: i % 7 === 0 ? a : -a, currency: 'EUR', counterparty_iban: `EE${String(38 + (i % 60)).padStart(2, '0')}2200${String(221020145685 + i)}`, counterparty_descriptor: e.name, reference: i % 3 ? `RF${18 + (i % 80)}${i}` : null, status: 'open' }; });
  const matched = new Set(txs.slice(0, n(200)).map((t) => t.id));
  const matches = [...matched].map((id, k) => ({ id: 200000 + k, bankTransactionId: id, status: 'active', amountMatched: Math.abs(txs[k].amount), objectLabel: `Expense ${10000 + k}`, counterpartyName: txs[k].counterparty_descriptor }));
  const proposals = txs.slice(n(200), n(500)).map((t, k) => ({ bankTransactionId: t.id, voucherId: 300000 + k, matchType: 'exact', amountMatched: Math.abs(t.amount), confidence: k % 3 === 2 ? 'medium' : 'high', signal: 'counterparty', objectType: 'expense', objectId: 10000 + k, objectLabel: `Expense ${10000 + k} · ${t.counterparty_descriptor}`, counterpartyName: t.counterparty_descriptor, voucherRemaining: Math.abs(t.amount) }));
  const recon = txs.map((t) => ({ bankTransactionId: t.id, amountBase: t.amount, matchedSum: matched.has(t.id) ? t.amount : 0, remaining: matched.has(t.id) ? 0 : t.amount, reconStatus: matched.has(t.id) ? 'matched' : 'open' }));
  const periods = [{ id: 2, name: '2026-09', start_date: '2026-09-01', end_date: '2026-09-30', status: 'open', filed_at: null }, { id: 1, name: '2026-08', start_date: '2026-08-01', end_date: '2026-08-31', status: 'locked', filed_at: day('2026-09-15') }];
  return { entities, expenses, invoices, docs, triage, approvals, statements, txs, matches, proposals, recon, periods };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export async function setup(browser, { width, height, small = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await context.addInitScript(() => localStorage.setItem('bk_api_token', 'qa-303-fixture'));
  const page = await context.newPage();
  const d = buildData({ small });
  const log = { unhandled: [], held: [], pageErrors: [], consoleErrors: [], gets: 0, previews: 0 };
  page.on('pageerror', (e) => log.pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') log.consoleErrors.push(m.text().slice(0, 200)); });
  const byId = (a, id) => a.find((x) => x.id === +id);
  await page.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    if (url.origin !== base) return route.abort();
    if (!/^\/(api|admin)(\/|$)/.test(p)) return route.continue();
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() !== 'GET') {
      if (/\/propose-matches$/.test(p)) return send(d.proposals);
      log.held.push(req.method() + ' ' + p); // never answered: a pending mutation, nothing leaves the page
      return;
    }
    log.gets++;
    let m;
    if (/^\/api\/documents\/\d+\/preview$/.test(p)) { log.previews++; return route.fulfill({ status: 200, contentType: 'image/png', body: PNG }); }
    if (p === '/api/entities') return send({ entities: d.entities });
    if ((m = p.match(/^\/api\/entities\/(\d+)$/))) return send(byId(d.entities, m[1]) ?? {});
    if (p === '/api/categories') return send({ categories: ['office', 'software', 'travel', 'fuel', 'rent', 'telecom', 'meals', 'consulting'].map((key) => ({ key, label: key[0].toUpperCase() + key.slice(1) })) });
    if (p === '/api/organization') return send({ id: 1, country: 'EE', org_type: 'company', base_currency: 'EUR', vat_registered: true, vat_registration_kind: 'ordinary', input_vat_entitlement: 'full', name: 'Kalamaja Konsultatsioonid OÜ' });
    if (p === '/api/organization/period-config') return send({});
    if (p === '/api/approvals/pending') return send({ approvals: d.approvals });
    if (p === '/api/approvals') return send({ approvals: [] });
    if (p === '/api/triage/needs-triage') return send({ items: d.triage });
    if (p === '/api/triage/pending') return send({ pending: [] });
    if (p === '/api/reporting-periods') return send({ reportingPeriods: d.periods });
    if (p === '/api/mailbox/connectors') return send([]);
    if (p === '/api/expenses') return send({ expenses: d.expenses });
    if ((m = p.match(/^\/api\/expenses\/(\d+)$/))) return send(byId(d.expenses, m[1]) ?? {});
    if ((m = p.match(/^\/api\/expenses\/(\d+)\/attachable-documents$/))) return send({ documents: [] });
    if (p === '/api/sales-invoices') return send({ invoices: d.invoices });
    if ((m = p.match(/^\/api\/sales-invoices\/(\d+)$/))) return send(byId(d.invoices, m[1]) ?? {});
    if (p === '/api/documents') return send({ documents: d.docs });
    if ((m = p.match(/^\/api\/documents\/(\d+)$/))) return send(byId(d.docs, m[1]) ?? byId(d.triage, m[1]) ?? {});
    if ((m = p.match(/^\/api\/documents\/(\d+)\/details$/))) return send({ document_id: +m[1], ocr: { ok: true, markdown: 'OCR fixture text.' }, classification: null });
    if (p === '/api/credit-notes') return send({ credit_notes: [] });
    if (p === '/api/bank-statements') return send(d.statements);
    if ((m = p.match(/^\/api\/bank-statements\/(\d+)\/transactions$/))) return send(+m[1] === 3 ? d.txs : []);
    if ((m = p.match(/^\/api\/bank-statements\/(\d+)\/reconciliation$/))) return send(+m[1] === 3 ? d.recon : []);
    if ((m = p.match(/^\/api\/bank-statements\/(\d+)\/matches$/))) return send(+m[1] === 3 ? d.matches : []);
    if (/\/match-candidates$/.test(p)) return send({ bankTransactionId: +(url.searchParams.get('bankTransactionId') ?? 0), lineRemaining: 0, candidates: [] });
    log.unhandled.push(p + url.search);
    return send({ message: 'No QA fixture' }, 503);
  });
  return { context, page, data: d, log };
}
