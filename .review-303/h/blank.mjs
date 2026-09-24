// Mechanism probe: press ONE key into an idle URL-bound search and sample the field's DOM value
// every animation frame. A controlled input whose value arrives via a router transition shows
// the OLD value until that transition commits; any key landing in that window is applied to it.
import fs from 'node:fs/promises'; import { launch, setup, base } from './fixtures.mjs';
const SCREENS = [['books', '/books', 'Search expenses'], ['inbox', '/inbox', 'Search the Inbox'], ['bank', '/bank/statements/3?seg=all', 'Search this statement']];
const b = await launch(); const out = [];
for (const small of [false, true]) for (const [width, height] of [[1440, 900], [1920, 1080]]) {
  const f = await setup(b, { width, height, small }); const p = f.page;
  for (const [name, url, label] of SCREENS) for (let t = 0; t < 3; t++) {
    await p.goto(base + url); const box = p.getByRole('searchbox', { name: label }); await box.waitFor();
    await p.waitForLoadState('networkidle'); await p.waitForTimeout(300); await box.click();
    await p.evaluate(() => { const el = document.activeElement; window.__s = []; let t0 = null;
      el.addEventListener('keydown', () => { t0 = performance.now(); const tick = () => { window.__s.push([Math.round(performance.now() - t0), el.value]); if (performance.now() - t0 < 3000) requestAnimationFrame(tick); }; queueMicrotask(tick); requestAnimationFrame(tick); }, { once: true }); });
    await p.keyboard.type('1'); await p.waitForTimeout(3200);
    const s = await p.evaluate(() => window.__s);
    const firstShown = s.find(([, v]) => v === '1')?.[0] ?? null; const blankFrames = s.filter(([ms, v]) => v === '' && ms > 0).map(([ms]) => ms);
    const row = { data: small ? 'small' : 'full', width, screen: name, trial: t, oldValueUntilMs: firstShown, lastBlankSampleMs: blankFrames.at(-1) ?? null, samples: s.length };
    out.push(row); console.log(JSON.stringify(row));
  }
  out.push({ width, data: small ? 'small' : 'full', log: { unhandled: f.log.unhandled, held: f.log.held, pageErrors: f.log.pageErrors } });
  await f.context.close();
}
await fs.writeFile(process.env.OUT || '../blank-results.json', JSON.stringify(out, null, 1)); await b.close();
