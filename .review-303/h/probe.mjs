import { launch, setup, base } from './fixtures.mjs';
const b = await launch();
const f = await setup(b, { width: 1440, height: 900 }); const p = f.page;
for (const u of ['/books', '/inbox', '/bank/statements/3', '/bank']) {
  const t = Date.now(); await p.goto(base + u); await p.waitForLoadState('networkidle'); await p.waitForTimeout(500);
  const info = await p.evaluate(() => ({ links: document.querySelectorAll('main a').length, btns: document.querySelectorAll('main button').length, checks: document.querySelectorAll('[role=checkbox]').length, search: [...document.querySelectorAll('input[type=search]')].map((i) => i.getAttribute('aria-label')), text: document.querySelector('main')?.innerText.slice(0, 600) }));
  console.log(u, Date.now() - t, JSON.stringify(info));
}
console.log(JSON.stringify(f.log).slice(0, 1500)); await b.close();
