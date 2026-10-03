# QA-012: Other sticky action bars and the mobile preview (issue #305)

This was a verification task, not an assumed bug. The run was a bounded,
mocked Chromium matrix on `main` `68d2289`, at **320×844** and **390×844**
(mobile), plus **320×568** (short phone, added so the short screens scroll)
and a **1440×900** desktop control. No product code, tests, configs or app
assets were changed. **No real backend was involved.** Every `/api` request
was answered by a Playwright route mock, and every financial write was
**refused by the mock (503)**. The harness only proves that a tap or key
press reached the action. **Native iOS is out of scope for this issue and
was not run. No physical device and no Safari or Firefox were used.**

Related issues: UI-001 [#245](https://github.com/EmpiresHQ/headless-bookkeeping/issues/245)
(the M1 Match bar on TxCandidates), UI-002 [#246](https://github.com/EmpiresHQ/headless-bookkeeping/issues/246)
(a backdrop tap must only close the preview) and UI-013 [#257](https://github.com/EmpiresHQ/headless-bookkeeping/issues/257)
(the source document inside the verification form). The issue says the M1
proof covers TxCandidates only. So each panel below was measured on its own,
and TxCandidates was re-run as a control.

## Verdict

| Area                                                                                                                             | Status                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ActionBar geometry at every scroll position: TxCreateExpense, TxMatched (Unmatch; Confirm + Unmatch), IncomingOpen, TxCandidates | Run, 4 viewports. **Pass**. 136 scroll samples, 170 button checks: every CTA was fully inside the viewport and above the tab bar, and 5 of 5 hit points landed on the button. The ActionBar/TabBar overlap was 0 px in every sample                  |
| Touch tap on the CTA after a real finger drag to an intermediate scroll position                                                 | Run. **Pass** (20 of 20). The tap reached the action, and the route never changed to `/bank`. Details: [Taps](#touch-and-keyboard-activation)                                                                                                        |
| M1 control (TxCandidates: select a row, drag about 335 px, tap Match)                                                            | **Pass** at 320/390/320×568, plus a click at 1440. `POST /api/bank-statements/1/match` was sent (refused by the mock). The #245 scenario does not reproduce on this build                                                                            |
| Keyboard: Tab reaches each CTA; Enter activates it                                                                               | **Pass** (20 of 20). IncomingOpen: Enter opens the prepayment sheet with focus on Close. Escape closes it, and focus returns to the CTA                                                                                                              |
| Keyboard: the focused control stays visible (WCAG 2.2 SC 2.4.11)                                                                 | **Confirmed defect D1.** Tab moves focus to controls that are **100% hidden** under the sticky ActionBar or the fixed TabBar, on TxCandidates (all 4 viewports, desktop included) and TxCreateExpense (320×844, 320×568)                             |
| Soft keyboard                                                                                                                    | **Proxy only:** layout viewport 844 → 508 with the VAT field focused. The field stayed above the bar, the bar sat above the tab bar, and typing worked. **A real on-screen keyboard was NOT TESTED**                                                 |
| Horizontal overflow (bank screens, lightbox, verification sheet at 300%)                                                         | **Pass**. `documentElement.scrollWidth` = viewport width in every case, with 0 unclipped offenders                                                                                                                                                   |
| Preview lightbox (Inbox row and triage "Source document" row): X, Escape, backdrop, Back                                         | **Pass** on 3 widths × 4 fixtures. Each one closes only the preview. Route and list position are kept (Inbox list at 2 787–4 387 px), focus returns to the opener, and Back uses no history entry                                                    |
| Lightbox scroll lock and focus trap                                                                                              | **Pass**. A touch drag or wheel on the overlay left `scrollY` unchanged. `body` had `overflow:hidden` + `data-scroll-locked`. Tab cycled Open original ↔ Close only                                                                                  |
| Lightbox zoom/pan                                                                                                                | There is **no in-app zoom**, by design. A browser pinch works in Chromium: scale 1 → 5, pan moves the visual viewport, and pinching out restores it. While zoomed, X is outside the visual viewport (O1)                                             |
| Verification sheet source pane: 12-page PDF + 3024×4032 photo, zoom 100→300%, pan, pages, Form↔Source                            | **Pass**. All 12 pages drawn, including a landscape page 7. Zoom-in is disabled at 300%. A touch drag pans both axes inside the pane. Page 12 and the zoom survive Form↔Source. Escape, Back and X close the sheet; after Escape and X focus returns |
| Browser pinch inside the verification sheet                                                                                      | **Blocked** (scale stays 1). Vaul sets `touch-action:none` on the drawer. The pane's own zoom covers the need (O3)                                                                                                                                   |
| iOS Safari, Android Chrome, physical devices, real soft keyboard, real safe-area insets                                          | **NOT TESTED**                                                                                                                                                                                                                                       |

**Confirmed product defect: D1 (suggested P3).** The touch geometry of every
sticky panel passes, and so does the mobile preview. **As instructed, no
follow-up issue was filed.** A draft for D1 is under Findings.

## Set-up

- **Build:** a fresh production build of `packages/web` at `68d2289`:
  `vite build --outDir ../../.review-305/dist` (exit 0, 7.0 s).
  `index.html` sha256 `0088245…f430`; `assets/index-B89dC_Y3.js` sha256
  `3a68762…37fb`. These are byte-identical to the QA-010/011 builds, because
  the commits since are docs-only. `vite preview` served the build on
  `127.0.0.1:5373` (`REVIEW_BASE`). It was stopped afterwards: port 5373 is
  free and no Chromium process is left.
  - `pdfjs-dist` came through the same **ignored** symlink as QA-010/011:
    `packages/web/node_modules/pdfjs-dist` →
    `/tmp/hbk-ui-257/.review-257/pdf-deps` (6.3.289). There was no
    `npm install`.
  - `vite preview` proxies `/api` to `localhost:3000`, and a live server runs
    there on this host. The harness answered every `/api` and `/admin`
    request itself and aborted other origins, so nothing was proxied.
- **Browser:** Playwright 1.63.0, headless Chromium 153.0.8010.12 (build
  1243), `--no-sandbox`. Env: `TMPDIR=/root/.cache/hbk-browser-tmp`,
  `LD_LIBRARY_PATH=/tmp/hbk-browser-libs/root/usr/lib`,
  `FONTCONFIG_FILE=/tmp/hbk-browser-libs/fonts.conf`. One browser at a time.
  - Mobile contexts: `isMobile`, `hasTouch`, **DPR 2**. Desktop: DPR 1, no
    touch. Safe-area insets are 0 (`env()` is not emulated), so
    `--tabbar-h` = 47 + max(0, 8) = **55 px**.
- **Machine:** Linux, Intel Core i5-7400T @ 2.40 GHz (4 cores), 7 GB RAM,
  Node 24.21.0. Libraries: React 18.3, Vaul 1.1.2, Radix Dialog 1.1.19.
- **Touch input:** `Input.synthesizeScrollGesture` and
  `synthesizePinchGesture` do nothing in this headless shell
  (`probe-pinch.log`). All drags and pinches were raw
  `Input.dispatchTouchEvent` sequences. A drag holds still for about 120 ms
  before lifting, so there is no fling. A −200 px drag scrolls 185 px
  (`probe-drag.log`): 15 px is touch slop. Taps used `page.touchscreen.tap`.

### Fixtures

- **Bank statement 1, five lines** (the long SEPA description wraps to 2–3
  lines at 320):
  - `501` −123.45 € with no candidates → **TxCreateExpense**
  - `502` −9 865.43 € with 14 active matches → **TxMatched**, Unmatch only
  - `503` −4 550.00 € with 3 staged + 9 active matches → **TxMatched**,
    Confirm match + Unmatch. The 3 staged matches have pending
    `reconciliation_match` approvals `96001`–`96003`
  - `504` +500.00 € incoming with no candidates → **IncomingOpen**
  - `505` −2 500.00 € with 16 candidates of 156.25 € → **TxCandidates**
    (the M1 shape)
- **Inbox:** 40 triage items `31001`–`31040`. Their reasons alternate
  `low_confidence` / `category_unresolved`.
- **Preview bytes,** drawn in the page on an OffscreenCanvas with a 100 px
  grid, fine print and corner markers (`inpage.js`). The sizes follow the
  server renderer's caps: thumb about 256 px, lg `maxEdge 1600`
  (`packages/server/src/documents/preview-renderer.ts:48`).
  - `31001` A4: thumb 181×256, lg **1131×1600**
  - `31002` long thermal receipt (800×6000 original): lg **213×1600**
  - `31003` wide scan (6000×1500 original): lg **1600×400**
- **Source files** (`/api/documents/:id/file`):
  - `31004`: a **12-page PDF** generated in node, 101 kB. Pages are A4
    portrait (595×842 pt), except page 7, which is landscape (842×595).
    Each page carries a 48 pt title and 6 pt fine print.
  - `31005`: a **3024×4032 PNG photo**.

## Steps

### Sticky ActionBar (`sticky.mjs`; each phase in a fresh context)

For each viewport × line:

1. **Load:** open `/bank/statements/1/tx/:id`. For `505`, tap the first
   candidate row.
2. **Sweep:** scroll to 0, 1/7 … 6/7 of the maximum, 350 px and the
   maximum. At each position, measure:
   - the ActionBar, TabBar and CTA rectangles;
   - that each CTA is fully inside [0, TabBar top];
   - `elementFromPoint` at the centre and at 4 inset corners of each CTA;
   - the ActionBar/TabBar overlap.
3. **Touch activation:** back at the top, drag a real finger upward by
   min(350, 0.6 × max). Tap the primary CTA, and on `503` also Unmatch.
   Then record the route, any dialog, any error text and the mocked writes.
4. **Keyboard:** blur, then press Tab up to 40 times. At each focus, sample
   a 5×5 grid in the focused box and classify what covers each point
   (ActionBar, TabBar or offscreen). Then reload, Tab to the CTA and press
   Enter. For IncomingOpen, also press Escape.
5. **Soft-keyboard proxy** (TxCreateExpense, 320/390×844): tap the VAT
   field, set the viewport height to 508, measure, press Ctrl+A, type
   `5,00`, then restore to 844.

### Preview (`preview.mjs`)

1. **Inbox lightbox:**
   - Open `/bank` and go to the Inbox through the nav link, so Back is an
     in-app traversal.
   - Scroll the target row into view, plus 300 px.
   - Tap the row's "Open document preview" button and wait for the lg image.
   - Measure the image, the Close button and body lock. Press Tab ×4.
   - Drag on the overlay twice (mobile) or wheel 600 (desktop).
   - Mobile: pinch ×3 at the image centre, drag to pan, pinch out twice.
   - Close with X; open with the keyboard (focus + Enter) and close with
     Escape; open and close with a backdrop tap outside the image; open and
     close with `history.back()`.
2. **Triage row lightbox:**
   - From the Inbox, tap the link to `/inbox/doc/31002`.
   - Tap "Source document · Tap to preview".
   - Close with X, Escape, Back and backdrop, in turn.
3. **Source pane:**
   - From the Inbox, tap the link to `31004` and tap "Choose category"; for
     `31005`, tap "Review extracted data".
   - Mobile: tap **Source document** in the Form/Source switch.
   - Wait for the first page to be drawn.
   - Zoom in ×3 to 300%.
   - Drag inside the pane (mobile) or wheel (desktop).
   - Mobile: scroll the pane back to the top, then drag down 250 px (does it
     drag-dismiss the sheet?), and pinch ×2.
   - PDF only: press Next ×11, checking each page as it is drawn, then Fit
     width. Mobile: Form → Source.
   - Close with Escape; reopen and press Back; reopen and press X.
4. **Pure-axis pan check** (`probe-pan`, 320/390): at 300%, drag left,
   right, up, down, diagonally, and pinch.

## Results

### ActionBar geometry (see `sticky-summary.txt`)

CTA box y-range in CSS px. At 390 the values are the same apart from wider
buttons.

| Viewport | Screen             | Max scroll | At 0 / intermediate       | At max  | TabBar top |
| -------- | ------------------ | ---------- | ------------------------- | ------- | ---------- |
| 320×844  | TxCreateExpense    | 123        | 672–718 / 602–648 (y 70)  | 549–595 | 789        |
| 320×844  | TxMatched (502)    | 1 024      | 729–775 pinned            | 628–674 | 789        |
| 320×844  | TxMatched (503) ×2 | 541        | 729–775 pinned            | 627–673 | 789        |
| 320×844  | IncomingOpen       | **0**      | 299–345                   | same    | 789        |
| 320×844  | TxCandidates       | 844        | 729–775 pinned            | 535–581 | 789        |
| 320×568  | TxCreateExpense    | 399        | 453–499 / 444–490         | 273–319 | 513        |
| 320×568  | TxMatched (502)    | 1 300      | 453–499 pinned            | 352–398 | 513        |
| 320×568  | IncomingOpen       | **0**      | 299–345                   | same    | 513        |
| 1440×900 | TxMatched (502)    | 410        | 840–886 pinned (bottom 0) | 770–816 | no TabBar  |

The pinned ActionBar sits at `bottom: 55px`, exactly on the TabBar's top
edge (717–789 against 789). None of the 136 samples showed an overlap.
**IncomingOpen had no scroll range** at any tested viewport, including
320×568. With these fixtures its content is shorter than the screen, so
"intermediate scrolling" cannot happen there. The CTA was verified at rest
only. A longer IncomingOpen (for example with a "Recorded earlier" notice)
was not constructed.

### Touch and keyboard activation

| Screen          | Touch tap after the drag (scrollY 36–335)                                                   | Tab → CTA / Enter                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| TxCreateExpense | "Choose a category" error, no write, route unchanged (empty category = the form's own gate) | 7 Tabs (13 at 1440); same result                                                                          |
| TxMatched 502   | `DELETE /api/bank-statements/1/matches/7001` (refused)                                      | 2 Tabs (8); same DELETE                                                                                   |
| TxMatched 503   | Confirm: `POST /api/approvals/96001/approve`; Unmatch: `DELETE …/matches/7018` (refused)    | 2 Tabs; `POST …/96001/approve`                                                                            |
| IncomingOpen    | The prepayment sheet opens, focus on its Close                                              | 2 Tabs; Enter opens the sheet (focus on Close); Escape closes it and focus is back on "Record prepayment" |
| TxCandidates    | `POST /api/bank-statements/1/match` (refused), tap at y 752 with scrollY 335                | 16 Tabs; same POST                                                                                        |

Every case at 320×844, 390×844, 320×568 and 1440×900 matched this table.
There were 0 page errors and 0 unhandled requests. When the CTA itself held
focus it was always fully visible (20 of 20).

### Soft-keyboard proxy (TxCreateExpense, 320/390)

With the VAT field focused and the layout height at 508:

- the field was at y 334–378;
- the ActionBar was at 381–453, the TabBar at 453–508, and the CTA at 393–439;
- nothing covered the field, and `scrollY` stayed 0;
- the typed value was `5,00`.

Back at 844, the CTA returned to 672–718. **This is a layout-resize proxy
only.** It does not show iOS Safari (visual-viewport-only keyboard) or
Android `resizes-visual` behaviour. See QA-002 (#295) for the device matrix.

### Preview lightbox

| Fixture (lg)         | 320×844: shown size, scale, image top | 390×844        | 1440×900        |
| -------------------- | ------------------------------------- | -------------- | --------------- |
| A4 1131×1600         | 296×419, 0.262, 242.6 px              | 366×518, 0.324 | 577×816, 0.510  |
| Receipt 213×1600     | **101×760**, 0.475, 72 px             | 101×760, 0.475 | 109×816, 0.510  |
| Wide 1600×400        | **296×74**, 0.185, 415 px             | 366×92, 0.229  | 1416×354, 0.885 |
| Triage row (receipt) | 101×760                               | 101×760        | 109×816         |

- **Close button (all cases):** 40×40 at top right, hit-testable. On open,
  focus goes to Close. Tab cycles Open original → Close only.
- **Closing (all 12 Inbox cases):** X, Escape, a backdrop tap (on the image
  box's empty area) and Back each left the dialog closed, with the route
  `/inbox` and `scrollY` unchanged (2 787–4 387 px). Focus came back to the
  row's preview button. `history.length` was 3 before Back, and Back did not
  leave `/inbox`.
- **Triage row:** the same four close paths all stayed on `/inbox/doc/31002`.
  That screen does not scroll with this fixture, so its position check is
  trivially 0.
- **Scroll lock:** `scrollY` did not change on a touch drag in the middle or
  at the edge (mobile), or on a 600 px wheel (desktop). `body` had
  `overflow: hidden; pointer-events: none` and `data-scroll-locked`.
- **Pinch (mobile):** the visual viewport reached scale **5** (the maximum)
  and a drag moved its offset. After two pinch-outs the scale was 1.
  `scrollY` never changed. **While zoomed, the Close button is outside the
  visual viewport** (O1).
- **Overflow:** `scrollWidth` = viewport width while the lightbox was open,
  and the image box never scrolled (`object-contain`). So there is no pan
  other than the browser's own.

### Verification sheet source pane

| Viewport | Fit (page 1, CSS / backing)           | 300% (CSS / backing)      | Page 7 at 300% | Pane scroll box at 300% |
| -------- | ------------------------------------- | ------------------------- | -------------- | ----------------------- |
| 320×844  | PDF 304×430 / 608×860; photo 304×405  | PDF 911×1290 / 1823×2581  | 912×644        | 927×1306 in 320×534     |
| 390×844  | PDF 374×529 / 748×1058; photo 374×499 | PDF 1122×1587 / 2244×3175 | 1122×792       | 1138×1603 in 390×534    |
| 1440×900 | PDF 579×819 (split view, no switch)   | PDF 1737×2458             | 1737×1227      | 1753×2474 in 595×658    |

- **Pages:** all 12 pages were drawn, each with the label "Page k of 12"
  shown when its canvas was ready. The pane's `scrollTop` reset to 0 on each
  page change. Next is disabled on page 12, and Zoom in is disabled at 300%.
- **Mobile pan:** at 300%, a pure-axis drag of 200 px moved the pane 185 px
  in each direction. A diagonal drag moved it (149, 149). The page never
  scrolled sideways: `scrollWidth` = 320/390 with 0 offenders.
- **Swipe down at the pane's top:** it did **not** dismiss the sheet.
- **Browser pinch inside the sheet:** the scale stayed 1 (O3).
- **Form ↔ Source** kept page 12 at 100%.
- **Closing:** Escape, Back and X each closed the sheet and stayed on
  `/inbox/doc/:id`. After Escape and X, focus returned to "Choose category"
  / "Review extracted data" (focus after Back was not recorded). `scrollY`
  stayed 0; this screen has no scroll range with this fixture.
- **Toolbar targets:** 36×36 px (the page and zoom buttons), which is under
  the 44 px target size used elsewhere in the app. All were inside the
  viewport at 320. Recorded only.

## Findings

### D1: Tab focus can be fully hidden under the sticky ActionBar or the TabBar (confirmed, suggested P3)

- **Where:** `ui/ActionBar.tsx` (`sticky bottom-[var(--tabbar-h)]`, z-20) and
  `shell/TabBar.tsx` (fixed, z-30), with the screens that put focusable
  content below or behind them: `bank/TxCandidates.tsx` (the candidate list)
  and `bank/TxCreateExpense.tsx` + `TxScreen`'s `OrRow`. Chromium moves
  focus without scrolling as long as the element is inside the layout
  viewport. Nothing declares the bottom inset, for example with
  `scroll-padding-bottom`, so a control behind the bars counts as
  "visible".
- **Repro:** open `/bank/statements/1/tx/505` (16 candidates) and press Tab
  from the top. Also open `/tx/501` (create) at 320×844.
- **Result:** the grid sample was 100% covered at these steps (`final-sticky-results.json` `tabWalk`):

  | Viewport | Focus fully hidden at                                                                                                                    |
  | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
  | 320×844  | Candidate rows #1308 and #1315 (ActionBar), #1309 (ActionBar + TabBar). Create: "Personal · Bank fee · Prepayment" at y 792 (**TabBar**) |
  | 390×844  | Candidate rows #1309, #1310, #1311 (#1308 80%). Create: "Or" row 20% only                                                                |
  | 320×568  | Candidate rows #1304, #1305, #1309, #1310, #1311, #1315. Create: "Receipt coming later" (ActionBar + TabBar)                             |
  | 1440×900 | Candidate rows #1311, #1312 (ActionBar; #1310 40%). There is no TabBar here, so the sticky bar alone does it                             |

  The first 100%-hidden step was captured at 320×844 and 1440×900:
  `focus-hidden-candidates-320x844.jpg`, `focus-hidden-create-320x844.jpg`
  and `focus-hidden-candidates-1440x900.jpg`. Only the top 1–2 px of the
  focus ring shows above the Match bar. TxMatched and IncomingOpen had
  **0** hidden steps, and the CTA was never hidden itself.

- **Impact:** keyboard users (desktop, a tablet with a keyboard, switch
  access) cannot see which candidate they are on, and Space toggles a row
  they cannot see. The Match total does update. This fails WCAG 2.2
  **2.4.11 Focus Not Obscured (Minimum)**, level AA, which requires that the
  focused item is not _entirely_ hidden. Touch users are not affected: every
  touch check passed.
- **Possible direction (not verified):** a bottom `scroll-padding` covering
  `--tabbar-h` + the ActionBar height on screens with an ActionBar, or
  scrolling focused rows into view with that margin.
- **Draft for a maintainer:** "[UI] Keyboard focus hidden behind the bank
  ActionBar/TabBar (TxCandidates, TxCreateExpense)". Priority P3. Link #305,
  and #245 as related.

### Observations (not defects)

- **O1: the lightbox has no zoom of its own.** The browser pinch works in
  Chromium: Radix `allowPinchZoom`, and the viewport meta does not limit
  scaling. At scale 5 the layout-positioned Close button is outside the
  visual viewport. Escape, Back and pinching out still work, so the user is
  not trapped. iOS Safari was not tested.
- **O2: the detail limit is the server's lg cap, not the UI.** A long
  receipt's lg is 213 px wide (maxEdge 1600, from the code). At 320 it
  shows 101×760, and zooming cannot add detail beyond 213 px. The
  verification sheet's source pane (the original file) is the path that
  shows full resolution: the 3024×4032 photo draws at up to 912×1216 CSS px
  at 320. This comes from the code plus the fixtures; real receipts were not
  tested.
- **O3: no browser pinch inside Vaul sheets.** `[data-vaul-drawer]
{touch-action:none}` (from vaul 1.1.2 CSS) blocks page zoom anywhere in
  the sheet: the scale stayed 1 in 4 of 4 runs. Panning the inner scroller
  still works. The pane's 100–300% zoom is the substitute. Users who rely on
  pinch-zoom for other sheet content (form fields) lose it. This is recorded
  for the design owners.
- **O4:** the source-pane toolbar buttons are 36×36 CSS px (see above).

## Environment limits and harness issues

- **Not tested:** iOS Safari / WebKit, Android Chrome, physical devices, a
  real on-screen keyboard, non-zero safe-area insets, VoiceOver/TalkBack,
  and a real backend or real documents. Emoji glyphs render as boxes in the
  screenshots, because the host has no emoji font.
- **The synthetic gesture APIs do nothing here** (see Set-up). The first
  runs (`dev1`/`dev2`, not committed) used them. Their "tap after gesture"
  data was really at scroll 0, so it was discarded. The final runs use raw
  touch events.
- **A diagonal drag locks to one axis.** A (−200, −250) drag moved only the
  pane's `scrollTop` (Chromium's scroll rails). The pure-axis probe
  (`touch-pan.log`) shows that both axes pan.
- **Harness fixes before the final runs:**
  - Confirm match first reads `/api/approvals/pending`, so the mock needed
    the staged approvals.
  - A refused write leaves a "recorded earlier" receipt (#259) that moves
    the layout, so each phase uses a fresh context.
  - The first Inbox row tagging matched the wrong row.
  - Back from a directly loaded URL leaves the app (about:blank), so the
    runs now enter through in-app navigation.
- **Pinch screenshots are not committed.** A headless capture of a
  pinch-zoomed page is not a faithful picture of the visual viewport. The
  numbers above come from `visualViewport`.

## Evidence

`.review-305/` (see `MANIFEST`): the final logs and compacted results for
both matrices, `sticky-summary.txt`, the touch probes and 10 screenshots.
Harness scripts, dev runs, the build and the preview logs are kept locally
and untracked.
