import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, normalize, sep } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * pdf.js resource files the source viewer (issue #257) needs for a COMPLETE
 * page: Adobe CMaps (CJK text), the standard 14 fonts (PDFs that do not embed
 * them), JPEG2000/JBIG2/colour-management wasm (scanned documents) and ICC
 * profiles. pdf.js loads them by original filename from a base URL, so they
 * are served in dev and emitted into the build under /pdfjs/<version>/ from
 * the installed package — never a CDN. quickjs-eval (PDF scripting) is not
 * shipped: the viewer runs no document JavaScript.
 */
function pdfjsAssets(): Plugin {
  const pkgDir = dirname(
    createRequire(import.meta.url).resolve('pdfjs-dist/package.json'),
  );
  const { version } = JSON.parse(
    readFileSync(join(pkgDir, 'package.json'), 'utf8'),
  ) as { version: string };
  const dirs = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
  const files = dirs.flatMap((d) =>
    readdirSync(join(pkgDir, d))
      .filter((f) => !f.startsWith('quickjs-eval'))
      .map((f) => `${d}/${f}`),
  );
  const prefix = `/pdfjs/${version}/`;
  const known = new Set(files);
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0] ?? '';
        if (!path.startsWith(prefix)) return next();
        const rel = normalize(path.slice(prefix.length)).split(sep).join('/');
        if (!known.has(rel)) return next();
        const abs = join(pkgDir, rel);
        res.setHeader('Content-Length', statSync(abs).size);
        if (rel.endsWith('.wasm')) {
          res.setHeader('Content-Type', 'application/wasm');
        }
        createReadStream(abs).pipe(res);
      });
    },
    generateBundle() {
      for (const rel of files) {
        this.emitFile({
          type: 'asset',
          fileName: `pdfjs/${version}/${rel}`,
          source: readFileSync(join(pkgDir, rel)),
        });
      }
    },
  };
}

// Dev: proxy API + admin to the running Nest server so the SPA works against a
// local backend without a rebuild. Prod build is served by serve-static at /.
export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/admin': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
  test: {
    globals: true,
    // Wraps the built-in jsdom environment to keep Node's native fetch
    // working under react-router v7 data routers — see the file for why.
    environment: './test/jsdomFetchSafeEnvironment.ts',
    setupFiles: ['./src/test-setup.ts'],
  },
});
