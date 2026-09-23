# QA-004: short height, large text and long confirmations (issue #297)

This is a verification task, not an assumed bug. The run was a bounded,
mocked Chromium matrix on `main` `07d2047` (includes #362). No product code
was changed, and nothing here is a result from a physical device.

## Verdict

| Criterion                                                      | Status                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Short confirm, realistic Entity delete at 320×568 and 844×390  | Run. **Pass**: fits, both buttons fully visible and hit-testable, pointer Cancel works                                                                                                                                                                                   |
| Very long (still accepted) Entity name, normal text            | Run. **Fail**: dialog taller than viewport and title clipped. Buttons are only a 9–18 px strip (own 657-char name) or fully off-screen (root's 678-char name at 844×390). Filed by root as [**#366 (P2)**](https://github.com/EmpiresHQ/headless-bookkeeping/issues/366) |
| Unbroken Entity name                                           | Run. **Fail (related to #366)**: the token overflows the body box horizontally and the name is unreadable. Buttons stay reachable                                                                                                                                        |
| Amount-bearing buttons (Create expense / Create invoice)       | Run. **Pass**: amount wraps as a whole token, no horizontal overflow, reachable by wheel and Tab                                                                                                                                                                         |
| Native / OS text scale 200 %                                   | **NOT TESTED**: `Emulation.setEmulatedOSTextScale({scale:2})` had no measurable effect on this build (see below)                                                                                                                                                         |
| Enlarged text (synthetic CSS doubling, not a native setting)   | Run. **Fail** for every Entity confirm in both viewports, for the short confirm at 844×390 (clipped top) and at 320×568 ("Delete" 18 px past the viewport); forms pass                                                                                                   |
| Physical devices, real browser text-size / Dynamic Type, pinch | **NOT RUN**                                                                                                                                                                                                                                                              |
| Issue #297                                                     | Defect reproduced → #366. Native text scaling and devices remain untested, so this is **not** an all-clear                                                                                                                                                               |

## Set-up

- **Build:** own `vite build` of `07d2047`, unmodified (`index-Bx2QxDOq.js`, `index-DJUHFF8w.css`), served by `vite preview` on `127.0.0.1:5361`. The server was stopped after the run.
- **Browser:** Chromium 153.0.8010.12 headless (Playwright 1.63.0), Linux, `isMobile` + `hasTouch`, DPR 1. Run at 2026-09-23T21:08Z (UTC) = 2026-09-24 local time.
- **Viewports:** 320×568 and 844×390 via the context viewport. Not a device, no browser chrome.
- **Mocking:** every `/api` and `/admin` request went to the harness's own route table, and other origins were aborted. Any non-GET was answered 409 and logged. **Across all runs: 0 mutations, 0 unhandled routes, 0 page errors.** No destructive Confirm was ever clicked: Confirm was only hit-tested.
- **Harness:** `.review-297/confirm-matrix.mjs` (untracked). Results are in `confirm-final.json` (confirms), `matrix-results.json` (forms: normal/native) and `synthetic-results.json` (scoped synthetic). Screenshots are in `.review-297/shots/`.

## Fixture data

| Case                     | Route / trigger                          | Name length | Body length | Body text (start)                                                                                                                                |
| ------------------------ | ---------------------------------------- | ----------: | ----------: | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `expense-draft-delete`   | `/books/expenses/12`, "Delete draft…"    |           — |          88 | "The draft is removed permanently. Posted expenses can never be deleted — only corrected."                                                       |
| `entity-delete-long`     | `/settings/entities/7`, "Delete entity…" |         117 |         244 | "Osaühing Põhja-Eesti Raamatupidamis- ja Maksunõustamisteenuste Keskus ning Partnerid Rahvusvaheline Esindus Tallinnas disappears from pickers…" |
| `entity-delete-stress`   | same                                     |         657 |         784 | a 217-char spaced legal name ("Baltic Sea Freight Forwarding, … Registered Office Tallinn, Estonia OÜ") ×3, joined by " — "                      |
| `entity-delete-unbroken` | same                                     |          94 |         221 | "VeryLongSupplierLegalNameWithoutAnySpacesOrBreakOpportunities-Holding-International-Tallinn-OÜ disappears…"                                     |

Every name is accepted by the API: `onboardEntitySchema.name` is `z.string()` with no max (`packages/server/src/entities/types.ts`), and the web forms set no `maxLength` on name. The body comes from `EntityScreen.tsx`: `` `${entity.name} disappears from pickers…` ``.

Form cases: `/books` → "Add to the books" → New expense / New sales invoice. Gross `45.67` or `9999999.99`, tax point date `2026-09-21`, category `office` / invoice number `INV-2026-000297`. Labels: "Create expense · −9999999.99 €" and "Create invoice · +9999999.99 €" (`signedEuros`, no thousands separator).

## Text-size mechanism

- **Native (CDP):** `Emulation.setEmulatedOSTextScale({scale:2})` returned OK. The probe before and after was identical: a 13.5 px span measured 13.5 px with Range 113×16; a `font-size:medium` span measured 16 px with Range 118×19; root 16 px; `visualViewport.scale` 1. In all 16 native runs, the dialog, body and button boxes matched the normal run exactly. Only the absence of any effect was observed (even the `medium` probe was unchanged); the cause was not determined. **Native/OS text scaling is not tested by this report.** Root probed it independently with the same result.
- **Synthetic (valid, scoped):** after the dialog or sheet opened, every element in that subtree had its computed `font-size` and px `line-height` snapshotted, then doubled with inline `!important` (7 elements per confirm, 52–55 per sheet). `<html>` and rem-based boxes were untouched, so the dialog stayed 272 / 384 px wide. The measured result was body 27 px / 40.5 px, title 34 px / 51 px, buttons 30 px. This is **synthetic** enlarged text, not a browser or OS setting.
- **Invalid, superseded:** the first synthetic pass also doubled `<html>`, which doubled rem padding and `max-w-sm`, and pushed the dialog to 535 px at 320×568. Those synthetic rows in `matrix-results.json` are **void**. So is `body: null` in that file (a description-selector bug, fixed via `aria-describedby`). Pinch / page scale was not used.

## ConfirmDialog results (normal text = native, identical)

y ranges are viewport px. "Visible" is the share of each button's box inside the viewport. "Hit" means `elementFromPoint` at the centre of the button's visible part returned the button.

| Case @ viewport            | Dialog y            | Buttons y           | Visible / hit  | Title / body lines | Cancel via                  |
| -------------------------- | ------------------- | ------------------- | -------------- | ------------------ | --------------------------- |
| short @320×568             | 164.8–403.3         | 340.8–383.3         | 100 % / yes    | 2 / 4              | pointer                     |
| long @320×568              | 115.6–452.4         | 367.4–432.4         | 100 % / yes    | 1 / 9              | pointer                     |
| **stress @320×568**        | **−66.6–634.6**     | **549.6–614.6**     | **28 % / yes** | 1 / 27             | pointer on an 18.4 px strip |
| unbroken @320×568          | 146–422             | 337–402             | 100 % / yes    | 1 / 6              | pointer                     |
| short @844×390             | 98.6–291.4          | 228.9–271.4         | 100 % / yes    | 1 / 3              | pointer                     |
| long @844×390              | 68.3–321.8          | 259.3–301.8         | 100 % / yes    | 1 / 6              | pointer                     |
| **stress @844×390**        | **−53.3–443.3**     | **380.8–423.3**     | **22 % / yes** | 1 / 18             | pointer on a 9.2 px strip   |
| **root 678-char @844×390** | **−63.375–453.375** | **390.875–433.375** | **0 % / no**   | —                  | Escape only                 |
| unbroken @844×390          | 78.4–311.6          | 249.1–291.6         | 100 % / yes    | 1 / 5              | pointer                     |

**Stress (#366).** The dialog is `fixed`, centred with `translate(-50%,-50%)`, and has `max-height: none` and `overflow-y: visible`. Its top (the title) sits above the viewport, and its buttons sit below the fold. Wheel (+600) and touch drag (−400 px) moved nothing: dialog top, `scrollY` and dialog `scrollTop` were unchanged. Tab cycles only Cancel ↔ Delete entity (focus trap), and focusing them does not bring them into view. With **this run's 657-char name** the buttons are still hit-testable on a thin visible strip (9.2–18.4 px, below a 24 px target), and a pointer click on Cancel's strip closed the dialog: partly exposed, but far too small to use. With **root's 678-char name** (3 × a 224-char base joined by an em dash; `/tmp/hbk-297-browser/entity-long-results.json`, `entity-long.log`) at 844×390, normal text, both buttons sit at y 390.875–433.375, **entirely below the 390 px viewport, with zero visible strip**. Wheel, PageDown and Tab did not expose them, trial clicks timed out, and only Escape closed the dialog (0 writes, 0 errors). That is a fully unreachable Cancel/Confirm with no text or CSS override. Both results show the same defect: the title and the top of the body are unreadable.

**Unbroken name (related to #366, no separate issue).** The body box is 232 px wide at 320×568 but its `scrollWidth` is 500. The text Range ends at x = 544: that is 248 px past the dialog's right edge (296) and 224 px past the viewport. At 844×390 the figures are `scrollWidth` 500 / `clientWidth` 344, and the Range ends at 750 against a dialog right edge of 614 (inside the viewport). The document never overflows (`scrollWidth` = viewport width; the page is scroll-locked). In this run's screenshot the name is unreadable after "…WithoutAn"; root's 184-char screenshot shows it painting past the dialog. Buttons are unaffected.

**Lock and Cancel (all normal runs).** While open: `body` `overflow:hidden` plus `data-scroll-locked`. Focus is trapped (Cancel → Confirm → Cancel). After Cancel: dialog gone, lock removed, route unchanged, focus back on the trigger ("Delete draft…" / "Delete entity…").

**Button wrapping.** At 320×568, "Delete entity" wraps to 2 lines (buttons 111×65), with no internal horizontal overflow. "Cancel" and "Delete" stay on 1 line.

## ConfirmDialog, synthetic enlarged text (scoped, valid)

| Case     | 320×568: dialog y / buttons y / visible                                                           | 844×390: dialog y / buttons y / visible |
| -------- | ------------------------------------------------------------------------------------------------- | --------------------------------------- |
| short    | 1.3–566.8 / 481.8–546.8 / Cancel 100 %, Delete 87 % (x 197–338, past dialog 296 and viewport 320) | −21.8–411.7 / 326.8–391.8 / 97 %        |
| long     | −238.8–806.7 / 676.8–786.8 / **0 %**                                                              | −165.8–555.7 / 425.8–535.8 / **0 %**    |
| stress   | −1150–1718 / 1588–1698 / **0 %**                                                                  | −672–1062 / 932–1042 / **0 %**          |
| unbroken | −137.5–705.5 / 575.5–685.5 / **0 %**                                                              | −105–495 / 365–475 / 23 %               |

At 0 % visible, neither wheel, touch drag nor Tab exposes the buttons. Escape still closes the dialog with no request. With enlarged text the short confirm fits at 320×568, but the 30 px labels' min-content widens the row: "Delete" pokes 18 px past the viewport, though it is still hit on its visible part. At 844×390 the title is clipped at the top.

## Amount-bearing form buttons

| Sheet @ viewport, text  | Amount             | CTA lines | CTA box (w×h) | Overflow X | Start in view | Wheel steps (150 px) | Tabs from date | Hit after scroll |
| ----------------------- | ------------------ | --------: | ------------- | ---------- | ------------- | -------------------: | -------------: | ---------------- |
| expense @320×568 normal | 45.67              |         1 | 280×42.5      | no         | yes           |                    0 |              4 | yes              |
| expense @320×568 normal | 9999999.99         |         2 | 280×65        | no         | yes           |                    0 |              4 | yes              |
| invoice @320×568 normal | 45.67 / 9999999.99 |     1 / 2 | 280×42.5 / 65 | no         | no            |                    2 |              8 | yes              |
| expense @844×390 normal | both               |         1 | 536×42.5      | no         | yes           |                    0 |              4 | yes              |
| invoice @844×390 normal | both               |         1 | 536×42.5      | no         | no            |                    3 |              8 | yes              |
| expense @320×568 synth. | 45.67 / 9999999.99 |     3 / 4 | 280×155 / 200 | no         | no            |                    4 |              4 | yes              |
| invoice @320×568 synth. | 45.67 / 9999999.99 |     2 / 3 | 280×110 / 155 | no         | no            |                    6 |              8 | yes              |
| expense @844×390 synth. | 45.67 / 9999999.99 |     1 / 2 | 536×65 / 110  | no         | no            |                    2 |              4 | yes              |
| invoice @844×390 synth. | 45.67 / 9999999.99 |     1 / 2 | 536×65 / 110  | no         | no            |                    5 |              8 | yes              |

The label breaks at "·", keeping "−9999999.99 €" whole on its own line (screenshot `create-expense-9999999.99-320x568-normal.png`). There is no page-level horizontal overflow in any form run. Keyboard Tab focused the CTA with it in view every time. The CTA was not submitted. Root independently ran expense and invoice with `9999999.99` at both sizes, normal and scoped synthetic (8 states). After `scrollIntoViewIfNeeded`, every CTA was fully in view, centre-hit, enabled, with no horizontal overflow and the full amount shown (`/tmp/hbk-297-browser/amount-results.json`, 0 POSTs). That run did not test wheel scrolling; this matrix covers it.

## Not covered

- Native/OS text scaling (the CDP method had no effect), real browser text-size settings, iOS Dynamic Type and Android font scale. Pinch zoom was deliberately excluded.
- Physical devices, real toolbars and keyboards; 390×844 and other sizes.
- Other ConfirmDialog call sites (invoice, statement, mailbox, triage, document): not tested.
- Other amount-bearing buttons: "Match X €" (`TxCandidates`), "Close & freeze · …" (`LockSheet`), "Post correction · …" (`CorrectSheet`), "Issue credit note · …".
- Keyboard Enter/Space on a clipped, focused Confirm (not pressed, by design).
