# Triage prompt evals

## Production pipeline (primary regression suite)

`npm run eval:triage:pipeline` runs the actual `MastraService` agent factories,
`Pass2AgentService`, production prompts, Zod schemas and application-owned lookup.
Only business reads are replaced with synthetic fixtures; it cannot write to the
books. This is a live model eval, not a mock-agent test and not copied prompts.

Use Node 24 and the repository dependencies (`npm ci`). Export `EVAL_BASE_URL`,
`EVAL_MODEL` (with or without the `openai/` prefix) and `OPENAI_API_KEY` in the
process environment. The runner does not automatically load `.env` files.

```sh
EVAL_REPORT=/tmp/triage-eval.json npm run eval:triage:pipeline
# Optional: repeated samples or one diagnostic scenario
EVAL_REPEATS=3 EVAL_FILTER=forged-id npm run eval:triage:pipeline
```

Cases and exact assertions live in `packages/server/test/triage-evals/cases.ts`:

- Positive: existing supplier, new supplier, European number formatting,
  discount/reverse-charge invoice, outgoing customer.
- Negative: forged database ID/prompt injection, missing supplier identifiers,
  missing country, buyer mistaken for seller, historical category contradicted
  by the actual purchase, order confirmation mistaken for invoice, newsletter.

The runner exits nonzero on any failed assertion, pipeline failure or empty case
selection. Reports contain only synthetic documents/results and timings, never
credentials. It tests the default production prompts; operator prompt overrides
are not loaded. Repeat runs when changing a prompt, model or inference runtime.

The normal server unit suite tests negative controls for these eval assertions
(wrong but schema-valid IDs/amounts/categories must fail). It also tests malformed
extraction/context, failed lookup, bounded retries, deterministic ID attachment,
and database-backed history selection. Existing intake and posting integration
and e2e suites continue to cover duplicate prevention and Rules → Policy.

Regular PR CI runs the offline assertion, unit and integration tests. Live
model evals run with the command above and produce a standalone JSON report;
they are not automatically run in CI and require a reachable inference endpoint.

## Legacy endpoint capability probes

The three promptfoo commands remain available for diagnosing older setups:

- `npm run eval:triage:tools`: any valid tool call with `tool_choice:auto`.
  This does **not** test forced tool choice or the current production pipeline.
- `npm run eval:triage:classify`: six direct-classification examples without
  existing-supplier lookup context.
- `npm run eval:triage:classify-outgoing`: three outgoing-invoice examples.

These use historical prompt/schema snapshots; passing them is not evidence that
production triage works. Automatic triage no longer relies on tool calling.
See `.env.example` for endpoint variable names. `npm run eval:view` opens the
promptfoo report; pipeline reports are standalone JSON.
