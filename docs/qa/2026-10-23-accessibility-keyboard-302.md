# #302 — bounded browser keyboard and accessibility-tree verification

**No native VoiceOver/TalkBack pass is claimed.** This run exercises real
Chromium keyboard behavior and captures its accessibility tree (AX). It found
no new confirmed product defect, so no product/shared component was changed.
The existing pending-focus fix and the related #268/#269/#287/#288 behaviors
passed the conditions below. **#302 remains OPEN for native screen-reader and
physical-device verification.** Nothing here proves what a screen reader speaks.

## Build, environment and fixtures

- Fresh worktree `/root/.cache/hbk-worktrees/issue-302`, branch
  `qa/302-accessibility-keyboard`, base
  `940648810402abd58390c28610629d206cfed73b` from `origin/main`.
- Node **24.21.0** selected explicitly; own installed dependencies, data,
  browser contexts and ports. Fresh production web typecheck/build and Nest
  build; web index SHA256
  `338a78ca3c5e9d59b97af21602904a07c9442e1ad87a0e73a4468d7ffe5c2b9d`.
- Chromium **153.0.8010.12**, Playwright **1.63.0**, Linux headless, DPR1.
  Viewports **320×844**, **390×844** with mobile/touch emulation; **1280×844**
  desktop. Local Adwaita fallback fonts, not iOS/Android system typography.
- Own real Nest/SQLite on **4302**, production assets plus real HTTP proxy on
  **5302**. Real backend reads and selected local draft writes are used;
  explicitly injected held/refused requests are described below.
- Synthetic supplier `SYNTHETIC302 Supplier`; three initial Expenses:
  posted100.00EUR/Voucher1, draft123.45EUR and pending234.56EUR/Approval2.
  Setup uses normal posting/approval APIs for the posted object. No production
  records, external accounts or physical devices were touched.
- One synthetic needs-triage Document with a valid **120×160 PNG placeholder**
  and one open finding; its actual backend-rendered preview is used. No real
  document legibility/OCR claim. One statement with two open EUR movements
  (−100.00 and−50.00), with real backend-generated match candidates.
  [fixtures.json](issue-302/fixtures.json) records exact IDs and state.

Source/domain instructions and previous #302 evidence were read before the
run. Shared dialog/sheet behavior belongs jointly with #299 coordination:
**this worker made no shared or product edits**, so no conflicting dialog,
dirty-navigation, Back/touch-dismissal fix was attempted. Previous #301/#420
QA was not repeated; the creation action below checks only keyboard focus
handoff, not expense-create retry/idempotency behavior.

## Method and boundaries

`browser.cjs` opens actual product routes and presses Playwright keyboard keys
into Chromium: Tab, Shift+Tab, Enter, Space and Arrow keys. The start control is
focused programmatically to bound each scenario; activation and subsequent
traversal are keyboard events. This is **not** proof of a physical keyboard,
full-page keyboard-only journey, OS focus behavior or touch/gesture physics.
No Back/touch/dirty-dismissal matrix belonging to #299 was run.

CDP `Accessibility.getFullAXTree` is captured as normalized **unignored** nodes,
including role, name, description, value, properties and child IDs. AX artifacts
are named by viewport/case/stage. They support observations about exposed
semantics and hidden background controls, **not** VoiceOver/TalkBack reading
order, actual live-region timing, verbosity, speech, rotor or swipe navigation.

DOM `role=status`, `role=alert`, `aria-live`, `aria-busy`, `disabled`, associated
field descriptions and actual activeElement positions are inspected separately.
An exposed role/message is not called a heard announcement. Focus-ring evidence
is computed styling plus screenshots for search; no universal contrast/pixel-diff
or forced-colors audit was performed.

## Results — seven scenarios at each viewport

Every row below was verified at **320,390 and1280**. The initial run's successful
15 cases were retained; only its six selector failures were re-run. There is no
invented single all21-pass execution.

