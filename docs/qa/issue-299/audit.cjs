// Read-only verification of saved browser and persisted-state evidence.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const dir = __dirname;
const data = JSON.parse(
  fs.readFileSync(path.join(dir, 'results.json'), 'utf8'),
);
const expected = [
  'H1-clean-browser-back',
  'H2-dirty-browser-back',
  'H3-dirty-same-task-double-back',
  'H4-pending-same-task-double-back',
  'H5-clean-double-close',
  'H6-dirty-double-close',
  'H7-dirty-100ms-double-back',
  'H8-pending-browser-back',
  'H9-pending-no-navigation-control',
  ...['portrait', 'landscape'].flatMap((v) =>
    ['clean', 'dirty', 'pending'].map((s) => `T-${v}-${s}`),
  ),
  'C-landscape-clean-content',
  'C-landscape-dirty-content',
];
assert.equal(data.cases.length, expected.length);
const cases = expected.map((id) => {
  const records = data.cases.filter((c) => c.id === id);
  assert.equal(records.length, 1, `${id}: exactly one canonical result`);
  const c = records[0];
  assert.equal(c.harnessPass, true, `${id}: harness completed`);
  assert.match(
    c.verdict,
    /^(PASS|FAIL|UNVERIFIED): /,
    `${id}: explicit verdict required`,
  );
  assert.deepEqual(c.pageErrors, []);
  const requests = c.events.filter(
    (e) =>
      e.event === 'server-response' &&
      e.method === 'POST' &&
      e.url === '/api/expenses',
  );
  assert.equal(
    requests.length,
    c.state === 'pending' ? (c.retryAfterAbort ? 2 : 1) : 0,
  );
  for (const table of Object.keys(c.before)) {
    if (
      ['expense', 'expense_create_operation'].includes(table) &&
      c.state === 'pending'
    ) {
      const key = table === 'expense' ? 'id' : 'operation_key';
      assert.deepEqual(
        c.after[table].filter((row) =>
          c.before[table].some((old) => old[key] === row[key]),
        ),
        c.before[table],
        `${id}: existing ${table} rows unchanged`,
      );
      continue;
    }
    assert.deepEqual(
      c.after[table],
      c.before[table],
      `${id}: ${table} unchanged`,
    );
  }
  const inserted = c.after.expense.filter(
    (e) => !c.before.expense.some((b) => b.id === e.id),
  );
  const ops = c.after.expense_create_operation.filter(
    (e) =>
      !c.before.expense_create_operation.some(
        (b) => b.operation_key === e.operation_key,
      ),
  );
  assert.equal(inserted.length, c.state === 'pending' ? 1 : 0);
  assert.equal(ops.length, inserted.length);
  if (inserted.length) {
    assert.equal(inserted[0].status, 'draft');
    assert.equal(inserted[0].gross_amount, 4567);
    assert.equal(inserted[0].vat_amount, 0);
    assert.equal(inserted[0].voucher_id, null);
    assert.equal(ops[0].expense_id, inserted[0].id);
    for (const r of requests) {
      assert.equal(r.status, 201);
      assert.equal(r.operationKey, ops[0].operation_key);
      assert.equal(JSON.parse(r.body).id, inserted[0].id);
    }
  }
  if (id === 'H4-pending-same-task-double-back') {
    assert.match(c.verdict, /^FAIL:/);
    assert.equal(c.retryAfterAbort, true);
    assert.ok(
      c.networkFailures.some(
        (n) =>
          n.failure.errorText === 'net::ERR_ABORTED' &&
          n.url.endsWith('/api/expenses'),
      ),
    );
    assert.ok(c.pendingText.includes('Creation was not confirmed'));
    assert.match(c.final.url, new RegExp(`/books/expenses/${inserted[0].id}$`));
  } else if (id.startsWith('C-')) {
    assert.match(c.verdict, /^UNVERIFIED:/);
    assert.ok(
      c.afterAction.scroll.top < c.open.scroll.top,
      'content actually scrolled',
    );
    assert.ok(
      c.afterAction.events.touch.some((e) => e.type === 'pointercancel'),
    );
  } else assert.match(c.verdict, /^PASS:/);
  assert.equal(c.afterAction.heading, 'Books');
  assert.equal(c.afterAction.historyState.idx, c.open.historyState.idx);
  assert.equal(new URL(c.afterAction.url).pathname, '/books');
  return {
    id,
    harnessPass: c.harnessPass,
    verdict: c.verdict,
    createRequests: requests.length,
    newExpenses: inserted.map((e) => e.id),
    newOperationKeys: ops.map((e) => e.operation_key),
    scrollBefore: c.open.scroll,
    scrollAfter: c.afterAction.scroll,
    touchPeak: c.drag?.peak ?? null,
    networkFailures: c.networkFailures ?? [],
  };
});
const summary = {
  harnessPass: true,
  total: cases.length,
  pass: cases.filter((c) => c.verdict.startsWith('PASS:')).length,
  fail: cases.filter((c) => c.verdict.startsWith('FAIL:')).length,
  unverified: cases.filter((c) => c.verdict.startsWith('UNVERIFIED:')).length,
  physicalGesture: 'UNVERIFIED',
  nativeSystemBack: 'UNVERIFIED',
  osKeyboard: 'UNVERIFIED',
  cases,
};
const output = JSON.stringify(summary, null, 2) + '\n';
if (process.argv.includes('--write'))
  fs.writeFileSync(path.join(dir, 'audit.json'), output);
else
  assert.equal(
    fs.readFileSync(path.join(dir, 'audit.json'), 'utf8'),
    output,
    'derived audit matches source',
  );
console.log(
  JSON.stringify({
    harnessPass: summary.harnessPass,
    total: summary.total,
    pass: summary.pass,
    fail: summary.fail,
    unverified: summary.unverified,
  }),
);
