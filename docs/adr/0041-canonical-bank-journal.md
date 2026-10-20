# Canonical bank-transaction journal: one movement, many statements; audited duplicate repair

Issue #399's reproduced case: the same LHV bank account imported a
May–June statement and a June statement; the pre-#399 model inserted every
uploaded row as a new `bank_transaction` owned by exactly one statement
(`statement_id` NOT NULL), so the eight overlapping outgoing movements
(EUR 1726.59 total, each pair carrying the same original bank transaction id
and archive id in both source CSVs) were imported twice, overstating open
reconciliation amounts. This ADR records the canonical-journal decision and
its boundaries.

## Decision

### The statement is an import artifact; the transaction is the movement

`bank_transaction` is the **canonical account journal** keyed within a bank
account. `bank_statement` is the **import artifact** — a source that
*references* movements, never an exclusive owner of a private copy of each.
A new table `bank_transaction_source` records **many-source provenance**: every
imported source row (statement, row number, per-source ids and per-source
facts) that resolved to a canonical transaction. `statement_id` on
`bank_transaction` remains only as the ORIGIN statement pointer, now NULLABLE
(detaching an origin whose movement survives — shared with another statement,
or carrying financial history — sets it to NULL, never cascade-deletes the
movement or its reconciliation history).

### Two identities, never conflated

- **MOVEMENT identity** — `(provider_code, source_account_ref, external_id)`,
  all three required, enforced by a partial UNIQUE index at storage level.
  This is authoritative: the same movement arriving through another statement
  is recognised as already-known; concurrent/retried imports collide at the
  database, not at a pre-insert read. A NULL in ANY component means the
  identity is UNKNOWN, and **unknown identity never merges** — date+amount
  alone is not identity, and genuine repeated identical purchases keep their
  multiplicity. The same id on a different provider or a different source
  account is a different movement (inter-account transfers are separate
  legitimate movements on each account).
- **SOURCE-REPLAY identity** — the exact same import arriving again (a retry,
  a repeat upload, a renamed file, a reordered file). `bank_statement.
  content_hash` (SHA-256 over the ledger account and RAW-SOURCE FINGERPRINT
  when named; otherwise the sorted, normalised structured row multiset and
  identity inputs) is UNIQUE at storage level, so a re-upload of the SAME source —
  including one whose rows carry no bank ids — inserts nothing. The
  fingerprint is computed from the ORIGINAL buffer's full raw rows — every
  column the source carried, mapped or not, including duplicate headers and
  cell whitespace, byte-preserved (never the lossy
  UTF-8 re-decode of the text) — so two exports differing only in an
  unmapped memo value are DIFFERENT sources, never one invented replay.
  A fresh LLM mapping cannot change an already-imported raw source's replay
  identity or overwrite its original facts.
  Replay is claimed only on authoritative evidence, never inferred from the
  projected rows alone: a fingerprinted import carries it; a pure structured
  import (no raw archive) is idempotent by its own identical content; an
  import linking a raw archive it did not characterise (a `file_path` with
  no fingerprint) is UNCERTAIN — no replay claim, every row decided by its
  movement identity and identity-less twins flagged for review.
  Distinct-but-overlapping sources are distinct sources whose shared rows
  need strong ids or human review, never a guessed merge.

### Honest provider-identity limitations

The provider is whatever the import asserts (`provider_code` from the LLM's
mapping rules, applied deterministically per ADR-0031); the source account
reference is whatever the mapping extracts (normally the IBAN/account number).
There is **no registry of real-world banks or verified account numbers** —
identity scope is import-asserted, not cryptographically confirmed. The
conservative unknown-identity policy is the mitigation: an unasserted or
unextractable component blocks merging entirely rather than guessing. A
provider-registry seam is future work, not a claim of this design.

### Conflicts are persisted, never overwritten

