// SYNTHETIC isolated QA302 only. Operational seed + ordinary posting/approval APIs.
const fs = require('node:fs'),
  crypto = require('node:crypto'),
  D = require('better-sqlite3');
const file = process.argv[2];
if (!file?.includes('/issue-302/.qa-data/'))
  throw Error('isolated path required');
const db = new D(file);
db.prepare('INSERT INTO api_token(token_hash,label) VALUES (?,?)').run(
  crypto.createHash('sha256').update('synthetic-302-only').digest('hex'),
  'SYNTHETIC302',
);
(async () => {
  const png = await require('sharp')({
    create: {
      width: 120,
      height: 160,
      channels: 4,
      background: { r: 245, g: 240, b: 225, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  fs.mkdirSync('.qa-data/documents', { recursive: true });
  fs.writeFileSync('.qa-data/documents/SYNTHETIC302.png', png);
  db.prepare(
    "INSERT INTO document(id,hash,filename,mime_type,size_bytes,storage_path,status,created_at) VALUES (1,?,'SYNTHETIC302-source.png','image/png',?,'SYNTHETIC302.png','needs_triage',1792600000)",
  ).run(crypto.createHash('sha256').update(png).digest('hex'), png.length);
  db.prepare(
    "INSERT INTO audit_finding(finding_type,severity,description,referenced_object_type,referenced_object_id,status,created_at,reason_type) VALUES ('needs_triage','low','SYNTHETIC302 manual classification required','document',1,'open',1792600000,'unrecognized_document')",
  ).run();
  const bank = db
    .prepare("SELECT id FROM account WHERE code='BANK_EUR'")
    .get().id;
  db.prepare(
    "INSERT INTO bank_statement(id,account_id,start_date,end_date,uploaded_at) VALUES (1,?,'2026-10-01','2026-10-31',1792600000)",
  ).run(bank);
  for (const [id, amount] of [
    [1, -10000],
    [2, -5000],
  ])
    db.prepare(
      "INSERT INTO bank_transaction(id,statement_id,account_id,transaction_date,description,amount,currency,reference,status,created_at) VALUES (?,1,?,'2026-10-23',?,?, 'EUR',?,'open',1792600000)",
    ).run(
      id,
      bank,
      'SYNTHETIC302 payment ' + id,
      amount,
      id === 1 ? 'SYN-302-001' : 'SYN-302-OTHER',
    );
  async function api(path, method = 'GET', body) {
    const r = await fetch('http://127.0.0.1:4302' + path, {
      method,
      headers: {
        Authorization: 'Bearer synthetic-302-only',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text(),
      j = text ? JSON.parse(text) : null;
    if (!r.ok) throw Error(path + ' ' + r.status + ' ' + text);
    return j;
  }
  const supplier = await api('/api/entities', 'POST', {
    role: 'supplier',
    country: 'IE',
    name: 'SYNTHETIC302 Supplier',
    registrationKey: 'SYNTHETIC302-REG',
    goodsVsServices: 'services',
    taxStatus: 'taxable_business',
  });
  const fixtures = {
    synthetic: true,
    node: process.version,
    documentId: 1,
    statementId: 1,
    expenses: [],
  };
  for (const [id, gross] of [
    [1, 10000],
    [2, 12345],
    [3, 23456],
  ]) {
    let e = await api('/api/expenses', 'POST', {
      supplier_id: supplier.id,
      category: 'software',
      gross_amount: gross,
      vat_amount: 0,
      currency: 'EUR',
      tax_point_date: '2026-10-23',
      supplier_invoice_number: 'SYN-302-' + String(id).padStart(3, '0'),
    });
    if (id !== 2) {
      await api('/api/expenses/' + e.id + '/post', 'POST', {});
      const p = (await api('/api/approvals?status=pending')).approvals.find(
        (a) => a.object_type === 'expense' && a.object_id === e.id,
      );
      if (id === 1)
        await api('/api/approvals/' + p.id + '/approve', 'POST', {
          approved_by: 'SYNTHETIC302',
        });
      else fixtures.pendingApprovalId = p.id;
    }
    e = await api('/api/expenses/' + e.id);
    fixtures.expenses.push({
      id: e.id,
      status: e.status,
      grossCents: e.gross_amount,
      voucherId: e.voucher_id,
    });
  }
  fixtures.foreignKeyCheck = db.pragma('foreign_key_check');
  fs.writeFileSync(
    __dirname + '/fixtures.json',
    JSON.stringify(fixtures, null, 2) + '\n',
  );
  console.log(fixtures);
  db.close();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
