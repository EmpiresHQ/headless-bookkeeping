// QA-011 re-run (#304): preview switch-race matrix. VIEWPORTS=1440x900,1920x1080,390x844m CASES=S1,...
import fs from 'node:fs/promises';
import { launch, setup, base, plan, prePlan, release, waitGate, counters, fname } from './common.mjs';
const VIEWPORTS = (process.env.VIEWPORTS || '1440x900,1920x1080,390x844m').split(',').map((v) => { const m = /^(\d+)x(\d+)(m?)$/.exec(v); return { width: +m[1], height: +m[2], mobile: !!m[3], label: v }; });
const CASES = (process.env.CASES || 'S1,S2,S3,S4,S5,S6,S7,S8,S9,S10,S11,S12,S13').split(',');
const OUT = process.env.OUT || '../results.json';
const SHOTS = process.env.SHOTS || '..';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

// ── UI helpers ──────────────────────────────────────────────────────────────
const main = (p) => p.locator('main');
const screenId = (p) => p.evaluate(() => { const h = document.querySelector('h1[data-screen-title]'); const m = /qa-doc-(\d+)/.exec(h?.getAttribute('aria-label') || ''); return m ? +m[1] : null; });
async function waitScreen(p, id) { await p.waitForFunction((i) => (document.querySelector('h1[data-screen-title]')?.getAttribute('aria-label') || '').includes(`qa-doc-${i}.pdf`), id, { timeout: 8000 }); }
/** The Source document row: shown image (blob identity + decoded width) or placeholder label. */
const rowState = (p) => p.evaluate(() => {
  const row = [...document.querySelectorAll('main li, main button, main a')].find((e) => /Source document/.test(e.textContent || '') && e.querySelector('img, span[aria-label]'));
  if (!row) return { none: true };
  const img = row.querySelector('img'); const q = window.__qa;
  if (img) { const i = q.urls[img.src]; return { img: true, id: i?.id ?? null, variant: i?.variant ?? null, w: img.naturalWidth, complete: img.complete }; }
  return { label: row.querySelector('span[aria-label]')?.getAttribute('aria-label') };
});
const dialogState = (p) => p.evaluate(() => {
  const d = document.querySelector('[role=dialog]'); if (!d) return { open: false };
  const img = d.querySelector('img'); const i = img ? window.__qa.urls[img.src] : null;
  const retry = [...d.querySelectorAll('button')].find((b) => /^(Retry|Retrying…)$/.test(b.textContent.trim()));
  return { open: true, img: !!img, id: i?.id ?? null, variant: i?.variant ?? null, w: img?.naturalWidth ?? 0, note: d.querySelector('[role=status]')?.textContent || '', retry: retry?.textContent.trim() ?? null };
});
async function openInbox(p) { await p.goto(base + '/inbox'); await main(p).locator('a[href^="/inbox/doc/"]').first().waitFor(); await p.waitForTimeout(300); }
async function openDoc(p, id) { await main(p).locator(`a[href="/inbox/doc/${id}"]`).click(); await waitScreen(p, id); }
async function advance(p, nextId) {
  await main(p).getByRole('button', { name: 'Archive without booking' }).last().click();
  await p.getByRole('alertdialog').getByRole('button', { name: 'Archive document' }).click();
  if (nextId) await waitScreen(p, nextId);
}
async function openPreview(p) { await main(p).getByText('Source document').click(); await p.getByRole('dialog').waitFor(); }
async function closePreview(p) { await p.getByRole('button', { name: 'Close preview' }).click(); await p.getByRole('dialog').waitFor({ state: 'detached' }); }
async function until(p, fn, what, timeout = 5000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) { last = await fn(); if (last.ok) return last; await sleep(25); }
  throw new Error(`timeout: ${what} — last ${JSON.stringify(last)}`);
}
const reqsFor = (p, key) => p.evaluate((k) => window.__qa.reqs.filter((r) => r.key === k), key);
const urlOfSeq = (p, seq) => p.evaluate((s) => Object.values(window.__qa.urls).find((u) => u.seq === s) ?? null, seq);
const sameMsRevoke = async (p, key) => { const r = (await reqsFor(p, key)).at(-1); const u = await urlOfSeq(p, r.seq); return { seq: r.seq, created: u?.created, revoked: u?.revoked, deltaMs: u && u.revoked !== null ? u.revoked - u.created : null, shown: !!u?.shown, same: !!u && u.revoked !== null && !u.shown }; };
function check(cond, msg, detail) { if (!cond) throw new Error(msg + ' ' + JSON.stringify(detail ?? '')); return detail; }

