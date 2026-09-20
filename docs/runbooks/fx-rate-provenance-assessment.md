# Runbook — assessing historical FX rates after the placeholder removal (issue #203)

Applies to **vouchers posted before this fix shipped**. Until then, the live
Estonia plugin answered every `getReferenceRate(from, to, date)` from a
hardcoded map — `USD→EUR 0.92`, `GBP→EUR 1.16` — and **ignored the `date`
argument entirely**. A 2020 invoice and a 2026 invoice in the same currency
were therefore booked at the same rate. Since the plugin fed
`CurrencyService.toBase` and the voucher projection, that rate reached the
base amounts, the VAT base and every FX difference derived from them.

Nothing below edits, annotates or deletes a posted voucher. Posted vouchers and
their lines are immutable at the database level (ADR-0019) and there is no
break-glass (ADR-0012). The assessment is **read-only**; a correction, if one
is warranted, is **appended** through the ordinary corrections flow.

## What shipped

- The placeholder rate map is **gone** from the production posting path.
- Rates now come from the **ECB euro foreign exchange reference rates**, the
  authority Estonian VAT law prescribes (KMS § 29 lg 13: for a non-import
  transaction, the ECB euro rate *in force* on the § 11 tax-point date; the EU
  basis is VAT Directive Art. 91).
- Each posted line records **which publication was applied**: `fx_rate`,
  `fx_rate_date` and `fx_rate_source` on `voucher_line`.
- When no supported rate governs, the conversion is **refused** — the posting
  is held rather than completed at a substituted rate. The refusal is
  structured, not an opaque 500:

  ```json
  {
    "statusCode": 422,
    "code": "FX_RATE_UNAVAILABLE",
    "reason": "no_rate_for_date",
    "fromCurrency": "USD", "toCurrency": "EUR", "date": "2026-03-02",
    "retryable": false,
    "message": "No authoritative FX rate for USD → EUR on 2026-03-02: …"
  }
  ```

  `reason` is `unsupported_pair` or `no_rate_for_date` (**422**, retrying will
  not help) or `upstream_unavailable` (**503**, retry once the source is
  reachable). A document arriving through intake is **held** — routed to
  `needs_triage` with the same reason in plain words — and no voucher is
  posted.

### Non-publication days, explicitly

The ECB publishes around 16:00 CET on working days only, never on TARGET
closing days. The statute asks for the rate *in force* ("kehtiv"), so the last
publication governs until the next one:

| Tax point | Applied `fx_rate_date` |
| --- | --- |
| Saturday / Sunday | the preceding Friday |
| 1 January (TARGET closing) | the last working day of the previous year |
| today, before ~16:00 CET | yesterday's publication |
| nothing published for 7 days | **refused** — a rate that stale is not "in force" |

A same-day answer taken before publication is provisional: it is re-fetched
until the day closes, so a **later** posting for the same date picks up that
day's rate once the ECB publishes it. Two vouchers with the same tax point can
therefore legitimately carry different `fx_rate_date`s. Each says which it
used; neither is rewritten.

## 1. Find affected vouchers

```
GET /api/fx/provenance-audit
```

Read-only. It groups every **posted** line booked at a rate other than 1 by
currency, rate and source, and reports:

- `groups` — every population, with line/voucher counts, the tax-point date
  range and the total base amount booked at that rate;
- `unattributed_line_count` — lines with `fx_rate_source IS NULL`, i.e. posted
  before provenance existed and **not traceable to any publication**;
- `suspected_date_blind` — the subset where one unattributed `(currency, rate)`
  pair spans **more than one distinct tax-point date**. A genuine reference
  rate moves; one that does not, across months, is the placeholder's signature.

The equivalent direct query, for a read-only SQLite session:

