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

## Releasing (maintainers)

Releases publish `@empireshq/hbk` to the private Verdaccio registry
(`https://npm.empireshq.com`) via `.github/workflows/cli-release.yml`.

The workflow is currently **paused** (manual `workflow_dispatch` only). To enable
automatic diff-driven releases later, uncomment the `push:` trigger in that file —
then any merge to `main` touching `packages/cli/**` cuts a patch release (use
`[minor]` / `[major]` in the merge commit message to bump higher).

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
