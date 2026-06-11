import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Walk up from `start` to the monorepo root — the first ancestor whose
 * package.json declares a `workspaces` field. Falls back to `start` if none is
 * found (e.g. an unexpected runtime layout).
 */
export function repoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, 'utf8')) as {
          workspaces?: unknown;
        };
        if (json.workspaces) return dir;
      } catch {
        // ignore an unreadable/malformed package.json and keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/** The data directory (repo-root `/data` by default; `DATA_DIR` overrides). */
export function dataDir(): string {
  const dir = process.env.DATA_DIR ?? join(repoRoot(), 'data');
  mkdirSync(dir, { recursive: true });
  return dir;
}
