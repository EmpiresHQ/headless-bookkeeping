// SYNTHETIC isolated fixtures. Seed auth only in SQL, then use real domain APIs.
const fs = require('node:fs'),
  crypto = require('node:crypto');
const dbPath = process.argv[2];
if (!dbPath?.includes('/issue-301/.qa-data/'))
  throw Error('isolated path required');
const db = new (require('better-sqlite3'))(dbPath);
db.prepare('INSERT INTO api_token(token_hash,label) VALUES (?,?)').run(
  crypto.createHash('sha256').update('synthetic-301-only').digest('hex'),
  'synthetic QA301 only',
);
db.close();
async function api(path, method = 'GET', body) {
  const r = await fetch('http://127.0.0.1:4301' + path, {
    method,
    headers: {
      Authorization: 'Bearer synthetic-301-only',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text(),
    j = t ? JSON.parse(t) : null;
  if (!r.ok) throw Error(`${path} ${r.status} ${t}`);
  return j;
}
(async () => {
  await api('/api/organization', 'PUT', {
    country: 'EE',
    name: 'SYNTHETIC QA301 OÜ',
    vat_registered: true,
    vat_registration_number: 'EE100000001',
    registry_code: '17499653',
  });
  const supplier = await api('/api/entities', 'POST', {
    role: 'supplier',
    country: 'EE',
    name: 'SYNTHETIC 301 Supplier OÜ',
    registrationKey: 'EE200000002',
    goodsVsServices: 'services',
    taxStatus: 'taxable_business',
  });
  const fixtures = {
    synthetic: true,
    node: process.version,
    supplierId: supplier.id,
    earlierOpenPeriodId: 1,
    periods: [],
  };
  for (const [name, net] of [
    ['2026-08', 200000],
    ['2026-09', 300000],
  ]) {
    const p = await api('/api/reporting-periods', 'POST', {
      name,
      start_date: name + '-01',
      end_date: name + (name.endsWith('08') ? '-31' : '-30'),
    });
    let e = await api('/api/expenses', 'POST', {
      supplier_id: supplier.id,
      category: 'software',
      gross_amount: net * 1.24,
      vat_amount: net * 0.24,
      currency: 'EUR',
      tax_point_date: name + '-10',
    });
    if (e.status === 'draft')
      await api(`/api/expenses/${e.id}/post`, 'POST', {});
    const pending = await api('/api/approvals?status=pending');
    const a = pending.approvals.find(
      (a) => a.object_type === 'expense' && a.object_id === e.id,
    );
    if (a)
      await api(`/api/approvals/${a.id}/approve`, 'POST', {
        approved_by: 'SYNTHETIC QA301',
      });
    e = await api('/api/expenses/' + e.id);
    if (e.status !== 'posted') throw Error('not posted ' + JSON.stringify(e));
    fixtures.periods.push({
      id: p.id,
      name,
      expenseId: e.id,
      voucherId: e.voucher_id,
      netCents: net,
      vatCents: net * 0.24,
      grossCents: e.gross_amount,
    });
  }
  fs.writeFileSync(
    __dirname + '/fixtures.json',
    JSON.stringify(fixtures, null, 2) + '\n',
  );
  console.log(fixtures);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
