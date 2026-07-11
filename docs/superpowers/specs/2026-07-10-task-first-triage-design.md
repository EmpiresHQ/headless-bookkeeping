# Task-First Document Triage

## Problem

The current triage screen exposes an internal failure sentence and gives Retry
AI and Dismiss the same visual weight as the accounting decision. In the invalid
supplier-match case it shows an entity ID that does not exist, although the
operator cannot repair that reference from the UI.

## Product Rule

Every triage state must answer three questions in this order:

1. What decision is needed?
2. What evidence and resulting booking are available?
3. Which domain action resolves it?

The raw machine reason is diagnostic data. It must never be the primary copy or
the only explanation of an actionable state.

## Scenarios

### Invalid Supplier Match

Title: `Supplier could not be confirmed`.

If a supplier is found by a strong observed identifier, show it as a suggestion,
state the matching evidence, summarize the expense draft, and make `Use supplier
and book` the primary action. `Choose another supplier` opens search. The stale
AI entity ID is not displayed and is never treated as evidence.

If no strong match is found, offer supplier search first and creation second.

### New Supplier

Show the extracted supplier name, country, and registration key plus the draft
outcome. The primary action reviews and creates the supplier; search for an
existing supplier remains available.

### Low Confidence Or Category Unresolved

Explain which extracted fields need review and show persisted intake facts. The
primary action opens the classification form. Do not imply that rerunning AI is
the operator's required decision.

### Outgoing Invoice

State that this is a sales document and show customer, amount, VAT, and date when
available. The primary action opens sales-invoice recording.

### OCR Failure

Explain that the file could not be read. The primary action replaces or repairs
the file; retry is secondary.

### Not An Accounting Document

Make `Archive without booking` the primary action. Permanent deletion is a
separate destructive action with confirmation.

## Shared Actions

`Retry AI` and `Archive without booking` are tertiary actions beneath the domain
decision. Archive and delete always require confirmation. Technical details are
collapsed by default.

## API Contract

The pending supplier read model is discriminated:

- `kind: create` contains extracted supplier fields.
- `kind: invalid_match` contains observed identifiers and an optional suggested
  supplier resolved by the server from a strong identifier.

The invalid entity ID proposed by AI is not returned to the operator-facing UI.
Supplier resolution still posts an explicit, existing supplier entity ID.

## Success Criteria

- Document 125 can be resolved to Citybee from the UI without seeing entity
  `705731`.
- Every reason type presents one clear primary domain action.
- Existing search/create, classification, invoice, OCR, retry, archive, and
  delete workflows remain available.
- Desktop and mobile layouts do not overlap, truncate identifiers, or shift when
  data loads.
