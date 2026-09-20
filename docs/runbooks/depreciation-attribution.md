# Runbook — allocating unattributed depreciation (issue #208)

Applies to databases that carried fixed assets **before migration 075 shipped**,
and to any ledger where depreciation has been posted to an
`ACCUM_DEPRECIATION_*` account **by hand** rather than through the annual close
or a disposal.

## Why this exists

The annual close posts ONE voucher whose accumulated-depreciation lines are
aggregated per asset **class**. The ledger alone therefore cannot say how much
of a class's accumulated depreciation belongs to a single asset. Two things
depend on knowing that:

- a **disposal** has to charge only the depreciation the asset has not already
  been charged, and has to remove exactly its own accumulated depreciation, so
  nothing is left stranded on the class;
- the **asset register** has to show each asset's own book value rather than
  deducting the whole class contra from every card.

Since migration 075 the kernel records that split as it posts it
(`fixed_asset_depreciation`, written inside the same transaction as the
voucher). For movements posted earlier, the migration back-fills only what the
evidence determines:

- an **annual close** is re-derived with the same deterministic arithmetic that
  produced it, and written only where it reconciles to the cent per class;
- a **disposal** already names its owner — `fixed_asset.disposal_voucher_id`
  points at the voucher that retired one specific asset, and the catch-up
  carries the documented reason naming the same asset — so both its legs are
  attributed from that, not from arithmetic.

Anything it cannot prove is left unattributed. A charge someone posts by hand
is unattributed by nature.

**The kernel never guesses.** While an amount is unattributed:

- disposing of an asset in that class is **refused** with
  `error: "depreciation_attribution_required"`, naming the vouchers;
- finalizing a financial year that contains the amount is **refused**, and the
  draft carries a blocking `depreciation_unattributed` diagnostic instead of
  presenting the figures as complete.

Nothing posted is ever rewritten by this procedure. Attribution rows are
append-only at the database level (ADR-0009) and describe vouchers that already
exist.

## 1. See what is unattributed

```
GET /api/fixed-assets/unattributed-depreciation
```

```json
{
  "unattributed": [
    {
      "voucherId": 42,
      "voucherReason": "Annual depreciation charge for FY2026",
      "taxPointDate": "2026-12-31",
      "assetClass": "it_equipment",
      "unattributedMinor": 50000,
      "cause": "unattributed_posting"
    }
  ]
}
```

`cause` is either:

- **`unattributed_posting`** — the voucher moved the class contra and no asset
  owns that movement (a legacy close that would not re-derive, or a hand-posted
  charge);
- **`partial_reversal`** — the voucher REVERSES another one but does not
  exactly cancel its class leg, so which asset the part belongs to is a real
  question. It is reported against the reversing voucher, which is the one to
  allocate.

A reversal that cancels a fully attributed voucher **in full** never appears
here and must not be allocated: its split is the negation of the one already
recorded, so the kernel derives it. The same goes for a disposal's clearing
leg, which carries its own negative attribution written when the asset was
retired. Attempting to allocate either is refused — allocating it on top of
what is already accounted for would count the movement twice.

Amounts are **signed**, credit-positive: a charge is positive and a reversal is
negative. An allocation must carry the same sign as the movement it explains.

`GET /api/fixed-assets` also reports the part that bears on each asset, as
`unattributed_depreciation_minor` beside `book_value_minor`. While that number
is non-zero the card's book value reflects only what is evidenced — it is
**not** the complete figure.

## 2. Work out the true split

Read the voucher and decide which asset each part of the class movement
belongs to. Useful inputs:

- `GET /api/fixed-assets` — cost, acquisition date, useful life and residual
  value per asset, which is what the original charge was computed from;
- the voucher itself, and the period its `taxPointDate` falls in.

For an ordinary straight-line close the share of one asset is
`(cost − residual) ÷ (life × 12) × months in the period`, rounded to whole
cents — the same arithmetic the engine uses.

## 3. Record it

```
POST /api/fixed-assets/depreciation-allocations
{
  "voucher_id": 42,
  "allocations": [
    { "fixed_asset_id": 1, "amount_minor": 30000 },
    { "fixed_asset_id": 2, "amount_minor": 20000 }
  ]
}
```