// ── Cases ──────────────────────────────────────────────────────────────────
const cases = {
  async S1(p, s) { // slow thumb; the same screen switches to B before A's answer
    await openInbox(p);
    await plan(p, '31001:thumb', [{ kind: 'ok', gate: 'A' }]); await plan(p, '31002:thumb', [{ kind: 'ok', gate: 'B' }]);
    await openDoc(p, 31001); await waitGate(p, 'A');
    s.a0 = check((await rowState(p)).label === 'loading preview', 'A placeholder', await rowState(p));
    await p.evaluate(() => { const r = [...document.querySelectorAll('main li')].find((e) => /Source document/.test(e.textContent)); if (r) r.dataset.qaTag = '1'; });
    await advance(p, 31002); await waitGate(p, 'B');
    s.sameNode = await p.evaluate(() => !!document.querySelector('main li[data-qa-tag="1"]'));
    await release(p, 'A'); await p.waitForTimeout(300);
    s.afterStaleA = check((await rowState(p)).label === 'loading preview', 'B placeholder after stale A', await rowState(p));
    s.staleA = check((await sameMsRevoke(p, '31001:thumb')).same, 'A revoked on arrival', await sameMsRevoke(p, '31001:thumb'));
    await release(p, 'B');
    s.b = (await until(p, async () => { const r = await rowState(p); return { ok: r.img && r.id === 31002 && r.w === 62, r }; }, 'B thumb')).r;
  },
  async S2(p, s) { // fast A→B→C→D, answers out of order (B, D, then C after D)
    await openInbox(p);
    await openDoc(p, 31001);
    await until(p, async () => { const r = await rowState(p); return { ok: r.img && r.id === 31001, r }; }, 'A thumb');
    for (const [id, g] of [[31002, 'B'], [31003, 'C'], [31004, 'D']]) await plan(p, `${id}:thumb`, [{ kind: 'ok', gate: g }]);
    const t0 = Date.now(); await advance(p, 31002); await advance(p, 31003); await advance(p, 31004); s.advanceMs = Date.now() - t0;
    for (const g of ['B', 'C', 'D']) await waitGate(p, g);
    await release(p, 'B'); await p.waitForTimeout(250);
    s.afterB = check((await rowState(p)).label === 'loading preview', 'D placeholder after stale B', await rowState(p));
    await release(p, 'D');
    s.d = (await until(p, async () => { const r = await rowState(p); return { ok: r.img && r.id === 31004, r }; }, 'D thumb')).r;
    await release(p, 'C'); await p.waitForTimeout(300);
    s.afterC = check((await rowState(p)).id === 31004, 'still D after stale C', await rowState(p));
    s.staleB = await sameMsRevoke(p, '31002:thumb'); s.staleC = await sameMsRevoke(p, '31003:thumb');
    check(s.staleB.same && s.staleC.same, 'stale B/C revoked on arrival', [s.staleB, s.staleC]);
  },
  async S3(p, s) { // slow lg: close/reopen while pending, answer while open, reopen after
    await openInbox(p);
    await plan(p, '31001:lg', [{ kind: 'ok', gate: 'L' }]);
    await openDoc(p, 31001);
    await until(p, async () => { const r = await rowState(p); return { ok: r.img, r }; }, 'thumb');
    await openPreview(p); await waitGate(p, 'L');
    s.pending = check((await dialogState(p)).note === 'Loading full-size preview…', 'lg loading note', await dialogState(p));
    check((await dialogState(p)).variant === 'thumb' && (await dialogState(p)).id === 31001, 'thumb placeholder', await dialogState(p));
    if (s.shot) await p.screenshot({ path: `${SHOTS}/s3-lg-loading-${s.vp}.jpg`, quality: 60 });
    await closePreview(p); await openPreview(p);
    s.lgReqsAfterReopen = (await reqsFor(p, '31001:lg')).length;
    check(s.lgReqsAfterReopen === 1, 'still 1 lg request after reopen', s.lgReqsAfterReopen);
    await release(p, 'L');
    s.lg = (await until(p, async () => { const d = await dialogState(p); return { ok: d.variant === 'lg' && d.id === 31001 && d.w === 601, d }; }, 'lg shown')).d;
    await closePreview(p);
    await main(p).getByText('Source document').click();
    s.firstFrame = await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => { const img = document.querySelector('[role=dialog] img'); r({ w: img?.naturalWidth ?? null, v: img ? window.__qa.urls[img.src]?.variant : null }); })));
    check(s.firstFrame.v === 'lg', 'cached lg on reopen first frame', s.firstFrame);
    check((await reqsFor(p, '31001:lg')).length === 1, 'lg fetched once');
    await closePreview(p);
  },
  async S4(p, s) { // A's lg pending when the row switches to B; B opened with thumb + lg pending
    await openInbox(p);
    await plan(p, '31001:lg', [{ kind: 'ok', gate: 'LA' }]);
    await openDoc(p, 31001);
    await until(p, async () => { const r = await rowState(p); return { ok: r.img, r }; }, 'A thumb');
    await openPreview(p); await waitGate(p, 'LA'); await closePreview(p);
    await plan(p, '31002:thumb', [{ kind: 'ok', gate: 'TB' }]); await plan(p, '31002:lg', [{ kind: 'ok', gate: 'LB' }]);
    await advance(p, 31002); await openPreview(p); await waitGate(p, 'LB');
    s.open = check((await dialogState(p)).note === 'Loading preview…' && !(await dialogState(p)).img, 'B: loading, no image', await dialogState(p));
    await release(p, 'LA'); await p.waitForTimeout(300);
    s.afterStaleLA = check(!(await dialogState(p)).img, 'B unchanged after A lg', await dialogState(p));
    if (s.shot) await p.screenshot({ path: `${SHOTS}/s4-after-stale-lg-${s.vp}.jpg`, quality: 60 });
    s.staleLA = check((await sameMsRevoke(p, '31001:lg')).same, 'A lg revoked on arrival', await sameMsRevoke(p, '31001:lg'));
    await release(p, 'TB');
    s.tb = (await until(p, async () => { const d = await dialogState(p); return { ok: d.variant === 'thumb' && d.id === 31002 && d.note === 'Loading full-size preview…', d }; }, 'B thumb + note')).d;
    await release(p, 'LB');
    s.lb = (await until(p, async () => { const d = await dialogState(p); return { ok: d.variant === 'lg' && d.id === 31002, d }; }, 'B lg')).d;
    await closePreview(p);
  },
  async S5(p, s) { // errors on the NEW document's fetch: 500 → Retry, 404, network error
    await openInbox(p);
    await plan(p, '31002:thumb', [{ kind: '500', delay: 600 }, { kind: 'ok', delay: 300 }]);
    await plan(p, '31002:lg', [{ kind: '500', delay: 600 }, { kind: 'ok', delay: 300 }]);
    await plan(p, '31003:thumb', [{ kind: '404' }]); await plan(p, '31003:lg', [{ kind: '404' }]);
    await plan(p, '31004:thumb', [{ kind: 'neterr', delay: 200 }]); await plan(p, '31004:lg', [{ kind: 'neterr', delay: 200 }]);
    await openDoc(p, 31001);
    await until(p, async () => { const r = await rowState(p); return { ok: r.img, r }; }, 'A thumb');
    await advance(p, 31002);
    s.loading = (await rowState(p)).label;
    s.failed = (await until(p, async () => { const r = await rowState(p); return { ok: r.label === 'preview failed to load', r }; }, '500 → failed')).r;
    await openPreview(p);
    s.dlgErr = (await until(p, async () => { const d = await dialogState(p); return { ok: d.note === 'The preview couldn’t be loaded.' && d.retry === 'Retry' && !d.img, d }; }, 'error + Retry')).d;
    if (s.shot) await p.screenshot({ path: `${SHOTS}/s5-error-retry-${s.vp}.jpg`, quality: 60 });
    await p.getByRole('dialog').getByRole('button', { name: 'Retry' }).click();
    s.retrying = (await dialogState(p)).retry;
    s.recovered = (await until(p, async () => { const d = await dialogState(p); return { ok: d.variant === 'lg' && d.id === 31002, d }; }, 'retry recovers')).d;
    s.rowRecovered = (await until(p, async () => { const r = await rowState(p); return { ok: r.img && r.id === 31002, r }; }, 'row recovers')).r;
    await closePreview(p); await advance(p, 31003);
    s.r404 = (await until(p, async () => { const r = await rowState(p); return { ok: r.label === 'no preview', r }; }, '404 → no preview')).r;
    await openPreview(p);
    s.d404 = (await until(p, async () => { const d = await dialogState(p); return { ok: /^No preview is available/.test(d.note) && !d.img, d }; }, '404 dialog')).d;
    await closePreview(p); await advance(p, 31004);
    s.neterr = (await until(p, async () => { const r = await rowState(p); return { ok: r.label === 'preview failed to load', r }; }, 'network error → failed')).r;
    await openPreview(p);
    s.dNeterr = (await until(p, async () => { const d = await dialogState(p); return { ok: d.note === 'The preview couldn’t be loaded.' && d.retry === 'Retry', d }; }, 'neterr dialog')).d;
    await closePreview(p);
  },
  async S6(p, s) { // undecodable 200 image/png bytes (row + lightbox); D2 frame check
    await openInbox(p);
    await plan(p, '31002:thumb', [{ kind: 'broken', delay: 200 }]);
    await plan(p, '31002:lg', [{ kind: 'broken', delay: 200 }, { kind: 'ok', delay: 200 }]);
    await plan(p, '31003:lg', [{ kind: 'broken', delay: 200 }]);
    await openDoc(p, 31001);
    await until(p, async () => { const r = await rowState(p); return { ok: r.img, r }; }, 'A thumb');
    await advance(p, 31002);
    s.row = (await until(p, async () => { const r = await rowState(p); return { ok: r.label === 'preview failed to load', r }; }, 'broken thumb → failed')).r;
    await openPreview(p);
    s.dlg = (await until(p, async () => { const d = await dialogState(p); return { ok: d.note === 'The preview couldn’t be loaded.' && d.retry === 'Retry', d }; }, 'broken lg → error')).d;
    await p.getByRole('dialog').getByRole('button', { name: 'Retry' }).click();
    s.retried = (await until(p, async () => { const d = await dialogState(p); return { ok: d.variant === 'lg' && d.id === 31002 && d.w > 0, d }; }, 'retry ok')).d;
    await closePreview(p); await advance(p, 31003); await openPreview(p);
    s.lgBrokenThumbOk = (await until(p, async () => { const d = await dialogState(p); return { ok: d.note === 'The full-size preview couldn’t be loaded — showing a smaller one.' && d.variant === 'thumb' && d.id === 31003, d }; }, 'lg broken, thumb kept')).d;
    await closePreview(p);
  },
  async S7(p, s) { // Inbox list thumbnails (DocThumbLightbox): A open/close, B open, A late, reopen A
    await openInbox(p);
    await plan(p, '31001:lg', [{ kind: 'ok', gate: 'A' }, { kind: 'ok', gate: 'A2' }]); await plan(p, '31002:lg', [{ kind: 'ok', gate: 'B' }]);
        const thumbBtn = (id) => main(p).locator('li, div').filter({ has: p.locator(`a[href="/inbox/doc/${id}"]`) }).last().getByRole('button', { name: 'Open document preview' });
    await p.evaluate(() => (window.__qa.expectLightbox = 31001)); await thumbBtn(31001).click(); await waitGate(p, 'A'); await closePreview(p);
    await p.evaluate(() => (window.__qa.expectLightbox = 31002)); await thumbBtn(31002).click(); await waitGate(p, 'B');
    await release(p, 'A'); await p.waitForTimeout(300);
    s.bAfterA = check((await dialogState(p)).variant === 'thumb' && (await dialogState(p)).id === 31002, 'B lightbox unaffected by A', await dialogState(p));
    await release(p, 'B');
    s.b = (await until(p, async () => { const d = await dialogState(p); return { ok: d.variant === 'lg' && d.id === 31002, d }; }, 'B lg')).d;
    await closePreview(p);
    await p.evaluate(() => (window.__qa.expectLightbox = 31001)); await thumbBtn(31001).click(); await waitGate(p, 'A2');
    s.reopenA = check((await dialogState(p)).variant === 'thumb' && (await dialogState(p)).note === 'Loading full-size preview…', 'A reopen: thumb + note', await dialogState(p));
    await release(p, 'A2');
    s.a = (await until(p, async () => { const d = await dialogState(p); return { ok: d.variant === 'lg' && d.id === 31001, d }; }, 'A lg')).d;
    await closePreview(p); await p.evaluate(() => (window.__qa.expectLightbox = null));
    s.lgReqsA = (await reqsFor(p, '31001:lg')).length;
  },
  async S8(p, s) { // Books › Documents rows with undecodable bytes (D1)
    await p.context().addInitScript(() => { window.__qaPre = { '32002:thumb': [{ kind: 'broken' }] }; });
    await p.goto(base + '/books?seg=documents');
    await main(p).locator('a[href^="/books/documents/32003"]').first().waitFor();
    await p.waitForTimeout(1200);
    s.rows = await p.evaluate(() => [32001, 32002, 32003].map((id) => {
      const a = document.querySelector(`main a[href^="/books/documents/${id}"]`);
      let el = a; while (el.parentElement && el.parentElement.querySelectorAll('a[href^="/books/documents/"]').length === 1) el = el.parentElement;
      const img = el.querySelector('img');
      return { id, img: !!img, broken: !!img && img.complete && img.naturalWidth === 0, w: img?.naturalWidth ?? null, glyph: !img && !!el.querySelector('span.bg-line svg') };
    }));
    s.brokenRaf32002 = await p.evaluate(() => window.__qa.broken.filter((b) => b.exp === 32002).length);
    if (s.shot) await p.screenshot({ path: `${SHOTS}/s8-books-documents-${s.vp}.jpg`, quality: 60, clip: { x: 0, y: 0, width: Math.min(1440, p.viewportSize().width), height: Math.min(600, p.viewportSize().height) } });
    check(!s.rows.find((r) => r.id === 32002).broken, 'D1: row 32002 keeps a broken image', s.rows);
    check(s.rows.find((r) => r.id === 32002).glyph, 'D1: row 32002 shows the fallback glyph', s.rows);
  },
  async S9(p, s) { // leave/re-enter by Back/Forward while thumbs are pending (unmount + remount)
    // The Inbox list refetches its own thumbs on every return, so each plan is added only after the
    // list's requests went out: the gate then belongs to the screen's request.
    const listIdle = async () => { await main(p).locator('a[href="/inbox/doc/31004"]').waitFor(); await p.waitForTimeout(400); };
    await openInbox(p);
    await plan(p, '31003:thumb', [{ kind: 'ok', gate: 'C1' }]); await openDoc(p, 31003); await waitGate(p, 'C1');
    await p.goBack(); await listIdle();
    await plan(p, '31004:thumb', [{ kind: 'ok', gate: 'D1' }]); await openDoc(p, 31004); await waitGate(p, 'D1');
    await p.goBack(); await listIdle();
    await plan(p, '31004:thumb', [{ kind: 'ok', gate: 'D2' }]); await p.goForward(); await waitScreen(p, 31004); await waitGate(p, 'D2');
    await release(p, 'D1'); await release(p, 'C1'); await p.waitForTimeout(300);
    s.afterStale = check((await rowState(p)).label === 'loading preview', 'D (remounted) waits for its own request', await rowState(p));
    await release(p, 'D2');
    s.d = (await until(p, async () => { const r = await rowState(p); return { ok: r.img && r.id === 31004, r }; }, 'D thumb')).r;
    // Back while the lightbox is open closes it, stays on D (modal layer, #267)
    await plan(p, '31004:lg', [{ kind: 'ok', gate: 'DL' }]);
    await openPreview(p); await waitGate(p, 'DL'); await p.goBack(); await p.getByRole('dialog').waitFor({ state: 'detached' });
    s.backClosed = { path: new URL(p.url()).pathname, screen: await screenId(p) };
    check(s.backClosed.screen === 31004, 'Back closed the preview only', s.backClosed);
    await release(p, 'DL'); await openPreview(p);
    s.dl = (await until(p, async () => { const d = await dialogState(p); return { ok: d.variant === 'lg' && d.id === 31004, d }; }, 'D lg')).d;
    await closePreview(p);
  },
  async S10(p, s) { // slow body download (headers early, bytes trickle) across switch / close-reopen
    await openInbox(p);
    await plan(p, '31001:thumb', [{ kind: 'slowbody', bodyMs: 1200 }]);
    await plan(p, '31002:thumb', [{ kind: 'slowbody', bodyMs: 600 }]);
    await plan(p, '31002:lg', [{ kind: 'slowbody', bodyMs: 1500 }]);
    await openDoc(p, 31001); await p.waitForTimeout(300);
    await advance(p, 31002);
    s.mid = await rowState(p);
    s.b = (await until(p, async () => { const r = await rowState(p); return { ok: r.img && r.id === 31002, r }; }, 'B thumb after slow body')).r;
    await openPreview(p); await p.waitForTimeout(400); s.midLg = await dialogState(p); await closePreview(p); await p.waitForTimeout(200); await openPreview(p);
    s.lg = (await until(p, async () => { const d = await dialogState(p); return { ok: d.variant === 'lg' && d.id === 31002 && d.w === 602, d }; }, 'lg after slow body', 6000)).d;
    s.lgReqs = (await reqsFor(p, '31002:lg')).length;
    await closePreview(p);
    await p.waitForTimeout(1300); // let A's stale body finish
    s.staleA = await sameMsRevoke(p, '31001:thumb');
  },
  async S11(p, s) { // seeded fault soak: random plans + random switch/open/close/leave with no settling
    await openInbox(p);
    const r = rng(304 + s.vpIndex); const kinds = ['ok', 'ok', 'ok', 'slowbody', '500', '404', 'broken', 'neterr'];
    const pick = (a) => a[Math.floor(r() * a.length)];
    for (let id = 31001; id <= 31030; id++) for (const v of ['thumb', 'lg']) {
      await plan(p, `${id}:${v}`, Array.from({ length: 4 }, () => ({ kind: pick(kinds), delay: Math.floor(r() * 500), bodyMs: 200 + Math.floor(r() * 600) })));
    }
    await openDoc(p, 31001);
    const ops = []; let cur = 31001;
    for (let i = 0; i < 40; i++) {
      const a = r(); let op;
      if (await p.getByRole('dialog').count()) { op = r() < 0.5 ? 'close' : 'back'; if (op === 'close') await closePreview(p); else { await p.goBack(); await p.getByRole('dialog').waitFor({ state: 'detached' }); } }
      else if (a < 0.45) { await advance(p, null); await p.waitForFunction((c) => { const m = /qa-doc-(\d+)/.exec(document.querySelector('h1[data-screen-title]')?.getAttribute('aria-label') || ''); return m && +m[1] !== c; }, cur, { timeout: 8000 }); cur = await screenId(p); op = `advance→${cur}`; }
      else if (a < 0.8) { op = 'open'; await openPreview(p); }
      else { op = 'leave+reenter'; await p.goBack(); const links = main(p).locator('a[href^="/inbox/doc/"]'); await links.first().waitFor(); const n = await links.count(); const k = Math.floor(r() * Math.min(n, 4)); const href = await links.nth(k).getAttribute('href'); cur = +href.split('/').pop(); await openDoc(p, cur); }
      ops.push(op); await p.waitForTimeout(Math.floor(r() * 350));
    }
    if (await p.getByRole('dialog').count()) await closePreview(p);
    await p.waitForTimeout(1500);
    s.ops = ops.join(' '); s.final = { screen: await screenId(p), row: await rowState(p) };
    const last = (await reqsFor(p, `${s.final.screen}:thumb`)).at(-1);
    const want = { ok: 'img', slowbody: 'img', '500': 'preview failed to load', neterr: 'preview failed to load', broken: 'preview failed to load', '404': 'no preview' }[last.kind];
    s.final.lastThumbKind = last.kind;
    check(want === 'img' ? s.final.row.img && s.final.row.id === s.final.screen : s.final.row.label === want, 'settled state matches the last request', s.final);
    s.pending = await p.evaluate(() => window.__qa.pendingGates());
  },
  async S12(p, s, vp) { // #378 landmarks and #303 fast URL-bound search do not regress
    s.landmarks = {};
    for (const path of ['/inbox', '/inbox/doc/31001', '/books']) {
      await p.goto(base + path); await p.waitForTimeout(700);
      const l = { mains: await p.getByRole('main').count(), navs: await p.getByRole('navigation').evaluateAll((n) => n.map((x) => x.getAttribute('aria-label'))) };
      s.landmarks[path] = l;
      check(l.mains === 1, 'one main', l); if (!vp.mobile) check(l.navs.includes('Primary'), 'desktop Primary nav', l);
    }
    s.search = [];
    for (const [path, label, word] of [['/inbox', 'Search the Inbox', 'qa-doc-31004'], ['/books', 'Search expenses', 'Põhja-Eesti 1234.56']]) for (const delay of [0, 30]) {
      await p.goto(base + path); const box = p.getByRole('searchbox', { name: label }); await box.waitFor(); await p.waitForTimeout(300);
      await box.click(); await box.pressSequentially(word, { delay }); await p.waitForTimeout(1000);
      const r = { path, delay, field: await box.inputValue(), q: new URL(p.url()).searchParams.get('q') }; r.intact = r.field === word && r.q === word; s.search.push(r);
    }
    check(s.search.every((r) => r.intact), 'fast search intact', s.search);
    s.inboxFiltered = await main(p).locator('a[href^="/inbox/doc/"]').count();
  },
  async S13(p, s) { // D2 repeat: 25 cycles of open doc (thumb broken) + preview (lg broken)
    const ids = [31001, 31002, 31003, 31004, 31005, 31006]; s.cycles = [];
    await openInbox(p);
    for (let i = 0; i < 25; i++) {
      const id = ids[i % ids.length];
      await main(p).locator(`a[href="/inbox/doc/${id}"]`).waitFor(); await p.waitForTimeout(350); // list thumbs fetched
      const before = await p.evaluate(() => window.__qa.broken.length);
      await plan(p, `${id}:thumb`, [{ kind: 'broken', delay: 50 + (i % 5) * 40 }]); await plan(p, `${id}:lg`, [{ kind: 'broken', delay: 50 + (i % 3) * 60 }]);
      await openDoc(p, id);
      await until(p, async () => { const r = await rowState(p); return { ok: r.label === 'preview failed to load', r }; }, 'row error');
      await openPreview(p);
      await until(p, async () => { const d = await dialogState(p); return { ok: d.retry === 'Retry', d }; }, 'lightbox error');
      await closePreview(p); await p.goBack();
      const b = await p.evaluate((n) => window.__qa.broken.slice(n), before);
      s.cycles.push({ id, row: b.filter((x) => x.where === 'screen').length, lightbox: b.filter((x) => x.where === 'lightbox').length });
    }
    s.cyclesWithRowFrame = s.cycles.filter((c) => c.row).length; s.cyclesWithLightboxFrame = s.cycles.filter((c) => c.lightbox).length;
  },
};

