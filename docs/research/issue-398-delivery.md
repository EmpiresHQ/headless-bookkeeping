# Issue 398 delivery and verification

Worktree: `/root/.cache/hbk-worktrees/issue-398`; branch `fix/398-eu-vat-rules`; base `7437033415c100ffce623252a5e8c769b62d029c` (`origin/main`, PR413 merged). No push, merge, deployment or production financial mutation was performed. The original checkout and other worktrees were not edited.

## Implemented behavior

- `plugins/eu-vat.ts` is a pure, composed classifier: transaction facts → special/general branch → jurisdiction → Article196 liability. It contains no EE tax codes, KMD rows or national rate table. It covers Art44/45, property/accommodation, passenger transport with optional country-distance shares, short hire (30/90 days), physical admission, dated virtual admission and physical/onboard catering. Goods use explicit domestic/intra-Community/import movement paths. Digital consumer services, long hire, margin schemes, use/enjoyment overrides, transitional-rate arrangements and unsupported national combinations return named review requirements.
- EE owns national decisions, dated rates, establishment-based KMD6/7 origin and deduction. International EE passenger journeys, including the two directions of a return ticket, produce a purchase-only zero code: no RC, acquisition base, sales turnover or input reclaim. Software from an airline follows its own explicit service facts. Onboard qualifying international ship/aircraft services have their own purchase-zero code. Foreign tax, evidenced foreign zero/exempt/outside treatment, ordinary RC and import are distinct decisions; supplier VAT cannot stand in for customs VAT evidence.
- Nullable migration088 adds expense `eu_vat_facts` and voucher `vat_decision`. No facts or postings are backfilled. The decision records its inputs, date/version, evidence, human confirmations and national rate/treatment. Expense create, draft edit, manual classification, AI proposal/resume, preview and financial correction share the facts. AI cannot invent attributable human confirmations or overwrite confirmed draft VAT facts on a probabilistic retry. The posting fingerprint includes the facts; approval still regenerates; reversals and credit notes preserve the original decision.
- Input entitlement remains a plugin decision, separate from output liability. Buyer/business evidence feeds the EE decision; full/partial/none and limited registration retain the existing exact-fraction composition. No foreign VAT becomes EE deductible VAT.
- Open-period reporting connects reversal and explicit correction-object links, including the source expense voucher and zero-base bridge members. Only a zero-net **related component** clears unresolved acquisition origins. Unrelated opposite amounts and nonzero chains stay blocking. A regression reproduces a legacy Wizz-sized compensation without `reverses_id`, then completes final export and period lock.
- Dated standard-rate bases use separate KMD20/22/24 fields in XML/CSV, including negative prior-rate corrections. New INF payloads retain the original measurement date; old frozen payloads keep their prior rendering. National rate facts come from one EE schedule. Posted history and filed snapshots remain immutable.

## Acceptance evidence

SAS EUR554.87 and Wizz EUR1119.40 are **labelled synthetic fixtures using the issue's amounts**, not downloaded production tickets. Tests prove no RC on verified journeys, unchanged expense/AP totals, preserved active payment allocation, retained original decision on reversal, and no second correction/duplicate expense. Dates/routes used by tests are explicit synthetic evidence, not claims about the real source documents.

Primary legal evidence, consolidation dates and the unexecuted historical audit plan are in [issue-398-eu-vat.md](issue-398-eu-vat.md). The architectural boundary change is [ADR0042](../adr/0042-composed-eu-vat-decisions.md).

## Verification logs

All logs are retained under `/tmp/hbk-issue-loop/`.

| Check | Result | Log |
| --- | --- | --- |
| Full server unit/integration, maxWorkers2 | Initial full run:196 suites passed,4 failed,3 skipped;2426 tests passed,30 failed,13 skipped. All four failing suites were repaired and verified below; the unchanged full set was not repeated. | `398-server-full.log` |
| Remediation of original failures | Four suites plus EU rules:149 tests passed,3 remaining fixture/serialization failures; those remaining failures repaired and verified in the next row. | `398-server-failed-rerun.log` |
| Missing-entity, #403 and intake remediation | 3 suites,109 tests passed. Includes preservation of stored JSON facts across an unrelated draft edit. | `398-server-remediation-final.log` |
| Full server e2e, maxWorkers2 | 33 suites,193 tests passed. | `398-e2e-full.log` |
| Final dated report/classifier/deduction/renderers | 9 suites,205 tests passed. | `398-dated-report-verified.log` |
| Final credit-note/FX/EU contracts | 3 suites,57 tests passed. | `398-final-contracts.log` |
| Final import/projection/Rules | 3 suites,68 tests passed. | `398-final-import-projection.log` |
| Final explicit special-case guards | 1 suite,28 tests passed. | `398-special-guards.log` |
| Final RC/ticket/compensation/report/deduction e2e | 3 suites,41 tests passed, including final export/lock and payment allocation. | `398-delivery-e2e.log` |
| Full web, minWorkers1/maxWorkers2 | 150 files,1539 tests passed. | `398-web-final.log` |
| Server typecheck and build | Passed. | `398-typecheck-delivery.log`, `398-server-build-delivery.log` |
| Web typecheck/build | Passed; existing bundle-size advisory only. | `398-web-build-final.log` |
| Scoped lint, changed TypeScript files | Passed. | `398-scoped-lint-delivery.log` |

The first web startup lacked pdf.js in the available dependencies. Verification subsequently used an isolated dependency copy under `/root/.cache/hbk-dependencies/issue-398/node_modules`, with pdf.js6.3.289 matching the lockfile. No dependency manifests or lockfiles were changed.

## Limits and operational handoff

- No production snapshot/tickets were available or inspected. Actual SAS/Wizz dates, buyer evidence and chain links remain unverified. Do not duplicate existing compensating vouchers290/291. The historical plan explicitly starts by reading those vouchers and proving whether the result should be a no-op.
- New mandatory transaction facts intentionally hold old foreign-service drafts until evidence is supplied. New facts can be supplied through the expense/manual-classify APIs; dedicated SPA controls for every specialized fact were not added. Existing #403 sheet facts and bank valuation paths remain supported.
- Undated advisory plugin callers retain their legacy compute interface; every actual dated expense preview/post/correction uses the composed classifier. A second complete country adapter was not implemented.
- Unsupported national combinations are explicit holds: e.g. foreign-supplier domestic passenger liability, special services located in EE requiring a specific national rate/exemption or person-liable determination, pre2025 virtual participation, and passenger routes requiring other countries' national treatment. No universal EU zero rate is asserted.
- The statutory renderer remains the repository's pinned KMD6 format. Historical20/22 corrections in current returns are covered; distinct historical form-version selection and all transitional national schemes are not introduced. Existing frozen artifacts are never reinterpreted. Legacy vouchers without decision provenance require the evidence-based audit in the research note; a date or supplier name is not retroactive human confirmation.
- Shared classification depends on explicit transaction declarations and evidence supplied by intake/operators, not an external legal-fact verifier. Mixed-rate/mixed-service documents retain the repository's existing one-treatment-per-expense limit and require explicit review/classification rather than an automatic split.

Independent root review and publication are the next steps. No subsequent issue was taken.
