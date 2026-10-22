# #297 — short height, enlarged text and confirmations

**Bounded real-browser verification; native text scaling remains unproven.**
The existing long-dialog fix passed the tested confirmation matrix. A separate
Expense hero overflow was reproduced under **synthetic 200% text** and fixed
locally. No production data or real financial operation was changed. The
coordinator owns independent review, linked issue publication and acceptance.

## Environment

- New worktree `/root/.cache/hbk-worktrees/issue-297`, branch
  `qa/297-small-height-large-text`, baseline
  `bc1cb5af1578ed3a2cf744e630c2342918b2b818` from `origin/main`.
- Node **24.21.0** explicitly selected for all application/browser/native-addon
  commands. Own `npm ci` dependencies and Playwright install. No #300 files,
  dependencies, browser contexts or ports were touched. Prior library/font
  knowledge was reused read-only and copied into this worktree's `.qa-tools`.
- Production `tsc -b && vite build`, Chromium **153.0.8010.12** with Playwright
  **1.63.0**, Linux headless, DPR1, `isMobile:true`, `hasTouch:true`.
- Exact emulated viewports: **320×568** and **844×390 CSS px**. Neither is a
  physical iPhone/Android, real browser toolbar, real screen keyboard or Safari.
- Own Nest/SQLite on **4297** and production static assets plus real HTTP proxy
  on **5297**. All GETs are real backend responses; no response-fixture totals
  or route-mocked reads. Baseline/fixed build output is committed as text.
  Fixed index SHA256:
  `8964d03fe3262e31c4cd54d2d70a03c2dccf140c60022cf8abf277b6169d63dc`.
- **Non-GET UI requests are intercepted, held and rejected409 by the harness**,
  never forwarded to backend. Busy geometry is observed while held, before the
  synthetic failure. This is not backend mutation reliability or success QA;
  network mutation logic belongs to #300 and was not edited here.

## Synthetic data, not customer data

[fixture-summary.json](issue-297/fixture-summary.json) contains exact synthetic
names and lengths. Local seed creates four Entities and one draft Expense:

| Case                   | Fixture / meaning                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| Expense delete         | `/books/expenses/297`; actual short delete confirmation                                             |
| Long Entity delete     | `/settings/entities/1`; 118-character Estonian supplier name                                        |
| Stress Entity delete   | `/settings/entities/2`; 667-character spaced legal name                                             |
| Unbroken Entity delete | `/settings/entities/3`; 192-character registration-style name                                       |
| New expense / invoice  | Actual Books create sheets, gross9999999.99 EUR, VAT0, date2026-10-22                               |
| Meaningful document ID | `SYNTHETIC-INVOICE-297-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-LONG-MEANINGFUL-SUFFIX`, 82 characters |
| Existing Expense hero  | Same identifier, supplier118characters, gross9999999.99 USD, draft                                  |

The name and gross inputs are accepted by current schemas; no production
frequency is implied for these deliberately long/stress values. Dialog titles,
warning text, button labels and forms come from the actual application, not an
isolated component demonstration or a custom test page.

After all UI attempts, backend still held **4 Entities, 1 draft Expense,
0 Vouchers and 0 reconciliation matches**, foreign-key check empty. See
[backend-after.json](issue-297/backend-after.json). The original matrix held24
writes and the focused invoice follow-up4 more; all28 were intercepted, none
forwarded. Read-only Expense regressions submitted nothing. No external mailbox,
AI intake, real device integration or production financial mutation was used.

## What “text200%” means here

1. **Normal control**: unmodified production typography.
2. **Native CDP control**: `Emulation.setEmulatedOSTextScale({scale:2})` returned
   accepted at both viewports, but before/after measurements were identical:
   title17px/25.5px line-height, body13.5px/20.25px, root16px, visual scale1.
   Title/body Range widths and heights were also unchanged. This provides
   **no evidence of native 200% text support**, and is not called a pass.
3. **SYNTHETIC enlarged text**: after opening/populating the real dialog/form,
   snapshot computed font sizes and pixel line heights for that subtree and
   every descendant, then double them using inline important declarations.
   For the read-only Expense case, the scope is `main`. All values are sampled
   before any mutation, so inherited sizes are not multiplied repeatedly.
   Root `html` stays16px: rem-based widths, padding and viewport geometry do not
   double. Title becomes34px, description27px and standard buttons30px. No
   transform, page/pinch zoom or claim of an OS accessibility setting is made.

