# QA-005: iOS focus zoom and numeric/date entry (issue #298)

This is a verification task, not a confirmed bug, and **it is not closed.** As
in #295/#296, the host is Linux with headless Chromium only. No physical iOS
or Android device, iOS Safari, software keyboard or Dynamic Type was
available. No native iOS/Android date picker was tested; only Chromium's own
`type=date` control was driven, by Playwright `fill()`. What follows is a
partial source inspection plus bounded Chromium mobile-emulation _proxy_
runs. No product code was changed.

## Verdict

| Question                                                  | Status                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------- |
| iOS Safari focus/zoom on the inspected fields             | **NOT RUN**: no device                                                |
| Software keyboard Next/Done, decimal keypad layout        | **NOT RUN**: no device                                                |
| Native iOS/Android date picker UI                         | **NOT RUN**: no device                                                |
| Parser: decimal comma/dot, invalid text, required date    | Run (Chromium proxy): as designed, one mocked POST with correct cents |
| Product defect reproduced with current source and fixture | **None**                                                              |
| Issue #298                                                | **Stays OPEN** for the device items above                             |

## Environment

- Source `332262f` (main after #368), built with Vite into `.review-298/dist`
  and served by `vite preview` on 127.0.0.1:5363. Chromium 153.0.8010.12
  (Playwright), locale en-US, `isMobile`/`hasTouch` emulation, 320×844 and
  390×844, and desktop keyboard events.
- Requests actually executed: other origins were aborted by the fixture.
  Root's 8 accepted POSTs were each refused by a mocked 409 (per root's run).
  This audit made 4 `POST /api/documents/12/manual-classify`, each answered
  200 by the copied #257 mock, plus mocked GETs. No production call. The
  shared helper chain answers some known writes with 200, so it is not a
  blanket write guard.
- Two runs. **Root** (`/tmp/hbk-298-browser/numeric.{mjs,log}`,
  `numeric-results.json`): manual Expense and Invoice, 320/390 ×
  `12,34`/`12.34`, 8 cases. **This audit** (`.review-298/verify-settings.{mjs,log}`,
  `verify-settings-results.json`, `shots/`): Verify (inbox classify)
  Expense/Invoice at 320/390, the Add IMAP mailbox sheet and the token gate,
  6 cases. The fixtures are copies of the #252–#265 helper chain in
  `.review-298/fx/`.

## Inspected source (static, not exhaustive; not a device result)

`index.html` viewport is `width=device-width, initial-scale=1.0`, with no
`maximum-scale`/`user-scalable`. The font column is the source class.
`INPUT_CLS` (`ui/Form.tsx`, `text-[15px]`) is applied by `TextInput`/`SelectInput`.

| Field (file)                                                     | type / inputMode  | font class    | enterKeyHint | autocomplete / autocapitalize |
| ---------------------------------------------------------------- | ----------------- | ------------- | ------------ | ----------------------------- |
| Gross, VAT: manual (`books/create.tsx`), Edit (`EditDraftSheet`) | text / decimal    | `INPUT_CLS`   | none         | none                          |
| Amount, VAT: Verify (`inbox/Classify{Expense,Invoice}Sheet`)     | text / decimal    | `INPUT_CLS`   | none         | none                          |
| Tax point / Date / Due date (same forms)                         | date / —          | `INPUT_CLS`   | none         | none                          |
| Currency (`EditDraftSheet`)                                      | text              | `INPUT_CLS`   | none         | `autocapitalize=characters`   |
| Deductible per mille (`settings/OrganizationScreen`)             | text / numeric    | `INPUT_CLS`   | none         | none                          |
| IMAP host, Username, Folder (`settings/AddImapSheet`)            | text              | `INPUT_CLS`   | none         | none                          |
| IMAP Port / App password                                         | number / password | `INPUT_CLS`   | none         | none                          |
| Entity Email (`settings/CreateEntitySheet`)                      | email             | `INPUT_CLS`   | none         | none                          |
| API token (`components/TokenGate`)                               | password          | `text-sm`     | none         | `autocomplete=off`            |
| Search (`ui/SearchInput`)                                        | search            | `text-[13px]` | none         | none                          |

- No `enterKeyHint` attribute occurs in `packages/web/src` (grep). The device
  key label (return/Next/Done/Go) was not observed.
