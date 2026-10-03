// Vite `?url` import of the bundled pdf.js worker (issue #257): the worker is
// emitted as a local asset — never loaded from a CDN.
declare module 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url' {
  const src: string;
  export default src;
}
