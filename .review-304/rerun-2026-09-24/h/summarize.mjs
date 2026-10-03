// Summarise a run: FILE=../final-after.json node summarize.mjs
import fs from 'node:fs';
const r = JSON.parse(fs.readFileSync(process.env.FILE, 'utf8'));
const tot = { runs: 0, wrong: 0, frames: 0, samples: 0, created: 0, revoked: 0, live: 0, writes: 0, pageErrors: 0, unhandled: 0, routePreview: 0 };
for (const c of r) {
  const where = {}; for (const b of c.monitor.broken || []) where[`${b.where} ${b.rect}`] = (where[`${b.where} ${b.rect}`] || 0) + 1;
  const extra = c.case === 'S13' ? ` cyclesRow=${c.s.cyclesWithRowFrame}/25 cyclesLightbox=${c.s.cyclesWithLightboxFrame}/25` : c.case === 'S8' ? ` rows=${JSON.stringify(c.s.rows?.map((x) => `${x.id}:${x.broken ? 'BROKEN' : x.img ? 'img' : x.glyph ? 'glyph' : '?'}`))}` : '';
  console.log(`${c.case.padEnd(4)} ${c.vp.padEnd(10)} steps=${c.error ? 'FAIL: ' + c.error.slice(0, 140) : 'ok'} wrongObject=${c.monitor.fails?.length} brokenFrames=${JSON.stringify(where)} urls=${c.counters?.created}/${c.counters?.revoked} live=${c.counters?.live} frames=${c.counters?.frames} samples=${c.counters?.samples}${extra}`);
  tot.runs++; tot.wrong += c.monitor.fails?.length || 0; tot.frames += c.counters?.frames || 0; tot.samples += c.counters?.samples || 0;
  tot.created += c.counters?.created || 0; tot.revoked += c.counters?.revoked || 0; tot.live += c.counters?.live || 0;
  tot.writes += c.log.writes.filter((w) => w.startsWith('POST')).length; tot.pageErrors += c.log.pageErrors.length; tot.unhandled += c.log.unhandled.length; tot.routePreview += c.log.routePreview;
  if (c.log.writes.some((w) => !w.startsWith('POST'))) console.log('  held writes', c.log.writes.filter((w) => !w.startsWith('POST')));
}
console.log(JSON.stringify(tot));
