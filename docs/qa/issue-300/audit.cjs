// Read-only audit of the isolated synthetic database. No ledger modifications.
const DB = require('better-sqlite3'),
  fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  { createHash } = require('node:crypto');
if (!process.cwd().endsWith('/issue-300'))
  throw Error('isolated issue-300 worktree required');
const db = new DB(path.resolve('data/qa-300/app.sqlite'), { readonly: true });
const vouchers = db.prepare('SELECT * FROM voucher ORDER BY id').all();
let previous = '0'.repeat(64);
const chain = [];
for (const v of vouchers) {
  const lines = db
    .prepare('SELECT * FROM voucher_line WHERE voucher_id=? ORDER BY id')
    .all(v.id);
  assert.equal(
    lines.reduce(
      (sum, l) => sum + (l.is_debit ? l.base_amount : -l.base_amount),
      0,
    ),
    0,
  );
  assert.equal(v.previous_hash, previous);
  const canonical = JSON.stringify({
    voucher_number: v.voucher_number,
    tax_point_date: v.tax_point_date,
    posted_at: v.posted_at,
    lines: lines.map((l) => ({
      account_id: l.account_id,
      amount: l.amount,
      currency: l.currency,
      base_amount: l.base_amount,
      fx_rate: l.fx_rate,
      is_debit: l.is_debit ? 1 : 0,
    })),
  });
  previous = createHash('sha256')
    .update(previous + canonical)
    .digest('hex');
  chain.push({ id: v.id, number: v.voucher_number, hash: previous });
}
const duplicatePairs = db
  .prepare(
    'SELECT bank_transaction_id,voucher_id,count(*) n FROM reconciliation_match GROUP BY bank_transaction_id,voucher_id HAVING count(*)>1',
  )
  .all();
assert.equal(duplicatePairs.length, 0);
const overAllocated = db
  .prepare(
    "SELECT t.id,t.amount,sum(m.amount_matched) allocated FROM bank_transaction t JOIN reconciliation_match m ON m.bank_transaction_id=t.id WHERE m.status='active' GROUP BY t.id HAVING sum(m.amount_matched)>abs(t.amount)",
  )
  .all();
assert.equal(overAllocated.length, 0);
const counts = Object.fromEntries(
  [
    'expense',
    'document',
    'document_source',
    'voucher',
    'voucher_line',
    'approval',
    'reconciliation_match',
  ].map((t) => [t, db.prepare(`SELECT count(*) n FROM ${t}`).get().n]),
);
const evidence = JSON.parse(fs.readFileSync('docs/qa/issue-300/results.json'));
const cases = evidence.cases.map((c) => ({
  id: c.id,
  harnessPass: c.harnessPass,
  verdict: c.verdict || 'PASS',
  before: c.before,
  after: c.after,
  mutations: c.events
    .filter(
      (e) =>
        e.method === 'POST' &&
        e.event === 'server-response' &&
        !e.url.includes('propose-matches'),
    )
    .map((e) => ({ url: e.url, status: e.status })),
  duplicateDrafts: c.draftsAfterOneClick || c.draftsAfterOneFetch,
}));
assert.ok(
  evidence.cases.every((c) => c.harnessPass),
  'Harness error remains',
);
const result = {
  synthetic: true,
  foreignKeyCheck: db.pragma('foreign_key_check'),
  integrityCheck: db.pragma('integrity_check'),
  counts,
  balancedVouchers: chain.length,
  hashChain: chain,
  duplicatePairs,
  overAllocated,
  cases,
};
assert.equal(result.foreignKeyCheck.length, 0);
assert.deepEqual(result.integrityCheck, [{ integrity_check: 'ok' }]);
fs.writeFileSync(
  'docs/qa/issue-300/audit.json',
  JSON.stringify(result, null, 2) + '\n',
);
console.log(
  JSON.stringify(
    {
      counts,
      balancedVouchers: chain.length,
      hashChainValid: true,
      duplicatePairs,
      overAllocated,
      cases: cases.length,
      confirmedDefectCases: cases
        .filter((c) => c.verdict.startsWith('FAIL'))
        .map((c) => c.id),
    },
    null,
    2,
  ),
);
