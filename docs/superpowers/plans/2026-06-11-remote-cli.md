# `hbk` Remote REST CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `hbk`, a standalone npm-published CLI that auto-generates its entire command tree from the server's OpenAPI spec and drives the headless-bookkeeping HTTP API with a stored Bearer token.

**Architecture:** A new npm workspace package `packages/cli` (ESM, TypeScript). At codegen time the server's OpenAPI document is emitted **offline** from the Nest application context (no HTTP server) into `packages/cli/openapi.json` and turned into `types.gen.ts` via `openapi-typescript`. At runtime `bin.ts` loads the bundled `openapi.json`, and `builder.ts` (a pure function) walks `paths × methods` to build a `yargs` tree; generic handlers translate argv into `openapi-fetch` calls. `login` is the only hand-written command; it stores `{baseUrl, token}` profiles in `~/.config/hbk/config.json`. Releases are diff-driven: a per-PR drift-check keeps the committed artifacts honest, and a path-gated workflow on `main` publishes to npm + GitHub Releases.

**Tech Stack:** TypeScript (ESM), yargs, openapi-fetch, openapi-typescript, vitest, NestJS (`@nestjs/swagger`, existing), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-06-11-remote-cli-design.md`

---

## File Structure

**Server repo (existing `src/`):**
- Modify `src/swagger.ts` — extract `buildOpenApiDocument(app)` (used by both `setupSwagger` and the emitter).
- Create `src/openapi-emit.ts` — offline spec emitter (boots Nest context, no `listen`, writes `packages/cli/openapi.json`).
- Modify root `package.json` — add `workspaces`, `openapi:emit` + `cli:codegen` scripts, `openapi-typescript` devDep.

**New package `packages/cli/`:**
- `package.json` — bin `hbk`, ESM, deps yargs + openapi-fetch, devDeps vitest + typescript + openapi-typescript types.
- `tsconfig.json`, `vitest.config.ts`.
- `src/config.ts` — profile config: pure `resolveContext` + IO `readConfig`/`writeConfig`.
- `src/client.ts` — `openapi-fetch` client factory + generic `makeRequest`.
- `src/builder.ts` — pure `specToCommands(spec)` + `buildCli(spec, deps)` (the autogen core).
- `src/commands/login.ts` — the one hand-written command.
- `src/bin.ts` — entrypoint: load spec, compose builder + login + `api` escape hatch, parse argv.
- `src/openapi.json` *(committed, generated)* — wait: lives at `packages/cli/openapi.json` (package root), imported by `bin.ts`.
- `src/types.gen.ts` *(committed, generated)*.
- Tests: `src/config.test.ts`, `src/builder.test.ts`, `src/commands/login.test.ts`, `src/client.test.ts`.

**CI:**
- `.github/workflows/cli-drift.yml` — per-PR drift-check.
- `.github/workflows/cli-release.yml` — path-gated publish to npm + GitHub Release.

> Note on locations: `openapi.json` is written to **`packages/cli/openapi.json`** (package root, not `src/`). `types.gen.ts` is written to **`packages/cli/src/types.gen.ts`**. The spec doc's section 2 sketch is approximate; this plan is authoritative on paths.

---

## Task 1: Workspace scaffold for `packages/cli`

**Files:**
- Modify: root `package.json` (add `workspaces`)
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/vitest.config.ts`
- Create: `packages/cli/src/.gitkeep`

- [ ] **Step 1: Add the workspaces field to root `package.json`**

Open root `package.json`. Add a top-level `"workspaces"` key (place it right after `"name": "bookkeeping"`):

```json
  "workspaces": [
    "packages/*"
  ],
```

- [ ] **Step 2: Create `packages/cli/package.json`**

```json
{
  "name": "hbk",
  "version": "0.0.0",
  "description": "Remote REST CLI for the headless-bookkeeping API (auto-generated from OpenAPI).",
  "type": "module",
  "bin": {
    "hbk": "./dist/bin.js"
  },
  "files": [
    "dist",
    "openapi.json"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": {
    "node": ">=24"
  },
  "dependencies": {
    "openapi-fetch": "^0.13.0",
    "yargs": "^17.7.2"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/yargs": "^17.0.33",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Create `packages/cli/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": false,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "dist"]
}
```

- [ ] **Step 4: Create `packages/cli/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 5: Create placeholder so the dir is committable**

Create empty file `packages/cli/src/.gitkeep`.

- [ ] **Step 6: Install and verify the workspace resolves**

