# QA-002 re-run: software keyboard and viewport resize (issue #295)

Date: 2026-09-24. Scope: web UI only (native iOS is out of scope). This
re-run follows the [first pass](2026-09-23-mobile-keyboard.md), which filed
[#362](https://github.com/EmpiresHQ/headless-bookkeeping/issues/362) (fixed
in `1491815`, closed). No physical phone or tablet was available, so every
result here comes from a **Chromium proxy**, not a soft keyboard.

## Verdict

| Question                                          | Status                                                                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Real soft keyboard on iOS Safari / Android Chrome | **NOT RUN**: no device. The [device matrix](2026-09-23-mobile-keyboard.md#physical-device-matrix) from the first pass is still open                                                  |
| Chromium proxy, 19 scenarios on `main` `1208ad8`  | 18/19 pass. **D1 reproduced**: rotating with the keyboard up pushes the sheet's top, Close and first fields above the screen                                                         |
| Same 19 scenarios with the D1 fix                 | 19/19 pass                                                                                                                                                                           |
| #362 regression (layout shrink → restore)         | Holds: form sheets and the 92vh source sheet return to their opened height with no inline size, at 320/390 wide and on desktop windows                                               |
| Issue #295                                        | **Stays OPEN**: the device matrix still decides. D1 has a fix in this branch. It is not filed as a separate issue; the proposed text is [below](#proposed-follow-up-issue-not-filed) |

## Environment

|                 |                                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source          | `main` `1208ad8`, worktree `qa/295-keyboard-resize-rerun`. "Before" = unmodified build (`index-DFA8n2ML.js`); "after" = the same plus the `Sheet.tsx` change in this commit (`index-Dd_1sNVu.js`). Both are `vite build` production bundles served by `vite preview` 5.4.21                                                                                                    |
| Libraries       | React 18.3.1, **vaul 1.1.2** (same as the first pass)                                                                                                                                                                                                                                                                                                                          |
| Browser         | Chromium 153.0.8010.12 headless via Playwright 1.63.0, Node 24.21.0, Linux 7.2.4 (Arch). Contexts below 1024 px wide use `isMobile`, `hasTouch` and DPR 2. The UA is desktop Linux, so Vaul's iOS-only branches (`preventScrollMobileSafari`, `usePositionFixed`) **do not run**                                                                                               |
| Viewports       | Phones 320×568, 390×844, 412×915 and their landscapes (568×320, 844×390, 915×412); tablet 768×1024; desktop 1024×768 and 1440×900. Window-shrink proxies: 390×844→390×430, 320×844→320×430, desktop 1440×900→×480, 1024×768→×400, 768×1024→×520, full pages to 60% height                                                                                                      |
| Data            | Every `/api/*` and `/admin/*` request is answered by a route fixture (the #305 harness's `common.mjs`: Estonian supplier/customer, 6 categories, 40 inbox documents, a bank statement with 5 lines, a pending reconciliation-match approval). Other origins are aborted. No backend runs                                                                                       |
| Writes          | The mock **refuses every non-GET** (503) and counts it. **0 writes reached the mock in every scenario**, before and after. No CTA was submitted; CTAs are checked by geometry and an `elementFromPoint` hit-test at their centre                                                                                                                                               |
| Unanswered GETs | Three GETs had no fixture and got a 503/599. They are not part of the keyboard geometry: `/api/documents/31001/file` (the source pane shows its error state; S4 checks sheet geometry only), `/api/reconciliation/matches/7015` (optional facts panel on the approval screen; the Reject action still renders), and `/admin/settings` (IMAP sheet). No page errors were logged |

### Stimuli (labelled in every step)

- **(V) visual-viewport stub.** The `VisualViewport.prototype.height` getter
  returns `innerHeight − Δ`, and a `resize` event is fired on
  `window.visualViewport`. `innerHeight` stays the same, which is what iOS
  Safari and Android Chrome (default `resizes-visual`) do for a keyboard.
  It exercises Vaul's `repositionInputs` listener and the Sheet's own. There
  is no OS keyboard, no occlusion, no visual pan and no browser
  scroll-to-focus. Δ values: 336 (portrait 390/844), 260 (320×568), 300
  (412×915), 190/170/180 (landscape), and +44 px for a suggestion or autofill
  bar.
- **(V-orient) rotation stub.** Δ is chosen by the _current_ orientation
  inside the getter. The window and visual-viewport events fired by a
  rotation therefore see a coherent pair. The first pass stubbed a fixed Δ,
  which produces an impossible intermediate state across a rotation.
- **(L) layout resize.** `page.setViewportSize` stands in for window shrink,
  split screen and rotation. `innerHeight` and the visual viewport change
  together.

"Reachable" means the element can be scrolled fully into the visible band
(`scrollIntoView({block:'nearest'})`). The proxy cannot show whether a
device auto-scrolls to it.

## Results

Full step geometry: `.review-295-rerun/evidence/kb-checks-compact.json` (402
checks). Logs: `kb-before.log`, `kb-after.log`. Only S3-rotate differs
between before and after.

| #   | Scenario                                                                                        | Field types                             | Before        | After |
| --- | ----------------------------------------------------------------------------------------------- | --------------------------------------- | ------------- | ----- |
| S1  | New expense, full (V) lifecycle, 390×844 and 320×568                                            | select, search, text+decimal ×2, date   | pass          | pass  |
| S2  | Dismiss with the keyboard up: ✕, Escape, browser Back, backdrop tap                             | text+decimal                            | pass          | pass  |
| S3  | (L) shrink → restore: New expense 390, New sales invoice 320 (#362 regression)                  | text, decimal                           | pass          | pass  |
| S3r | **Rotate 390×844 → 844×390 → back with the keyboard up (V-orient)**                             | decimal                                 | **FAIL (D1)** | pass  |
| S4  | Inbox → Verify source sheet (`h-[92vh]`), 390×844 (V + Form/Source switch + L) and 1440×900 (L) | decimal, text, date                     | pass          | pass  |
| S5  | Desktop/tablet window shrink with New sales invoice open: 1440×900, 1024×768, 768×1024          | text, decimal, date; Tab walk           | pass          | pass  |
| S6  | Approval → Reject match (textarea), 8 lines with Enter, (V) Δ336                                | textarea                                | pass          | pass  |
| S7  | Full pages: bank Create & match (sticky ActionBar) 390×844 and 320×568; Organization 390×844    | select, text, decimal/numeric, checkbox | pass          | pass  |
| S8  | Add IMAP mailbox: port (`type=number`, `inputmode=numeric`), password with +44 px autofill bar  | text, number, password                  | pass          | pass  |

What passed, in detail:

- **Open.** Every sheet opens with focus on **Close**, so no field and no
  keyboard pops. No inline Vaul size is present at open.
- **Keyboard up (V).** Vaul lifts the sheet to `bottom = Δ`. The sheet
  stays inside the visible band, and Close stays visible. The focused field
  and the CTA are reachable. The CTA hit-test lands on the CTA: New expense,
  Reject (enabled after typing) and Add mailbox.
- **Focus changes with the keyboard up.** Tab from Gross to VAT keeps VAT in
  the band. A keyboard that grows by 44 px (suggestion or autofill bar)
  stays under Vaul's 60 px flip threshold, and `bottom` follows it. Moving
  focus to the Category `select` and removing the keyboard clears the
  inline size and restores the opened height. Vaul counts `type=date` as a
  keyboard input and lifts the sheet for it, as the first pass read from
  source.
- **Keyboard hidden with focus kept** (iOS Done / Android back arrow). The
  inline size is released, the sheet is back at its opened height, and its
  bottom sits on the viewport bottom. A second keyboard cycle behaves the
  same way.
- **Dirty dismiss with the keyboard up.** Escape opens "Discard unsaved
  changes?" and moves focus to a dialog button, off the input, so a real
  keyboard would hide. Discard keeps `/books`, leaves `body` without a
  `pointer-events`, `position` or `overflow` lock, and returns focus to
  "Add to the books". Reopening gives an empty form with no stale inline
  size, and keyboard handling works again.
- **Clean dismiss with the keyboard up** (✕, Escape, Back, backdrop). No
  question is asked. The input loses focus, the route stays `/books`,
  `body` is unlocked, focus returns to the opener and the page is not left
  scrolled. For Back, the harness first navigates in-app (Settings → Books)
  because layers never write history (`lib/modalLayers`). With no earlier
  entry, Back leaves the app by design.
- **Verify source sheet.** It opens at 92vh (776 of 844). With the keyboard
  up, switching to Source moves focus to the Form/Source radio, and no text
  field stays focused. Once the keyboard hides, the sheet returns to 92vh,
  and the typed value survives Form → Source → Form. On a window shrink it
  fits the viewport, and restoring gives 92vh back. At 1440×900 the
  side-by-side layout behaves the same way.
- **Desktop window shrink.** The sheet top and Close stay visible, and the
  height stays ≤ 92vh. Four Tab steps each land inside the sheet and in
  view. The CTA is hit-testable after scrolling. Restoring gives the
  original height, and typed values are kept.
- **Textarea.** Enter inserts newlines (8 lines typed) and submits nothing
  (0 writes). The textarea's bottom edge, where the caret sits, is
  reachable above the keyboard, and so is the enabled CTA.
- **Full pages.** Programmatic focus on every text-like field and select of
  bank Create & match and Organization leaves none of them under the sticky
  ActionBar or the TabBar (the #305 `scroll-padding-bottom`). At 60%
  height, the last field and the CTA at the end of the scroll are
  reachable. Full pages have no visual-viewport listener; the (V) step is
  only recorded.

### D1: rotation with the keyboard up leaves the sheet top above the screen

**Reproduction** (before build, `rotate.mjs`, also S3r). Start at 390×844.
Open New expense, tap Gross, type, and put the keyboard up (Δ336): Vaul
gives `height:482px; bottom:336px` and the top at 26. Now rotate to 844×390
with the keyboard still up (Δ190):

| Case                        | Top after rotating | Close top | First field after `scrollIntoView` | Inline               |
| --------------------------- | ------------------ | --------- | ---------------------------------- | -------------------- |
| New expense 390×844         | **−159**           | −151      | **−73** (unreachable)              | `504.797px \| 190px` |
| New expense 320×568         | **−144**           | −136      | **−59**                            | `352.547px \| 170px` |
| New sales invoice 390×844   | **−159**           | −151      | **−73**                            | `504.797px \| 190px` |
| New expense 412×915         | **−147**           | −139      | **−62**                            | `499.031px \| 180px` |
| Verify source sheet 390×844 | **−386**           | −378      | **−323**                           | `586.469px \| 190px` |

The sheet's handle, title, Close button and first fields are above the
screen. The form scroller is already at `scrollTop 0`, so they cannot be
scrolled into view. They come back only when the keyboard is hidden: the
#362 release then works. A fresh open in landscape does fit (first pass),
so the problem is specific to the rotation path. Screenshot:
`evidence/rotate-kb-before-390x844.jpg`. The stub draws no keyboard, so
everything below y = 200 in the screenshot is the area a keyboard would
cover.

**Cause.** Vaul's `onVisualViewportChange` (vaul 1.1.2,
`dist/index.mjs` l. 1112–1167) sets
`height = max(newDrawerHeight, visualViewport.height − offsetFromTop)`.
Right after the layout change, `offsetFromTop` is the old portrait lift seen
in the landscape box, and it is negative (−305 here). The floor therefore
becomes 505 px against a 200 px band. The `max-h-[92vh]` cap (359 px)
still exceeds the band, and `bottom = Δ` then pushes the top off the
screen. The keyboard-height change (336 → 190, more than 60 px) also flips
Vaul's `keyboardIsOpen`, but the too-tall branch runs either way.

**Fix** (`packages/web/src/ui/Sheet.tsx`, in the existing visual-viewport
effect from #362). While the keyboard is up (visual viewport shorter than
the layout viewport) and the viewport is not zoomed: if the panel's top is
above the visible band, the Sheet sizes it to the smaller of its CSS height
and the room from 26 px (Vaul's `WINDOW_TOP_OFFSET`) below the band's top to
the panel's bottom. The bottom stays on the keyboard. Once the Sheet has
sized a panel, it keeps doing so until the keyboard goes. Without that
second rule, rotating back to portrait kept the 174 px landscape height (a
44–88 px scroller). A panel that fits is left to Vaul. The #362 release
still runs when the viewports coincide. No transform, focus or scroll is
touched, and the same frame re-check applies.

**After** (`rotate-after-final.log`): in landscape, the top is 26 in all
five cases and Close sits at 34. The first field is reachable (88–112).
Rotating back to portrait with the keyboard up gives the same size as the
first lift (e.g. 482 px, top 26). Hiding the keyboard restores the opened
height with no inline size. Screenshot: `evidence/rotate-kb-after-390x844.jpg`.

**Priority suggestion: P3.** It needs rotation, or a split-screen change,
while typing. Hiding the keyboard recovers, and no data is lost: focus and
the value are kept in every case. Whether real devices deliver this event
sequence has to be confirmed on a device (first-pass rows R4/A4).

## Tests

- `packages/web/src/ui/Sheet.test.tsx`, "viewport restore" block. The jsdom
  box model now honours the inline `bottom`: a fixed panel's top is
  `innerHeight − bottom − height`. The existing #362 tests pass unchanged
  under it. Three new tests:
  - **rotating with the keyboard up keeps the panel top on screen.** On the
    original `Sheet.tsx` it fails with `expected -158.8 to be ≥ 0`, the same
    geometry the browser gave (−159). With the fix, the landscape panel sits
    inside the band, portrait-with-keyboard is back at top 26 / bottom 508,
    hiding the keyboard restores the opened height, and focus and value are
    kept.
  - **a short panel keeps its own height when fitted after a rotation**
    (300 px content stays 300 px, it is not stretched). It also fails on the
    original code.
  - **leaves a lifted panel that fits to vaul** (style untouched).
- `npx vitest run` in `packages/web`: **147 files, 1497 tests passed**.
  `npm run lint` passed, `tsc -b` is clean, and Prettier is clean on the
  changed files.
- Browser matrix: before 18/19 (only S3r fails), after 19/19. Rotation
  probe: 5/5 cases fixed.

## Observations (not defects, not filed)

1. **Discard dialog vs. a keyboard that stays up (320×568, proxy only).**
   The "Discard unsaved changes?" buttons sit at the layout centre, below a
   308 px band. If the keyboard stayed up, they would be under it. In
   practice Escape or ✕ moves focus to a dialog button, and phones hide the
   keyboard when focus leaves a text field. After the stub keyboard hides,
   both buttons pass the hit-test. Recorded in the compact JSON
   (`discardButtonsWithStubStillUp`); device row R9 should confirm it.
2. **IMAP Port** is `type=number` plus `inputmode=numeric` at 15 px. The
   actual keypad, and whether iOS zooms inputs under 16 px, are device
   questions (first pass, rows R6 and Z1).
3. **Landscape leaves little room.** Even when correct, the landscape sheet
   over a 190 px keyboard is 174 px tall with an 88 px form scroller (about
   one field). That is the space the device gives; this proxy does not call
   it a defect.

## Limitations

- **No soft keyboard and no device.** iOS Safari's visual-viewport pan,
  scroll-to-focus, `preventScrollMobileSafari` (`translateY(-2000px)`
  trick), `position: fixed` on `body`, and Android's real keyboard insets
  are all untested. The stub keeps `visualViewport.offsetTop` at 0.
- A rotation is modelled as one `setViewportSize` with a coherent stub.
  Real devices may deliver several intermediate resize events in a
  different order.
- No backend. The three unanswered GETs above left the source pane and the
  approval facts panel in their error states. Keyboard geometry does not
  depend on them.
- No CTA was tapped. Hit-tests prove geometry, not submission.
- The browser matrix harness lives in `.review-295-rerun/harness` (`kb.mjs`,
  `rotate.mjs`, and `common.mjs`/`inpage.js` copied from the #305 harness).
  It needs the local Playwright set-up described in its header. The builds,
  preview logs and full JSON dumps stay local and untracked.

## Proposed follow-up issue (not filed)

> **[P3][QA-002] Sheet top above the screen after rotating with the keyboard up**
> Web, vaul 1.1.2. Open a form sheet on a phone in portrait, focus a text
> field (keyboard up), rotate to landscape. The sheet's title, Close and
> first fields sit above the screen until the keyboard is hidden: Vaul
> floors the height at `visualViewport.height − top` with the stale
> (negative) top. Chromium proxy: New expense 390×844 → 844×390, top −159,
> first field −73. Fixed by the Sheet change on branch
> `qa/295-keyboard-resize-rerun`; device confirmation pending (rows R4/A4
> of the QA-002 matrix).
