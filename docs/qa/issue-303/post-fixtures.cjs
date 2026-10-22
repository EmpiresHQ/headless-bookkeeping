// Only synthetic local fixtures; normal pipeline and approval API, no SQL ledger writes.
const fs = require('node:fs');
const base = 'http://127.0.0.1:4303';
const headers = {
  Authorization: 'Bearer synthetic-303-local-only',
  'Content-Type': 'application/json',
};
async function api(path, body) {
  const r = await fetch(base + path, {
    headers,
    method: body ? 'POST' : 'GET',
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw Error(`${path} ${r.status} ${JSON.stringify(j)}`);
  return j;
}
(async () => {
  const log = [];
  for (let id = 401; id <= 431; id++) {
    if (id === 420) continue;
    let e = await api('/api/expenses/' + id);
    if (e.status === 'draft') await api(`/api/expenses/${id}/post`, {});
    e = await api('/api/expenses/' + id);
    if (e.status === 'pending') {
      const approvals = await api('/api/approvals?status=pending');
      const list = Array.isArray(approvals) ? approvals : approvals.approvals;
      const a = list.find(
        (a) => a.object_type === 'expense' && a.object_id === id,
      );
      await api(`/api/approvals/${a.id}/approve`, {
        approved_by: 'SYNTHETIC QA',
      });
    }
    e = await api('/api/expenses/' + id);
    if (e.status !== 'posted') throw Error('not posted ' + id);
    log.push({ expenseId: id, voucherId: e.voucher_id });
  }
  fs.writeFileSync(
    __dirname + '/posted-fixtures.json',
    JSON.stringify(log, null, 2),
  );
  console.log('posted', log.length);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