- Parser (`lib/money.ts` `eurosToCents`): trims the input, replaces the
  **first** `,` with `.`, then matches `^-?\d+(\.\d{1,2})?$`. Integer cents
  are built from the digit string, with no float step. Thousands separators
  are rejected by design. Existing unit coverage in `lib/money.test.ts`
  accepts `89,05` (8905) and `1,1` (110), rejects `1.234`, and checks
  exactness. Related validation/native-submit coverage is in #265/#266.
  **Those existing tests were not rerun for this doc.**

## Browser results (Chromium proxy)

| #    | Case                                                             | Result                                                                                                                                                                                                                            |
| ---- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1–8 | Root: manual Expense/Invoice, 320/390, `12,34` and `12.34`       | Each: exactly one mocked POST, `gross_amount 1234`, `tax_point_date 2024-02-29`; `12,345` and blank date blocked (aria-invalid, no POST); Tab from Gross focused `VAT (€)`; Enter submits once; typed value kept after mocked 409 |
| V1   | Verify Expense 320, focus Amount, type `12,34`                   | Measured: text/decimal, 15px, `visualViewport.scale` 1 before and after focus; value `12,34`; one POST, `gross_amount 1234`, date `2024-02-29`                                                                                    |
| V2   | V1 invalid inputs `12,345`, `1.234,56`, `1,234.56`, `abc`, blank | 0 POSTs each; aria-invalid; "Enter an amount like 12.40 — digits, at most 2 decimals" / "Enter the amount"                                                                                                                        |
| V3   | V1 with blank Date                                               | 0 POSTs; aria-invalid; "Pick the date"                                                                                                                                                                                            |
| V4   | Verify Expense 390, `12.34`, Enter in Amount, then Tab           | Enter: **0 POSTs** (see observation); Tab focused aria-label `VAT (EUR)`; button: one POST, `1234`                                                                                                                                |
| V5   | Verify Invoice 320, `12,34`; `12,345`, `abc`, blank date         | Invalid inputs and blank date: 0 POSTs, aria-invalid; valid input: one POST, `1234`                                                                                                                                               |
| V6   | Verify Invoice 390, `" 12,3 "`, Enter, then Tab                  | Enter 0 POSTs; Tab focused aria-label `VAT` (the VAT amount input in source); button: one POST, `gross_amount 1230` (trimmed, one decimal padded)                                                                                 |
| S1   | Add IMAP mailbox 320: focus host/port/username/password/folder   | Measured: text/number/text/password/text, 15px, no autocomplete/autocapitalize/enterKeyHint, scale 1, 0 mutations                                                                                                                 |
| S2   | Token gate 320: focus API token                                  | Measured: password, 14px, `autocomplete=off`, scale 1; no API requests                                                                                                                                                            |

`scale 1` in Chromium only shows that the page itself does not zoom. It says
**nothing** about iOS. Date values were set with `fill()` (ISO string), not
through a picker. Verify date fields start at the fixture value `2026-09-10`
and were cleared for V3/V5. Error collection: the four Verify cases logged no
page errors or unhandled requests. The IMAP case logged 2 unhandled
`GET /admin/settings`, answered 503 by the base fixture. The token probe
recorded only attributes and requests, with no page-error listener.

## Observation (not a filed bug)

- **Verify sheets do not submit on Enter.** `ClassifyExpenseSheet` and
  `ClassifyInvoiceSheet` render no `<form>`/`SubmitForm`, so an Enter in
  Amount does nothing (V4, V6: 0 POSTs). The manual Expense/Invoice forms do
  submit once on Enter (#266, root R1–8). The #266 work covered the manual
  forms and the inline counterparty, not Verify. This is a difference between
  screens, not a demonstrated defect. No contract says whether Verify should
  implicitly submit, and nothing here says how a mobile Done/Go key behaves.
  A prioritized issue needs that expected contract first.

## Physical-device matrix (still required)

| Device / browser                 | Check                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| iPhone (Safari, ≥1 current iOS)  | Focus Gross/Amount, Date, IMAP Username, token: record scale on focus and after blur |
| iPhone, decimal keypad           | Which separator the key inserts in `et`/`ru`/`en` regions; `12,34` → 1234 cents      |
| iPhone, Next/Done/return         | Accessory arrows Gross→VAT→Date; Done/return on manual vs Verify (see observation)   |
| iPhone native date wheel         | Pick, clear and re-pick the required date; the "Pick the date" error clears          |
| Android Chrome (Gboard, Samsung) | Decimal keyboard `,`/`.`; default Enter key label; native date dialog                |
| iOS large Dynamic Type           | Labels and fields readable, no clipping                                              |

For each run, record the device model, OS, browser version, region/keyboard
language, width, the data typed and the POST payload seen in a mock or on a
staging instance.
