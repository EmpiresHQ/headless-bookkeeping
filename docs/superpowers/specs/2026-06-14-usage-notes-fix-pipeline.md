# Usage-notes fix pipeline

**Date:** 2026-06-14
**Branch / worktree:** `fix/cli-usage-notes` / `usage_notes_fixes`
**Source:** field notes from replicating the override OÜ books through the `hbk` CLI (`usage_note.md`). This is the single design source for every fix that came out of those notes — CLI and application — in one uniform record format. GitHub issues carry tracking; this doc carries the design decisions.

**Touches ADRs:** 0024 (AI ingestion two-pass + durable HITL), 0014 (supplier memory & identity), 0010 (intake triage, dedup, corrections). No ADR is overturned — these are gap fixes consistent with documented intent.

## Record format

Every fix below uses the same template so the pipeline reads uniformly:

> **Issue · Severity · Status · Depends on**
> **Problem** — user-visible symptom.
> **Root cause** — `file:line`, with a snippet where it sharpens the point.
> **Decision** — what we will do (resolved via grilling; not a survey of options).
> **Scope & testing** — the seam, the cases, and what is explicitly out.

Status vocabulary: `proposed` → `ready` (design locked) → `in-progress` → `done`.

## Pipeline

| ID | Area | Title | Issue | Severity | Status | Commit |
|----|------|-------|-------|----------|--------|--------|
| CLI-1 | cli | Expose JSON request-body fields as flags and in `--help` | [#128](https://github.com/EmpiresHQ/headless-bookkeeping/issues/128) | 🟡 medium | ✅ done | `0e40e56` |
| A | intake | `match` to a non-existent / wrong-role entity crashes intake and strands the document in `pending` | [#129](https://github.com/EmpiresHQ/headless-bookkeeping/issues/129) | 🔴 urgent | ✅ done | `a3ccaab` |
| F | reconciliation | `getMatchCandidates` returns candidates unranked | [#130](https://github.com/EmpiresHQ/headless-bookkeeping/issues/130) | 🟡 medium | ✅ done | `76e2f71` |
| C | intake/ocr | HEIC documents fail OCR | [#131](https://github.com/EmpiresHQ/headless-bookkeeping/issues/131) | 🟠 capability | ✅ done | `8c1e7df` |
| B | intake | `match` resolves to a plausible-but-wrong supplier | [#132](https://github.com/EmpiresHQ/headless-bookkeeping/issues/132) | 🟠 correctness | ✅ done | `982c57d` |
| D | categories | Coarse expense categories | — | low | folded | extended chart-of-accounts |

All five shipped via TDD (red→green, integration-level cases against in-memory SQLite + real services). An eval (`c4e21a9`) guards observed-country fidelity for B. D is folded into the in-progress extended chart-of-accounts effort and not tracked here.

---

## CLI-1 — Expose JSON request-body fields as flags and in `--help`
**Issue:** [#128](https://github.com/EmpiresHQ/headless-bookkeeping/issues/128) · **Severity:** 🟡 medium · **Status:** ready · **Depends on:** —

### Problem
A human or AI operator driving the kernel through `hbk` cannot discover or supply request-body fields for JSON-body operations. `hbk reporting-periods create --name … --start_date …` fails with *"Unknown arguments"*; the only path is hand-authored JSON piped to `hbk api post`. And `hbk <group> <command> --help` on any body-taking leaf prints only `--help`/`--version` — field names (`gross_amount`, `matchType`, `account_code`, …) live only in OpenAPI. The CLI advertises a self-describing 1:1 API map, but for the ledger-writing operations it is neither.

### Root cause
`packages/cli/src/builder.ts`: the builder expands **query** params and **multipart** form fields into flags, but for `application/json` bodies (~L281-287) it only offers `--body-file`/stdin and never introspects the schema — neither to make flags nor to list fields in help. The schemas exist, but `nestjs-zod`'s `cleanupOpenApiDoc` emits them into `components.schemas` referenced via `$ref`/`allOf`, so `requestBody.content['application/json'].schema.properties` reads empty without dereferencing.

### Decision
Symmetric with the existing multipart path, no server change:
- **Resolve `$ref`/`allOf`** against `components.schemas` (add `components` to the builder's `OpenApiSpec` type + a deref helper that merges `allOf`).
- **Flags for fully-scalar bodies** (all-or-nothing): if every top-level property is scalar (`string`/`number`/`integer`/`boolean`/enum), emit one `--<field>` flag per property; otherwise keep the body on stdin. Ground truth from the current spec: **28 scalar → flags, 4 mixed → stdin, 2 multipart** already flag-driven.
- **Flag name = schema property exactly** (`--start_date`), matching multipart (`--account_code`).
- **Body flags never `demandOption`** — required-ness is shown as `(required)` in the description; server Zod-400 stays the source of truth (else the stdin path breaks).
- **Conflict = error:** body flags **and** stdin/`--body-file` together → explicit failure, no merge.
- **Types:** integer/number → yargs `number`, boolean → `boolean`, enum → `choices`.
- **Help (#3) for stdin-only bodies:** epilogue "Request body fields:" listing names + types from the resolved schema. Scalar bodies need no epilogue — flags already show under Options.

### Scope & testing
- Module: CLI builder only. Seam: existing `packages/cli/src/builder.test.ts` (pure `specToCommands` / `buildCli` / `readBody` with injected `BuilderDeps`).
- Cases: `$ref` and `allOf` resolve to the right field list; scalar body assembles the expected JSON; number/boolean typed correctly and omitted optionals absent; enum → `choices` rejecting out-of-set; mixed body generates no flags, reads stdin, and prints the body-fields epilogue; flag + stdin ⇒ conflict error + non-zero exit; existing query/multipart/`readBody` tests stay green.
- End-to-end (live `bk.010.ee`): `documents upload-document --file` and `bank start-import --file …` confirmed working (multipart already shipped via #127; uploads dedup by hash).
- **Out:** nested/array body flags (the 4 mixed endpoints stay on stdin); any server change.

---

## A — Invalid `match` proposal crashes intake → `pending` deadlock
**Issue:** [#129](https://github.com/EmpiresHQ/headless-bookkeeping/issues/129) · **Severity:** 🔴 urgent · **Status:** ready · **Depends on:** —

### Problem
A legitimate document is permanently lost. When triage proposes `supplier_proposal: { mode: 'match', match_entity_id: N }` for an id that does not exist (a hallucination — observed as `500001`), intake throws a foreign-key violation while creating the expense. The document is left in `pending`, and **no API path recovers it**: `resolve-supplier` and `manual-classify` both require `needs_triage`; re-triage re-runs the same deterministic proposal and crashes identically.

### Root cause
`packages/server/src/ai/propose-draft.service.ts` (~L233):

```ts
if (proposal.mode === 'match') {
  return { outcome: 'resolved', supplierId: proposal.match_entity_id }; // never checks existence/role
}
```

`createExpense` is then called with a phantom `supplier_id` → FK violation → the exception escapes `IntakeWorkflowService.process()`. The document was `markProcessing`'d but never transitioned, so it stays `pending` (the `finally` only clears the processing flag). The `create` branch routes resolution failures to `needs_triage`; `match` is the only un-guarded supplier path.

### Decision
1. **Validate the match.** Look the entity up; if it does not exist **or** `role !== 'supplier'` (mirroring `IntakeWorkflowService.resolveSupplier` ~L338-343), return `supplier-unresolved` with a reason naming the id. The workflow already stores the `triageResult` and routes `supplier-unresolved` → `needs_triage` (intake-workflow.service.ts ~L229-239), making the document recoverable.
2. **Safety net.** Wrap the routing section of `process()` so any *unexpected* throw routes to `needs_triage` (reason = error message) instead of escaping. Consistent with ADR-0024.

### Scope & testing
- propose-draft unit: `match`→nonexistent ⇒ `supplier-unresolved`; `match`→customer (wrong role) ⇒ `supplier-unresolved`; `match`→valid supplier ⇒ resolves & posts.
- intake-workflow: failed-match document ends in `needs_triage` (not `pending`) with `triageResult` stored, then resolvable via `resolveSupplier(documentId, validSupplierId)`; injected throw in routing ⇒ `needs_triage`.
- **Out:** corroborating a valid-but-wrong supplier (→ B).

---

## B — `match` resolves to a plausible-but-wrong supplier
**Issue:** [#132](https://github.com/EmpiresHQ/headless-bookkeeping/issues/132) · **Severity:** 🟠 correctness · **Status:** proposed · **Depends on:** A

### Problem
Triage can match a document to the wrong *existing* supplier and auto-post. Field case: an Estonian rent invoice (Paavli Kinnisvara) matched to a US software supplier (Anomaly) — category and VAT correct, counterparty wrong, requiring `correct-expense`. A's fix does not catch this: the entity exists and is a supplier, so validation passes.

### Root cause
The `match` proposal carries only an id and nothing to check it against (`packages/server/src/triage/types.ts`):

```ts
z.object({ mode: z.literal('match'), match_entity_id: z.number().int().positive() })
```

No *observed* supplier identity (name / country / identifiers from the document) rides on `match` — those fields exist only on `create` — and `TriageResult`'s booking-critical fields don't carry them either. The kernel has no deterministic basis to corroborate and trusts the model's semantic match.

### Decision (schema + prompt + deterministic guard)
1. **Schema:** extend the `match` proposal (or `TriageResult`) with the document's *observed* identity — observed name, observed country, observed strong identifiers.
2. **Prompt:** triage instructions emit the observed identity alongside the matched id.
3. **Guard:** in `proposeDraft`'s `match` branch, compare observed identity vs the matched entity. On disagreement (country mismatch, or no identifier overlap when the document shows one) → `needs_triage`. Deterministic; does not lean on model confidence.

Builds on A's validated-match path.

### Scope & testing
- propose-draft unit: observed country ≠ matched entity country ⇒ `needs_triage`; corroborating country/identifier ⇒ resolves & posts.
- schema/eval: `match` validates with the new fields; eval suite covers the model emitting them.
- **Out:** the crash/deadlock (A); match *recall* (this is precision).

---

## F — `getMatchCandidates` returns candidates unranked
**Issue:** [#130](https://github.com/EmpiresHQ/headless-bookkeeping/issues/130) · **Severity:** 🟡 medium · **Status:** ready · **Depends on:** —

### Problem
Match candidates for a bank transaction come back in repository order (≈ voucher id): the top candidate is always the first voucher regardless of fit. The operator/agent must scan the whole list and pick the exact match by hand. On statements with many open vouchers the deterministic candidates endpoint is far less useful than it should be.

### Root cause
`packages/server/src/reconciliation/reconciliation.service.ts`, `getMatchCandidates` (~L238-250): iterates `findAllArCandidates()` / `findAllApCandidates()` and pushes a view per voucher in repository order; no sort against the line's `lineRemaining` before returning.

### Decision
Rank `candidates` deterministically (no fuzzy/AI signal):
1. exact remaining match first — `voucherRemaining === lineRemaining`;
2. then amount proximity — `|voucherRemaining - lineRemaining|` ascending;
3. stable tiebreak by `voucherId`.

Counterparty / invoice-number scoring stays in `proposeMatches` to avoid duplicating logic across endpoints.

### Scope & testing
- reconciliation.service unit: mixed remaining balances + known `lineRemaining` ⇒ order is exact → nearest → id; include a tie to pin the id tiebreak.
- **Out:** `proposeMatches` ranking and the single-eligible-candidate auto-match.

---

## C — HEIC documents fail OCR
**Issue:** [#131](https://github.com/EmpiresHQ/headless-bookkeeping/issues/131) · **Severity:** 🟠 capability · **Status:** proposed · **Depends on:** HEIC decoder dependency decision

### Problem
HEIC photos (default iPhone format) can't be triaged. Historically they arrived as `application/octet-stream` and hit the router's *"Unsupported document type"* path; even with a correct `image/heic` type they route to the LLM vision transcriber, which doesn't decode HEIC and fails downstream. Either way: silent failure, not a booked expense.

### Root cause
`packages/server/src/triage/mime-routing-transcriber.ts`: any `image/*` (~L36) is forwarded as-is to vision. HEIC is an `image/*` the vision provider does not decode. PDFs are already rasterized to PNG before vision (`PdfRasterizer.toPngPages`); HEIC has no equivalent decode step.

### Decision
Add a server-side **HEIC→PNG decode** before the vision call, mirroring PDF rasterization:
- detect `image/heic` / `image/heif`, decode to PNG (e.g. `sharp`+libheif or `heic-convert`) before vision;
- on decode failure, fall back to an explicit actionable rejection ("convert to PDF/JPG") → `needs_triage`, never a silent failure.

Introduces a new native dependency (libheif); weigh deploy-image size / build cost when picking the decoder — this is the blocking design decision before implementation.

### Scope & testing
- mime-routing/transcriber unit: `image/heic` decoded to PNG and handed to vision as `image/png`; decode failure ⇒ typed unsupported/needs-triage outcome with actionable detail.
- **Out:** other formats (e.g. multipage TIFF nuances).

---

## D — Coarse categories (folded)
Examples (car repair → `contractor`, monitor → `software`) are AI-quality and not KMD-critical. Category granularity is already being addressed by the in-progress extended chart-of-accounts work; a duplicate issue would fragment that effort. Tracked there, not here.