Run: `npm install`
Expected: completes without error; `node_modules/hbk` symlink exists (`ls -la node_modules/hbk`).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json packages/cli
git commit -m "chore(cli): scaffold hbk workspace package"
```

---

## Task 2: Extract reusable OpenAPI document builder in the server

The current `setupSwagger` both builds the document and mounts the UI. Split out the document construction so the offline emitter can reuse the exact same config.

**Files:**
- Modify: `src/swagger.ts`

- [ ] **Step 1: Rewrite `src/swagger.ts` to export `buildOpenApiDocument`**

Replace the file body so document construction is a separate exported function and `setupSwagger` calls it:

```ts
import { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';

/**
 * Builds the cleaned OpenAPI document (Zod-derived schemas inlined, Bearer
 * scheme applied to every operation). Shared by the HTTP `setupSwagger` mount
 * and the offline emitter (src/openapi-emit.ts) so the spec is identical in
 * both paths.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('headless-bookkeeping API')
    .setDescription(
      'AI-native bookkeeping kernel — remote HTTP API. ' +
        'Authenticate with a Bearer API token (mint one via POST /admin/tokens).',
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'token' },
      'bearer',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  document.security = [{ bearer: [] }];
  return cleanupOpenApiDoc(document);
}

/**
 * Mounts Swagger UI at `/api` and the OpenAPI JSON at `/api-json`.
 *
 * The Swagger routes are raw HTTP routes (not Nest controller handlers), so the
 * global ApiTokenGuard does not gate them — the docs are reachable without a
 * token, while the documented endpoints still require the Bearer token.
 */
export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup('api', app, buildOpenApiDocument(app));
}
```

- [ ] **Step 2: Verify the server still builds**

Run: `npm run build`
Expected: build succeeds (no TypeScript errors in `src/swagger.ts` or `src/main.ts`).

- [ ] **Step 3: Commit**

```bash
git add src/swagger.ts
git commit -m "refactor(swagger): extract buildOpenApiDocument for reuse"
```

---

## Task 3: Offline OpenAPI emitter + codegen scripts

**Files:**
- Create: `src/openapi-emit.ts`
- Modify: root `package.json` (scripts + `openapi-typescript` devDep)

- [ ] **Step 1: Create `src/openapi-emit.ts`**

```ts
/**
 * Offline OpenAPI emitter. Boots the Nest application context WITHOUT opening a
 * port, builds the same document the HTTP server serves at /api-json, and writes
 * it to packages/cli/openapi.json. Run from the repo root.
 *
 *   npm run openapi:emit
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './swagger';

const OUT = resolve(process.cwd(), 'packages/cli/openapi.json');

async function main(): Promise<void> {
  // Silence Nest bootstrap logs so only our own line reaches stdout.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  try {
    const doc = buildOpenApiDocument(app as never);
    writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
    process.stderr.write(`wrote ${OUT}\n`);
  } finally {
    await app.close();
  }
}

void main();
```

> Note: `SwaggerModule.createDocument` accepts an application context for route scanning in this NestJS version; the `as never` cast bridges the `INestApplication` parameter type. If `createDocument` rejects the context at runtime, switch `createApplicationContext` to `NestFactory.create(AppModule, { logger: ['error'] })` (still no `app.listen`, so no port opens).

- [ ] **Step 2: Add scripts + devDep to root `package.json`**

In the `"scripts"` block add:

```json
    "openapi:emit": "ts-node src/openapi-emit.ts",
    "cli:codegen": "npm run openapi:emit && openapi-typescript packages/cli/openapi.json -o packages/cli/src/types.gen.ts",
```

In `"devDependencies"` add:

```json
    "openapi-typescript": "^7.4.0",
```

- [ ] **Step 3: Install the new devDep**

Run: `npm install`
Expected: completes; `npx openapi-typescript --version` prints a 7.x version.

- [ ] **Step 4: Run codegen to produce the artifacts**

Run: `npm run cli:codegen`
Expected: stderr shows `wrote .../packages/cli/openapi.json`; both `packages/cli/openapi.json` and `packages/cli/src/types.gen.ts` now exist. Verify:
`test -s packages/cli/openapi.json && head -c 60 packages/cli/openapi.json` → starts with `{` and contains `"openapi"`.

- [ ] **Step 5: Sanity-check the spec content**

Run: `node -e "const s=require('./packages/cli/openapi.json'); const ops=Object.values(s.paths).flatMap(p=>Object.values(p)).map(o=>o.operationId); console.log('operations:',ops.length); console.log('sample:',ops.slice(0,3))"`
Expected: a non-zero count and operationIds shaped like `ExpensesController_createExpense`.

- [ ] **Step 6: Commit (including generated artifacts)**

```bash
git add src/openapi-emit.ts package.json package-lock.json packages/cli/openapi.json packages/cli/src/types.gen.ts
git commit -m "feat(cli): offline openapi:emit + codegen, commit generated artifacts"
```

---

## Task 4: Config — profiles & resolution precedence

`resolveContext` is a pure function (flags + env + config → resolved context) so the precedence rule is unit-testable without touching disk. `readConfig`/`writeConfig` do the IO.

**Files:**
- Create: `packages/cli/src/config.ts`
- Test: `packages/cli/src/config.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveContext, type CliConfig } from './config.js';

const cfg: CliConfig = {
  currentProfile: 'dev',
  profiles: {
    dev: { baseUrl: 'https://dev.example', token: 'dev-token' },
    prod: { baseUrl: 'https://prod.example', token: 'prod-token' },
  },
};

describe('resolveContext precedence', () => {
  it('uses the active profile when no flags or env are set', () => {
    const ctx = resolveContext({}, {}, cfg);
    expect(ctx).toEqual({
      baseUrl: 'https://dev.example',
      token: 'dev-token',
      profile: 'dev',
    });
  });

  it('selects a named profile via --profile', () => {
    const ctx = resolveContext({ profile: 'prod' }, {}, cfg);
    expect(ctx.baseUrl).toBe('https://prod.example');
    expect(ctx.token).toBe('prod-token');
  });

  it('env overrides the config profile', () => {
    const ctx = resolveContext({}, { HBK_URL: 'https://env', HBK_TOKEN: 'env-tok' }, cfg);
    expect(ctx.baseUrl).toBe('https://env');
    expect(ctx.token).toBe('env-tok');
  });

  it('flags override env and config', () => {
    const ctx = resolveContext(
      { url: 'https://flag', token: 'flag-tok' },
      { HBK_URL: 'https://env', HBK_TOKEN: 'env-tok' },
      cfg,
    );
    expect(ctx.baseUrl).toBe('https://flag');
    expect(ctx.token).toBe('flag-tok');
  });

  it('throws a helpful error when nothing resolves a token', () => {
    expect(() => resolveContext({}, {}, { currentProfile: 'x', profiles: {} })).toThrow(
      /no token/i,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w hbk`
Expected: FAIL — `Cannot find module './config.js'`.

- [ ] **Step 3: Implement `packages/cli/src/config.ts`**

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';

export interface Profile {
  baseUrl: string;
  token: string;
}

export interface CliConfig {
  currentProfile: string;
  profiles: Record<string, Profile>;
}

export interface ResolvedContext {
  baseUrl: string;
  token: string;
  profile: string;
}

/** CLI flags that influence context resolution. */
export interface ContextFlags {
  profile?: string;
  url?: string;
  token?: string;
}

