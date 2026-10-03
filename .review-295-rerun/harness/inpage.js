// QA-012 (#305) in-page mock: /api/documents/:id/preview[?size=lg] and
// image /file bodies are drawn deterministically on an OffscreenCanvas and
// answered by a window.fetch wrapper (no network). PDFs are left to the
// Playwright route mock. Everything else passes through to the route layer.
(() => {
  try { localStorage.setItem('bk_api_token', 'review-fixture'); } catch { return; } // about:blank after a Back out of the app
  // Fixture sizes (CSS px of the drawn bitmap) per document id + variant.
  // Sizes follow the server's renderer caps (server preview-renderer.ts:
  // thumb ~256px, lg maxEdge 1600 withoutEnlargement).
  const SIZES = {
    // A4 page 1 (from a 150 dpi raster, capped to 1600)
    31001: { thumb: [181, 256], lg: [1131, 1600], file: null },
    // long thermal receipt photo 800x6000 -> capped 213x1600
    31002: { thumb: [34, 256], lg: [213, 1600], file: null },
    // very wide landscape scan 6000x1500 -> capped 1600x400
    31003: { thumb: [256, 64], lg: [1600, 400], file: null },
    // multipage PDF source (file answered by the route mock)
    31004: { thumb: [181, 256], lg: [1131, 1600], file: 'pdf' },
    // large photo source (image/png file, 3024x4032 like a phone camera)
    31005: { thumb: [192, 256], lg: [1200, 1600], file: [3024, 4032] },
  };
  const DEFAULT = { thumb: [181, 256], lg: [1131, 1600], file: null };
  const cache = new Map();
  async function draw(id, variant, w, h) {
    const key = `${id}:${variant}:${w}x${h}`;
    if (cache.has(key)) return cache.get(key);
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d');
    g.fillStyle = '#fdfdf8'; g.fillRect(0, 0, w, h);
    // grid every 100px so zoom/pan is measurable in screenshots
    g.strokeStyle = '#c9d6e8'; g.lineWidth = Math.max(1, w / 1000);
    for (let x = 0; x < w; x += 100) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y < h; y += 100) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    g.strokeStyle = '#d33'; g.lineWidth = Math.max(4, w / 200); g.strokeRect(2, 2, w - 4, h - 4);
    g.fillStyle = '#123'; const fs = Math.max(10, Math.min(w, h) / 12);
    g.font = `bold ${fs}px sans-serif`;
    g.fillText(`DOC ${id} ${variant}`, fs * 0.4, fs * 1.4);
    g.font = `${Math.max(8, fs / 3)}px sans-serif`;
    g.fillText(`${w}x${h}px`, fs * 0.4, fs * 2.2);
    // fine print lines (the part you need to zoom for)
    g.font = `${Math.max(6, w / 90)}px monospace`;
    for (let y = fs * 3; y < h - 20; y += Math.max(10, w / 60)) g.fillText(`${Math.round(y)} Artikkel 1.00 x 12,34 EUR  KM 24%  ${id}`, fs * 0.4, y);
    // corner markers
    g.fillStyle = '#0a0'; g.fillRect(w - 60, h - 60, 50, 50);
    const blob = await c.convertToBlob({ type: 'image/png' });
    cache.set(key, blob);
    return blob;
  }
  window.__pv = { reqs: [] };
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    let m = /^\/api\/documents\/(\d+)\/(preview|file)$/.exec(url.pathname);
    if (!m) return orig(input, init);
    const id = +m[1]; const spec = SIZES[id] ?? DEFAULT;
    if (m[2] === 'file' && !Array.isArray(spec.file)) return orig(input, init);
    const variant = m[2] === 'file' ? 'file' : url.searchParams.get('size') === 'lg' ? 'lg' : 'thumb';
    const [w, h] = spec[variant];
    window.__pv.reqs.push({ id, variant, t: Math.round(performance.now()) });
    const blob = await draw(id, variant, w, h);
    const headers = { 'content-type': 'image/png' };
    if (variant === 'file') headers['content-disposition'] = `attachment; filename="photo_${id}.png"`;
    return new Response(blob, { status: 200, headers });
  };
})();
