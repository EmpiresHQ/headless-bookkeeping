# Bank-statement ingestion via LLM-inferred mapping applied deterministically

`POST /api/bank-statements` accepts an already-parsed `CreateStatementInput`:
an `account_code` (a `BANK_*` account) plus `transactions[]` in the kernel schema
(signed cents, currency, counterparty IBAN/descriptor, reference, disposition
status). A bank's CSV export does not match that shape, and its column layout
drifts over time (the operator's bank changes the format between statements). We
need to turn an arbitrary bank CSV into the kernel schema **without** hardcoding a
per-bank parser and **without** letting a non-deterministic LLM write ledger data
directly. This ADR records how.

## Decision

### Ingestion is a Mastra Workflow, run asynchronously

Building on ADR-0024 (Mastra is the AI runtime), bank-statement ingestion is a
**Mastra Workflow** rather than a synchronous request. Its run state persists in
LibSQL (`./data/mastra.sqlite`); the UI kicks off a run on upload and polls the
run for status + result. This is the system's only asynchronous, queued path —
deliberately scoped to statement ingestion (see "Triage stays synchronous"
below).

### Three steps — the LLM emits rules, not rows

1. **`inferMapping`** — an LLM agent receives the CSV header row plus a few
   sample rows and returns a **schema-validated mapping ruleset**: per target
   field, the source column(s) and a transform (Debit/Credit → sign, decimal →
   integer cents, the date format, which columns carry IBAN / descriptor /
   reference, and the statement-level `account_code`). The agent emits **rules,
   not parsed transactions**. The agent is wired through `AgentConfigService`
   (model + prompt resolution) like the triage agent.
2. **`applyRules`** — a deterministic, pure transformer applies the ruleset to
   every CSV line, producing `transactions[]`.
3. **`createStatement`** — the existing kernel path persists the statement.

### Fresh inference every upload — no cached ruleset

The mapping is inferred anew on **every** upload; it is not cached or reused per
bank/format. The format drifts frequently and statements arrive roughly monthly,
so a saved ruleset would be stale more often than not. One inference per month is
negligible; a cache would be wasted complexity.

### No human-confirm gate — schema validation is the safeguard

The workflow runs straight through; there is no preview/confirm
suspend-resume step. The single safeguard is that `applyRules`'s output is
validated against the `CreateStatementInput` Zod schema before `createStatement`.
A mismatch fails the run with a surfaced error rather than silently creating bad
transactions.

## Why

This preserves the kernel's core invariant — **only schema-validated structured
output crosses into the kernel** (ADR-0024; the posting pipeline). The LLM's
output is a mapping spec; the rows that reach the ledger are produced by
deterministic code from that spec, so the same CSV + same ruleset yields the same
transactions — reproducible and auditable. Letting the LLM emit transaction rows
directly would make ingestion non-deterministic: a re-upload could yield
different ledger data.

Alternatives rejected:

- **Hardcode a per-bank (LHV) parser** — brittle against the drifting format, and
  per-bank parsers multiply with every new bank.
- **Parse in the browser** — duplicates bank-format logic in the UI, untestable
  in the kernel, and couples the client to the format.
- **Cache the ruleset per header signature** — wasted complexity given the format
  churns and uploads are monthly (explicitly rejected by the operator).
- **Human-confirm / preview (suspend-resume)** — judged unnecessary overhead for
  a single trusted operator; the schema-validation failure mode is the net.

## Consequences

- New Mastra Workflow + an `inferMapping` agent (model/prompt via
  `AgentConfigService`); a pure `applyRules` transformer; a thin endpoint to
  start a run and one to poll status/result.
- `@mastra/*` does not load under jest's CJS runtime — the new workflow/agent
  must be added to `test/mastra-stub.ts` and is **not** unit-covered through
  Mastra. Test coverage targets the deterministic `applyRules` (a pure function
  over CSV fixtures) and the schema-validation gate.
- No caching or storage of mappings; no migration for a ruleset table. The
  `bank_statement` and `bank_transaction` tables already exist.
- Document triage stays **synchronous** (ADR-0024's intake path is unchanged);
  async/queued execution is not generalised beyond statement ingestion.
- Explicit failure mode: a bad or ambiguous mapping → schema validation fails →
  the run errors in the UI; the operator re-uploads. Per-upload inference is what
  makes the expected format-drift case a non-event.
- Delivered as **P3** of the operator-SPA work (ADR-0030).