/** Relevant environment variables. */
export interface ContextEnv {
  HBK_URL?: string;
  HBK_TOKEN?: string;
}

export const CONFIG_DIR = join(homedir(), '.config', 'hbk');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const EMPTY: CliConfig = { currentProfile: 'default', profiles: {} };

/**
 * Pure resolution of the active context. Precedence (highest first):
 *   1. flags  --url / --token / --profile
 *   2. env    HBK_URL / HBK_TOKEN
 *   3. the selected profile in config (flags.profile or config.currentProfile)
 * Throws if no baseUrl/token can be assembled.
 */
export function resolveContext(
  flags: ContextFlags,
  env: ContextEnv,
  config: CliConfig,
): ResolvedContext {
  const profileName = flags.profile ?? config.currentProfile;
  const profile = config.profiles[profileName];

  const baseUrl = flags.url ?? env.HBK_URL ?? profile?.baseUrl;
  const token = flags.token ?? env.HBK_TOKEN ?? profile?.token;

  if (!baseUrl) {
    throw new Error(
      `No base URL: pass --url, set HBK_URL, or run "hbk login" (profile "${profileName}").`,
    );
  }
  if (!token) {
    throw new Error(
      `No token: pass --token, set HBK_TOKEN, or run "hbk login" (profile "${profileName}").`,
    );
  }
  return { baseUrl, token, profile: profileName };
}

/** Read config from disk; returns an empty config if the file is absent. */
export function readConfig(path: string = CONFIG_PATH): CliConfig {
  if (!existsSync(path)) return { ...EMPTY };
  return JSON.parse(readFileSync(path, 'utf8')) as CliConfig;
}

/** Persist config (0600) creating the directory if needed. */
export function writeConfig(config: CliConfig, path: string = CONFIG_PATH): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  chmodSync(path, 0o600);
}

