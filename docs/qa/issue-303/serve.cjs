// Production assets + real loopback backend proxy; no mocked responses.
const http = require('node:http'),
  fs = require('node:fs'),
  path = require('node:path');
const root = path.resolve('packages/web/dist');
http
  .createServer((req, res) => {
    if (/^\/(api|admin|health)(\/|$)/.test(req.url)) {
      const upstream = http.request(
        {
          hostname: '127.0.0.1',
          port: 4303,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (r) => {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        },
      );
      upstream.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
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
      '.bcmap': 'application/octet-stream',
    };
    res.writeHead(200, {
      'content-type': types[path.extname(p)] || 'application/octet-stream',
    });
    fs.createReadStream(p).pipe(res);
  })
  .listen(5303, '127.0.0.1');
