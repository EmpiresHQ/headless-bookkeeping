// QA-011 re-run (#304): in-page /preview mock + identity tracking + per-frame image monitor.
// Injected before the app. Nothing here reaches the network.
(() => {
  const qa = (window.__qa = {
    seq: 0, plans: {}, gates: {}, reqs: [], urls: {}, created: 0, revoked: 0,
    expectLightbox: null, fails: [], broken: [], brokenDom: 0, samples: 0, frames: 0, domChecks: 0,
    wrongByWidth: 0, stateLog: [],
  });
  const now = () => Math.round(performance.now());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const origFetch = window.fetch.bind(window);
  async function png(id, variant, seq) {
    const w = (variant === 'lg' ? 600 : 60) + (id % 100), h = variant === 'lg' ? 800 : 80;
    const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
    g.fillStyle = `hsl(${(id * 47) % 360} 60% 70%)`; g.fillRect(0, 0, w, h);
    g.fillStyle = '#000'; g.font = `${variant === 'lg' ? 40 : 10}px sans-serif`;
    g.fillText(`${id} ${variant}`, 4, h / 2);
    const b = await c.convertToBlob({ type: 'image/png' });
    // Trailing bytes after IEND are ignored by decoders: carry the request identity.
    return new Blob([b, `QA|${id}|${variant}|${seq}|`.padEnd(32, '.')], { type: 'image/png' });
  }
  qa.release = (gate) => { const r = qa.gates[gate]; if (!r) return false; delete qa.gates[gate]; r(); return true; };
  qa.pendingGates = () => Object.keys(qa.gates);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const m = url.pathname.match(/^\/api\/documents\/(\d+)\/preview$/);
    if (!m) return origFetch(input, init);
    const id = +m[1], variant = url.searchParams.get('size') === 'lg' ? 'lg' : 'thumb', key = `${id}:${variant}`;
    if (window.__qaPre) { for (const [k, v] of Object.entries(window.__qaPre)) (qa.plans[k] ||= []).push(...v); window.__qaPre = null; }
    const step = (qa.plans[key] && qa.plans[key].shift()) || { kind: 'ok' };
    const seq = ++qa.seq;
    const rec = { seq, key, kind: step.kind, gate: step.gate || null, start: now(), settle: null };
    qa.reqs.push(rec);
    if (step.gate) await new Promise((r) => (qa.gates[step.gate] = r));
    if (step.delay) await sleep(step.delay);
    rec.settle = now();
    if (step.kind === '500') return new Response('{"message":"QA injected render failure"}', { status: 500, headers: { 'content-type': 'application/json' } });
    if (step.kind === '404') return new Response('{"message":"No preview"}', { status: 404, headers: { 'content-type': 'application/json' } });
    if (step.kind === 'broken') return new Response(new Blob([`this is not a png ${seq}`]), { status: 200, headers: { 'content-type': 'image/png' } });
    if (step.kind === 'neterr') throw new TypeError('Failed to fetch');
    const body = await png(id, variant, seq);
    if (step.kind === 'slowbody') {
      // Headers now, bytes trickled over `bodyMs` (slow download).
      const bytes = new Uint8Array(await body.arrayBuffer()), n = 8, ms = step.bodyMs || 600;
      const stream = new ReadableStream({ async start(ctl) {
        for (let i = 0; i < n; i++) { await sleep(ms / n); ctl.enqueue(bytes.slice(Math.floor((i * bytes.length) / n), Math.floor(((i + 1) * bytes.length) / n))); }
        rec.bodyDone = now(); ctl.close();
      } });
      return new Response(stream, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (obj) => {
    const u = create(obj); qa.created++;
    const info = (qa.urls[u] = { created: now(), revoked: null, id: null, variant: null, seq: null });
    if (obj instanceof Blob && obj.type === 'image/png') {
      obj.slice(-32).text().then((t) => { const p = t.split('|'); if (p[0] === 'QA') Object.assign(info, { id: +p[1], variant: p[2], seq: +p[3] }); else info.id = 'unmarked'; });
    }
    return u;
  };
  URL.revokeObjectURL = (u) => { const i = qa.urls[u]; if (i && i.revoked === null) { i.revoked = now(); qa.revoked++; } return revoke(u); };

  // Which document an <img> must show, from where it is.
  const idFromFilename = (t) => { const m = /qa-doc-(\d+)\.pdf/.exec(t || ''); return m ? +m[1] : null; };
  function expected(img) {
    if (img.closest('[role=dialog]')) return { where: 'lightbox', id: qa.expectLightbox ?? screenId() };
    // A list row: the nearest ancestor holding exactly one document link.
    for (let el = img.parentElement; el && el !== document.body; el = el.parentElement) {
      const links = el.querySelectorAll('a[href^="/inbox/doc/"], a[href^="/books/documents/"]');
      if (links.length === 1) return { where: 'row', id: +links[0].getAttribute('href').split(/[/?#]/)[3] };
      if (links.length > 1) break;
    }
    return { where: 'screen', id: screenId() };
  }
  // The rendered document (not the URL: a replace-advance changes the URL one commit early).
  function screenId() {
    const h = document.querySelector('h1[data-screen-title]');
    return idFromFilename(h?.getAttribute('aria-label') || h?.textContent);
  }
  let last = '';
  function check(kind) {
    const imgs = [...document.querySelectorAll('img')].filter((i) => i.src.startsWith('blob:'));
    const snap = [];
    for (const img of imgs) {
      const exp = expected(img), info = qa.urls[img.src];
      if (info) info.shown = true;
      const broken = img.complete && img.naturalWidth === 0;
      let byWidth = null;
      if (img.naturalWidth > 0) { const w = img.naturalWidth; byWidth = { variant: w >= 600 ? 'lg' : 'thumb', mod: (w >= 600 ? w - 600 : w - 60) }; }
      const f = [];
      if (!info) f.push('unknown-url');
      else {
        if (info.id !== null && info.id !== 'unmarked' && exp.id !== null && info.id !== exp.id) f.push(`blob-of-${info.id}-expected-${exp.id}`);
        if (info.revoked !== null && !(img.complete && img.naturalWidth > 0)) f.push('revoked-before-decode');
      }
      if (byWidth && exp.id !== null && byWidth.mod !== exp.id % 100) { f.push(`pixels-of-${byWidth.mod}-expected-${exp.id % 100}`); qa.wrongByWidth++; }
      if (f.length) qa.fails.push({ t: now(), kind, where: exp.where, exp: exp.id, src: img.src.slice(-8), f, path: location.pathname });
      if (broken) {
        const r = img.getBoundingClientRect();
        if (kind === 'raf') qa.broken.push({ t: now(), where: exp.where, exp: exp.id, seq: info?.seq ?? null, rect: `${Math.round(r.width)}x${Math.round(r.height)}` });
        else qa.brokenDom++;
      }
      snap.push(`${exp.where}:${exp.id}=${info ? `${info.id}/${info.variant}` : '?'}${broken ? '!broken' : img.naturalWidth ? '' : '~0x0'}`);
    }
    if (kind === 'raf') { qa.samples += imgs.length; qa.frames++; } else qa.domChecks++;
    const s = snap.join(' ');
    if (s !== last) { last = s; qa.stateLog.push(`${now()} ${kind} ${location.pathname} ${s || '(no blob img)'}`); if (qa.stateLog.length > 4000) qa.stateLog.shift(); }
  }
  const raf = () => { try { check('raf'); } catch (e) { qa.fails.push({ t: now(), monitorError: String(e) }); } requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  const start = () => {
    new MutationObserver(() => check('dom')).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
    document.addEventListener('load', (e) => e.target.tagName === 'IMG' && check('load'), true);
    document.addEventListener('error', (e) => e.target.tagName === 'IMG' && check('error'), true);
  };
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
})();
