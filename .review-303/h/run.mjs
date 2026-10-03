// QA-010 (#303) desktop matrix at 1440×900 and 1920×1080 against the production build.
import fs from 'node:fs/promises'; import { launch, setup, base } from './fixtures.mjs';
const OUT = process.env.OUT || '../run-results.json';
const WIDTHS = (process.env.WIDTHS || '1440x900,1920x1080').split(',').map((s) => s.split('x').map(Number));
const b = await launch(); const results = [];
const now = () => Date.now();
const heap = (p) => p.evaluate(() => { window.gc?.(); return Math.round(performance.memory.usedJSHeapSize / 1e5) / 10; });
const count = (p, sel) => p.evaluate((s) => document.querySelectorAll(s).length, sel);
const waitCount = async (p, sel, pred, max = 15000) => { const t = now(); await p.waitForFunction(([s, src]) => new Function('n', 'return ' + src)(document.querySelectorAll(s).length), [sel, pred], { timeout: max, polling: 'raf' }); return now() - t; };
const ROW = { books: 'main a[href^="/books/expenses/"]', inbox: 'main a[href^="/inbox/"]', bank: 'main [role=checkbox]' };
const geometry = (p, sel) => p.evaluate((sel) => {
  const rows = [...document.querySelectorAll(sel)]; let overlaps = 0, overflowRows = 0;
  for (const r of rows) {
    const rr = r.getBoundingClientRect(); if (r.scrollWidth > r.clientWidth + 1) overflowRows++;
    const cells = [...r.querySelectorAll(':scope > *')].map((c) => c.getBoundingClientRect()).filter((c) => c.width && c.height);
    for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) { const a = cells[i], c = cells[j]; if (a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1) overlaps++; }
    if (rr.right > innerWidth + 1) overflowRows++;
  }
  const side = document.querySelector('nav[aria-label="Primary"]')?.closest('aside, div');
  const sr = side?.getBoundingClientRect();
  return { rows: rows.length, overlaps, overflowRows, hOverflow: document.documentElement.scrollWidth > innerWidth, sidebar: side ? { pos: getComputedStyle(side).position, x: sr.x, y: sr.y, h: Math.round(sr.height) } : null };
}, sel);