```sql
SELECT vl.currency, vl.fx_rate, vl.fx_rate_source,
       COUNT(*)                          AS line_count,
       COUNT(DISTINCT v.id)              AS voucher_count,
       COUNT(DISTINCT v.tax_point_date)  AS date_count,
       MIN(v.tax_point_date)             AS first_date,
       MAX(v.tax_point_date)             AS last_date,
       SUM(vl.base_amount)               AS base_total
  FROM voucher_line vl
  JOIN voucher v ON v.id = vl.voucher_id
 WHERE v.posted_at IS NOT NULL
   AND vl.fx_rate <> 1
 GROUP BY vl.currency, vl.fx_rate, vl.fx_rate_source
 ORDER BY line_count DESC;
```

### Production assessment — 2026-09-20

Performed by the release operator against the production database opened
**read-only with `query_only`**, aggregates only, no writes. Evidence:
`/tmp/headless-issue-cycle/203-production-fx-assessment.json`. Organization:
EE / EUR.

| Population | Lines | Vouchers | Tax-point range |
| --- | --- | --- | --- |
| `USD` at `0.92` | 148 | 37 | 2024-04-12 … 2026-09-02 |
| `USD` at `0.8573388203017832` | 4 | 1 | 2026-08-24 |
| `USD` at `0.8707009142359599` | 4 | 1 | 2026-08-02 |
| `EUR` at `1` (no conversion) | 184 | 62 | — |

Read this carefully, because it says less than it appears to:

- The **37 vouchers at 0.92** are *candidates* — they carry the placeholder's
  value across a two-and-a-half-year span, which no real rate does. That makes
  them exposed to the defect. It does **not** establish that every one is
  materially wrong, nor what the net financial impact is. The set may also
  include reversal and correction artifacts that mirror an original line by
  design.
- The **two non-0.92 vouchers** are *not* thereby verified. Their rates carry
  no provenance either (they predate `fx_rate_source`); they are merely outside
  the flagged population. Do not mark them as checked.
- Net financial impact has **not** been quantified. Doing so requires comparing
  each voucher against the ECB publication in force on its own tax-point date,
  which is a per-voucher review, not an aggregate.

## 2. Decide, per voucher

For each candidate, fetch the rate that *should* have governed:

```
https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?startPeriod=<taxpoint-7d>&endPeriod=<taxpoint>&format=csvdata
```

The ECB quotes **units of the foreign currency per 1 EUR**, so the USD→EUR rate
is the reciprocal of `OBS_VALUE`. Apply the non-publication rule above to pick
the governing row.

Materiality, period status and whether the voucher has already been superseded
all bear on whether a correction is worth posting. That judgement is the
accountant's, not this runbook's.

## 3. Correct, by appending

A voucher whose rate is wrong is corrected the way every posting error is
corrected: **reverse it and post the corrected voucher**, through the
corrections flow, with a reason naming this issue. The original stays in the
books. Never:

- edit `fx_rate`, `fx_rate_date` or `fx_rate_source` on a posted line — the
  database refuses it, and rightly;
- back-fill `fx_rate_source` on legacy lines. A NULL source is a **true
  statement** about those lines: nobody can trace their rate. Filling it in
  would erase the only signal that distinguishes them, and would bless a rate
  that was never checked;
- blanket-mark the non-0.92 vouchers as verified.

If the period is locked, the correction follows the locked-period path
(ADR-0009 / ADR-0015) like any other post-lock adjustment; a period is never
unlocked.

## Reading `fx_rate_source` on a line

| Value | Meaning |
| --- | --- |
| `ECB` | the prescribed reference rate, from the publication named in `fx_rate_date` |
| `bank_statement` | the bank's own conversion, read off the statement line (a base-currency settlement leg) |
| `identity` | no conversion happened — the amount was already in base currency |
| `NULL` | posted before provenance existed; **not traceable**, and not to be back-filled |

A settlement's cash leg on a **foreign** bank account carries `ECB`, not
`bank_statement`: such a statement has no base figure of its own, so the cash
is valued at the reference rate in force (ADR-0004).

## 4. After correcting

Re-run `GET /api/fx/provenance-audit`. A corrected voucher shows as a new
attributed population (`fx_rate_source = 'ECB'`) alongside the original, which
remains unattributed — that pairing *is* the audit trail.