The request is validated, not trusted. It is refused with `400` when:

- the voucher is not posted, or moves no accumulated-depreciation account;
- an asset does not exist, or belongs to a class the voucher does not move;
- an asset was **acquired after the voucher was posted** — that voucher cannot
  have charged it;
- an amount is zero, fractional, or has the opposite sign to the class movement
  (a reversal is allocated with NEGATIVE amounts);
- the amounts for a class **do not reconcile exactly** to what is still
  unattributed on it. Both under- and over-allocation are refused, and the
  error states both figures;
- that class already carries a complete attribution — including one the kernel
  DERIVED, as it does for a clean full reversal, and the negative leg a
  disposal writes when it retires an asset. Rows are append-only and are never
  re-split here; a genuine correction belongs in the ledger, as a reversal and
  a re-posting.

Several partial reversals of the same charge are each judged on their own, even
when they add up to the whole of it: allocate each one. Their signed amounts
then simply sum, and an as-of read on any date in between still reports what
was standing on that date.

A voucher that is only **partly** resolved — the migration back-fills per
class, so a multi-class voucher can come out half done — stays resolvable for
the classes that are still open, without disturbing the rows already written.
Allocate the remaining class on its own.

Each accepted allocation writes an `audit_log` entry
(`fixed_asset.depreciation_allocated`) in the same transaction as the rows.

## 4. Confirm

```
GET /api/fixed-assets/unattributed-depreciation    # expect []
GET /api/fixed-assets                              # unattributed_depreciation_minor: 0
```

The register reconciles to the class control balance: for each class,
Σ `book_value_minor` over its live assets equals the `FIXED_ASSETS_*` ledger
balance minus the `ACCUM_DEPRECIATION_*` balance. Disposal and the annual close
proceed normally from here.

**Except where the old bug already damaged the ledger** — see below. That gap
is not something an allocation can close.

## Orphaned depreciation from a disposal made before this fix

Until this fix, a disposal charged the FULL theoretical accumulation as
catch-up even when the annual close had already posted part of it, and then
cleared only the figure it had just computed. An asset disposed of after a
year-end close therefore left the ledger with the closed year's depreciation
still sitting on the class contra — an orphan credit for an asset that is no
longer on the books.

**The upgrade does not repair this, by design.** Posted vouchers are immutable
(ADR-0009/ADR-0019), and minting a correcting entry inside a migration would be
precisely the silent guessing everything else here refuses. What the upgrade
does guarantee:

- the ledger is left **exactly** as it was — no line is added, changed or
  removed;
- nothing is invented, so the orphan does **not** show up as an unexplained
  movement demanding an allocation;
- the orphan stays **traceable**: it is attributed to the retired asset that
  produced it, so `postedForAsset` on that asset reports it rather than it
  becoming an anonymous class balance, and it is never reassigned to a living
  peer;
- every live asset stays correct and usable — the next annual close charges
  each peer its own year, and a peer's own disposal clears only its own cost
  and contra.

So for a class touched by such a disposal, **Σ live book value will exceed the
class control balance by the orphan**, and will keep doing so until someone
posts an accounting correction. That is a bookkeeping decision, not a data
repair: the usual route is a voucher taking the orphaned credit off
`ACCUM_DEPRECIATION_*` against the account the original gain/loss was booked
to, dated in an open period, with a reason that says what it corrects. Do not
expect the register to reconcile before that voucher exists.

To find the affected classes, compare for each class:

```
Σ book_value_minor over live assets   (GET /api/fixed-assets)
vs   FIXED_ASSETS_<class> − ACCUM_DEPRECIATION_<class>   (ledger)
```

A difference with an empty
`GET /api/fixed-assets/unattributed-depreciation` queue is an orphan of this
kind, not an attribution problem.

## If you cannot determine the split

Do not invent one. An allocation is a durable statement about immutable
history, and the kernel deliberately refuses rather than average an amount
across a class. Leave it unattributed: reporting for years that were already
finalized stays available, the ledger is untouched, and only the two operations
that genuinely need the split — a disposal in that class, and finalizing the
year the amount falls in — remain blocked until it is known.
