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

## Verdict

| Area                                              | Status                                                                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| VoiceOver (iOS) / TalkBack (Android)              | **NOT RUN** (no device or native screen reader available)                                                                                             |
| Physical keyboard / OS focus                      | **NOT RUN**. Playwright key events in headless Chromium only                                                                                          |
| Landmarks                                         | **1 proposed finding (F1)**, confirmed from source and DOM                                                                                            |
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

**F1. No `main` landmark on any route, and the desktop sidebar is not a
navigation landmark.** Confirmed from source and from the rendered DOM and AX
tree. No severity is proposed here; root decides the follow-up.

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