for (const [width, height] of WIDTHS) {
  const f = await setup(b, { width, height }); const p = f.page; p.setDefaultTimeout(20000);
  const R = { width, height, steps: {}, fails: [] };
  const step = async (name, fn) => { if (process.env.STEPS && !process.env.STEPS.split(",").includes(name)) return; try { R.steps[name] = await fn(); console.log(width, name, JSON.stringify(R.steps[name])); } catch (e) { R.fails.push({ name, error: String(e).slice(0, 300) }); console.error(width, 'FAIL', name, String(e).slice(0, 300)); await p.screenshot({ path: `../shots/fail-${name}-${width}.png` }).catch(() => {}); } };

  await step('landmarks', async () => {
    await p.goto(base + '/books'); await waitCount(p, ROW.books, 'n>=1200');
    const mains = await p.getByRole('main').count(); const navs = await p.getByRole('navigation').all();
    const names = await Promise.all(navs.map((n) => n.getAttribute('aria-label')));
    const primaryLinks = await p.getByRole('navigation', { name: 'Primary' }).getByRole('link').allInnerTexts();
    const searchInMain = await p.getByRole('main').getByRole('searchbox', { name: 'Search expenses' }).count();
    const navInsideMain = await p.getByRole('main').getByRole('navigation').count();
    if (mains !== 1 || !names.includes('Primary') || searchInMain !== 1 || navInsideMain !== 0) throw new Error('landmarks ' + JSON.stringify({ mains, names, searchInMain, navInsideMain }));
    return { mains, visibleNavs: names, primaryLinks: primaryLinks.map((t) => t.trim()), searchInMain, navInsideMain };
  });

  await step('coldLoad', async () => {
    const o = {};
    for (const [k, url, pred] of [['books', '/books', 'n>=1200'], ['inbox', '/inbox', 'n>=1000'], ['bank', '/bank/statements/3', 'n>=300']]) {
      await p.goto('about:blank'); const t = now(); await p.goto(base + url); await waitCount(p, ROW[k], pred); o[k] = now() - t;
    }
    return o;
  });

  await step('geometry', async () => {
    const o = {};
    for (const [k, url, pred] of [['books', '/books', 'n>=1200'], ['inbox', '/inbox', 'n>=1000'], ['bank', '/bank/statements/3?seg=all', 'n>=300']]) {
      await p.goto(base + url); await waitCount(p, ROW[k], pred);
      await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await p.waitForTimeout(300);
      o[k] = { ...(await geometry(p, ROW[k])), docH: await p.evaluate(() => document.documentElement.scrollHeight) };
      await p.screenshot({ path: `../shots/${k}-${width}.png` });
    }
    const bad = Object.entries(o).filter(([, g]) => g.overlaps || g.overflowRows || g.hOverflow || g.sidebar?.pos !== 'fixed' || g.sidebar?.y !== 0);
    if (bad.length) throw new Error('geometry ' + JSON.stringify(o));
    return o;
  });

  await step('repeatNav', async () => {
    await p.goto(base + '/inbox'); await waitCount(p, ROW.inbox, 'n>=1000');
    const nav = p.getByRole('navigation', { name: 'Primary' }); const rounds = []; const h0 = await heap(p); const dom0 = await count(p, '*');
    for (let i = 0; i < 6; i++) {
      const r = {};
      for (const [label, k, pred] of [['Books', 'books', 'n>=1200'], ['Bank', null, null], ['Reports', null, null], ['Inbox', 'inbox', 'n>=1000']]) {
        const t = now(); await nav.getByRole('link', { name: new RegExp('^' + label) }).click();
        if (k) await waitCount(p, ROW[k], pred); else await p.getByRole('heading', { level: 1, name: label }).waitFor();
        r[label] = now() - t;
      }
      r.heapMB = await heap(p); r.dom = await count(p, '*'); rounds.push(r);
    }
    return { heapStartMB: h0, domStart: dom0, rounds };
  });

  await step('booksFilters', async () => {
    await p.goto(base + '/books'); await waitCount(p, ROW.books, 'n>=1200');
    const box = p.getByRole('searchbox', { name: 'Search expenses' });
    let t = now(); await box.fill('kalamaja'); await waitCount(p, ROW.books, 'n<1200'); const search = now() - t;
    const rows = await p.$$eval(ROW.books, (as) => as.map((a) => a.innerText));
    const allMatch = rows.every((x) => /kalamaja/i.test(x));
    const showing = (await p.getByText(/^Showing \d+ of \d+/).first().textContent().catch(() => null));
    t = now(); await box.fill(''); await waitCount(p, ROW.books, 'n>=1200'); const clear = now() - t;
    t = now(); await p.getByRole('button', { name: /^Draft \d+/ }).click(); await waitCount(p, ROW.books, 'n<1200'); const draft = now() - t;
    const draftRows = await p.$$eval(ROW.books, (as) => as.map((a) => a.innerText));
    const allDraft = draftRows.every((x) => /\bdraft\b/i.test(x));
    t = now(); await p.getByRole('button', { name: /^All/ }).first().click(); await waitCount(p, ROW.books, 'n>=1200'); const all = now() - t;
    if (!allMatch || !allDraft) throw new Error('filter correctness ' + JSON.stringify({ allMatch, allDraft }));
    return { searchMs: search, searchRows: rows.length, showing, allRowsContainNeedle: allMatch, clearMs: clear, draftMs: draft, draftRows: draftRows.length, allRowsDraft: allDraft, allMs: all, url: p.url().replace(base, '') };
  });

  await step('booksOpenBack', async () => {
    const o = [];
    for (const idx of [5, 600, 1150, 5, 600]) {
      await p.goto('about:blank'); await p.goto(base + '/books'); await waitCount(p, ROW.books, 'n>=1200');
      const row = p.locator(ROW.books).nth(idx); await row.scrollIntoViewIfNeeded(); await p.waitForTimeout(200);
      const before = { top: Math.round((await row.boundingBox()).y), href: await row.getAttribute('href') };
      let t = now(); await row.click(); await p.getByRole('button', { name: '‹ Back', exact: true }).waitFor(); const open = now() - t;
      t = now(); await p.getByRole('button', { name: '‹ Back', exact: true }).click();
      const back = p.locator(`${ROW.books}[href="${before.href}"]`); await back.waitFor();
      await p.waitForFunction((h) => document.activeElement?.getAttribute('href') === h, before.href, { timeout: 5000 }).catch(() => {});
      const ms = now() - t; await p.waitForTimeout(300);
      const after = { top: Math.round((await back.boundingBox()).y), focused: await back.evaluate((el) => el === document.activeElement) };
      o.push({ idx, openMs: open, backMs: ms, dTop: after.top - before.top, focused: after.focused });
    }
    if (o.some((x) => Math.abs(x.dTop) > 2 || !x.focused)) throw new Error('restore ' + JSON.stringify(o));
    return o;
  });

  await step('bank', async () => {
    let t = now(); await p.goto(base + '/bank/statements/3'); await waitCount(p, ROW.bank, 'n>=300'); const load = now() - t;
    const checked = await count(p, 'main [role=checkbox][aria-checked=true]');
    const bookBtn = p.getByRole('button', { name: /^Book \d+/ }); const bookText = (await bookBtn.innerText()).replace(/\s+/g, ' ');
    const net = f.data.proposals.filter((x) => x.confidence === 'high').reduce((a, x) => a + f.data.txs.find((tx) => tx.id === x.bankTransactionId).amount, 0);
    const btnY = Math.round(await bookBtn.evaluate((el) => el.getBoundingClientRect().top + scrollY));
    const box = p.getByRole('searchbox', { name: 'Search this statement' });
    t = now(); await box.fill('kalamaja'); await waitCount(p, ROW.bank, 'n<300'); const search = now() - t;
    const shown = await count(p, ROW.bank); await box.fill(''); await waitCount(p, ROW.bank, 'n>=300');
    t = now(); await p.getByText(/^All 1000$/).click(); await p.waitForURL(/seg=all/); await p.waitForTimeout(50); const allSeg = now() - t;
    await p.goto(base + '/bank/statements/3'); await waitCount(p, ROW.bank, 'n>=300');
    const before = f.log.held.length;
    t = now(); await p.getByRole('button', { name: /^Book \d+/ }).click();
    await p.waitForFunction(() => [...document.querySelectorAll('main button')].some((b) => /^Book/.test(b.innerText) && (b.disabled || b.getAttribute('aria-busy') === 'true' || b.getAttribute('aria-disabled') === 'true')), null, { timeout: 5000 }).catch(() => {});
    const pendingMs = now() - t; await p.waitForTimeout(300);
    const held = f.log.held.slice(before);
    const btnState = await p.evaluate(() => { const b = [...document.querySelectorAll('main button')].find((x) => /^Book/.test(x.innerText)); return b ? { text: b.innerText.replace(/\s+/g, ' '), disabled: b.disabled, ariaBusy: b.getAttribute('aria-busy'), ariaDisabled: b.getAttribute('aria-disabled') } : null; });
    return { loadMs: load, preselected: checked, bookText, expectedNetCents: net, bookButtonDocY: btnY, searchMs: search, searchShownProposals: shown, allSegMs: allSeg, bookClickToPendingMs: pendingMs, heldRequests: held, bookButtonWhileHeld: btnState };
  });

  await step('focus302', async () => {
    const draft = f.data.expenses.find((e) => e.status === 'draft');
    await p.goto(base + '/books/expenses/' + draft.id); await p.getByRole('button', { name: /Delete draft/ }).click();
    const dlg = p.getByRole('alertdialog'); await dlg.waitFor();
    const before = f.log.held.length;
    await dlg.getByRole('button', { name: 'Delete', exact: true }).click();
    await p.waitForTimeout(400);
    const inside = () => p.evaluate(() => { const d = document.querySelector('[role=alertdialog]'); const a = document.activeElement; return { inside: !!d && d.contains(a), active: a === document.body ? 'body' : a?.tagName + ':' + (a?.getAttribute('aria-label') || a?.textContent || '').trim().slice(0, 30) }; });
    const s0 = await inside(); const tabs = [];
    for (let i = 0; i < 4; i++) { await p.keyboard.press('Tab'); tabs.push(await inside()); }
    for (let i = 0; i < 2; i++) { await p.keyboard.press('Shift+Tab'); tabs.push(await inside()); }
    const held = f.log.held.slice(before);
    if (!s0.inside || tabs.some((x) => !x.inside)) throw new Error('focus escaped ' + JSON.stringify({ s0, tabs }));
    return { expense: draft.id, heldRequests: held, afterSubmit: s0, tabs };
  });

  R.log = { unhandled: f.log.unhandled, held: f.log.held, pageErrors: f.log.pageErrors, consoleErrors: [...new Set(f.log.consoleErrors)].slice(0, 10), gets: f.log.gets, previews: f.log.previews };
  results.push(R); await f.context.close();
  await fs.writeFile(OUT, JSON.stringify(results, null, 1));
}
await b.close(); if (results.some((r) => r.fails.length)) process.exitCode = 1;