This tests a declared enlarged-text layout condition, not actual Dynamic Type,
Android font scale, browser text-only settings or spoken screen-reader output.
Local fallback fonts are Adwaita; they are not iOS/Windows system fonts.

## Confirmation results

The 4 real confirmation flows ×2 viewports ×2 text conditions all passed
(**16/16**) on baseline with existing #366. Each run checked:

- Initial viewport-bounded dialog, wrapping and no internal/page horizontal
  overflow. Title/description remain in the same scrollable region as actions.
- Wheel scrolling over the dialog until Confirm is fully visible and
  `elementFromPoint` at its center hits the intended button.
- Four actual Tab presses across Cancel/Confirm, including trap wrap; focused
  controls are in view. Pointer Cancel closes the dialog and restores trigger
  focus, then reopening and keyboard Enter on Confirm starts the held request.
- While pending, the exact action label remains; `disabled` and `aria-busy=true`
  are present, live-status DOM exists, and button width/height are unchanged.
  This is DOM accessibility evidence, not a screen-reader listening test.

| Stress confirmation   | Dialog client height / scroll height | 300px wheel steps to actions | Confirm dimensions before = busy |
| --------------------- | ------------------------------------ | ---------------------------- | -------------------------------- |
| 320×568 normal        | 536 / 762 px                         | 1                            | 111×65 px                        |
| 320×568 synthetic200% | 536 / 3389 px                        | 10                           | 232×110 px                       |
| 844×390 normal        | 358 / 537 px                         | 1                            | 167×42.5 px                      |
| 844×390 synthetic200% | 358 / 2129 px                        | 6                            | 344×65 px                        |

All16 confirmation cases had0 page errors. They do not reproduce the old
unreachable-dialog bug. No additional ConfirmDialog or shared Button fix was
made. Complete geometry, focus walks, pointer hit tests, scroll offsets and
pending labels are in [initial-results.json](issue-297/initial-results.json).

## Forms, IDs and busy geometry

New-expense sheet passed all4 conditions in the original matrix. New-invoice
sheet had a harness classification error: a long native text input's internal
scrollWidth was counted as page-layout overflow. These4 raw false statuses were
preserved. They are **not** declared product defects or retroactively rewritten.

The focused follow-up excludes normal native input/select/textarea scrolling
from box overflow checks and explicitly tests the 82-character ID with Home/End.
All4 invoice conditions passed. Value is unchanged; caret reaches82/0 and
scrollLeft moves to the suffix and back to0 (320 normal:484px; synthetic:1222px).
This is actual keyboard access to both ends, not a claim that the whole ID fits
simultaneously in one text input. The create sheets are actual product forms.

| Create button | Normal dimensions | Synthetic200% dimensions | Wheel steps / Tab presses  |
| ------------- | ----------------- | ------------------------ | -------------------------- |
| Expense320    | 280×65            | 280×155                  | 1/4 normal; 4/4 enlarged   |
| Expense844    | 536×42.5          | 536×110                  | 1/4 in both                |
| Invoice320    | 280×65            | 280×155                  | 1/14 normal; 3/14 enlarged |
| Invoice844    | 536×42.5          | 536×110                  | 2/14 normal; 3/14 enlarged |

Native date inputs have multiple Tab stops; recorded14 presses are observed,
not a human-effort estimate. Each CTA was reachable with wheel, keyboard and
pointer hit test. All8 form conditions retained label and exact dimensions
while pending. The request was held/rejected, so no successful-create claim is
made. See [focused-after.json](issue-297/focused-after.json).

## Concrete defect: Expense hero clips enlarged amounts/name

Actual baseline SPA at320×568 with scoped synthetic200% text:
`/books/expenses/297` expands to **scrollWidth416 at viewport320**. The supplier
paragraph is374px wide inside280px; the large USD amount's decimal suffix and
part of a long supplier compound extend outside the viewport. Normal text and
844px controls pass. This is browser evidence under the declared synthetic
condition, **not a native accessibility-setting reproduction**.