// ── Runner ─────────────────────────────────────────────────────────────────
const b = await launch(); const results = [];
for (const [vpIndex, vp] of VIEWPORTS.entries()) for (const name of CASES) {
  const f = await setup(b, { ...vp, triageCount: name === 'S11' ? 30 : 6 });
  const s = { vp: vp.label, vpIndex, shot: vp.label === '1440x900' || vp.label === '390x844m' }; const t0 = Date.now(); let error = null;
  try { await cases[name](f.page, s, vp); } catch (e) { error = String(e.message || e).slice(0, 600); }
  // Leave through the app so the screen's cleanup runs, then count URLs still alive.
  let after = null;
  try { await f.page.getByRole('link', { name: /^Settings/ }).first().click({ timeout: 3000 }); await f.page.waitForTimeout(400); after = await counters(f.page); } catch { after = await counters(f.page).catch(() => null); }
  const q = await f.page.evaluate(() => ({ fails: window.__qa.fails.slice(0, 20), broken: window.__qa.broken.slice(0, 20), reqs: window.__qa.reqs, stateLog: window.__qa.stateLog })).catch(() => ({}));
  const monitorFails = q.fails?.length ?? -1;
  const pass = !error && monitorFails === 0 && (q.broken?.length ?? 0) === 0 && f.log.pageErrors.length === 0 && f.log.routePreview === 0 && f.log.unhandled.length === 0;
  const row = { case: name, vp: vp.label, pass, error, ms: Date.now() - t0, s: { ...s, shot: undefined }, counters: after, monitor: { fails: q.fails, broken: q.broken }, log: f.log, reqs: q.reqs, stateLog: q.stateLog };
  results.push(row);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${vp.label} ${row.ms}ms created=${after?.created} revoked=${after?.revoked} live=${after?.live} frames=${after?.frames} samples=${after?.samples} fails=${monitorFails} brokenRaf=${q.broken?.length} brokenDom=${after?.brokenDom} writes=${f.log.writes.length} unhandled=${f.log.unhandled.length}${error ? ' ERR ' + error : ''}`);
  await f.context.close();
  await fs.writeFile(OUT, JSON.stringify(results, null, 1));
}
await b.close();
