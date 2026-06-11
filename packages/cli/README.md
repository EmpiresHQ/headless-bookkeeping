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