| Scenario                                   | Observed browser result                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search and segmented radio group           | Books, Inbox and Bank names remain `Search expenses`, `Search the Inbox`, `Search this statement` after typing. AX reports the same name/value. Wrapper outline2px and input focus-visible are present. Books group is named `Record type`; arrows change checked option, one is checked, Tab exits to search and Shift+Tab returns to checked radio.                                                                                                                                 |
| Edit draft validation, pending and error   | Actual Edit draft expense opens by Enter with initial focus on Close.20Tab+20Shift+Tab stay inside. Empty Gross has aria-invalid and resolved error description, Save disabled. Held save parks focus inside;4Tab+4Shift+Tab stay inside, button busy/disabled, status text present. Injected409 gives exposed alert and keeps draft. Native duplicate-consent checkbox toggles via Space with checked state in AX. Real PATCH then saves; sheet closes, focus returns to Edit draft. |
| ConfirmDialog                              | Named alertdialog with warning description; initial focus Cancel.8Tab+8Shift+Tab stay inside; background Submit is absent from AX. Keyboard Cancel restores Delete draft opener. Held Delete parks focus inside for4Tab+4Shift+Tab; injected503 closes refusal path and restores opener. Error text exists in live DOM region and AX. No DELETE reaches backend.                                                                                                                      |
| Document preview                           | Enter opens actual Document preview; dialog modal property is exposed. Background navigation is absent from unignored AX.16Tab+16Shift+Tab remain inside. Keyboard Close preview restores the thumbnail opener. No original-file popup/navigation or physical preview gesture is tested.                                                                                                                                                                                              |
| Inbox Reject form                          | Initial focus and8Tab+8Shift+Tab recorded in the actual Reject expense sheet. Held Reject keeps focus inside for4Tab+4Shift+Tab. Injected503 leaves reason intact, and refusal text is exposed in AX. Clearing reason before keyboard Close avoids a dirty-dismissal test; focus returns to Reject opener. The real Approval remains pending.                                                                                                                                         |
| Bank checkbox / correction radios          | Actual named proposal checkbox changes aria-checked via Space, AX agrees, second Space restores state. Correct sheet's three native radios change indices1,2,1,0 with ArrowDown/Down/Up/Up. Returning to original values and keyboard Close restores Correct opener. No match booking or correction is submitted.                                                                                                                                                                     |
| Route-changing success with removed opener | Actual New expense sheet submitted once per viewport; no retry/idempotency test. Sheet/menu opener disappears with route change, and the new detail's H1 is focused, not an outgoing trigger. Destinations Expense4/5/6 respectively; no dialog remains.                                                                                                                                                                                                                              |

The modal traversal checks cover **104 key presses per viewport** in Edit
validation/pending, Confirm traversal/pending and Preview alone, plus Inbox and
radio/checkbox navigation. Complete orders and active-element snapshots are
retained; this is not a human-effort or speed measurement.

### Concrete examples from the captures

- Post-create focus: H1 `aria-label=Expense #4/#5/#6`, tabindex−1,
  `focus-visible=true`. All three runs report the logical destination heading
  focused and the former menu action absent.
- The three live draft PATCHes keep Expense2 in draft at123.45EUR; its invoice
  number ends `SYN-302-EDIT-1280`. The injected duplicate message is a **simulated
  refusal for accessibility QA**, not evidence of a real duplicate. The native
  consent toggles were exercised; the succeeding real PATCH includes that
  explicit consent but creates no duplicate or ledger posting.
- The sole real posted Voucher remains1; Approval2 remains pending; matches0.
  Backend after QA:6Expenses (three setup + three new drafts),1Document,
  2bank transactions,2Approval rows including the setup's approved one;
  foreign-key check empty. See [backend-after.json](issue-302/backend-after.json).
- Each search case records one main element on the tested routes. Background
  control absence is asserted while specific modals are open; this is not a
  full landmarks/headings audit of every route.

## Pending and errors: precise evidence, not speech claims

Four kinds of non-GET request are deliberately gated in browser routing:

| Request                                    | Treatment / purpose                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| PATCH Expense2, first attempt per viewport | Held to inspect focus and pending semantics, then409 `SYNTHETIC302 Possible duplicate` to expose in-sheet alert and consent; never forwarded. |
| PATCH Expense2, next attempt               | Held long enough to observe pending, then forwarded to the isolated backend; real draft save/return focus.                                    |
| DELETE Expense2                            | Held, then503 synthetic refusal; never forwarded, Expense not deleted.                                                                        |
| Reject Approval2                           | Held, then503 synthetic refusal; never forwarded, no actual decision.                                                                         |

