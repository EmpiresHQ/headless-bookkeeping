import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Route motion contract (issue #282, DESIGN.md §6): route navigation —
 *  enter, Back, section switch and queue completion — is instant, with no
 *  View Transition, so it behaves the same with or without the API and under
 *  reduced motion. completionHistory.test.tsx pins this at runtime on the
 *  Inbox/Bank/Settings paths (a native-like API stub must stay uncalled).
 *  This static guard only rejects the opt-ins themselves anywhere in
 *  production source: router `viewTransition`, direct API calls and
 *  view-transition CSS. It does not prove other CSS motion is absent.
 *  Local motion (busy buttons, sheets) is separate and allowed.
 *  Read from disk: vitest serves CSS modules to tests as empty strings. */
const SRC = join(__dirname, '..');

function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return productionSources(path);
    if (!/\.(ts|tsx|css)$/.test(e.name)) return [];
    if (/\.test\.tsx?$/.test(e.name) || e.name === 'test-setup.ts') return [];
    return [relative(SRC, path)];
  });
}

const sources = Object.fromEntries(
  productionSources(SRC).map((f) => [f, readFileSync(join(SRC, f), 'utf8')]),
);

const ROUTE_MOTION =
  /viewtransition|::view-transition|@view-transition|view-transition-name/i;

describe('route motion contract (#282)', () => {
  it('scans the production sources, including the route-link primitives and CSS', () => {
    const primitives = [
      'index.css',
      'ui/LinkButton.tsx',
      'ui/List.tsx',
      'shell/Headers.tsx',
      'shell/TabBar.tsx',
      'shell/Sidebar.tsx',
    ];
    expect(primitives.filter((f) => !/\S/.test(sources[f] ?? ''))).toEqual([]);
  });

  it('no production file opts route navigation into a view transition', () => {
    const offenders = Object.keys(sources).filter((f) =>
      ROUTE_MOTION.test(sources[f]),
    );
    expect(offenders).toEqual([]);
  });
});
