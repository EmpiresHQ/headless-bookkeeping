// Real HTTP fault injector + production asset server. Never simulates an API success.
const http = require('node:http'),
  fs = require('node:fs'),
  path = require('node:path');
const DB = require('better-sqlite3');
const root = process.cwd();
if (!root.endsWith('/issue-300')) throw Error('isolated issue-300 required');
const assets = path.join(root, 'packages/web/dist');
const db = new DB(path.join(root, 'data/qa-300/app.sqlite'), {
  readonly: true,
});
let rule = null,
  events = [],
  held = [];
const snapshot = () =>
  Object.fromEntries(
    [
      'document',
      'document_source',
      'expense',
      'voucher',
      'voucher_line',
      'reconciliation_match',
      'approval',
      'audit_log',
    ].map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()]),
  );
const json = (res, value) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};
const record = (e) => {
  events.push({ at: new Date().toISOString(), ...e });
  console.log(JSON.stringify(events.at(-1)));
};
http
  .createServer(async (req, res) => {
    if (req.url.startsWith('/__qa/')) {
      let body = '';
      for await (const b of req) body += b;
      if (req.url === '/__qa/arm') {
        rule = JSON.parse(body);
        return json(res, { armed: rule });
      }
      if (req.url === '/__qa/release') {
        for (const go of held.splice(0)) go();
        return json(res, { released: true });
      }
      if (req.url === '/__qa/state')
        return json(res, {
          snapshot: snapshot(),
          events,
          rule,
          held: held.length,
        });
      return json(res, { unknown: true });
    }
    if (/^\/(api|admin|health)(\/|$)/.test(req.url)) {
      const chosen =
        rule &&
        req.method === (rule.method || 'POST') &&
        new RegExp(rule.path).test(req.url)
          ? rule
          : null;
      if (chosen) {
        rule = null;
        record({
          event: 'fault-selected',
          method: req.method,
          url: req.url,
          mode: chosen.mode,
        });
      }
      const drop = () => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': '99999',
        });
        res.write('{');
        setTimeout(() => res.destroy(), 20);
      };
      if (chosen?.mode === 'before') {
        req.resume();
        record({ event: 'not-forwarded', method: req.method, url: req.url });
        return drop();
      }
      const forward = () => {
        const up = http.request(
          {
            hostname: '127.0.0.1',
            port: 4300,
            path: req.url,
            method: req.method,
            headers: { ...req.headers, host: '127.0.0.1:4300' },
          },
          (r) => {
            const parts = [];
            r.on('data', (b) => parts.push(b));
            r.on('end', () => {
              const buffer = Buffer.concat(parts);
              record({
                event: 'server-response',
                method: req.method,
                url: req.url,
                status: r.statusCode,
                bytes: buffer.length,
                body: req.method === 'POST' ? buffer.toString() : undefined,
              });
              if (chosen?.mode === 'after') return drop();
              if (chosen?.mode === 'empty-after') {
                res.destroy();
                return;
              }
              const finish = () => {
                res.writeHead(r.statusCode, r.headers);
                res.end(buffer);
              };
              if (chosen?.mode === 'hold-after') {
                held.push(finish);
                return;
              }
              finish();
            });
          },
        );
        up.on('error', (e) => {
          record({ event: 'upstream-error', message: e.message });
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        req.pipe(up);
      };
      if (chosen?.mode === 'hold-before') {
        held.push(forward);
        return;
      }
      forward();
      return;
    }
    let filename = path.join(assets, decodeURIComponent(req.url.split('?')[0]));
    if (!filename.startsWith(assets + path.sep)) {
      res.writeHead(400);
      return res.end();
    }
    if (!fs.existsSync(filename) || fs.statSync(filename).isDirectory())
      filename = path.join(assets, 'index.html');
    const type = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.wasm': 'application/wasm',
    };
    res.writeHead(200, {
      'content-type':
        type[path.extname(filename)] || 'application/octet-stream',
    });
    fs.createReadStream(filename).pipe(res);
  })
  .listen(5300, '127.0.0.1', () =>
    console.log('QA300 proxy ready :5300 -> :4300'),
  );
