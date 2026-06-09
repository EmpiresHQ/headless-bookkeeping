# Task 41 Evidence: Pass 1 OCR → markdown

## Verification Commands

### Build
```
$ npm run build
> nest build
```
Result: PASS

### Tests
```
$ npm test -- --testPathPatterns='ocr'
Test Suites: 1 passed, 1 total
Tests:       10 passed, 10 total
```
Result: PASS

### Migration Verification
```
$ ls src/database/migrations/026_add_ocr_markdown_artifact_kind.ts
```
Result: EXISTS

## Files Created/Modified
- src/database/migrations/026_add_ocr_markdown_artifact_kind.ts
- src/database/migrations/index.ts (registered)
- src/conversations/types.ts (ArtifactKind += 'ocr_markdown')
- src/triage/ocr.service.ts (added transcribe())
- src/triage/ocr.service.spec.ts

## Key Acceptance Criteria
- [x] Transcribing a document yields markdown
- [x] Markdown stored as ocr_markdown Artifact on its Conversation
- [x] Re-running reads stored markdown without re-calling vision
- [x] Real-DI test with faux model
