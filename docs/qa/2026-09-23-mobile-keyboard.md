# QA-002: software keyboard and viewport resize (issue #295)

This is a verification task, not a confirmed bug, and **it is not closed.**
No physical iOS or Android device was available: the Linux host has no `adb`,
`xcrun` or `idevice_id`. This report records three things: a source reading of
the installed Vaul, a bounded Chromium _proxy_ run, and a physical-device
matrix for the runs that are still needed. Nothing here is a soft-keyboard
result. No product code was changed.

## Verdict

| Question                                                   | Status                                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real soft keyboard on iOS Safari / Android Chrome          | **NOT RUN**: no device                                                                                                                            |
| Chromium proxy (layout resize + synthetic visual viewport) | Run. Persistent reduced height confirmed as [#362](https://github.com/EmpiresHQ/headless-bookkeeping/issues/362); no physical-keyboard conclusion |
| Issue #295                                                 | **Stays OPEN** pending the [device matrix](#physical-device-matrix)                                                                               |

## How the sheet handles the keyboard (source)

`packages/web/src/ui/Sheet.tsx` wraps `vaul` (`packages/web/package.json`
`^1.1.2`; installed `node_modules/vaul/package.json` **1.1.2**). The sheet
passes no keyboard-related props, so Vaul's defaults apply. The line numbers
below are from `node_modules/vaul/dist/index.mjs`:

- **`repositionInputs = true`** (Root signature, l. 879). A listener on
  `window.visualViewport` `resize` (l. 1112–1167) acts when the focused
  element is a text-like input (`isInput`, l. 331: every `<input>` except
  checkbox/radio/range/color/file/image/button/submit/reset, plus `<textarea>`
  and contenteditable) **or** when its own `keyboardIsOpen` flag is already
  set (l. 1117). The second case covers the closing resize after focus has
  left the field. A change of more than 60px in
  `innerHeight − visualViewport.height` flips `keyboardIsOpen` (l. 1131). The
  listener then writes the drawer's inline `height` and sets
  `bottom = max(innerHeight − visualViewport.height, 0)`, lifting the drawer
  above the keyboard. The CSS `max-h-[92vh]` (form sheets) still applies as a
  cap on that inline height; it is not overridden. For source sheets, the
  inline height replaces the `h-[92vh]` value. In both cases, the 92vh class
  alone does not decide keyboard behaviour.
- When the keyboard is judged closed and the drawer fits, Vaul writes
  `height = initialDrawerHeight` (l. 1153). The sheet is not restored this way
  on mobile Firefox (l. 1152). `initialDrawerHeight` is a ref (l. 922),
  captured at the first eligible event (l. 1126). The installed source has no
  reset for it, so it lives as long as the mounted `Drawer.Root`. Whether it
  starts fresh on every open depends on the Root being remounted.
  In the inspected source, New expense, New sales invoice
  (`books/BooksScreen.tsx`) and Add IMAP mailbox (`settings/MailboxScreen.tsx`)
  are keyed by the `useSheet` epoch, so each open remounts the Root. Other
  sheets were not checked.
- **iOS only** (`isIOS()`, l. 83: `navigator.platform` iPhone or iPad, or a `Mac` platform with `maxTouchPoints > 1`, i.e. iPadOS):
  `usePreventScroll` → `preventScrollMobileSafari` (l. 136–330). It
  intercepts touches on inputs, applies a temporary `translateY(-2000px)` to
  stop Safari's own scroll-into-view, then scrolls the nearest scroller after
  the visual viewport resizes (`KEYBOARD_BUFFER = 24`). `usePositionFixed`
  (l. 770) sets `body{position:fixed}` in Safari. **Headless Chromium on Linux
  takes none of these paths**; they still require device testing.
- `select` is not `isInput`. iOS/Android show a native picker, not the
  keyboard, and Vaul does not reposition for it.
- Focus: on open, the sheet focuses the explicit **Close** button, never a
  field (`Sheet.tsx` `initialFocus`; Vaul `autoFocus=false`), so opening a
  sheet should not pop the keyboard. Every dismiss path blurs the active
  element before closing.
- Lower CTA: in the sheets, the primary button is **in flow at the end of the
  `overflow-y-auto` body**, not sticky. With the keyboard up, the user scrolls
  the sheet to reach it. Full-page forms put it at the end of the document;
  the bank screens use `ui/ActionBar.tsx`, which is sticky above
  `--tabbar-h`.
- Font size: `INPUT_CLS` is `text-[15px]`. `SearchInput` is `text-[13px]`.
  `index.html` sets `width=device-width, initial-scale=1.0` without a
  maximum scale. Hypothesis for the device run: iOS Safari may auto-zoom on
  focus of inputs under 16px. This is **not observed**. The device matrix
  records it.

## Proxy run: set-up

|         |                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source  | `main` `d707a18` (includes #357 and earlier fixes), unmodified; own production build (`index-DaxsKItV.js`, `index-BbYaLByP.css`) served by `vite preview`                                                                                                                                                                                                                                                                                                |
| Browser | Chromium 153.0.8010.12 (Playwright 1.63.0), headless, Linux, `isMobile` + `hasTouch`, default desktop-Linux UA (so Vaul's iOS/Safari branches are inactive)                                                                                                                                                                                                                                                                                              |
| Data    | Every `/api/*` and `/admin/*` request was answered by a route fixture. Other origins were aborted. Every request was intercepted and every non-GET was counted: the fixture answers `POST /api/expenses` and `POST /api/sales-invoices` with a mock 200 and any other non-GET with a 500. **Actual non-GET count: 0 in every case.** Fixtures: 2 categories, supplier/customer entities, a VAT-registered EE organization, empty lists, `{settings: []}` |
| Writes  | **0 mutations in every case.** No CTA was submitted; checks are geometry plus a hit-test (`elementFromPoint` at the CTA centre)                                                                                                                                                                                                                                                                                                                          |
| Date    | 2026-09-23                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Two kinds of stimulus, labelled in every result:

- **(L) Explicit layout-viewport resize:** `page.setViewportSize`. It shrinks
  `innerHeight` **and** `visualViewport.height` together. It does not show
  what a native keyboard does on any platform.
- **(V) Synthetic visual-viewport stub:** the `VisualViewport.prototype.height`
  getter is overridden to `innerHeight − Δ`, and a `resize` event is
  dispatched. `innerHeight` stays. **This tests the listener only.** There is
  no OS keyboard, no occlusion, no visual-viewport pan and no browser
  auto-scroll to the focused field.

Each form was driven by touch taps and typing, then Tab/Shift+Tab. Before
every (L)/(V) step, the harness focused the field programmatically and then
**set the scroller to `scrollTop = 0`**. That deliberately moves the focused
field out of view. The initial "focused field not in band" observations come
from that precondition. They are not natural tap or keyboard failures. So the
harness also checks whether the field _can_ be scrolled into the band.

## Proxy results

The coordinating reviewer independently ran six (L) cases on the same source.
They covered New expense, New sales invoice, and the source-document Verify
sheet at 320 and 390 wide, 844→430→844 tall, with decimal fields focused. All
six passed: focus and typed values were kept, the CTA was hit-testable after
`scrollIntoView`, and close/discard left zero POSTs. Those cases are not
repeated here. The cases below add other field types, landscape, a full-page
form and the (V) path.

| Case (Δ = keyboard-like px)                                                                    | Field types exercised                                                    | (L) result                                                                                                               | (V) result                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New expense sheet, 390×844, Δ336 (`/books` → ＋ → New expense)                                 | select, search (13px), text+`inputmode=decimal` ×2 (VAT auto 8.24), date | not run (root covered)                                                                                                   | Vaul set `height:482px; bottom:336px`. Sheet at 26–508 = exactly the 508 band. Gross 269–314 in band, CTA in band after 66px sheet scroll, hit-test OK. Close state `height:568px; bottom:0` = original height |
| New expense sheet, **landscape 844×390**, Δ190                                                 | select, decimal, date                                                    | Sheet 184px tall, **sheet scroller only 98px** (~2 fields). Field and CTA reachable by scrolling, CTA hit-test OK        | `height:184px; bottom:190px`. Sheet inside the 200 band. Field and CTA reachable by scrolling                                                                                                                  |
| Add entity → Employee, 390×844, Δ336 (`/settings/entities` → ＋ Add)                           | select, text, **email**, text (Telegram id)                              | Field and CTA reachable, CTA hit-test OK (**CTA disabled**: form incomplete, so geometry only, not submission usability) | Sheet inside band, `bottom:336px`. Field and CTA reachable                                                                                                                                                     |
| Add IMAP mailbox, 390×844, Δ336 (`/settings/mailbox`) _(rerun after a fixture fix, see below)_ | select ×2, text, **number** (993), text, **password**, text              | Field and CTA reachable, CTA hit-test OK (enabled)                                                                       | Sheet inside band, `bottom:336px`. Field and CTA reachable                                                                                                                                                     |
| Organization, **full page**, 390×844, Δ336 (`/settings/organization`)                          | text, `inputmode=numeric`, select, checkbox                              | IBAN reachable. Save at maximum document scroll: 317–359, above the tab bar (453–508), hit-test OK                       | n/a: no listener on a full page, and Chromium does not pan a stubbed viewport                                                                                                                                  |

Focus and close, all sheet cases:

- The sheet opened with focus on **Close**. Tab order was Gross → VAT → Tax
  point date, Telegram id ⇄ Email, and App password ⇄ Folder.
- Typed values were kept after every resize and stub. Password values were
  recorded by length only.
- Close on a dirty form asked "Discard unsaved changes?". Discard closed the
  sheet, kept the route, returned focus to the opener, and left the body
  inline style empty (no leftover `pointer-events` or `position`).
- Picking a supplier from the search list moved focus to the sheet container
  (the list unmounts). On a device, this is expected to hide the keyboard.
  Recorded for the device run, not filed.

Observations (only #362 is filed; nothing here is a physical-keyboard claim):

1. **Height stays shrunk after (L): filed as
   [#362](https://github.com/EmpiresHQ/headless-bookkeeping/issues/362) (P2,
   limited to explicit layout resize).** When the first visual-viewport event
   of an open comes from a layout resize, Vaul records the already-shrunk
   height as `initialDrawerHeight`. Restoring the viewport then keeps the
   sheet short (467px / 184px, sitting low on a full 844 / 390 screen). The
   reviewer's six layout-only runs (no visual-viewport stub) confirm it at
   320 and 390 wide, 844→430→844: New expense 668.5→395.594px, New sales
   invoice 760→395.594px, source Verify 776.469→395.594px. Focus and values
   were kept, and the CTA stayed reachable by scrolling. Under (V) alone, the
   sheet returned to its original 568px. The fix belongs to #362, not #295.
   Whether a real rotation or split-screen with the keyboard open reaches
   this state can be shown only on a device (rows R4/A4).
2. **Landscape leaves little room.** At 844×390 with a 190px "keyboard", the
   form scroller is 98px. Check the real ratio on devices.
3. **Proxy harness corrections, preserved from the initial run:** (a) the
   `scrollTop = 0` precondition caused all "focused field not in band"
   negatives; (b) `scrollIntoView({block:'nearest'})` put the Organization
   Save button under the fixed tab bar, but scrolling to the maximum exposes
   it, so there is no accessibility defect; (c) the IMAP case first logged an
   unhandled `GET /admin/settings` (503). A fixture (`{settings: []}`) was
   added and only that case was rerun. The rerun had no unhandled requests
   and the same geometry and field outcome. The IMAP row above reports that
   rerun. The earlier final-run record for IMAP still shows the 503 and is
   superseded; the other four rows come from the final run.

## Physical-device matrix

Device, OS and browser versions: **NOT RUN / unavailable**. Fill in with the
real values at run time. For each row, record:

- `innerHeight`, `visualViewport.height` and `offsetTop`, before and with the
  keyboard (e.g. via remote Web Inspector or `chrome://inspect`);
- the drawer's inline `height`/`bottom`;
- a screenshot.

Data: a local or staging instance with test data. **Do not submit against
production books.** Stop at the CTA, or use a throw-away organization.

| #   | Screen / route                                                                          | Fields and focus transition                                                                     | Steps                                                                                                  | Pass criteria                                                                                                                                                                                           | iOS Safari | Android Chrome |
| --- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------- |
| R1  | Books → ＋ → New expense (`/books`)                                                     | Category select → supplier search → Gross/VAT (decimal keypad) → Tax point date (native picker) | Open (keyboard must stay down). Tap each field in turn, then use the keyboard's next/prev. Type values | Sheet top below the status bar, focused field visible above the keyboard, no page scroll behind the overlay, decimal keypad shown, values kept                                                          | NOT RUN    | NOT RUN        |
| R2  | Same                                                                                    | Gross focused, keyboard up                                                                      | Scroll the sheet to **Create expense**                                                                 | Geometry only, without tapping: CTA fully visible above the keyboard and not covered by the tab bar or keyboard. A one-tap submit check needs an isolated mock or staging instance with throw-away data | NOT RUN    | NOT RUN        |
| R3  | Same                                                                                    | Gross → hide keyboard (iOS Done / Android back) while focus stays                               | Hide, then blur                                                                                        | Sheet returns to its pre-keyboard height and bottom = 0. No gap under the sheet, no stuck short sheet                                                                                                   | NOT RUN    | NOT RUN        |
| R4  | Same                                                                                    | Gross focused, keyboard up                                                                      | Rotate to landscape, type, rotate back                                                                 | Field and CTA reachable in landscape. After rotating back, sheet at normal height (checks #362 on a device)                                                                                             | NOT RUN    | NOT RUN        |
| R5  | Settings → Entities → ＋ Add → Employee                                                 | Name → **email** keyboard → Telegram id                                                         | Type, switch fields                                                                                    | Email keyboard variant shown, focused field visible, CTA reachable once valid                                                                                                                           | NOT RUN    | NOT RUN        |
| R6  | Settings → Mail intake → Add IMAP mailbox                                               | host → **number** (Port) → username → **password** (autofill bar) → folder                      | Type, switch fields                                                                                    | Record the keyboard variant actually shown for Port (`type=number`), and confirm 993 can be entered. The password autofill/QuickType bar does not cover the focused field or the CTA                    | NOT RUN    | NOT RUN        |
| R7  | Inbox → document → Verify (source sheet, `h-[92vh]`)                                    | Amount (decimal), switch Form/Source with the keyboard up                                       | Focus Amount, toggle Source and back                                                                   | Keyboard hides or stays sensibly. Form value and scroll are kept. Source pane is not stuck under the keyboard                                                                                           | NOT RUN    | NOT RUN        |
| R8  | Settings → Organization (full page)                                                     | text → IBAN → `numeric` field                                                                   | Focus a lower field, scroll to **Save organization**                                                   | Field visible above the keyboard. Save reachable and not under the tab bar or keyboard. Fixed tab bar does not float over the input                                                                     | NOT RUN    | NOT RUN        |
| R9  | Any sheet                                                                               | Focused text field                                                                              | Close via ✕, via swipe down, via browser Back                                                          | Keyboard hides. Dirty form asks before closing. Focus returns to the opener. The page scrolls afterwards (no body lock left)                                                                            | NOT RUN    | NOT RUN        |
| R10 | Inbox → approval → Reject (`/inbox/approval/:id`); also Books expense/invoice → Correct | **textarea** Reason (multi-line), Return key, then scroll to the button                         | Focus the textarea, type several lines, scroll to the action                                           | Return inserts a newline and does not submit. The caret line stays visible above the keyboard as the text grows. Action reachable (geometry only, without tapping)                                      | NOT RUN    | NOT RUN        |
| Z1  | Any form                                                                                | 15px inputs, 13px search                                                                        | Tap a field                                                                                            | Record whether iOS auto-zooms on focus, and whether zoom persists after blur                                                                                                                            | NOT RUN    | n/a            |

Controls that do not open a text keyboard have separate coverage and are
not keyboard rows. Vaul's `isInput` also excludes them:

- `select` shows a native picker (R1, R5, R6).
- `type=date` shows a native date picker on both platforms, even though Vaul
  counts it as `isInput` (R1). Record what appears.
- Checkboxes: Lock period (`reports/PeriodScreen.tsx`), Edit draft,
  Organization.
- Radio: Correct (`books/CorrectSheet.tsx`).
- File: Attach document (`books/AttachDocumentSheet.tsx`).

For each of these, record only that focusing or activating the control does
not leave a stale keyboard or a shifted sheet. This matrix does not cover
every field type.

Android: record the Chrome version and whether the page used the default
keyboard mode (`interactive-widget` is not set in `index.html`). Rows A1–A9 =
R1–R9 on Android. A4 = rotation.

## Reproduce the proxy

The scripts were ephemeral and are not committed. To rebuild the run:

1. Build: `node ../../node_modules/vite/bin/vite.js build` from
   `packages/web`, then serve it with `vite preview`.
2. In Playwright Chromium, create a context with `isMobile: true`,
   `hasTouch: true` and a token in `localStorage.bk_api_token`. Route every
   same-origin `/api` and `/admin` path to the fixtures above, and abort
   other origins.
3. For (L), call `setViewportSize(w, h − Δ)`. For (V), override
   `VisualViewport.prototype.height` and dispatch `resize` on
   `window.visualViewport`.
4. Measure `innerHeight`, `visualViewport`, the open `[data-vaul-drawer]`
   rect and inline style, the sheet's `.overflow-y-auto` scroller, the active
   element and the CTA centre `elementFromPoint`.
