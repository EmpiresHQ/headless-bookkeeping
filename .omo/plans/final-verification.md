# Final Verification Wave

## Overview
After ALL implementation tasks (Waves 1-6) are complete, 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before marking work complete.

## Prerequisites
- **Waves 1-6 complete**: All 31 tasks done, evidence captured
- `docker compose up` starts and health responds 200
- `npm run build` passes with zero errors
- `npm test` passes with all new tests

## Definition of Done
- Plan compliance audit passes (all Must Have present, all Must NOT Have absent)
- Code quality review passes (build, lint, tests clean)
- Real manual QA passes (all scenarios executed, integration tested)
- Scope fidelity check passes (no scope creep, no cross-task contamination)
- User gives explicit "okay" to complete

---

## TODOs

- [ ] F1. Plan Compliance Audit

  **Agent Profile**: `oracle`

  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .omo/evidence/. Compare deliverables against plan.

  **Output**: Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT

- [ ] F2. Code Quality Review

  **Agent Profile**: `unspecified-high`

  Run tsc --noEmit + linter + npm test. Review all changed files for: as any / @ts-ignore, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names (data/result/item/temp).

  **Output**: Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT

- [ ] F3. Real Manual QA

  **Agent Profile**: `unspecified-high`

  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration (features working together, not isolation). Test edge cases: empty state, invalid input, rapid actions. Save to .omo/evidence/final-qa/.

  **Output**: Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT

- [ ] F4. Scope Fidelity Check

  **Agent Profile**: `deep`

  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination: Task N touching Task M's files. Flag unaccounted changes.

  **Output**: Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT

---

## Consolidated Results Format

Present to user:

```
## Final Verification Results

| Review | Verdict | Details |
|--------|---------|---------|
| F1 Plan Compliance | [APPROVE/REJECT] | Must Have [N/N], Must NOT Have [N/N] |
| F2 Code Quality | [PASS/FAIL] | Build [PASS], Lint [PASS], Tests [N/N] |
| F3 Real QA | [PASS/FAIL] | Scenarios [N/N], Integration [N/N] |
| F4 Scope Fidelity | [PASS/FAIL] | Tasks [N/N], Contamination [CLEAN] |

## Action Required
[ ] User gives explicit "okay" → Mark complete
[ ] User requests fixes → Create new tasks, re-run F1-F4
```

## Commit
- Message: `chore(review): final verification and fixes` — any fixes from F1-F4
