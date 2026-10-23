const http = require('node:http'),
  fs = require('node:fs'),
  path = require('node:path');
const root = path.resolve('packages/web/dist');
http
  .createServer((req, res) => {
    if (/^\/(api|admin|health)(\/|$)/.test(req.url)) {
      const p = http.request(
        {
          hostname: '127.0.0.1',
          port: 4302,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (r) => {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        },
      );
      p.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(p);
      return;
    }
    let f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(root + path.sep)) {
      res.writeHead(400);
      res.end();
      return;
    }
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory())
      f = path.join(root, 'index.html');
    res.writeHead(200, {
      'content-type':
        {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
          '.wasm': 'application/wasm',
        }[path.extname(f)] || 'application/octet-stream',
    });
    fs.createReadStream(f).pipe(res);
  })
  .listen(5302, '127.0.0.1');
