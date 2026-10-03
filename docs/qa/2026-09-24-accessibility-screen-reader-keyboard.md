# QA-009: Accessibility — screen reader and keyboard (issue #302)

This is a verification task, not an assumed bug. The run was a bounded,
mocked Chromium matrix at 320, 390 and 1280 CSS px on `main` `f3aae50`. No
product code was changed.

**No VoiceOver, no TalkBack, no physical keyboard or OS focus handling, and
no physical device were used.** Screen-reader behaviour is inferred from
Chromium's accessibility tree (CDP `Accessibility.getFullAXTree`) and from
Playwright role/name locators. That is a browser AX snapshot. It is not what
VoiceOver or TalkBack actually speak, and it is not native screen-reader
acceptance. Keyboard input was real Playwright `Tab` / `Shift+Tab` / `Enter` /
`Space` / `Arrow*` / `Escape` presses into headless Chromium. No real backend
was involved. Every API call went to an in-page mock, and no write was issued.

A later same-day run re-checked current `main` `ab7c6eb` after the landmark
fix (#378). It also covered the areas marked NOT RUN below: sheets,
validation, pending and error announcements, and radio/checkbox groups. That
run found one defect (F2), which is fixed in the same commit as that section.
See [Re-verification on `main` `ab7c6eb`](#re-verification-on-main-ab7c6eb).

## Verdict

| Area                                              | Status                                                                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| VoiceOver (iOS) / TalkBack (Android)              | **NOT RUN** (no device or native screen reader available)                                                                                             |
| Physical keyboard / OS focus                      | **NOT RUN**. Playwright key events in headless Chromium only                                                                                          |
| Landmarks                                         | **1 confirmed finding (F1 → [#378](https://github.com/EmpiresHQ/headless-bookkeeping/issues/378))**, from source and DOM                              |
| Keyboard route navigation                         | Run, 320/390/1280. Works. 1 observation (O1)                                                                                                          |
| Focus visible (Books list, Reports period)        | Run, 320/390/1280. **Pass**: every distinct Tab stop changed pixels when focused. 1 observation (O2)                                                  |
| Segmented control as a radio group (#288)         | Run, 320/390/1280. **Pass**                                                                                                                           |
| Search label and focus ring (#287)                | Run, 320/390/1280. **Pass**                                                                                                                           |
| ConfirmDialog: name, description, trap, Escape    | Run, 320/390/1280. **Pass**                                                                                                                           |
| Horizontal overflow (8 routes)                    | Run, 320/390/1280. **Pass**: `scrollWidth` = viewport width everywhere                                                                                |
| Touch target sizes (8 routes)                     | Run, measured. Observation only (O3)                                                                                                                  |
| Sheet focus/dismissal (#267/#268), preview (#269) | **NOT RUN in this pass**. Covered by the #267/#268/#269 fixes' own browser runs; not re-verified here                                                 |
| Validation errors, busy/pending announcements     | **NOT RUN in this pass**. Source reviewed only (`Form.tsx` `Field`/`FormErrorSummary`/`PendingFieldset`, `Button.tsx`); no browser claim is made here |
| Issue #302                                        | **Stays OPEN**: native VoiceOver/TalkBack acceptance is untested                                                                                      |

## Proposed finding (not fixed here)

**F1 → [#378](https://github.com/EmpiresHQ/headless-bookkeeping/issues/378) (filed by root, P2): no `main` landmark on any route, and the desktop sidebar is not a
navigation landmark.** Confirmed from source and from the rendered DOM and AX
tree.

- Source: `packages/web/src/shell/AppLayout.tsx` wraps the routed screen in a
  plain `<div>`. There is no `<main>` or `role="main"` anywhere in
  `packages/web/src` (grep). `shell/Sidebar.tsx` renders the desktop nav links
  inside an `<aside>` with no `<nav>`. Only the mobile `shell/TabBar.tsx` is a
  `<nav>`, and it has no `aria-label`.
- DOM/AX, every route in the matrix (`/inbox`, `/books`, `/bank`, `/reports`,
  `/reports/periods/7`, `/settings`, `/settings/entities`,
  `/books/expenses/12`):
  - 320 / 390: landmarks = `navigation` (the tab bar) + `region
"Notifications alt+T"` (sonner). `main` count 0.
  - 1280: landmarks = `complementary` (the sidebar) + the sonner region. The
    tab-bar `<nav>` is `display:none` (`lg:hidden`), so there is **no
    navigation landmark at all** on desktop. `main` count 0.
  - No skip link on any route. At 1280, keyboard users pass 6 sidebar stops
    (5 links + Sign out) before the screen's first control on every route.
- Consequence (inferred, not heard on a device): landmark navigation in a
  screen reader (VoiceOver rotor "Landmarks", TalkBack "Landmarks" menu)
  cannot jump to the screen content, and on desktop cannot find the app
  navigation as navigation. Each list screen does have exactly one `h1`, so
  heading navigation still reaches the content.
- Artifacts: `probe.log` (first DOM probe, 390 + 1280), `shell-results-final.json`
  cases `landmarks-routes-{320,390,1280}`.

## Observations (no defect claimed)

**O1. Entering the Reports period detail leaves focus on `body`, and the
screen has no `h1`.** From `/reports`, Enter on the "September 2026" row goes to
`/reports/periods/7`, and `document.activeElement` is then `body` (all three
widths). "‹ Back" by Enter returns to `/reports`, also with focus on `body`.
The period header "September 2026" is a `span` (`ScreenHeader` without
`heading`), so the page has no `h1` (`landmarks-routes-*`, `h1=[]`). Record
screens that pass `heading` (issue #357, `lib/screenEntry`) focus their title
instead; the expense detail has `h1` "Expense". The next Tab from `body`
starts at the top of the document, so nothing is lost for a keyboard user.
Whether a screen reader announces the new screen was not verified natively.
`document.title` stays "Bookkeeping" on every route.

**O2. At 320 px a focused row can sit partly under the fixed tab bar.** On
`/reports/periods/7` at 320×844, Tabbing to the INF row "Fixture supplier ·
office · 10 Sep · no invoice number" scrolled it to the bottom edge, where
54.5 px of its 83 px height is under the fixed tab bar. It is never fully
hidden, so WCAG 2.2 SC 2.4.11 (AA, "not entirely hidden") holds. The stricter
2.4.12 (AAA) would not. There is no `scroll-padding-bottom` in the source.
No such overlap was measured at 390 or 1280, or on `/books`.

**O3. Some targets are below 24 px on one axis.** Measured on the 8 routes.
"Upload" (Inbox header) is 59×22.5, "Import" (Bank) 57×18, "‹ Back" 51×22.5.
Each searchbox `<input>` is 19.5 px tall inside a taller, outlined wrapper,
but a tap on the wrapper padding does not focus the input. An inline "Reports"
text link in Books "Dates & order" is 53×14; inline links are exempt from SC
2.5.8. The 2.5.8 spacing exception may cover the others, but spacing between
targets was not measured. The segmented options (#273) and the tab-bar links
are ≥ 44 px tall.

## What passed (per width 320 / 390 / 1280)

- **Keyboard route navigation.** Real Tab presses reach the "Reports" nav link
  (17 stops at 320/390, 4 at 1280). Enter navigates to `/reports`, focus stays
  on the link, and the link has `aria-current="page"`.
- **Focus visible.** Every distinct Tab stop on `/books` (18 at 320/390, 17 at 1280) and `/reports/periods/7` (11, 11, 12) was measured. Each was
  `:focus-visible` and changed pixels in its ±6 px clip between the focused and
  blurred states. The caret was hidden by a test-only style. 0 stops without an
  indicator.
- **Segmented control (#288).** The AX tree shows `radiogroup "Record type"`
  with radios "Expenses", "Invoices", "Documents", "Credit notes" and a checked
  state. Tab enters on the checked radio. ArrowRight/Left/Down/Up move the
  check and the URL `?seg=` each time, and the focus ring (a 2 px solid outline
  on the pill) shows each time. Enter does nothing. Tab leaves the group, and
  Shift+Tab comes back to the checked radio. Every option label is 44 px tall.
- **Search (#287).** `searchbox` "Search expenses", "Search the Inbox" and
  "Search entities" keep their accessible name after typing. The wrapper shows
  a 2 px solid `rgb(14, 90, 60)` outline while the input has focus.
- **ConfirmDialog** (`/books/expenses/12` → "Delete draft…", opened by Enter
  and by Space):
  - `alertdialog "Delete this draft expense?"`, described as "The draft is
    removed permanently. Posted expenses can never be deleted — only
    corrected."
  - Initial focus is on Cancel. Tab ×5 and Shift+Tab stay on Cancel ↔ Delete.
  - The background buttons "Submit for posting" and "Edit draft…" are absent
    from the AX tree while the dialog is open.
  - Escape, and Enter on Cancel, close the dialog and return focus to "Delete
    draft…". The route is unchanged. **No DELETE was sent.**
- **No horizontal overflow** on any of the 8 routes at any width.
- Every case: 0 page errors, **0 non-GET requests**.

## Set-up

- **Build:** a fresh production build from this worktree at `f3aae50`
  (`vite build --outDir ../../.review-302/dist`, exit 0, `build.log`), served
  by `vite preview` on `127.0.0.1:5370`, PID 562072. The preview was stopped by
  that PID after the runs and port 5370 is free.
- **Browser:** the Chromium bundled with Playwright 1.63.0
  (`/tmp/hbk-browser-check`), headless, on Node 24.21.0, Linux. Contexts
  320×844 and 390×844 with `isMobile` + `hasTouch`; 1280×844 desktop. DPR 1.
  Env: `TMPDIR=/root/.cache/hbk-browser-tmp`,
  `LD_LIBRARY_PATH=/tmp/hbk-browser-libs/root/usr/lib`,
  `FONTCONFIG_FILE=/tmp/hbk-browser-libs/fonts.conf`,
  `REVIEW_BASE=http://127.0.0.1:5370`.
- **Harness** (`.review-302/evidence/`, untracked):
  - `fixtures.mjs` is cloned from the #301 agent harness with its output path
    replaced. It imports `/tmp/hbk-252-browser/fixtures.mjs` read-only: token
    `review-fixture`, other origins aborted, unknown GETs 503 and recorded as
    page errors, unknown non-GETs 500. Every non-GET under `/api` or `/admin`
    is also recorded, and each case asserts there were 0.
  - `lib.mjs` holds the AX-tree, Tab-walk, pixel-diff, target and overflow
    helpers. `shell.mjs` has 8 cases × 3 widths = 24.
- **Data:** open period #7 `2026-09` (VAT to pay 624.07 €); draft expense #12,
  supplier "Fixture supplier", 1500.00 € gross, no supplier invoice number;
  entities "Fixture supplier" and "Fixture customer"; no bank statements.

## Runs and harness corrections

The runner status is the real `node` exit code (output redirected to a log,
then `$?` written to `*.exit`).

| Run     | Exit | Result | Cause of failures / change before next run                                                                                                                                                                                                                                                                                                   |
| ------- | ---- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| initial | 1    | 15/24  | Harness. (a) Waiting for "any `h1`" timed out on `/reports/periods/7`, which has none (see O1). Changed to per-route loaded markers ("VAT to pay", the Entities searchbox, "Delete draft…", named `h1`s). (b) Books → Documents requests `/api/documents/9/preview`, which was unmocked. Now mocked as 404, the product's "no preview" state |
| run2    | 1    | 18/24  | Harness. `/bank` read `/api/bank-statements`, which was unmocked. Now mocked as `[]`                                                                                                                                                                                                                                                         |
| run3    | 0    | 24/24  | Passed, but two measurement bugs were found on review. (a) A wrapped Tab cycle re-tagged the first-visited stops, so 3 stops per page (9 at period/1280) were never pixel-diffed. (b) The tab-bar overlap check counted the tab bar's own links as "hidden". Fixed in `lib.mjs`                                                              |
| final   | 0    | 24/24  | Every distinct stop measured. At period/1280, indices 13–18 are the fixed sidebar links on their second pass; the cycle key includes scroll offset, so they were not flagged as repeats. Their first visits (0–5) were measured                                                                                                              |

No product behaviour changed between runs. The mocks only answer reads the
screens make by design. `run3` was produced with the earlier `lib.mjs`; only
the final `lib.mjs` is kept. `MANIFEST.sha256` freezes the evidence files.

## Limitations

- No native screen reader. The AX tree shows roles, names, descriptions and
  hidden subtrees, but not reading order, verbosity, live-region timing or
  gesture navigation in VoiceOver/TalkBack.
- No physical keyboard, no OS focus, no iOS Safari / Android Chrome, and no
  on-screen keyboard.
- Sheets, the document preview, form validation and busy/pending
  announcements were not exercised in this pass (see the verdict table).
- Colour contrast and forced-colors mode were not measured in this pass.

## Re-verification on `main` `ab7c6eb`

Same bounded, mocked Chromium method as above, re-run on 2026-09-24 against
`main` `ab7c6eb`. That commit includes #378 (landmarks) and #376 (IMAP port).
**Still no VoiceOver, no TalkBack, no physical keyboard and no physical
device.** Key presses are Playwright events in headless Chromium, and
"announced" means only that the text is in a `role=status` / `role=alert` /
`aria-live` region or in the AX tree. Nothing was heard.

**Mocked writes only.** The cases that submit something send the request to
an in-page Playwright route and never to a server:

- `PATCH /api/expenses/12`
- `DELETE /api/expenses/12`
- `POST /api/reporting-periods/7/lock`

Every other origin is aborted. Each case asserts the exact list of non-GET
requests. The mocked lock and delete always answer 503, so even the mock
state never shows the period locked or the draft deleted.

### Verdict (this run)

| Area                                                         | Status                                                                                                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VoiceOver / TalkBack / physical keyboard                     | **NOT RUN** (no device, no native screen reader)                                                                                                          |
| Landmarks (F1 → #378)                                        | Run, 320/390/1280, 7 routes. **Pass**: exactly one non-empty `main` on every route; `navigation "Primary"` on desktop, the tab bar `navigation` on mobile |
| Sheet focus, trap, Escape, return (Edit draft)               | Run, 320/390/1280. **Pass**                                                                                                                               |
| Field validation (`aria-invalid` + description)              | Run, 320/390/1280. **Pass**                                                                                                                               |
| Pending announcement (busy button, `PendingFieldset` status) | Run, 320/390/1280. **Pass**                                                                                                                               |
| Error announcement (sheet `alert`, toast live region)        | Run, 320/390/1280. **Pass**. 1 observation (O6)                                                                                                           |
| **Focus while a submit is pending**                          | **F2: defect confirmed on `ab7c6eb`, fixed in this commit.** 9/9 cases fail on `ab7c6eb` and 9/9 pass with the fix                                        |
| Checkbox (duplicate consent, lock acknowledgement)           | Run, 320/390/1280. **Pass**. 1 observation (O4)                                                                                                           |
| Radio group (Correct sheet)                                  | Run, 320/390/1280. **Pass** for keyboard. 1 observation (O5)                                                                                              |
| Token gate error                                             | Run, 320/390/1280. **Pass**                                                                                                                               |
| Touch geometry                                               | Run, measured. Unchanged from O3, plus O4                                                                                                                 |
| Issue #302                                                   | **Stays OPEN**: native VoiceOver/TalkBack acceptance is still untested                                                                                    |

### F2 (fixed here): a pending submit drops keyboard focus out of the modal

**Steps.** These were run at 320, 390 and 1280 on a production build of
`ab7c6eb`:

1. Open `/books/expenses/12` (a draft). Focus "Edit draft…" and press Enter.
   Change "Supplier invoice no.", focus "Save draft" and press Enter. The
   mocked PATCH is held.
2. Or: press Enter on "Delete draft…", then Enter on "Delete". The mocked
   DELETE is held.
3. Or: open `/reports/periods/7` with the warnings read failing, then press
   Enter on "Close period…". Tick "Close anyway…" with Space, type `2026-09`,
   focus "Close & freeze…" and press Space. The mocked lock is held.
4. While the request is held, press Tab 4 times. Then answer the held request
   with 503.

**Observed on `ab7c6eb`** (`before-results.json`, cases `pending-focus-*`,
`confirm-pending-*` and `lock-sheet-*`):

- The busy operation disables the focused button, so `document.activeElement`
  becomes `body` in all 9 cases.
- The first Tab lands on Radix's `data-radix-focus-guard` span. That span is
  outside the dialog, `aria-hidden="true"` and invisible (`opacity: 0`).
- In ConfirmDialog and LockSheet, the 4th Tab reaches a background link in
  the `aria-hidden` screen behind the modal: "‹ Back" at 320/390 and the
  sidebar "Inbox" at 1280.
- When the Edit sheet's save fails, focus stays on the guard span outside
  the sheet, and the next Tab goes to `body`.
- When the delete fails, ConfirmDialog closes as designed, but focus stays on
  the background link instead of returning to "Delete draft…".

**Cause.** `Button` disables itself while `busy` (#281). `PendingFieldset`
and the Sheet's Close button also disable while busy. Radix's FocusScope can
only put focus back on the last focused element, and that element is now
disabled. So nothing holds focus inside the modal.
`Sheet.restoreAfterVeto` already moved focus back to the content, but only
after a refused dismiss such as Escape.

**Fix.** `useHoldFocusWhileBusy` in `lib/focusReturn.ts` is used by `Sheet`
and `ConfirmDialog`. When the layer becomes busy and focus has dropped (to
`body`, or onto a disabled control inside the layer), it focuses the layer's
own content element. That is Radix Content, which has `tabIndex -1`. The
hook never takes focus from an enabled control inside the layer, and never
from anything focused outside it.

With nothing enabled inside, Tab stays on the content. When the operation
settles, Tab continues inside the layer. After a success or failure close,
focus returns to the opener as #268 intended.

**After the fix** (`final-results.json`), at all 3 widths:

- Focus while pending is the dialog content.
- All 4 Tabs stay inside the modal.
- After the failed save, focus stays in the sheet and the next Tab goes to
  "Category".
- After the failed delete, focus returns to "Delete draft…".

**Regression tests** in `ui/Sheet.focus.test.tsx`:

- A save that disables its focused button parks focus on the sheet.
- Busy never takes focus from an enabled control.
- A busy confirm keeps focus in the dialog, and a failure close returns it to
  the trigger.

With the three source files reverted, the two #302 tests that exercise the
defect fail (`2 failed | 22 passed`), and they pass with the fix.

**Severity (proposed, not filed as a separate issue):** P2. A keyboard or
switch user who tabs during a save can end up on invisible or aria-hidden
elements, or behind the modal. No data is at risk: the operation is still
locked (#251).

### What passed (per width 320 / 390 / 1280)

- **Landmarks (#378).** Checked on `/inbox`, `/books`, `/bank`, `/reports`,
  `/reports/periods/7`, `/settings` and `/books/expenses/12`:
  - Mobile: `main`, `navigation` and the sonner `region`.
  - Desktop: `complementary` containing `navigation "Primary"`, plus `main`.
  - `main` is non-empty everywhere. There is no horizontal overflow.
- **Edit draft sheet.**
  - `dialog "Edit draft expense"` opens by Enter, and initial focus is
    `button "Close"`.
  - "Submit for posting" and "Delete draft…" are absent from the AX tree
    while it is open.
  - 40 Tab and 40 Shift+Tab presses all stay inside.
  - Each of the 10 distinct stops is `:focus-visible` and changed pixels in
    its ±6 px box.
- **Validation.** Clearing Gross gives the input `aria-invalid="true"`, and
  its `aria-describedby` resolves to "Enter an amount like 12.40". "Save
  draft" is disabled.
- **Pending.** "Save draft" is `aria-busy="true"` and disabled. Its sibling
  `role=status` reads "Working… please wait." Escape is refused while busy.
- **Error.** The mocked 409 "Possible duplicate…" renders a `role=alert` with
  "Not saved… Your changes are kept".
- **Consent checkbox.** It appears with the name "This is a separate purchase
  — save anyway…", and Save is disabled until it is ticked. Space toggles it,
  and it shows a focus ring. The second PATCH carries
  `allow_duplicate: true`.
- **Success.** The sheet closes and focus returns to "Edit draft…". "Draft
  saved — submit it for posting when ready" appears in the `aria-live=polite`
  region.
- **Lock sheet.**
  - The dialog is named "Close September 2026".
  - The AX checkbox is "Close anyway without complete checks — …", unchecked.
    Space checks it, and the AX tree then reports `checked=true`.
  - "Close & freeze" stays disabled until the box is ticked.
  - While pending, the `PendingFieldset` status reads "Saving… the form is
    locked until the server answers." Exactly one button is `aria-busy`.
  - Escape is refused while busy. The mocked refusal appears in the polite
    toast region. The period stays open.
- **Correct sheet radios.**
  - 3 named radios, exactly one checked.
  - The group is one Tab stop, and the radio shows a focus ring.
  - ArrowDown, ArrowDown, ArrowUp move the check: Cosmetic, Credit note,
    Cosmetic.
  - Escape on the changed form asks "Discard unsaved changes?" with focus on
    "Keep editing". "Discard" returns focus to "Correct…".
- **Token gate** (no stored token, every API answers 401):
  - The token input is autofocused.
  - A wrong token gives `role=alert` "That token was not accepted…", and the
    input gets `aria-invalid="true"` with
    `aria-describedby="token-gate-problem"`. Focus stays on the input.
- Every case records 0 page errors. Non-GET requests are exactly the mocked
  ones listed above.

### Observations (no defect claimed)

**O1 is unchanged.** `/reports/periods/7` still has no `h1`. The first Tab
there is "‹ Back".

**O3 is unchanged.** "Upload" is 59×22.5, "Import" 57×18 and "‹ Back"
51×22.5. The search inputs are 19.5 px tall. The inline "Reports" link is
53×14. There is still no skip link: at 1280 the first Tab on every route is
the sidebar "Inbox". Landmarks now give screen-reader users a bypass (2.4.1).

**O4. Checkbox and radio inputs are the native 13×13.** Each sits inside a
`<label>` that also toggles it, so the effective targets are:

- Mobile checkboxes: 280–350 × 39 px, and 272–342 × 82–102 px for the lock
  acknowledgement.
- Radio labels: at least 83 px tall.
- At 1280, the duplicate-consent label is 536 × 19.5 px, below 24 px tall.
  That is desktop pointer use, and the SC 2.5.8 spacing exception was not
  measured.

**O5. The Correct sheet's radios have no group name.** They sit in the
`PendingFieldset` `<fieldset>`, which has no `<legend>`, so the AX tree
shows `group ""`. Each radio's name is its whole label, including the
explanation sentence. For example: "Financial — amounts or category are
wrong Reverses the posted entry and posts…". The sheet title "Correct" gives
context. Whether this is too verbose in VoiceOver/TalkBack was not heard.

**O6. Failures of the lock and the delete are reported only in the toast
region.** That region is sonner's `aria-live="polite"` section. The lock
sheet stays open with no in-sheet error, and the delete dialog closes. The
text is announced politely, not as an alert. Whether VoiceOver/TalkBack read
it before the next focus change was not verified.

### Set-up (this run)

- **Build:** two production builds from this worktree with `vite build`
  (`build.log`, `build-fixed.log`, both exit 0):
  - Unmodified `ab7c6eb`, served by `vite preview` on `127.0.0.1:5372`.
  - `ab7c6eb` plus the fix, on `127.0.0.1:5373`.

  Both previews were stopped by PID afterwards, and the ports are free.
  `node_modules` was symlinked from `hbk-ui-378`, because the shared checkout
  lacks `pdfjs-dist`.

- **Browser:** Playwright 1.63.0 Chromium, headless, Node 24.21.0, Linux.
  Contexts at 320×844 and 390×844 (`isMobile` + `hasTouch`) and 1280×844
  (desktop), DPR 1. Env as above.
- **Harness:** `a11y.mjs` in `.review-302/evidence/` (untracked, frozen by
  `MANIFEST.sha256`).
  - It imports `/tmp/hbk-252-browser/base-fixtures.mjs` and
    `/tmp/hbk-255-browser/fixtures.mjs` read-only, with the same data as
    above.
  - It adds its own gated routes for the PATCH, the DELETE and the lock POST.
  - It mocks `bank-statements` as `[]`, the document preview as 404 and
    `mailbox/connectors` as `[]`.
  - 8 cases × 3 widths = 24.
  - `probe2.mjs` and `probe3.mjs` are the first single-width reproductions.

| Run     | Build         | Exit | Result | Note                                                                                                                                                                                                  |
| ------- | ------------- | ---- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| initial | `ab7c6eb`     | 1    | 15/18  | Harness: Escape on a changed Correct form asks to discard (#267, by design). The case now answers "Discard". No pending-focus cases yet                                                               |
| probe   | `ab7c6eb`     | 1    | 3/6    | First F2 reproduction (`pending-focus`)                                                                                                                                                               |
| before  | `ab7c6eb`     | 1    | 15/24  | 9 F2 failures (`pending-focus`, `confirm-pending`, `lock-sheet`). An earlier run of this pass read a `body` focus as "inside" (a harness bug in the returned record), so it is superseded by this one |
| final   | `ab7c6eb`+fix | 0    | 24/24  | All cases pass                                                                                                                                                                                        |

**Checks on the fix** (`packages/web`):

- `tsc -b`: exit 0.
- `eslint "src/**/*.{ts,tsx}"`: exit 0.
- `prettier --check` on the 4 changed files: exit 0.
- `vitest run`: 145 files and 1484 tests passed.
