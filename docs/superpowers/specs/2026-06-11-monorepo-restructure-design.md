# Design: Kosher monorepo — packages/{server,web,cli}

Date: 2026-06-11
Status: Approved (design), pending implementation plan

## 1. Goal

Turn the repo into a proper npm-workspaces monorepo. The NestJS app and the
operator SPA move out of the root into `packages/*` alongside the existing CLI,
each package owns its dependencies, the Dockerfile travels with the server, the
server serves the SPA by resolving the web package (not a cwd path), and CI runs
each package's tests only when that package (or shared root files) changed.

## 2. Target layout

```
/                          # private monorepo root (single lockfile, thin)
  package.json             # { private, workspaces: ["packages/*"], shared devtools }
  package-lock.json        # the one and only lockfile (npm workspaces)
  packages/
    server/                # NestJS — from ./src + ./test + nest-cli.json + tsconfig* + jest
      Dockerfile           # moved here (build context = repo root)
      src/ test/ nest-cli.json tsconfig*.json
      package.json         # @headless-bookkeeping/server (private)
    web/                   # from ./frontend (Vite SPA)
      package.json         # @headless-bookkeeping/web (private)
    cli/                   # @empireshq/hbk (unchanged; published to Verdaccio)
  docs/ deploy/ evals/     # stay at root
  data/                    # local SQLite + uploads (repo-root, gitignored)
```

Package names: `@headless-bookkeeping/server`, `@headless-bookkeeping/web`
(neither published — names are workspace identifiers only). The CLI keeps its
published name `@empireshq/hbk`. Root package stays `bookkeeping`, `private: true`.

## 3. Dependency split (kosher)

Each package owns its deps in its own `package.json`; the root keeps only
`private`, `workspaces`, and genuinely shared devtools (prettier, the eslint
config). All ~25 server runtime deps + server devDeps (`@nestjs/*`, `kysely`,
`zod`, `better-sqlite3`, `jest`, `ts-jest`, `ts-node`, `supertest`, …) move into
`packages/server/package.json`. `web` and `cli` are already self-contained. One
root `package-lock.json` (npm workspaces hoists shared deps).

`packages/server/package.json` adds a workspace dependency on the web package:
`"@headless-bookkeeping/web": "*"` (the server serves its built assets — see §6).

## 4. packages/server internals

