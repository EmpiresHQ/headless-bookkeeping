# Supplier multi-key deduplication — design

**Date:** 2026-06-12
**Status:** Approved (pending spec review)
**Area:** server / AI triage + entity resolution

## Problem

The AI intake pipeline creates a brand-new supplier on every document for the
same real-world counterparty. Observed: supplier "Anomaly" (US, services) was
onboarded twice (entity #5 and #6) from two documents.

Root cause is a single-key, exact-string dedup whose input is non-deterministic:

- `resolveSupplier` (`ai/propose-draft.service.ts`) deduplicates a `create`
  proposal **only** via `entitiesService.findByRegistrationKey(create_registration_key)`.
- `findByRegistrationKey` (`entities.service.ts`) is an exact equality match on
  `entity_identifier.value` where `kind = 'registration_key'` and `confirmed = 1`.
- The supplier proposal schema (`triage/types.ts`) makes `create_registration_key`
  **required** (`z.string().min(1)`). For a non-EU supplier with no VAT/registry
  number, the model is forced to fabricate a value — it produced `"US"` (country
  code) for one document and `"help@anoma.ly"` (support email) for the other.
- Different strings → `findByRegistrationKey` misses → `onboard()` blindly
  `INSERT`s a second entity. No name/country fallback, no normalization, no
  DB-level uniqueness.

The identity of a supplier hinges on a single AI-chosen string, and the schema
forces that string to exist even when the document has no stable identifier.

## Goal

Make supplier resolution robust to documents that carry **different subsets** of
identifying fields, and stop forcing the model to invent a registration key.
Prevent future duplicates; do not silently mis-merge distinct suppliers.

Out of scope: auto-merging the existing duplicate entities (#5/#6). This design
prevents new duplicates only.

## Design

### 1. Structured output (supplier proposal schema)

`supplierProposalSchema`, `mode: 'create'` branch (`triage/types.ts`):

```ts
mode: 'create',
create_name: z.string().min(1),                                 // unchanged, required
create_country: z.string().min(1),                              // unchanged, required
create_registration_key: z.string().nullable().default(null),  // was required → now nullable
create_email:   z.string().nullable().default(null),           // NEW
create_phone:   z.string().nullable().default(null),           // NEW
create_address: z.string().nullable().default(null),           // NEW
```

- The schema stays permissive: all identifiers are nullable. The "all
  identifiers null → triage" rule lives in `resolveSupplier`, not the schema, so
  the document routes to `supplier-unresolved` **with the proposal preserved**
  (existing path) rather than failing Zod and losing the extraction.
- `create_name` and `create_country` remain required — the intrinsic anchoring
  facts a supplier is created with (ADR-0014).
- The triage prompt in `ai/agent-config.ts` is updated to describe the new
  fields and instruct the model **not to fabricate** a registration key when the
  document does not contain one (leave it null).

### 2. Identifier normalization + multi-key matching (`entities.service.ts`)

`entity_identifier` already supports an arbitrary `kind`; no DB schema migration
is needed. New `kind` values: `email`, `phone`, `address` (alongside the
existing `registration_key`).

Values are stored **already normalized**, so matching stays an exact-equality
lookup (consistent with today's `findByRegistrationKey`). Normalization per kind:

| kind               | normalization                                          | match key? |
|--------------------|--------------------------------------------------------|------------|
| `registration_key` | `trim`, `toUpperCase`, strip internal spaces           | yes        |
| `email`            | `trim`, `toLowerCase`                                  | yes        |
| `phone`            | keep leading `+` and digits; drop spaces/()/-          | yes        |
| `address`          | `trim`, collapse whitespace, `toLowerCase`             | **no — stored only** |

`address` is intentionally **not** a match key: exact-match on address produces
false merges (e.g. multiple tenants of a coworking space, formatting variance).
It is stored for record-keeping / future use.

New method:

```ts
resolveByIdentifiers(candidates: { kind: string; value: string }[]): Promise<number[]>
```

Normalizes each candidate, queries `entity_identifier` for any row matching
`(kind, value)` with `confirmed = 1`, returns the **distinct** `entity_id`s.

`findByRegistrationKey` stays (still used elsewhere); `resolveByIdentifiers` is
the new multi-key entry point.

### 3. `resolveSupplier` rewrite (`ai/propose-draft.service.ts`)

`mode === 'create'` branch:

```
keys = normalize([reg_number, email, phone]) without nulls   // address excluded
if keys is empty:               return supplier-unresolved   // → triage
matches = resolveByIdentifiers(keys)
  0 distinct entities:          onboard(new) with ALL present identifiers (incl. address)
  exactly 1 distinct entity:    resolve to it; backfill any missing identifiers onto it
  >1 distinct entities:         return supplier-unresolved    // conflict → triage
```

- **Empty keys → triage:** no strong identifier to anchor on; route to
  `supplier-unresolved` so an operator confirms rather than spawning a nameless
  duplicate.
- **Conflict (>1 entity) → triage:** ambiguity is a red flag (possibly a sign
  two existing entities should be merged); never guess.
- **Backfill / enrichment:** on a single match, `INSERT` any candidate
  identifiers the entity does not yet have (`confirmed = 1`). Matching gets more
  robust over time.

`onboard` (`entities.service.ts`) is extended to write all present identifiers,
not just `registration_key`.

### 4. Data model / migration

- No storage migration: `entity_identifier` is already generic over `kind`.
- **No hard `UNIQUE(kind, value)` constraint.** Existing data already contains
  junk (entity #5 has `registration_key = "US"`); a global unique index would
  fail on it. Cross-entity collisions are handled at the application layer (the
  conflict → triage path above).
- Existing duplicate "Anomaly" entities (#5/#6) are **not** auto-merged. A manual
  merge / dedicated merge feature is out of scope.

### 5. Testing + evals

Unit:
- Normalizers — one case per `kind` (idempotent, expected canonical form).
- `entities.service.resolveByIdentifiers` — 0 / 1 / many matches; `confirmed = 0`
  rows are ignored.

Service:
- `resolveSupplier`:
  - all identifiers null → `supplier-unresolved`.
  - new supplier → `onboard` writes every present identifier (incl. address).
  - **"Anomaly" regression:** doc1 with `create_email` + doc2 with the same
    email but `create_registration_key = null` → resolve to the **same** entity.
  - conflict (email→A, phone→B) → `supplier-unresolved`.
  - single match missing a key → backfill inserts it.

Evals (follow-up, `evals/triage/`):
- Extend `classify.yaml` with cases that extract `email` / `phone` /
  `registration_key` from a document.
- Add a case asserting the model leaves `create_registration_key` **null** when
  the document has no registry/VAT number (no fabrication).

## Affected files

- `packages/server/src/triage/types.ts` — schema + types.
- `packages/server/src/ai/agent-config.ts` — triage prompt.
- `packages/server/src/entities/entities.service.ts` — normalizers,
  `resolveByIdentifiers`, extended `onboard`.
- `packages/server/src/ai/propose-draft.service.ts` — `resolveSupplier` rewrite.
- Corresponding `.spec.ts` files + `evals/triage/classify.yaml`.

## Follow-ups (not in this change)

- Merge tool for existing duplicate entities.
- Optional: distinguish operator-confirmed vs AI-proposed identifiers (currently
  all `confirmed = 1`).
