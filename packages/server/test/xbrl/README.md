# Annual-accounts XBRL validation

## What is validated, and against what

The annual-accounts export targets the official Estonian annual-report
taxonomy `et-gaap_2026-01-01`, published by the Centre of Registers and
Information Systems. The taxonomy's core schema is vendored byte-exact and
SHA-256 pinned — see [`../fixtures/xbrl/PROVENANCE.md`](../fixtures/xbrl/PROVENANCE.md).

Two layers:

1. **Every commit (Jest).** `validate-xbrl-instance.ts` validates generated
   instances against the concept table `et-gaap-taxonomy.ts` reads out of the
   *vendored official schema*: concept existence, `xbrli:periodType`, item
   type and abstractness all come from RIK's file, so a concept name invented
   in `rtj-mapping.ts` fails the suite. On top of that it enforces the XBRL 2.1
   instance rules that bear on the defects in issue #204 — well-formed
   `instant` / `startDate`+`endDate` contexts, a non-empty entity identifier
   and scheme, resolvable `contextRef`/`unitRef`, a single ISO 4217 measure on
   monetary units, a `decimals` accuracy claim the value honours, and
   concept-`periodType`-vs-context agreement. Offline, deterministic, ~40 ms.

   These rules are *not* expressible in XSD, and libxml2's XSD compiler cannot
   handle the core schema in practice anyway: ~3400 global elements in a single
   substitution group send `xmlSchemaParse` into minutes of 100 %-CPU work
   (measured: `xmllint --noout --nonet --schema` on the core schema had not
   returned after 90 s). Reading the declarations directly uses the same
   authority at a fraction of the cost.

2. **Out of band (Arelle).** `arelle-validate.sh` runs the reference XBRL 2.1
   processor, pinned to `arelle-release==2.45.1`, over a generated instance —
   once against its own `schemaRef`, and once with the official
   `cal_StatementOfFinancialPosition_role-201012` and
   `cal_IncomeStatementScheme1_role-301011` calculation linkbases loaded, so
   calculation consistency is checked too. The taxonomy zip it seeds its cache
   from is SHA-256 pinned; after the first run it is fully offline.

   ```sh
   cd packages/server
   npx ts-node --transpile-only test/xbrl/emit-sample-instance.ts /tmp/sample.xbrl
   ./test/xbrl/arelle-validate.sh /tmp/sample.xbrl
   ```

   The first run installs Arelle and seeds its cache (network); every run after
   that is offline. The script fails on a nonzero Arelle exit *and* on any
   non-`[info]` log line, so neither a crash nor a clean-exit-with-errors slips
   through.

   This is how the expense-sign question was settled: the et-gaap
   income-statement expense concepts are `xbrli:balance="credit"` and enter
   `TotalProfitLoss` with calculation weight +1, so expenses are reported
   negative. Reporting them positive raises `xbrl.5.2.5.2:calcInconsistency`.

## Scope and limits

* **No RIK portal import has been performed.** Nothing here demonstrates that
  the e-Business Register's own intake accepts a generated file; it
  demonstrates conformance to the published taxonomy and to XBRL 2.1.
* Only the `[201012]` väikeettevõtja balance sheet and `[301011]` income
  statement scheme 1 concepts this renderer emits are covered. The taxonomy's
  notes, cash-flow and equity-movement sections, the completeness rules a real
  filing must satisfy, and any presentation-order or mandatory-field rules RIK
  enforces outside the taxonomy are **not** covered.
* `xbrli:identifier/@scheme` is set to the commercial register's own address.
  XBRL 2.1 requires a scheme URI but fixes no value, and no RIK filing rule
  naming a required scheme was found in any reachable published source. It is a
  single constant in `xbrl.ts` if RIK later publishes one.
* The calculation-linkbase check in pass 2 holds only when every nonzero ledger
  account maps to a reported line. A draft with an unmapped nonzero account
  already carries an `unmapped_nonzero_account` warning, and `finalize` refuses
  outright.
