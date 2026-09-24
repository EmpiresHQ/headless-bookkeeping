# QA-012 re-run: sticky action bars and the mobile preview (issue #305)

A fresh verification of issue #305 on `main` `de159d2` (2026-09-24),
following the first pass in
[2026-09-24-mobile-preview-sticky-actions.md](2026-09-24-mobile-preview-sticky-actions.md)
(run on `68d2289`). Scope: **web UI only; native iOS is out of scope and
was not run.** No real backend was involved. Every `/api` request was
answered by a Playwright route mock, and every write was **refused by the
mock (503)**, so there were no financial mutations. No physical device,
Safari/WebKit or Firefox was used.

That first pass confirmed defect **D1**: Tab could move keyboard focus onto
a row fully hidden behind the sticky ActionBar or the fixed TabBar. D1 was
recorded but not fixed. This re-run reproduced D1 on current `main`, fixed
it, and re-ran the whole matrix on the fixed build.

## Verdict

| Area                                                                                                    | Before (`de159d2`)                                                              | After the fix                                                                          |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| ActionBar geometry at every scroll position (TxCreateExpense, TxMatched ×2, IncomingOpen, TxCandidates) | Pass: 0 bad samples in 136                                                      | Pass: 0 bad samples in 136, plus 0 in 125 (extra viewports)                            |
| Touch tap on the CTA after a real finger drag                                                           | Pass 20/20                                                                      | Pass 20/20 + 15/15 (extra viewports)                                                   |
| Tab reaches the CTA; Enter activates it; IncomingOpen Escape returns focus                              | Pass 20/20                                                                      | Pass 20/20 + 15/15                                                                     |
| **Focused control not hidden (WCAG 2.2 SC 2.4.11)**                                                     | **Fail (D1 reproduced):** 16 Tab steps 100% hidden, 6 partly hidden, out of 195 | **Pass:** 0 hidden and 0 partly hidden out of 195; 0 out of 126 on the extra viewports |
| Soft-keyboard proxy (layout height 844 → 508, VAT field)                                                | Pass (proxy only)                                                               | Pass, same numbers                                                                     |
| Horizontal overflow                                                                                     | Pass                                                                            | Pass                                                                                   |
| Preview lightbox: X, Escape, backdrop, Back; scroll lock; focus trap and return; browser pinch          | Not re-run on `de159d2` (the fix does not touch it)                             | Pass: 12 of 12 lightbox cases                                                          |
| Source pane: 12-page PDF + 3024×4032 photo, 100→300% zoom, pan, pages, X/Escape/Back                    | Not re-run on `de159d2`                                                         | Pass: 6 of 6                                                                           |
| iOS Safari, Android Chrome, physical devices, a real soft keyboard, safe-area insets                    | **NOT TESTED**                                                                  | **NOT TESTED**                                                                         |

