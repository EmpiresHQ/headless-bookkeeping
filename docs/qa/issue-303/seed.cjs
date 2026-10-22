// SYNTHETIC, isolated QA database only. Run after server migrations, before browser.
const Database = require('better-sqlite3');
const { createHash } = require('node:crypto');
const db = new Database(process.argv[2]);
if (!process.argv[2]?.includes('issue-303/.qa-data/'))
  throw Error('isolated path required');
db.pragma('foreign_keys=ON');
const put = (table, row) =>
  db
    .prepare(
      `INSERT INTO ${table} (${Object.keys(row)}) VALUES (${Object.keys(row).map(() => '?')})`,
    )
    .run(...Object.values(row));
const now = 1792500000;
const fs = require('node:fs'),
  path = require('node:path');
fs.mkdirSync(path.join(path.dirname(process.argv[2]), 'documents'), {
  recursive: true,
});
const png = require('./png.cjs');
for (let i = 1; i <= 600; i++)
  fs.writeFileSync(
    path.join(path.dirname(process.argv[2]), `documents/synthetic-${i}.png`),
    png(i),
  );
db.transaction(() => {
  put('api_token', {
    token_hash: createHash('sha256')
      .update('synthetic-303-local-only')
      .digest('hex'),
    label: 'synthetic QA only',
  });
  for (let i = 1; i <= 450; i++)
    put('entity', {
      id: i,
      role: i > 300 ? 'customer' : 'supplier',
      country: 'EE',
      name: `SYNTHETIC ${i % 17 === 0 ? 'Põhja-Eesti Kalamaja Väga Pikk Tarnija Nimetus Rahvusvaheline Teenindus ja Kaubandus Osaühing' : 'Tarnija'} ${i}`,
      created_at: now,
      updated_at: now,
    });
  for (let i = 1; i <= 1200; i++)
    put('expense', {
      id: i,
      supplier_id: 1 + (i % 300),
      category: 'software',
      gross_amount: i === 1200 ? 1234567890 : 1 + i * 101,
      vat_amount: 0,
      currency: i % 20 === 0 ? 'USD' : 'EUR',
      tax_point_date: `${i % 2 ? 2025 : 2026}-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
      supplier_invoice_number: `SYNTHETIC-INVOICE-303-${String(i).padStart(6, '0')}-LONG-IDENTIFIER`,
      status: i <= 400 ? 'pending' : 'draft',
      created_at: now + i,
      updated_at: now + i,
    });
  for (let i = 1; i <= 400; i++)
    put('approval', {
      id: i,
      object_type: 'expense',
      object_id: i,
      status: 'pending',
      requested_by: 'synthetic QA',
      created_at: now + i,
    });
  for (let i = 1; i <= 600; i++) {
    put('document', {
      id: i,
      hash: createHash('sha256').update(png(i)).digest('hex'),
      filename: `SYNTHETIC-${i}-Põhja-Eesti-very-long-source-document-identifier-for-desktop-queue.png`,
      mime_type: 'image/png',
      size_bytes: png(i).length,
      storage_path: `synthetic-${i}.png`,
      status: 'needs_triage',
      created_at: now + i,
    });
    put('audit_finding', {
      finding_type: 'needs_triage',
      severity: 'low',
      description: 'SYNTHETIC QA: manual classification required',
      referenced_object_type: 'document',
      referenced_object_id: i,
      status: 'open',
      created_at: now + i,
      reason_type: 'unrecognized_document',
    });
  }
  const account =
    db.prepare("SELECT id FROM account WHERE code='BANK_EUR' LIMIT 1").get() ||
    db.prepare('SELECT id FROM account LIMIT 1').get();
  for (let i = 1; i <= 24; i++)
    put('bank_statement', {
      id: i,
      account_id: account.id,
      start_date: '2026-09-01',
      end_date: '2026-09-30',
      uploaded_at: now + i,
    });
  for (let i = 1; i <= 1000; i++)
    put('bank_transaction', {
      id: i,
      statement_id: 3,
      account_id: account.id,
      transaction_date: `2026-09-${String(1 + (i % 30)).padStart(2, '0')}`,
      description: `SYNTHETIC ${i % 17 === 0 ? 'Kalamaja Põhja-Eesti long counterparty description for reconciliation' : 'payment'} ${i}`,
      reference: `SYNTHETIC-BANK-REF-${String(i).padStart(6, '0')}`,
      amount: -(1 + i * 101),
      currency: 'EUR',
      status: 'open',
      created_at: now + i,
    });
})();
console.log(
  JSON.stringify({
    synthetic: true,
    entities: 450,
    expenses: 1200,
    pendingApprovals: 400,
    triageDocuments: 600,
    bankStatements: 24,
    bankLines: 1000,
    foreignKeyCheck: db.pragma('foreign_key_check'),
  }),
);
