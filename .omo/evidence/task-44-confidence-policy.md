# Task 44 Evidence: Confidence → Policy + AI-provenance audit

## Verification Commands

### Build
```
$ npm run build
> nest build
```
Result: PASS

### Tests
```
$ npm test -- --testPathPatterns='policy'
Test Suites: 1 passed, 1 total
Tests:       12 passed, 12 total
```
Result: PASS

### Provenance Test
```
$ npm test -- --testPathPatterns='propose-draft'
Test Suites: 1 passed, 1 total
Tests:       14 passed, 14 total
```
Result: PASS (includes ai_provenance row verification)

## Files Created/Modified
- src/policy/types.ts (PolicyContext added)
- src/policy/policy.service.ts (confidence gate un-stubbed)
- src/database/migrations/027_add_ai_proposal.ts
- src/ai/propose-draft.service.ts (writes ai_provenance)

## Key Acceptance Criteria
- [x] Low-confidence AI draft holds for Approval
- [x] High-confidence is auto-post-eligible
- [x] Posted AI-originated voucher has provenance record (ai_proposal row)
- [x] Ledger row unchanged/deterministic (provenance is operational audit only)
