# Posting-pipeline business-object refetch stays a caller-supplied callback (no refetch registry)

An architecture review (2026-06-10) flagged the post-approval / post-post **refetch** of a business object (Expense / SalesInvoice) — done via a caller-supplied callback into `PostingPipelineService` — as a candidate to concentrate behind an `object_type → refetch` registry (a DI-collected strategy keyed by `approval.object_type`). After applying the deletion test, **we deliberately did not build it.** This ADR records why, so future reviews don't re-suggest the same refactor.

## Decision

The pipeline `refetch` callback is **not** polymorphic `object_type` dispatch. Each of the three call sites already knows its concrete type at compile time and supplies a thin closure over an already-known id:
- `expenses.controller.ts` → `() => expensesService.getExpenseById(id)`
- `sales-invoices.controller.ts` → `() => salesInvoicesService.getInvoiceById(id)`
- `ai/propose-draft.service.ts` → the expense one
There is no `switch (object_type)` over refetch anywhere on the pipeline path — the callback is the pipeline being intentionally **business-object-agnostic** (its documented design). A registry would *relocate* those N closures into per-type DI registrations + an injection token + a `Refetcher` interface, **deleting nothing from the callers** — the deletion test fails (complexity moves, it does not vanish).

The one genuinely polymorphic spot — `ApprovalsService`'s `switch (object_type)` in `generateDraftVoucher` and the table-name-as-`object_type` reads in `getPostedVoucherForApproval` — is **already concentrated in single methods**, and its own post-approve refetch is `getApprovalById(id)` (it refetches the *Approval*, non-polymorphic), not a business object via dispatch. A refetch registry would not absorb it.

At the current fixed type set (`expense | sales_invoice`, 2 values) the registry is strictly more indirection than it removes. (`sales-invoices.controller.spec.ts` also pins `refetch: expect.any(Function)`, so the callback shape is a tested contract.)

## Revisit trigger

If a **third** approvable `object_type` is added (e.g. `credit_note`), revisit — but the thing to concentrate then is `ApprovalsService`'s `object_type` switch (a small typed `ApprovableRefetchService` could earn its keep), **not** the pipeline callback, which should stay agnostic.
