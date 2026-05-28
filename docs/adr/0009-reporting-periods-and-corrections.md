# Reporting periods: tax-point membership, filing-driven lock, corrections in the current period

A Voucher belongs to a VAT reporting period by its **tax-point date** (what counts as the tax point is a country-plugin rule; in DK/EU usually the invoice/document date), not by its posting date. Period boundaries and frequency are set by the country plugin + Organization config — frequency can depend on turnover (e.g. Denmark files VAT monthly / quarterly / half-yearly by size), so the period calendar is not just calendar quarters.

Key decisions:

- **A period locks on filing, not on the calendar.** A past calendar quarter that hasn't been filed stays `open`. Consequently multiple periods can be open at once (an unfiled Q1 alongside Q2), and filing must proceed in order (no filing Q2 before Q1). Posting into a past-but-unfiled period is allowed (optionally with an advisory warning).
- **Membership is derived while open, frozen at filing.** While a period is open, "which vouchers belong" is just a query over tax-point dates. Filing produces an immutable **VAT report** that snapshots the exact included vouchers and computed declaration boxes, so the filed return is reproducible. Then the period becomes `locked`.
- **No posting into a locked period.** This is a hard *process* rule (legal, not arithmetic) — non-overridable, distinct from the structural double-entry invariants. It is what forces corrections out of filed periods.
- **Corrections to a locked period land in the current open period.** A late-discovered error produces a reversal Voucher + a corrected Voucher, both tax-point-dated in the current period, carrying `reverses` (→ original Voucher) and `corrects_object` (→ business object) references. The locked period and its filed VAT report are never touched; the VAT effect surfaces in the current period's return. The threshold between "adjust in next return" and "file an amended return" is a country-plugin rule.

"Missed filing Q1" and "filed Q1 then found an error" are therefore different: the former leaves Q1 open (file it late, in place), the latter requires the current-period correction with back-references.
