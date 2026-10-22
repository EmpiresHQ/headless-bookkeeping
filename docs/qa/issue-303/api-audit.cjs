const fs = require('node:fs');
(async () => {
  const paths = [
    '/api/expenses',
    '/api/triage/needs-triage',
    '/api/approvals?status=pending',
    '/api/bank-statements',
    '/api/bank-statements/3/transactions',
  ];
  const rows = [];
  for (const path of paths) {
    const t = performance.now();
    const r = await fetch('http://127.0.0.1:4303' + path, {
      headers: { Authorization: 'Bearer synthetic-303-local-only' },
    });
    const text = await r.text();
    const j = JSON.parse(text);
    rows.push({
      path,
      status: r.status,
      ms: Math.round(performance.now() - t),
      bytes: Buffer.byteLength(text),
      counts: Array.isArray(j)
        ? { array: j.length }
        : Object.fromEntries(
            Object.entries(j)
              .filter(([, v]) => Array.isArray(v))
              .map(([k, v]) => [k, v.length]),
          ),
    });
  }
  fs.writeFileSync(
    __dirname + '/api-audit.json',
    JSON.stringify(rows, null, 2),
  );
  console.log(rows);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