**Result: product defect D1 was confirmed and fixed** (suggested priority
P3; it affects keyboard users only). There is one new observation, O5 (see
[Observations](#observations)). It was not fixed here.

## Environment

- **Build:** production `vite build` of `packages/web`.
  - Before: `de159d2`. Entry chunk `index-DpiddmlL.js`; `index.html` sha256
    `1fd7cb24fc399c6b…`.
  - After: the working tree with the fix. Entry chunk `index-DFA8n2ML.js`;
    `index.html` sha256 `b6a38e8d4e56a386…`. The committed tree (after a
    Prettier-only reflow) builds the same entry chunk.
  - Served by `vite preview` on `127.0.0.1:5373`, which was stopped
    afterwards.
  - `node_modules` came from an ignored symlink to the `hbk-ui-378`
    worktree, which has `pdfjs-dist`. There was no `npm install`.
- **Browser:** Playwright 1.63.0, headless Chromium (build 1243),
  `--no-sandbox`, one browser at a time.
  - Mobile contexts: `isMobile`, `hasTouch`, DPR 2. Desktop: DPR 1, no
    touch.
  - Safe-area insets are 0, so `--tabbar-h` = 55 px.
  - Drags and pinches are raw `Input.dispatchTouchEvent` sequences, because
    the synthetic gesture APIs do nothing in this headless shell (see the
    first pass).
- **Host:** Linux, Intel Core i5-7400T (4 cores), 7 GB RAM, Node 24.21.0.
- **Viewports:**
  - Main matrix: 320×844, 390×844, 320×568 and 1440×900 (desktop control).
  - Extra, to force intermediate scrolling on short screens: 320×480,
    844×390 and 667×375 (landscape phones). All three are below `lg`, so
    the TabBar is shown.
- **Data:** the same deterministic fixtures as the first pass. Bank
  statement 1 has these lines:
  - `501` → TxCreateExpense;
  - `502` (14 active matches) and `503` (3 staged + 9 active) → TxMatched;
  - `504` incoming → IncomingOpen;
  - `505` (16 candidates of 156.25 €) → TxCandidates.

  The Inbox has 40 triage items. The preview fixtures are an A4 page, a
  long receipt and a wide scan, all drawn in the page, plus a 12-page PDF
  (page 7 is landscape) and a 3024×4032 PNG photo.

## Steps

These are the same as in the first pass (see its "Steps" section), using the
same harness:

1. **Sticky matrix.** For each viewport × line:
   - sweep the ActionBar at 0, 1/7 … 6/7 of the maximum, 350 px and the
     maximum, checking hit points and the TabBar overlap;
   - drag with a real finger, then tap the CTA;
   - from the top, press Tab up to 40 times, sampling a 5×5 grid in each
     focused box to see what covers it;
   - Tab to the CTA and press Enter (plus Escape on IncomingOpen);
   - run the soft-keyboard proxy on TxCreateExpense at 844.
2. **Preview matrix** (320×844, 390×844, 1440×900):
   - Inbox-row lightbox (A4, receipt, wide) and triage-row lightbox: X,
     Escape, backdrop, Back, the Tab cycle, scroll lock, and a pinch/pan and
     un-pinch at scale 5;
   - verification-sheet source pane (PDF and photo): fit, zoom to 300%
     (Zoom in then disabled), a touch pan, a swipe-down at the pane's top,
     Next through all 12 pages, Fit width, Form↔Source, and close with
     Escape, Back and X.
3. **Probe** (`probe-scrollpad.log`): on `de159d2`, inject
   `html{scroll-padding-bottom:calc(var(--tabbar-h) + 72px)}` and repeat the
   Tab walk. This confirms that Chromium honours `scroll-padding` when Tab
   focus scrolls an element into view, before any product change was made.

## D1: keyboard focus fully hidden behind the ActionBar/TabBar

### Reproduction on `de159d2` (`evidence/before-sticky.log`)

On `/bank/statements/1/tx/505`, select a candidate row, then press Tab from
the top of the page. At 320×844 the focus moves to "Expense #1308" at y 713
and to "Expense #1315". Both are **100% covered by the Match bar**.
"Expense #1309" is covered by the ActionBar and the TabBar together. The
page does not scroll, because Chromium treats the element as already
inside the viewport.

The same happens at every viewport:

| Viewport | Fully hidden focus steps (partly hidden)                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| 320×844  | candidates #1308, #1309, #1315; create: "Personal · Bank fee · Prepayment" (TabBar)                          |
| 390×844  | candidates #1309, #1310, #1311 (#1308 80%); create "Or" row 20%                                              |
| 320×568  | candidates #1304, #1305, #1309, #1310, #1311, #1315 (#1303, #1308, #1314 20%); create "Receipt coming later" |
| 1440×900 | candidates #1311, #1312 (#1310 40%). There is no TabBar on desktop, so the sticky bar alone does it          |

Totals: 16 of 195 focus steps were 100% hidden, and 6 were partly hidden.
TxMatched and IncomingOpen had 0 hidden steps. Screenshots:
`evidence/before-focus-hidden-*.jpg`.

### Cause

- The ActionBar (`ui/ActionBar.tsx`) is `position: sticky` at
  `bottom: var(--tabbar-h)`.
- The TabBar (`shell/TabBar.tsx`) is `position: fixed` at the bottom.
- Nothing told the page's scroller that its bottom edge is covered, so the
  browser's "scroll the focused element into view if needed" check treated
  a row behind either bar as visible.

### Fix

- `index.css`: `html { scroll-padding-bottom: calc(var(--tabbar-h) +
var(--actionbar-h, 0px)); }`. On `lg` screens `--tabbar-h` is 0, so only
  the ActionBar is reserved there.
- `ui/ActionBar.tsx`:
  - While mounted, the bar publishes its own height as `--actionbar-h` on
    `<html>`.
  - A `ResizeObserver` tracks the height, which changes with the
    TxCreateExpense error summary and blocked reason.
  - If two bars are mounted, the tallest one wins. On unmount the property
    is removed.
  - Without `ResizeObserver` (jsdom), the bar still measures once.
- No screen-level code changed. TxCandidates, TxCreateExpense, TxMatched and
  TxDispositions (IncomingOpen) all get the fix through the shared
  `ActionBar`.

### Verification after the fix (`evidence/after-sticky.log`, `extra-sticky.log`)

- **Tab walk:** 0 of 195 focus steps hidden (0 partly hidden) on the main
  viewports, and 0 of 126 on 320×480, 844×390 and 667×375. The computed
  `scroll-padding-bottom` is 127 px on mobile (55 + 72) and 72 px at 1440
  (`shot-after.log`).
- **Scrolling:** when Tab reaches a row behind the bars, the page now
  scrolls it clear. For example, "Expense #1309" at 320×844 ends at y 717,
  exactly on the ActionBar's top edge (`focus-visible-*.jpg`).
- **Nothing else changed:** the tap, keyboard-CTA, route and write results
  are byte-identical to the before-run once the focus column is removed
  (`diff` exit 0). The sweep geometry still has 0 bad samples, and the
  soft-keyboard proxy numbers are identical (the VAT field is at 334–378
  and the bar top at 381, with `scrollY` 0).

### Regression tests

`packages/web/src/ui/ActionBar.test.tsx` (5 tests) checks that:

- the bar publishes its height while mounted and clears it on unmount;
- the value follows a resize;
- the tallest of two bars wins, and the survivor's height stays after one
  unmounts;
- the one-shot measurement works without `ResizeObserver`;
- `index.css` keeps the `scroll-padding-bottom` contract.

All 5 fail against `de159d2`'s `ActionBar.tsx` and `index.css`, and pass with
the fix. jsdom has no layout, so the real scroll behaviour is covered by the
browser matrix above, not by the unit tests.

## Intermediate scrolling on IncomingOpen

In the first pass, IncomingOpen never scrolled. On the extra viewports it
scrolls slightly:

- 320×480: 7 px of range, 8 sweep samples, all passing;
- 667×375: 32 px of range, 8 samples; the tap after a drag came at
  `scrollY` 4;
- 844×390: no scroll range.

In each case, the tap and Tab + Enter opened the prepayment sheet, and
Escape returned focus to "Record prepayment · +500.00 €". **Limitation:** a
longer IncomingOpen screen (for example with a "recorded earlier" notice)
was not constructed, so large intermediate offsets on this screen remain
untested. The 7 px range is below touch slop, so the 320×480 tap was at
`scrollY` 0.

## Preview (after the fix; `evidence/after-preview-summary.txt`)

All 18 cases passed with 0 page errors and 0 writes. The numbers match the
first pass.

- **Lightbox:**
  - X, Escape, a backdrop tap and Back each close only the preview. The
    route stays `/inbox` or `/inbox/doc/31002`, `scrollY` is kept
    (2 787–4 377 px), and focus returns to the opener.
  - Keyboard open puts focus on "Close preview". Tab cycles Open original ↔
    Close preview only.
  - A touch drag does not scroll the page behind (scroll lock holds).
  - A pinch reaches scale 5 and un-pinches back to 1.
- **Source pane:**
  - The PDF fits at 304×430 CSS px with a 608×860 backing store (320
    wide). At 300% it is 911×1290 with a 1823×2581 backing store, and Zoom
    in is disabled.
  - Pages 1 to 12 all draw, and the landscape page 7 draws at 912×644.
  - The photo shows 912×1216 at 300% from its 3024×4032 source.
  - A touch pan moves the pane, and a swipe-down at the top does not
    dismiss the sheet.
  - Escape, Back and X close only the sheet; focus returns after Escape and
    X.
  - `scrollWidth` equals the viewport width everywhere.

## Observations

The first pass's O1–O4 still hold, unchanged:

- **O1:** the lightbox has no in-app zoom, and at a pinch scale of 5 the X
  button is outside the visual viewport.
- **O2:** the lg preview is capped at 1600 px.
- **O3:** browser pinch is blocked inside Vaul sheets.
- **O4:** the source-pane toolbar buttons are 36 px.

**O5 (new, not fixed, suggested P3):**

- **What happens:** a page-level busy `Button` drops keyboard focus to
  `<body>`. On TxMatched, pressing Enter on "Unmatch" (or "Confirm match")
  sets `busy`, and `ui/Button` renders `disabled` while busy. Chromium then
  moves `document.activeElement` to `<body>`, and after the write fails it
  stays there (`probe-focus-after-write`, 390×844: `activeElement` =
  BODY).
- **Relation to #302:** #302 fixed the same mechanism, but only inside
  modals (Sheet/ConfirmDialog). The bank ActionBar buttons are outside that
  fix.
- **Impact:** a screen-reader or keyboard user loses their place after a
  failed action. Chromium's sequential-focus starting point makes the next
  Tab continue near the button, which limits the damage.
- **Draft issue:** "[UI] Busy page-level buttons (bank ActionBar) drop
  keyboard focus to body". Link #302 and #305.

## Limits

- **Not tested:**
  - iOS Safari/WebKit, Android Chrome and Firefox;
  - physical devices;
  - a real on-screen keyboard (only the layout-resize proxy);
  - non-zero safe-area insets. With a real inset, `--tabbar-h` grows and
    the padding grows with it, but that was not observed;
  - VoiceOver/TalkBack;
  - a real backend or real documents.
- **Browser support:** support for `scroll-padding` during focus scrolling
  was verified in Chromium only. Safari and Firefox implement
  `scroll-padding` for scroll-into-view as well, but that was not run here.
- **Out of scope:** keyboard focus inside Sheets/dialogs and screens
  without an ActionBar. The TabBar part of the padding applies app-wide on
  mobile, but only the bank screens were measured.
- **Measurement limits:**
  - The 5×5 hit-grid measures occlusion by `elementFromPoint`. The
    ActionBar's top 12 px is a transparent gradient, and counts as covering
    the element.
  - Pinch screenshots are not a faithful picture of the visual viewport;
    the pinch numbers come from `visualViewport`.

## Evidence

`.review-305-rerun/evidence/` holds the logs, the compacted per-step
results for the three sticky runs, the preview summary and 9 screenshots
(see `.review-305-rerun/MANIFEST`). The harness scripts, the builds and the
full JSON dumps stay local and untracked. The harness is the first pass's
`.review-305/work` scripts, plus `VPS`/`SCREENS` environment overrides and
the probes named above.