The real backend's `POST .../propose-matches` is a read-like proposal operation;
it is listed separately by path in request evidence and is not claimed as a
booking. Three one-shot create POSTs are real local draft writes. No production
or external mutations occur.

While requests are held, activeElement remains inside the named modal, including
when disabled controls leave focus on the Content container. Status/live text
and AX busy/disabled properties are captured. After refusals, Edit has a
role=alert; confirm/Reject refusal messages appear in the exposed AX tree and
live DOM. Their delivery/order in VoiceOver/TalkBack **remains unverified**.
Screenshots are supporting visuals, not evidence that native speech occurred.

## Observations and unproven areas

- **Existing observation retained:** Correct form uses an unnamed AX `group`
  (fieldset without legend). Each radio has its full label/explanation and the
  dialog is named Correct. Keyboard selection is verified. No new defect or
  native verbosity/readability conclusion is inferred without additional
  context; this was already noted in the earlier #302 report.
- Initial modal focus is on non-editable Close/Cancel, but no OS software
  keyboard was present, so an unwanted-keyboard claim is not tested natively.
- Preview image is a synthetic placeholder. The tested isolation is DOM keyboard
  and AX background exclusion; background scroll physics, original-file popup,
  physical pinch/swipe and real document reading are not evaluated.
- Screen reader speech, reading order, rotor/gesture behavior, contrast,
  switch-control access, OS accessibility settings, iOS Safari/Android Chrome,
  hardware keyboard and physical devices remain **unproven**.
- This is bounded form/modal/group verification, not a complete WCAG/site audit.
  **#302 should remain OPEN for VoiceOver/TalkBack/physical acceptance.** No new
  product defect was confirmed, so no linked issue/fix was manufactured.

## Run history and reproducibility

| Artifact                                    | Result / interpretation                                                                                                                                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initial-results.json`, `initial-run.txt`   | 15/21 pass. Three search cases expected the wrong Bank name `Search statement lines`; three Reject cases used a strict text locator matching both operation-result card and toast. These are preserved harness failures, not product defects. |
| `targeted-results.json`, `targeted-run.txt` | 6/6 pass, only search/radios and Inbox Reject at each width. Correct Bank name and disambiguated text locator; other successful cases not repeated.                                                                                           |

All21 bounded scenario/viewport combinations are therefore evidenced across
these runs. No application page errors were recorded. AX snapshots and focused
screenshots are committed. Initial runner source is preserved locally under
`.qa-tools/archive/`; the final runner supports `ONLY`, `WIDTH`, `REPORT` and
`AX_TAG` for focused reruns without overwriting earlier AX artifacts.

Product code is unchanged: no unrelated unit/full suite was run. Checks were
fresh web typecheck/build and server build, actual browser assertions, Node24
script syntax, scoped formatting/diff checks and SHA256 artifact manifest.
The worker did not push/publish/merge/deploy/close or clean worktrees. Coordinator
owns independent Standards/Spec review, publication, CI, deployment and status.

Own runtime dependencies and data are ignored, artifacts in
[issue-302/](issue-302/) are hashed by `MANIFEST.sha256`. From the new worktree,
select Node24, run `npm ci`, install Playwright1.63.0 under `.qa-tools`, build web
and server, then use **fresh isolated data only**:

```sh
# Start built Nest with DATA_DIR=$PWD/.qa-data PORT=4302, await migrations.
node docs/qa/issue-302/seed.cjs "$PWD/.qa-data/app.sqlite"
node docs/qa/issue-302/serve.cjs
# Another shell, with your available Chromium/font/library environment:
FONTCONFIG_FILE="$PWD/.qa-tools/fonts.conf" \
LD_LIBRARY_PATH="$PWD/.qa-tools/libs/usr/lib" \
node docs/qa/issue-302/browser.cjs
# Targeted example, not a second whole run:
ONLY='search-radios|inbox-reject' AX_TAG=targeted REPORT=targeted-results.json \
FONTCONFIG_FILE="$PWD/.qa-tools/fonts.conf" \
LD_LIBRARY_PATH="$PWD/.qa-tools/libs/usr/lib" \
node docs/qa/issue-302/browser.cjs
```

The seed refuses paths outside this issue's local data directory. It creates
operational fixtures and uses real APIs for the posted/pending Expenses. Runtime
PDF/OCR, external services and real accounts are not used. This report makes no
VoiceOver/TalkBack PASS assertion.
