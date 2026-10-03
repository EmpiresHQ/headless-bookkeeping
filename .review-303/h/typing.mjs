// Keystroke integrity: type into each URL-bound search at fixed and human-like jitter delays;
// compare the field and ?q= with what was typed, after the page is idle.
import fs from 'node:fs/promises'; import { launch, setup, base } from './fixtures.mjs';
const OUT = process.env.OUT || '../typing-results.json';
const WIDTHS = (process.env.WIDTHS || '1440x900,1920x1080').split(',').map((s) => s.split('x').map(Number));
const DELAYS = (process.env.DELAYS || '0,30,60,100,jitter').split(',');
const TRIALS = +(process.env.TRIALS || 3);
const SCREENS = [['books', '/books', 'Search expenses'], ['inbox', '/inbox', 'Search the Inbox'], ['bank', '/bank/statements/3?seg=all', 'Search this statement']];
const WORDS = ['kalamaja', '1234.56', 'Põhja-Eesti'];
function jitter(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) >>> 0; return 40 + Math.floor((s / 2 ** 32) * 100); }; } // 40–139 ms
const b = await launch(); const results = [];
for (const small of (process.env.SMALL || 'false,true').split(',').map((x) => x === 'true'))
for (const [width, height] of WIDTHS) {
  const f = await setup(b, { width, height, small }); const p = f.page;
  for (const [name, url, label] of SCREENS) for (const delay of DELAYS) for (let t = 0; t < TRIALS; t++) {
    const word = WORDS[t % WORDS.length];
    await p.goto(base + url); const box = p.getByRole('searchbox', { name: label }); await box.waitFor();
    await p.waitForLoadState('networkidle'); await p.waitForTimeout(300);
    await box.click();
    const gaps = []; const J = jitter(303 + t);
    const t0 = Date.now();
    for (const ch of word) { await p.keyboard.type(ch); const d = delay === 'jitter' ? J() : +delay; gaps.push(d); if (d) await p.waitForTimeout(d); }
    const typedMs = Date.now() - t0;
    await p.waitForTimeout(1500);
    const field = await box.inputValue(); const q = new URL(p.url()).searchParams.get('q');
    const row = { data: small ? 'small' : 'full', width, screen: name, delay, word, field, q, intact: field === word && q === word, typedMs, meanGap: Math.round(gaps.reduce((a, c) => a + c, 0) / gaps.length) };
    results.push(row); console.log(JSON.stringify(row));
  }
  results.push({ width, data: small ? 'small' : 'full', log: { ...f.log, previews: undefined } });
  await f.context.close();
  await fs.writeFile(OUT, JSON.stringify(results, null, 1));
}
await b.close();