A same-identity source row whose **money facts** (amount, currency) or
**settlement/supplier facts** (source amount/currency, fx rate, conversion
fee, counterparty IBAN — the issue #403 facts) conflict with the canonical
row, or whose **dates changed without the pending/booked alias** (each row's
`{transaction_date, booking_date}` pair must overlap), is rejected into
`bank_import_conflict` for review: the canonical row is never overwritten, and
a retried upload of the conflicting source stays a conflict — never relabelled
as a successful known row. Differing NON-material facts (description wording,
counterparty descriptor, reference, archive reference) are retained verbatim
on the per-source provenance row — recorded, never silently applied. An
identity-less row exactly matching (account, date, amount, currency) of a
row from a DIFFERENT source is inserted as its own movement and flagged
`ambiguous_overlap` for review: surfaced ambiguity, never a guessed merge and
never a collapsed genuine purchase.

The import summary reports new / already-known / unresolved-conflict counts
separately (statement API response and the async import job the UI polls).

### Canonical consumers

Matching, allocations, open-item totals, counts and pagination operate on
canonical transactions once. Consumers that previously joined
`bank_transaction.statement_id → bank_statement → account` join
`bank_transaction.account_id → account` directly (the account link is
backfilled for legacy rows). A statement's view is the set of canonical
movements its source rows resolved to — with each movement's FULL
many-source provenance visibly shared. Detaching (deleting) a statement
removes only its provenance rows and any movement referenced solely by it
with no financial history; a movement carrying matches, settlement claims,
advance funding, conflict references or duplicate-repair history is RETAINED.
Resolved conflicts retain their historical source id after source detachment;
only that source's unresolved reviews are removed.

### Audited duplicate repair (pre-canonical history)

Already-imported duplicates (rows whose bank ids were lost by the
pre-#399 importer) are repaired by a **previewable, audited, idempotent
admin API** (`/admin/bank-duplicates/preview` + `/repair`), never a one-off
SQL patch:

- Preview groups candidate rows by (account, date, amount, currency) — the
  shape legacy duplicates have — with matches, settlement claims, provenance,
  the recommended (already-reconciled) survivor and the expected open-amount
  impact, which never counts rows carrying a distinct KNOWN identity.
- Apply is atomic with revalidation against the previewed state (stale →
  409); retries are idempotent (deterministic pair key, alias table). The
  removed id becomes a **resolvable alias** of the survivor.
- **Never** across distinct known identities (the transaction-137 control:
  a genuine same-day/same-amount payment with a different bank id), never
  across conflicting money facts, never onto/over a duplicate carrying
  financial references (matches, settlement claims, advance funding) — those
  require explicit resolution through the normal reversal/unmatch flows, and
  allocations are never summed.
- The merge is **metadata-only**: no voucher, expense, payment, FX entry or
  VAT fact is created, changed or removed; a metadata merge records zero
  financial postings. Necessary financial corrections use the normal
  reversal/approval flow.

Every import, dedup decision, conflict and repair is recorded in the
append-only audit log (ADR-0026). The migration preserves legacy ids,
allocations, immutable vouchers, source files and the AUTOINCREMENT
high-water mark (deleted historical ids are never re-minted).

## Consequences

- Migration 087 rebuilds `bank_transaction` (the migration-054 pattern) to
  make `statement_id` nullable; dependent FKs and the hash-chained ledger are
  untouched.
- The LLM's mapping gains `provider_code`, `source_account`, `external_id`,
  `archive_id` evidence targets — rules the deterministic transformer applies
  (ADR-0031 stands: the LLM never emits rows, and never asserts a universal
  pending/booked equivalence; the date alias is an explicit, documented rule).
- For the reproduced eight pairs, the supported result is: EUR 1726.59
  leaves the open amounts (via import dedup for future imports, via the
  audited repair for already-imported history), matches 17/18/23 and all 15
  unique June operations are preserved, and transaction 137 remains distinct
  from 128/136. The fixtures demonstrating this are SYNTHETIC — no production
  source was inspected, imported or repaired, and no live production repair
  is authorised by this ADR.