Before screenshot:
[320-synthetic200-expense-facts-before.png](issue-297/320-synthetic200-expense-facts-before.png).
Focused browser regression on baseline: **3 pass / 1 fail**, executable returns1;
[focused-before.json](issue-297/focused-before.json) and its text log preserve it.

Fix: add the existing shared `READABLE` (`overflow-wrap:anywhere`) token to the
**local ExpenseScreen hero container**, inherited by amount and supplier text.
No shared components, amounts, API behavior or network logic changed. At200%
text, a numeric token too wide to fit may wrap between digits; its complete
value/currency and semantic text are retained, with no ellipsis or clipped tail.

After production rebuild the same focused4 read-only conditions pass with no
horizontal overflow. The long invoice identifier remains complete; supplier,
category and USD amount are unchanged. After screenshot:
[320-synthetic200-expense-facts.png](issue-297/320-synthetic200-expense-facts.png).
All8 focused cases (invoice follow-up + read-only Expense) passed. The successful
16 confirmation cases and4 expense-create cases were not repeated unnecessarily.

Proposed linked **P2 candidate**, with synthetic/native distinction explicit:
`/tmp/hbk-issue-loop/issue297-linked-hero-proposal.md`. No issue was published.
The coordinator was notified of the local-only style edit before it was made;
no shared component coordination or #300 edit was required.

## Validation, artifacts and limits

- Relevant unit suites: ExpenseScreen13, ConfirmDialog3, Button10 = **26 passed**,
  workers1–2. Production web build/typecheck, scoped ESLint, Prettier and diff
  checks passed. Browser geometry on the actual application is the regression
  seam; no jsdom layout pass or class-name-only test is claimed. No full suite.
- Initial matrix28 cases =23 pass,4 invoice harness false statuses,1 real
  enlarged Expense overflow. Native controls2 accepted/no measurable effect.
  Focused baseline4 =3 pass/1 fail; focused corrected8 =8 pass. Raw evidence is
  kept separately; there is no invented single “all28 after-fix” execution.
- UI writes were intercepted and rejected on purpose. No successful posting,
  correction, approval, delete or backend slow-response behavior was verified.
  No touch-drag sequence or real screen-reader speech was performed; pointer
  wheel, clicks and CDP keyboard events in mobile/touch-emulated contexts were.
- Physical devices, native/OS200%, real toolbars, actual on-screen keyboard,
  Safari/Firefox and untested other dialog call sites remain **unproven**.
  Whether #297 can close under these bounded conditions is the coordinator's
  decision. No PR/merge/deploy/closure was performed by this worker.

Evidence is under [issue-297/](issue-297/), with screenshot names containing
viewport/mode/flow, raw JSON, before/after console output and build/test logs.
`MANIFEST.sha256` records artifact hashes. Scripts require own dependencies,
Playwright in `.qa-tools/node_modules/playwright`, Node24, and an available
Chromium with suitable libraries/fonts. Fresh isolated setup, from repo root:

```sh
# Start built Nest with DATA_DIR=$PWD/.qa-data PORT=4297, let migrations finish.
node docs/qa/issue-297/seed.cjs "$PWD/.qa-data/app.sqlite"
node docs/qa/issue-297/serve.cjs
# Another shell; explicitly select Node24 and local fonts/libs:
FONTCONFIG_FILE="$PWD/.qa-tools/fonts.conf" \
LD_LIBRARY_PATH="$PWD/.qa-tools/libs/usr/lib" \
node docs/qa/issue-297/browser.cjs
# Focused regression without repeating successful confirmation flows:
ONLY='create-invoice|expense-facts' REPORT=focused-after.json \
FONTCONFIG_FILE="$PWD/.qa-tools/fonts.conf" \
LD_LIBRARY_PATH="$PWD/.qa-tools/libs/usr/lib" \
node docs/qa/issue-297/browser.cjs
```

Never run the seed against existing/shared/production data. A baseline full run
has expected nonzero status for the reproduced Expense overflow; the committed
initial run predates that exit-status improvement and records its failures in
JSON. Browser build artifacts/data/dependencies remain local and ignored.
