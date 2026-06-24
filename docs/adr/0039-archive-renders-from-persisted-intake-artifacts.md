# Document archive renders from persisted intake artifacts, never by recomputation

The `/documents` archive (and the document-detail view) renders a Document's preview thumbnail and its classification **from data persisted at intake time** — never by re-invoking OCR or the LLM to display what was already computed. Concretely: a `preview_path` thumbnail is rendered once as an early intake step (decoupled from the OCR/classification outcome) and reused thereafter; and the classification facts (`confidence`, `document_type`, `kind`, on top of the category/amounts already stored) are persisted onto the draft `Expense` so the detail view reads them directly. The old `Debug` action — which called `pass2Agent.classify()` on every click — is replaced by a read-only `Details` view. Recomputation remains available **only** as an explicit, human-initiated re-triage in the `/intake` work queue (the existing Retry path).

## Context

The previous `Debug` endpoint re-ran the full OCR + LLM classification pipeline every time an operator wanted to *see* what a document was — the very pipeline `feat/ocr-perf` exists to make cheaper (10-minute timeout, vision endpoint contention). Yet the results already existed: OCR markdown as a persisted `ocr_markdown` artifact, and the classification materialized into the draft Expense. Displaying a document should be a read, not a recomputation.

## Consequences

- **Persisting display fields is now load-bearing.** `confidence` / `document_type` / `kind` must be written at triage (migration + write site in `propose-draft.service`), and `preview_path` must be populated. A lazy fallback renders a missing preview once and persists it, so no backfill job is needed for pre-existing documents.
- **Surprising-on-purpose deletion.** Because the persisted artifact is the displayed evidence, deleting a Document linked to a posted/reversed Expense is blocked (consistent with ADR-0012 no-break-glass).
- **Reversible escape hatch retained.** Genuinely re-running the AI is still possible, but it is an explicit operator action in the work queue, not a side effect of viewing the archive.
