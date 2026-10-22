// Production assets + actual isolated backend; no mocked GET responses.
const http = require('node:http'),
  fs = require('node:fs'),
  path = require('node:path');
const root = path.resolve('packages/web/dist');
http
  .createServer((req, res) => {
    if (/^\/(api|admin|health)(\/|$)/.test(req.url)) {
      const up = http.request(
        {
          hostname: '127.0.0.1',
          port: 4297,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (r) => {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        },
      );
      up.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(up);
      return;
    }
    let p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(root + path.sep)) {
      res.writeHead(400);
      res.end();
      return;
    }
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory())
      p = path.join(root, 'index.html');
    const types = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.wasm': 'application/wasm',
    };
    res.writeHead(200, {
      'content-type': types[path.extname(p)] || 'application/octet-stream',
    });
    fs.createReadStream(p).pipe(res);
  })
  .listen(5297, '127.0.0.1');
