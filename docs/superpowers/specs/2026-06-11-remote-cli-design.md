# Design: `hbk` — remote REST CLI (auto-generated from OpenAPI)

Date: 2026-06-11
Status: Approved (design), pending implementation plan

## 1. Purpose & boundaries

A standalone workspace package (`packages/cli`) shipping a `hbk` binary: a thin
**remote** HTTP client for the headless-bookkeeping server. It calls the running
server over HTTP with `Authorization: Bearer <token>`.

It explicitly does **not**:

- touch the SQLite database,
- boot the NestJS application context,
- mint the bootstrap token.

Those remain the job of the existing in-process `src/cli.ts`, which runs locally
next to the DB and exists precisely to solve the chicken-and-egg of minting the
first token before any token exists. The two tools are complementary and live in
separate packages:

| Tool | Nature | Job |
|------|--------|-----|
| `src/cli.ts` (existing) | in-process, boots Nest, hits local SQLite | bootstrap: mint first token, configure org, open period, junk cleanup |
| `hbk` (this design) | remote HTTP client | day-to-day operations against a running server |

The `hbk` command tree is built **at runtime from a bundled `openapi.json`**, so
the CLI is always exactly equal to the server's API surface with zero hand-
maintained command code.

## 2. Package layout

```
packages/cli/
  package.json          # bin: { hbk: ./dist/bin.js }; deps: yargs, openapi-fetch
  src/
    bin.ts              # entrypoint: load spec -> builder -> parseAsync(argv)
    config.ts           # profiles: read/write ~/.config/hbk/config.json
    client.ts           # openapi-fetch instance + Bearer injection + baseUrl
    builder.ts          # spec (JSON) -> yargs command tree (the autogen core)
    commands/
      login.ts          # the ONE hand-written command
    openapi.json        # committed; refreshed by codegen
    types.gen.ts        # committed; openapi-typescript output
  scripts/
    pull-schema.ts      # GET <url>/api-json -> openapi.json + run openapi-ts
```

It is wired as an npm workspace of the root repo but is otherwise isolated from
`src/`.

## 3. Codegen pipeline (build-time)

`npm run codegen` inside the package:

1. `pull-schema.ts` does `GET $HBK_SCHEMA_URL/api-json` and writes `openapi.json`.
2. Runs `openapi-typescript openapi.json -o src/types.gen.ts`.

Both artifacts are **committed**. Building the package and running `hbk --help`
therefore require no live server. Updating the API surface = re-run codegen +
commit the diff. In CI this is a dedicated step run against a booted instance
(schema is pulled over HTTP, per the chosen approach).

## 4. Config & auth

Auth on the server is **Bearer API token only** — there is no
username/password login, and `POST /admin/tokens` is itself behind the guard
(not `@Public`). So `hbk login` is not a credentials exchange: it ingests a
token obtained out-of-band (via the in-process `src/cli.ts token create`),
validates it, and persists it.

Config file: `~/.config/hbk/config.json`, written with `chmod 600`:

```json
{
  "currentProfile": "dev",
  "profiles": {
    "dev": { "baseUrl": "https://...", "token": "..." }
  }
}
```

Context resolution precedence (highest first):

1. flags: `--profile` / `--url` / `--token`
2. env: `HBK_URL` / `HBK_TOKEN`
3. active profile in config

`hbk login`:

- accepts `--url`, `--token`, and optional `--profile` (default `default`),
- validates by calling `GET /admin/tokens` (which is guarded, so `200` = token
  works, `401` = bad token); `/admin/health` is `@Public` and cannot validate a
  token,
- saves the profile and sets it current on success.

## 5. Core: `builder.ts` (spec -> yargs)

`buildCli(spec, io, ctx): Argv` — a pure function over the parsed OpenAPI JSON.
Walk `paths × methods`:

- **Group** = `tag` (kebab-cased). The server has `@ApiTags` on 28/29
  controllers, giving clean resource groups: `expenses`, `sales-invoices`,
  `vat-report`, ...
- **Action** = the method-name portion of the default nestjs-swagger
  `operationId` (`ExpensesController_createExpense`), suffix stripped, kebab-cased:
  `createExpense` -> `create-expense`, `postExpense` -> `post-expense`.
- **Options**:
  - `path` parameters -> required positionals
  - `query` parameters -> `--flags` with type / required / enum derived from the
    schema
  - request body (JSON) -> supplied via **`--body-file <path>` or piped stdin**
    (detected via non-TTY stdin), e.g. `cat doc.json | hbk expenses create-expense`.
    No per-field flags.
- **Handler** (generic): assembles `{ params, query, body }` from argv, calls the
  `openapi-fetch` client for that method+path, prints the JSON response body to
  stdout.

A raw escape hatch `hbk api <METHOD> <path> [--body-file|stdin]` is provided for
anything non-standard, though full autogen already covers the surface.

## 6. Output & error conventions

- stdout: response body as JSON only (machine-readable; matches the existing
  CLI's stdout discipline).
- stderr: notes, progress, usage, and error bodies.
- HTTP status >= 400: print the error body to stderr and `exit 1`.
- JSON output is the default; human-readable tables are intentionally out of
  scope for this iteration (YAGNI), but the output layer leaves room for them.

## 7. Testing

- `builder.ts`: pure `(spec) -> Argv`; unit-test the mapping (path-param ->
  positional, query -> flag, enum constraints, body via file/stdin) against a
  small fixture spec.
- `config.ts`: unit-test the resolution precedence (flag > env > profile).
- Handlers: a couple of smoke tests with HTTP mocked (msw or a fetch stub).
- No live server required for the unit suite.

## 8. Defaults chosen (not separately asked)

- HTTP client: `openapi-fetch` (runtime companion to `openapi-typescript`).
- Binary name: `hbk`.
- Default profile name: `default`.

## 9. Decisions log

- Separate package, not a mode of the existing CLI (user: "отдельный пакет вообще").
- Workspace in this repo; schema pulled over HTTP at codegen time.
- `login` stores URL + token with multi-profile support; validation via a real
  network call to a guarded endpoint.
- Full autogen from OpenAPI; command tree built at runtime from a bundled spec.
- Request body via `--body-file` or stdin pipe only (no inline `--body`, no
  per-field flags).