/** Upsert a profile and make it current. */
export function upsertProfile(
  config: CliConfig,
  name: string,
  profile: Profile,
): CliConfig {
  return {
    currentProfile: name,
    profiles: { ...config.profiles, [name]: profile },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w hbk`
Expected: PASS (5 tests in `config.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/config.ts packages/cli/src/config.test.ts
git commit -m "feat(cli): config profiles with flag>env>profile resolution"
```

---

## Task 5: HTTP client — generic request via openapi-fetch

**Files:**
- Create: `packages/cli/src/client.ts`
- Test: `packages/cli/src/client.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/client.test.ts` (stubs global `fetch`; asserts Bearer header, path-param substitution, query, and body are forwarded):

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeRequest } from './client.js';

afterEach(() => vi.restoreAllMocks());

function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

describe('makeRequest', () => {
  it('sends Bearer auth, substitutes path params, appends query, returns body', async () => {
    const calls = stubFetch(200, { id: 7 });
    const request = makeRequest({
      baseUrl: 'https://api.example',
      token: 'tok',
      profile: 'dev',
    });

    const res = await request('get', '/api/expenses/{id}', {
      pathParams: { id: '7' },
      query: { include: 'voucher' },
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 7 });

    const { url, init } = calls[0];
    expect(url).toBe('https://api.example/api/expenses/7?include=voucher');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('marks ok=false on >=400 and returns the error body', async () => {
    stubFetch(404, { message: 'not found' });
    const request = makeRequest({ baseUrl: 'https://api.example', token: 't', profile: 'dev' });
    const res = await request('get', '/api/expenses/{id}', { pathParams: { id: '1' } });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'not found' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w hbk`
Expected: FAIL — `Cannot find module './client.js'`.

- [ ] **Step 3: Implement `packages/cli/src/client.ts`**

```ts
import createClient from 'openapi-fetch';
import type { ResolvedContext } from './config.js';

export interface RequestArgs {
  pathParams?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
}

export interface RequestResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export type RequestFn = (
  method: string,
  path: string,
  args?: RequestArgs,
) => Promise<RequestResult>;

/**
 * Generic request function bound to a resolved context. Uses openapi-fetch's
 * low-level `request(method, path, init)` so a single dispatcher serves every
 * operation: openapi-fetch substitutes `{...}` path params from `params.path`
 * and serializes `params.query`. Typing is generic here by design — the CLI
 * dispatches dynamically; openapi-typescript's `types.gen.ts` is for consumers.
 */
export function makeRequest(ctx: ResolvedContext): RequestFn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = createClient<any>({
    baseUrl: ctx.baseUrl,
    headers: { Authorization: `Bearer ${ctx.token}` },
  });

  return async (method, path, args = {}) => {
    const { response, data, error } = await client.request(
      method.toLowerCase() as 'get',
      path,
      {
        params: { path: args.pathParams, query: args.query },
        ...(args.body !== undefined ? { body: args.body } : {}),
      },
    );
    return {
      ok: response.ok,
      status: response.status,
      body: response.ok ? data : (error ?? data),
    };
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w hbk`
Expected: PASS. If openapi-fetch's query serializer renders the URL differently (e.g. encoding), adjust the expected `url` string in the test to match the real output — keep the assertion, fix the literal.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/client.ts packages/cli/src/client.test.ts
git commit -m "feat(cli): generic openapi-fetch request wrapper with Bearer auth"
```

---

## Task 6: Builder — spec → command descriptors (pure)

Split the autogen core: first the pure `specToCommands` that turns the spec into descriptors (easy to test), then (Task 7) wire descriptors into yargs.

**Files:**
- Create: `packages/cli/src/builder.ts`
- Test: `packages/cli/src/builder.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/builder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { specToCommands, actionFromOperationId, kebab } from './builder.js';

const SPEC = {
  paths: {
    '/api/expenses': {
      post: {
        tags: ['expenses'],
        operationId: 'ExpensesController_createExpense',
        summary: 'Create an expense',
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      },
      get: {
        tags: ['expenses'],
        operationId: 'ExpensesController_getExpenses',
        parameters: [
          { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['draft', 'posted'] } },
        ],
      },
    },
    '/api/expenses/{id}': {
      get: {
        tags: ['expenses'],
        operationId: 'ExpensesController_getExpense',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
  },
};

describe('kebab', () => {
  it('camelCase to kebab-case', () => {
    expect(kebab('createExpense')).toBe('create-expense');
    expect(kebab('getVATReport')).toBe('get-vat-report');
  });
});

describe('actionFromOperationId', () => {
  it('strips the Controller_ prefix and kebabs', () => {
    expect(actionFromOperationId('ExpensesController_createExpense')).toBe('create-expense');
  });
  it('falls back to the whole id when there is no underscore', () => {
    expect(actionFromOperationId('ping')).toBe('ping');
  });
});

describe('specToCommands', () => {
  const cmds = specToCommands(SPEC);

  it('derives one command per operation, grouped by tag', () => {
    expect(cmds).toHaveLength(3);
    expect(cmds.every((c) => c.group === 'expenses')).toBe(true);
  });

  it('maps path params to positionals', () => {
    const get = cmds.find((c) => c.action === 'get-expense')!;
    expect(get.method).toBe('get');
    expect(get.path).toBe('/api/expenses/{id}');
    expect(get.positionals).toEqual(['id']);
  });

  it('maps query params to options with enum choices', () => {
    const list = cmds.find((c) => c.action === 'get-expenses')!;
    const status = list.options.find((o) => o.name === 'status')!;
    expect(status.required).toBe(false);
    expect(status.choices).toEqual(['draft', 'posted']);
  });

  it('flags operations that carry a JSON request body', () => {
    const create = cmds.find((c) => c.action === 'create-expense')!;
    expect(create.hasBody).toBe(true);
    expect(create.positionals).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w hbk`
Expected: FAIL — `Cannot find module './builder.js'`.

- [ ] **Step 3: Implement the descriptor half of `packages/cli/src/builder.ts`**

```ts
export interface OptionSpec {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  choices?: string[];
  describe?: string;
}

export interface CommandSpec {
  group: string;
  action: string;
  method: string;
  path: string;
  positionals: string[];
  options: OptionSpec[];
  hasBody: boolean;
  summary?: string;
}

interface RawParam {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  schema?: { type?: string; enum?: string[] };
  description?: string;
}

interface RawOperation {
  tags?: string[];
  operationId?: string;
  summary?: string;
  parameters?: RawParam[];
  requestBody?: { content?: Record<string, unknown> };
}

export interface OpenApiSpec {
  paths: Record<string, Record<string, RawOperation>>;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** camelCase / PascalCase / ALLCAPS runs → kebab-case. */
export function kebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/** `ExpensesController_createExpense` → `create-expense`. */
export function actionFromOperationId(operationId: string): string {
  const underscore = operationId.indexOf('_');
  const name = underscore >= 0 ? operationId.slice(underscore + 1) : operationId;
  return kebab(name);
}

function optionType(schemaType?: string): OptionSpec['type'] {
  if (schemaType === 'integer' || schemaType === 'number') return 'number';
  if (schemaType === 'boolean') return 'boolean';
  return 'string';
}

/** Turn the OpenAPI spec into a flat list of command descriptors. */
export function specToCommands(spec: OpenApiSpec): CommandSpec[] {
  const commands: CommandSpec[] = [];

  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;

      const tag = op.tags?.[0] ?? 'misc';
      const params = op.parameters ?? [];
      const positionals = params
        .filter((p) => p.in === 'path')
        .map((p) => p.name);
      const options = params
        .filter((p) => p.in === 'query')
        .map<OptionSpec>((p) => ({
          name: p.name,
          type: optionType(p.schema?.type),
          required: p.required ?? false,
          choices: p.schema?.enum,
          describe: p.description,
        }));

      commands.push({
        group: kebab(tag),
        action: op.operationId
          ? actionFromOperationId(op.operationId)
          : kebab(`${method}-${path.replace(/[\/{}]/g, '-')}`),
        method,
        path,
        positionals,
        options,
        hasBody: op.requestBody !== undefined,
        summary: op.summary,
      });
    }
  }
  return commands;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w hbk`
Expected: PASS (builder descriptor tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/builder.ts packages/cli/src/builder.test.ts
git commit -m "feat(cli): specToCommands — derive command descriptors from OpenAPI"
```

---

## Task 7: Builder — wire descriptors into yargs + body input

Add `buildCli` (and a body-reading helper) to `builder.ts`. Handlers read the body from `--body-file` or piped stdin, call the injected `RequestFn`, and write JSON to the injected IO.

**Files:**
- Modify: `packages/cli/src/builder.ts`
- Test: extend `packages/cli/src/builder.test.ts`

- [ ] **Step 1: Write the failing test (append to `builder.test.ts`)**

```ts
import { buildCli, readBody, type BuilderDeps } from './builder.js';

describe('readBody', () => {
  it('reads JSON from a file when --body-file is given', () => {
    const deps = { readFileSync: () => '{"a":1}', stdinIsTTY: true, readStdin: () => '' };
    expect(readBody({ 'body-file': '/tmp/x.json' }, deps)).toEqual({ a: 1 });
  });

  it('reads JSON from stdin when piped (no TTY) and no --body-file', () => {
    const deps = { readFileSync: () => '', stdinIsTTY: false, readStdin: () => '{"b":2}' };
    expect(readBody({}, deps)).toEqual({ b: 2 });
  });

  it('returns undefined when no body source is present', () => {
    const deps = { readFileSync: () => '', stdinIsTTY: true, readStdin: () => '' };
    expect(readBody({}, deps)).toBeUndefined();
  });
});

describe('buildCli dispatch', () => {
  function makeDeps() {
    const out: string[] = [];
    const err: string[] = [];
    const requests: { method: string; path: string; args: unknown }[] = [];
    const deps: BuilderDeps = {
      request: async (method, path, args) => {
        requests.push({ method, path, args });
        return { ok: true, status: 200, body: { ok: true } };
      },
      io: { out: (s) => out.push(s), err: (s) => err.push(s) },
      readFileSync: () => '{"gross_amount":100}',
      stdinIsTTY: true,
      readStdin: () => '',
      exit: () => {},
    };
    return { deps, out, err, requests };
  }

  it('routes "expenses get-expense 7" to GET /api/expenses/{id} with the positional', async () => {
    const { deps, requests, out } = makeDeps();
    await buildCli(SPEC, deps).parseAsync(['expenses', 'get-expense', '7']);
    expect(requests[0]).toMatchObject({
      method: 'get',
      path: '/api/expenses/{id}',
      args: { pathParams: { id: '7' } },
    });
    expect(out.join('')).toContain('"ok": true');
  });

  it('sends the file body for a body-bearing command', async () => {
    const { deps, requests } = makeDeps();
    await buildCli(SPEC, deps).parseAsync([
      'expenses',
      'create-expense',
      '--body-file',
      '/tmp/e.json',
    ]);
    expect(requests[0]).toMatchObject({
      method: 'post',
      path: '/api/expenses',
      args: { body: { gross_amount: 100 } },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w hbk`
Expected: FAIL — `buildCli`, `readBody`, `BuilderDeps` not exported.

- [ ] **Step 3: Append the yargs wiring to `packages/cli/src/builder.ts`**

```ts
import yargs, { type Argv } from 'yargs';
import type { RequestFn } from './client.js';

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface BuilderDeps {
  request: RequestFn;
  io: CliIo;
  readFileSync: (path: string) => string;
  stdinIsTTY: boolean;
  readStdin: () => string;
  exit: (code: number) => void;
}

interface BodyDeps {
  readFileSync: (path: string) => string;
  stdinIsTTY: boolean;
  readStdin: () => string;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/**
 * Resolve a JSON request body from --body-file, else from piped stdin (when
 * stdin is not a TTY), else undefined.
 */
export function readBody(
  argv: Record<string, unknown>,
  deps: BodyDeps,
): unknown {
  const file = argv['body-file'] as string | undefined;
  if (file) return JSON.parse(deps.readFileSync(file));
  if (!deps.stdinIsTTY) {
    const piped = deps.readStdin();
    if (piped.trim().length > 0) return JSON.parse(piped);
  }
  return undefined;
}

function yargsType(t: OptionSpec['type']): 'string' | 'number' | 'boolean' {
  return t;
}

/** Build the full yargs CLI from the OpenAPI spec and injected dependencies. */
export function buildCli(spec: OpenApiSpec, deps: BuilderDeps): Argv {
  const commands = specToCommands(spec);
  // Group commands by their `group` so each becomes a yargs command group.
  const byGroup = new Map<string, CommandSpec[]>();
  for (const cmd of commands) {
    const list = byGroup.get(cmd.group) ?? [];
    list.push(cmd);
    byGroup.set(cmd.group, list);
  }

  let cli = yargs().scriptName('hbk');

  for (const [group, cmds] of byGroup) {
    cli = cli.command(group, `${group} operations`, (g) => {
      let sub = g;
      for (const cmd of cmds) {
        const positional = cmd.positionals.map((p) => `<${p}>`).join(' ');
        const commandString = positional ? `${cmd.action} ${positional}` : cmd.action;

        sub = sub.command(
          commandString,
          cmd.summary ?? `${cmd.method.toUpperCase()} ${cmd.path}`,
          (y) => {
            let yy = y;
            for (const name of cmd.positionals) {
              yy = yy.positional(name, { type: 'string', demandOption: true });
            }
            for (const opt of cmd.options) {
              yy = yy.option(opt.name, {
                type: yargsType(opt.type),
                demandOption: opt.required,
                choices: opt.choices,
                describe: opt.describe,
              });
            }
            if (cmd.hasBody) {
              yy = yy.option('body-file', {
                type: 'string',
                describe: 'Path to a JSON request body (or pipe JSON via stdin)',
              });
            }
            return yy;
          },
          async (argv) => {
            const pathParams: Record<string, string> = {};
            for (const name of cmd.positionals) {
              pathParams[name] = String(argv[name]);
            }
            const query: Record<string, unknown> = {};
            for (const opt of cmd.options) {
              if (argv[opt.name] !== undefined) query[opt.name] = argv[opt.name];
            }
            const body = cmd.hasBody
              ? readBody(argv as Record<string, unknown>, deps)
              : undefined;

            const res = await deps.request(cmd.method, cmd.path, {
              pathParams,
              query,
              body,
            });
            if (res.ok) {
              deps.io.out(json(res.body));
            } else {
              deps.io.err(json(res.body));
              deps.exit(1);
            }
          },
        );
      }
      return sub.demandCommand(1, `Specify a ${group} subcommand`).strict();
    });
  }

  return cli
    .demandCommand(1, 'Specify a command group')
    .strict()
    .exitProcess(false)
    .fail((msg, err) => {
      deps.io.err(`${msg || (err && err.message) || 'error'}\n`);
      throw err ?? new Error(msg);
    });
}
```

> Note: move the `import yargs ...` and `import type { RequestFn }` lines to the top of `builder.ts` with the other imports — TypeScript requires imports at module top. The code block above lists them first for clarity.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w hbk`
Expected: PASS (all builder tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/builder.ts packages/cli/src/builder.test.ts
git commit -m "feat(cli): buildCli — yargs tree from descriptors + file/stdin body"
```

---

## Task 8: `login` command

`login` validates the token by calling `GET /admin/tokens` (guarded → 200 means the token works) and persists the profile. The network call and config IO are injected so it is unit-testable.

**Files:**
- Create: `packages/cli/src/commands/login.ts`
- Test: `packages/cli/src/commands/login.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/commands/login.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { runLogin, type LoginDeps } from './login.js';

function deps(overrides: Partial<LoginDeps> = {}): {
  deps: LoginDeps;
  saved: { name: string; baseUrl: string; token: string }[];
  err: string[];
} {
  const saved: { name: string; baseUrl: string; token: string }[] = [];
  const err: string[] = [];
  return {
    saved,
    err,
    deps: {
      validate: vi.fn(async () => 200),
      saveProfile: (name, baseUrl, token) => saved.push({ name, baseUrl, token }),
      io: { out: () => {}, err: (s) => err.push(s) },
      ...overrides,
    },
  };
}

describe('runLogin', () => {
  it('validates then saves the profile on 200', async () => {
    const { deps: d, saved } = deps();
    const code = await runLogin(
      { url: 'https://api.example', token: 'tok', profile: 'dev' },
      d,
    );
    expect(code).toBe(0);
    expect(d.validate).toHaveBeenCalledWith('https://api.example', 'tok');
    expect(saved).toEqual([{ name: 'dev', baseUrl: 'https://api.example', token: 'tok' }]);
  });

  it('does not save and returns 1 when validation is 401', async () => {
    const { deps: d, saved, err } = deps({ validate: vi.fn(async () => 401) });
    const code = await runLogin({ url: 'https://api.example', token: 'bad' }, d);
    expect(code).toBe(1);
    expect(saved).toEqual([]);
    expect(err.join('')).toMatch(/401|invalid|rejected/i);
  });

  it('defaults the profile name to "default"', async () => {
    const { deps: d, saved } = deps();
    await runLogin({ url: 'https://api.example', token: 'tok' }, d);
    expect(saved[0].name).toBe('default');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w hbk`
Expected: FAIL — `Cannot find module './login.js'`.

- [ ] **Step 3: Implement `packages/cli/src/commands/login.ts`**

```ts
import type { CommandModule } from 'yargs';
import type { CliIo } from '../builder.js';
import { readConfig, upsertProfile, writeConfig } from '../config.js';

export interface LoginArgs {
  url: string;
  token: string;
  profile?: string;
}

export interface LoginDeps {
  /** Returns the HTTP status of GET {url}/admin/tokens with the Bearer token. */
  validate: (url: string, token: string) => Promise<number>;
  saveProfile: (name: string, baseUrl: string, token: string) => void;
  io: CliIo;
}

/** Core login logic; returns the process exit code. */
export async function runLogin(args: LoginArgs, deps: LoginDeps): Promise<number> {
  const name = args.profile ?? 'default';
  const status = await deps.validate(args.url, args.token);
  if (status !== 200) {
    deps.io.err(`Token rejected by ${args.url} (HTTP ${status}).\n`);
    return 1;
  }
  deps.saveProfile(name, args.url, args.token);
  deps.io.err(`Logged in to ${args.url} as profile "${name}".\n`);
  return 0;
}

/** Default validator: a real network call to the guarded admin endpoint. */
async function defaultValidate(url: string, token: string): Promise<number> {
  const res = await fetch(`${url.replace(/\/$/, '')}/admin/tokens`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.status;
}

/** yargs command module wiring runLogin to real IO + disk. */
export function loginCommand(io: CliIo): CommandModule {
  return {
    command: 'login',
    describe: 'Store and validate a base URL + API token as a profile',
    builder: (y) =>
      y
        .option('url', { type: 'string', demandOption: true, describe: 'Server base URL' })
        .option('token', { type: 'string', demandOption: true, describe: 'API token' })
        .option('profile', { type: 'string', default: 'default', describe: 'Profile name' }),
    handler: async (argv) => {
      const code = await runLogin(
        { url: argv.url as string, token: argv.token as string, profile: argv.profile as string },
        {
          validate: defaultValidate,
          saveProfile: (name, baseUrl, token) =>
            writeConfig(upsertProfile(readConfig(), name, { baseUrl, token })),
          io,
        },
      );
      if (code !== 0) process.exitCode = code;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w hbk`
Expected: PASS (login tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/login.ts packages/cli/src/commands/login.test.ts
git commit -m "feat(cli): login command — validate token then persist profile"
```

---

## Task 9: Entrypoint `bin.ts` — compose everything

Wire the bundled spec, the autogen tree, `login`, and a raw `api` escape hatch. Context (baseUrl/token) is resolved lazily so `login` and `--help` work without credentials.

**Files:**
- Create: `packages/cli/src/bin.ts`

- [ ] **Step 1: Implement `packages/cli/src/bin.ts`**

```ts
#!/usr/bin/env node
import { readFileSync as fsReadFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hideBin } from 'yargs/helpers';
import { buildCli, type BuilderDeps, type CliIo } from './builder.js';
import { makeRequest } from './client.js';
import { resolveContext, readConfig } from './config.js';
import { loginCommand } from './commands/login.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// openapi.json sits at the package root (one level up from dist/).
const SPEC_PATH = join(__dirname, '..', 'openapi.json');

function readStdinSync(): string {
  try {
    return fsReadFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const spec = JSON.parse(fsReadFileSync(SPEC_PATH, 'utf8'));
  const io: CliIo = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  };

  // Lazily resolve context only when an autogen command actually runs, so
  // `hbk login` and `hbk --help` never require stored credentials. We peek at
  // argv to decide; login/help short-circuit before request() is needed.
  const argv = hideBin(process.argv);
  const isLogin = argv[0] === 'login';

  const request: BuilderDeps['request'] = async (method, path, args) => {
    const ctx = resolveContext(
      {
        profile: process.env.HBK_PROFILE,
      },
      { HBK_URL: process.env.HBK_URL, HBK_TOKEN: process.env.HBK_TOKEN },
      readConfig(),
    );
    return makeRequest(ctx)(method, path, args);
  };

  const deps: BuilderDeps = {
    request,
    io,
    readFileSync: (p) => fsReadFileSync(p, 'utf8'),
    stdinIsTTY: process.stdin.isTTY ?? false,
    readStdin: readStdinSync,
    exit: (code) => {
      process.exitCode = code;
    },
  };

  const cli = buildCli(spec, deps).command(loginCommand(io));

  try {
    await cli.parseAsync(argv);
  } catch {
    if (!isLogin) process.exitCode = process.exitCode || 1;
  }
}

void main();
```

> Note: per-command `--profile`/`--url`/`--token` flags can be layered later; this entrypoint wires profile selection via `HBK_PROFILE` plus env/config, which satisfies the precedence chain's env + profile tiers. `login` always takes explicit `--url/--token`.

- [ ] **Step 2: Build the package**

Run: `npm run build -w hbk`
Expected: `packages/cli/dist/bin.js` exists (`test -f packages/cli/dist/bin.js`).

- [ ] **Step 3: Smoke-test `--help` (no server, no credentials)**

Run: `node packages/cli/dist/bin.js --help`
Expected: prints the command groups (e.g. `expenses`, `login`, ...) and exits 0.

- [ ] **Step 4: Smoke-test a group's help**

Run: `node packages/cli/dist/bin.js expenses --help`
Expected: lists subcommands like `create-expense`, `get-expense <id>`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/bin.ts
git commit -m "feat(cli): bin entrypoint wiring autogen + login"
```

---

## Task 10: Raw `api` escape hatch

A generic `hbk api <method> <path>` for anything the autogen names awkwardly.

**Files:**
- Create: `packages/cli/src/commands/api.ts`
- Modify: `packages/cli/src/bin.ts` (register the command)
- Test: `packages/cli/src/commands/api.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/commands/api.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runApi, type ApiDeps } from './api.js';

describe('runApi', () => {
  it('forwards method, path, and parsed body to request and prints the result', async () => {
    const calls: unknown[] = [];
    const out: string[] = [];
    const deps: ApiDeps = {
      request: async (method, path, args) => {
        calls.push({ method, path, args });
        return { ok: true, status: 200, body: { pong: true } };
      },
      io: { out: (s) => out.push(s), err: () => {} },
      readFileSync: () => '{"x":1}',
      stdinIsTTY: true,
      readStdin: () => '',
      exit: () => {},
    };
    await runApi({ method: 'post', path: '/api/expenses', 'body-file': '/tmp/x.json' }, deps);
    expect(calls[0]).toMatchObject({
      method: 'post',
      path: '/api/expenses',
      args: { body: { x: 1 } },
    });
    expect(out.join('')).toContain('"pong": true');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w hbk`
Expected: FAIL — `Cannot find module './api.js'`.

- [ ] **Step 3: Implement `packages/cli/src/commands/api.ts`**

```ts
import type { CommandModule } from 'yargs';
import { readBody, type BuilderDeps } from '../builder.js';

export type ApiDeps = BuilderDeps;

export interface ApiArgs {
  method: string;
  path: string;
  'body-file'?: string;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** Core raw-request logic. */
export async function runApi(args: ApiArgs, deps: ApiDeps): Promise<void> {
  const body = readBody(args as Record<string, unknown>, deps);
  const res = await deps.request(args.method.toLowerCase(), args.path, { body });
  if (res.ok) deps.io.out(json(res.body));
  else {
    deps.io.err(json(res.body));
    deps.exit(1);
  }
}

/** yargs command module for `hbk api <method> <path>`. */
export function apiCommand(deps: ApiDeps): CommandModule {
  return {
    command: 'api <method> <path>',
    describe: 'Raw request: hbk api <get|post|...> <path> [--body-file | stdin]',
    builder: (y) =>
      y
        .positional('method', { type: 'string', demandOption: true })
        .positional('path', { type: 'string', demandOption: true })
        .option('body-file', { type: 'string', describe: 'JSON body file (or pipe via stdin)' }),
    handler: async (argv) =>
      runApi(
        {
          method: argv.method as string,
          path: argv.path as string,
          'body-file': argv['body-file'] as string | undefined,
        },
        deps,
      ),
  };
}
```

- [ ] **Step 4: Register `apiCommand` in `bin.ts`**

In `packages/cli/src/bin.ts`, add the import near the others:

```ts
import { apiCommand } from './commands/api.js';
```

And change the `cli` composition line to also register it:

```ts
  const cli = buildCli(spec, deps)
    .command(loginCommand(io))
    .command(apiCommand(deps));
```

- [ ] **Step 5: Run the tests + rebuild**

Run: `npm test -w hbk && npm run build -w hbk`
Expected: tests PASS; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/api.ts packages/cli/src/bin.ts packages/cli/src/commands/api.test.ts
git commit -m "feat(cli): raw 'api' escape-hatch command"
```

---

## Task 11: CI — per-PR drift-check

**Files:**
- Create: `.github/workflows/cli-drift.yml`

- [ ] **Step 1: Create `.github/workflows/cli-drift.yml`**

```yaml
name: cli-drift

on:
  pull_request:
    branches: [main]

jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - name: Regenerate OpenAPI artifacts
        run: npm run cli:codegen
      - name: Fail if committed artifacts are stale
        run: |
          git diff --exit-code -- packages/cli/openapi.json packages/cli/src/types.gen.ts \
            || (echo "::error::OpenAPI artifacts are stale — run 'npm run cli:codegen' and commit." && exit 1)
      - name: Build & test the CLI
        run: |
          npm run build -w hbk
          npm test -w hbk
```

- [ ] **Step 2: Validate the workflow locally**

Run: `node -e "require('js-yaml')" 2>/dev/null || npx -y js-yaml .github/workflows/cli-drift.yml >/dev/null && echo OK`
Expected: prints `OK` (YAML parses). If `js-yaml` is unavailable, instead run `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/cli-drift.yml')); print('OK')"`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/cli-drift.yml
git commit -m "ci(cli): per-PR OpenAPI drift-check + build/test"
```

---

## Task 12: CI — path-gated release to npm + GitHub Releases

Independent semver, auto-bumped: **patch** by default; **minor**/**major** when the merge commit message contains `[minor]` or `[major]`.

**Files:**
- Create: `.github/workflows/cli-release.yml`

- [ ] **Step 1: Create `.github/workflows/cli-release.yml`**

```yaml
name: cli-release

on:
  push:
    branches: [main]
    paths:
      - 'packages/cli/**'

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
          cache: npm
      - run: npm ci
      - run: npm run build -w hbk
      - run: npm test -w hbk

      - name: Decide semver bump from commit message
        id: bump
        run: |
          MSG="$(git log -1 --pretty=%B)"
          if echo "$MSG" | grep -q '\[major\]'; then echo "level=major" >> "$GITHUB_OUTPUT";
          elif echo "$MSG" | grep -q '\[minor\]'; then echo "level=minor" >> "$GITHUB_OUTPUT";
          else echo "level=patch" >> "$GITHUB_OUTPUT"; fi

      - name: Bump version
        id: version
        working-directory: packages/cli
        run: |
          NEW="$(npm version ${{ steps.bump.outputs.level }} --no-git-tag-version)"
          echo "version=$NEW" >> "$GITHUB_OUTPUT"

      - name: Publish to npm
        working-directory: packages/cli
        run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Commit version bump
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add packages/cli/package.json
          git commit -m "chore(cli): release ${{ steps.version.outputs.version }} [skip ci]"
          git tag "hbk-${{ steps.version.outputs.version }}"
          git push --follow-tags

      - name: Create GitHub Release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create "hbk-${{ steps.version.outputs.version }}" \
            --title "hbk ${{ steps.version.outputs.version }}" \
            --notes "Auto-release of the hbk CLI. API surface reflects the current OpenAPI spec (packages/cli/openapi.json)."
```

> Note: requires repo secret `NPM_TOKEN` (npm automation token). The package name `hbk` must be available on npm or scoped (e.g. `@your-org/hbk`); if unavailable, rename in `packages/cli/package.json` and the `bin` key stays `hbk`. The release workflow needs push access to `main` — if `main` is protected, allow the actions bot or use a deploy key/PAT.

- [ ] **Step 2: Validate the workflow YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/cli-release.yml')); print('OK')"`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/cli-release.yml
git commit -m "ci(cli): path-gated npm + GitHub release with semver auto-bump"
```

---

## Task 13: Package README + final verification

**Files:**
- Create: `packages/cli/README.md`

- [ ] **Step 1: Write `packages/cli/README.md`**

```markdown
# hbk — headless-bookkeeping CLI

Auto-generated remote REST client for the headless-bookkeeping API. Every command
maps 1:1 to an API operation; the command tree is built from the server's OpenAPI
spec, so the CLI is always exactly the API surface.

## Install

    npm i -g hbk

## Login

Obtain a token out-of-band (the in-process server CLI: `npm run cli token create`),
then:

    hbk login --url https://your-server --token <token> [--profile dev]

Credentials are stored in `~/.config/hbk/config.json` (chmod 600). Override per
invocation with `HBK_URL` / `HBK_TOKEN` / `HBK_PROFILE`.

## Use

    hbk --help                          # list command groups
    hbk expenses --help                 # list a group's operations
    hbk expenses get-expense 7          # GET /api/expenses/{id}
    cat expense.json | hbk expenses create-expense   # body via stdin
    hbk expenses create-expense --body-file expense.json

## Escape hatch

    hbk api get /api/expenses
    cat body.json | hbk api post /api/expenses

## Output

JSON response body → stdout. Notes/errors → stderr. HTTP >= 400 exits non-zero.
```

- [ ] **Step 2: Full verification pass**

Run: `npm run build -w hbk && npm test -w hbk`
Expected: build succeeds; all test files pass (config, client, builder, login, api).

- [ ] **Step 3: End-to-end help smoke test**

Run: `node packages/cli/dist/bin.js --help && node packages/cli/dist/bin.js api --help && node packages/cli/dist/bin.js login --help`
Expected: each prints usage and exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/README.md
git commit -m "docs(cli): package README with usage"
```

---

## Self-Review notes

- **Spec coverage:** §1 boundaries → Task 1/9 (separate package, no DB/Nest at runtime). §2 layout → Tasks 1,4–10. §3 offline emit + codegen → Tasks 2,3. §4 config/auth/login → Tasks 4,8. §5 builder → Tasks 6,7. §5 escape hatch → Task 10. §6 output/errors → Task 7 (handler) + README. §7 testing → tests in Tasks 4–10. §8 drift + release → Tasks 11,12. §9 defaults (openapi-fetch, `hbk`, `default`) → Tasks 5,1,8.
- **Type consistency:** `BuilderDeps` (Task 7) is reused as `ApiDeps` (Task 10) and consumed by `bin.ts` (Task 9). `RequestFn`/`RequestResult` (Task 5) flow into `BuilderDeps.request` (Task 7). `CliConfig`/`resolveContext`/`upsertProfile` (Task 4) used by `login` (Task 8) and `bin.ts` (Task 9). `readBody`/`CommandSpec`/`OptionSpec`/`OpenApiSpec` defined in Task 6/7 and reused in Task 10.
- **Open risk flagged in-task:** offline `createDocument` accepting an application context (Task 3 Step 1 note) — fallback documented. openapi-fetch query-serializer URL exactness (Task 5 Step 4 note) — adjust literal, keep assertion.