Move verbatim and re-root: `src/`, `test/` (e2e), `nest-cli.json`
(`sourceRoot: src`), `tsconfig.json`, `tsconfig.build.json`. The jest config moves
out of the root `package.json` into `packages/server` (a `jest.config.js` or the
package's `"jest"` key); `test/jest-e2e.json` moves with `test/`. Scripts on the
server package: `build` (`nest build`), `start`/`start:dev`/`start:prod`, `test`,
`test:e2e`, `lint`, `openapi:emit`. Internal imports are all relative, so they
survive the move unchanged.

## 5. cwd-relative paths (the main breakage risk — fixed explicitly)

Three runtime paths are `process.cwd()`-relative today and break when the app no
longer runs from the repo root:

1. **SQLite/data** — `database.module.ts: new Database('./data/app.sqlite')`.
   Requirement: keep data at the **repo-root `/data`** locally (prod unchanged).
   Fix: resolve the data dir to the monorepo root deterministically (walk up
   from the running file / cwd to the nearest dir containing the root
   `package.json` with a `workspaces` field; fallback to cwd). Optional
   `DATA_DIR` env override. Prod image keeps `WORKDIR /app` + volume
   `./data:/app/data`, so the resolved root is `/app` → `/app/data` as today.

2. **Served SPA** — `app.module.ts: ServeStaticModule.forRoot({ rootPath:
   join(process.cwd(),'frontend','dist') })`. Fix per §6 (resolve the web
   package).

3. **OpenAPI emit output** — `openapi-emit.ts` writes
   `resolve(cwd,'packages/cli/openapi.json')`, which is cross-package and breaks
   under `-w`. Fix: `openapi:emit` is a server-package script that emits the spec
   to stdout (or a path arg); the root `cli:codegen` runs it and writes
   `packages/cli/openapi.json` itself (cwd-agnostic).

## 6. Server serves the SPA from the web package

The server depends on `@headless-bookkeeping/web` and resolves its built `dist`
through node module resolution instead of a hardcoded path:

```ts
// resolve the web package's dist regardless of cwd / monorepo layout
const webDist = join(
  dirname(require.resolve('@headless-bookkeeping/web/package.json')),
  'dist',
);
ServeStaticModule.forRoot({ rootPath: webDist });
```

(If the compiled server is ESM, use `createRequire(import.meta.url)` — resolved
in the plan based on the actual emitted module format.)

`packages/web/package.json` declares `"files": ["dist"]` so the built assets are
part of the package, and the server's dependency makes
`require.resolve('@headless-bookkeeping/web/package.json')` succeed wherever the
workspace is installed (local symlink and prod image alike).

## 7. Docker (Dockerfile → packages/server/Dockerfile, context = repo root)

Single deployable image (backend + bundled SPA), as today. The build context is
the **repo root** because workspace `npm ci` needs the root manifests plus every
workspace `package.json`:

```dockerfile
# builder
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json    packages/web/
COPY packages/cli/package.json    packages/cli/
RUN npm ci                                  # whole workspace, once
COPY . .
RUN npm run build -w @headless-bookkeeping/web      # SPA → packages/web/dist
RUN npm run build -w @headless-bookkeeping/server   # nest build → packages/server/dist

# production: WORKDIR /app; node dist/main.js; ./data volume as today.
# Must include packages/web (package.json + dist) and the server so that
# require.resolve('@headless-bookkeeping/web/package.json') works at runtime.
```

This also fixes the pre-existing bug where `npm ci` ran before workspace
manifests were copied. The admin `cli` wrapper (`/usr/local/bin/cli` →
`node /app/.../dist/cli.js`) is preserved, pointed at the server's compiled CLI.

## 8. compose / deploy

- Root `docker-compose.yml`: `build.context: .`, add `dockerfile:
  packages/server/Dockerfile` for the `app` and `test` services.
- `deploy/docker-compose.yml`: pulls the image (`image:`), does not build — **not
  touched**.

## 9. CI workflows

### 9.1 Per-package change detection
A `changes` job (`dorny/paths-filter@v3`) outputs `server` / `web` / `cli`
booleans. A shared anchor (`package.json`, `package-lock.json`,
`.github/workflows/ci.yml`) forces all three when touched.

```yaml
filters: |
  shared: &shared
    - 'package.json'
    - 'package-lock.json'
    - '.github/workflows/ci.yml'
  server: [ *shared, 'packages/server/**' ]
  web:    [ *shared, 'packages/web/**' ]
  cli:    [ *shared, 'packages/cli/**' ]
```

### 9.2 Jobs (each gated on its filter)
- `build-test-image` — `if: needs.changes.outputs.server == 'true'`; builds
  `-f packages/server/Dockerfile .`, uploads the image artifact (as today).
- `lint` / `unit` / `e2e` — `needs: [changes, build-test-image]`,
  `if: server == 'true'`; download artifact, `docker load`, run their slice.
- `cli-test` — `if: cli == 'true'`; `npm ci` + build/test `-w @empireshq/hbk`.
- `web-check` — `if: web == 'true'`; `npm ci` + `npm run build -w
  @headless-bookkeeping/web` (+ web lint/test if present).

### 9.3 Skipped-needs gotcha (handled explicitly)
In GitHub Actions a dependent job is skipped if any `needs` job is *skipped*.
`build-and-push` therefore uses an explicit guard so skipped (not failed) test
jobs don't block, and it only rebuilds/deploys the server when the server
changed:

```yaml
build-and-push:
  needs: [changes, lint, unit, e2e, cli-test, web-check]
  if: >
    github.event_name == 'push'
    && needs.changes.outputs.server == 'true'
    && !cancelled()
    && !contains(needs.*.result, 'failure')
deploy:
  needs: build-and-push          # runs only if build-and-push ran & passed
```

Result: touch only `cli` → only `cli-test` runs; server is not rebuilt or
deployed. Touch a shared root file → everything runs.

### 9.4 cli-release.yml
`openapi:emit` / `cli:codegen` now target `packages/server`. The rest
(registry-driven version, tag + GitHub Release, generate-spec-at-release) is
unchanged.

## 10. Lint

Root `lint` glob updates from `{src,apps,libs,test}/**/*.ts` to the packages
(`packages/server/{src,test}/**/*.ts`), or each package runs its own lint. The
CLI/web keep their own lint setup.

## 11. Verification (sequenced in the plan)

At each plan step: `npm ci` green → `npm run build -w @headless-bookkeeping/server`
→ `npm test -w @headless-bookkeeping/server` → e2e → `npm run build -w
@headless-bookkeeping/web` → `docker build -f packages/server/Dockerfile .`
succeeds → the built image serves the SPA (web-resolve path) and boots with
`/data`. Confirm `cli:codegen` still emits a valid spec.

## 12. Decisions log

- Everything under `packages/*` (server, web, cli); no `apps/` split.
- Move server **and** web in this pass.
- Full dependency split; root is a thin private orchestrator with one lockfile.
- Names `@headless-bookkeeping/{server,web}` (unpublished); CLI stays
  `@empireshq/hbk` (published).
- Local data stays at repo-root `/data` (resolved to the monorepo root, not cwd).
- Single deploy image (server bundles + serves the SPA), SPA resolved via the
  `@headless-bookkeeping/web` package.
- CI runs a package's tests only when it (or shared root files) changed.

## 13. Risks

cwd-relative paths (§5); workspace-aware `npm ci` COPY order in Docker (§7);
ESM-vs-CJS `require.resolve` for the web dist (§6); jest/tsconfig relocation
(§4); GHA skipped-needs semantics (§9.3); lint glob (§10). The plan addresses
each with a build/test checkpoint.
