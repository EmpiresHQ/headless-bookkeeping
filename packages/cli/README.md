# hbk — headless-bookkeeping CLI

Auto-generated remote REST client for the headless-bookkeeping API. Every command
maps 1:1 to an API operation; the command tree is built from the server's OpenAPI
spec, so the CLI is always exactly the API surface.

## Install

Published to the private registry `https://npm.empireshq.com` under the
`@empireshq` scope. Point that scope at the registry once, then install:

    npm config set @empireshq:registry https://npm.empireshq.com
    npm i -g @empireshq/hbk

The installed binary is `hbk`.

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

## The OpenAPI spec is generated at release, not committed

`openapi.json` (and `types.gen.ts`) are **build artifacts**, gitignored, never
committed. The release workflow regenerates the spec fresh from the current
server code (`npm run cli:codegen` → offline Nest emit) right before publishing,
so a published `hbk` always matches the API it was cut from. There is no drift
check and no per-PR codegen burden — changing the API never breaks CI here.

For local CLI development, generate the spec once so `hbk --help` works:

    npm run cli:codegen        # from the repo root; writes packages/cli/openapi.json

## Releasing (maintainers)

Releases publish `@empireshq/hbk` to the private Verdaccio registry
(`https://npm.empireshq.com`) via `.github/workflows/cli-release.yml`.

The workflow is **manual** (`workflow_dispatch`). Cut a release with:

    gh workflow run cli-release.yml --ref main

It regenerates the spec, builds + tests the CLI, bumps the version
(patch by default; put `[minor]` / `[major]` in the triggering commit message to
bump higher), publishes to Verdaccio, then tags + creates a GitHub Release.

### One-time: create the publish token (Verdaccio)

Verdaccio has no "create token" UI — the token is what `npm login` writes to your
`~/.npmrc`:

    npm login --registry https://npm.empireshq.com --scope @empireshq
    # enter your Verdaccio username / password / email

Then copy the auth token it stored:

    grep '//npm.empireshq.com/:_authToken' ~/.npmrc
    # //npm.empireshq.com/:_authToken=<TOKEN>

Put `<TOKEN>` into the GitHub repo secret **`NPM_TOKEN`** (Settings → Secrets and
variables → Actions). The workflow injects it as `NODE_AUTH_TOKEN` for `npm publish`.
