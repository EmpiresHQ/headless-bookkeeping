// packages/server/test/pdf-text-extraction-runner.cjs
//
// Child-process runner for the REAL-PDF layout regression (issue #405).
// pdf.js (bundled inside pdf-parse) misbehaves under the jest/ts-node module
// loaders ("bad XRef entry"), so the layout spec spawns this plain-Node
// runner instead: it transpiles the ACTUAL PdfTextExtractor source with the
// repo's TypeScript compiler, runs the real extract() over the PDF bytes
// passed as base64, and prints the extracted text as JSON on stdout.
//
// Paths are derived from THIS file's own location (packages/server/test),
// never from the caller's cwd or jest's rewritten __dirname.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire, Module } = require('node:module');

// packages/server/test → packages/server.
const serverDir = path.resolve(__dirname, '..');
const req = createRequire(path.join(serverDir, 'package.json'));
const ts = req('typescript');

const filename = path.join(serverDir, 'src', 'triage', 'pdf-text-extractor.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.CommonJS,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    esModuleInterop: true,
  },
}).outputText;
const target = new Module(filename, module);
target.filename = filename;
target.paths = Module._nodeModulePaths(path.dirname(filename));
target._compile(compiled, filename);
const { PdfTextExtractor } = target.exports;

new PdfTextExtractor()
  .extract(Buffer.from(process.argv[2], 'base64'))
  .then((raw) => process.stdout.write(JSON.stringify(raw)))
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
