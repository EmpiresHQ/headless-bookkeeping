# QA-008: Mobile Reports and Settings (issue #301)

This is a verification task, not an assumed bug. The run was a bounded,
mocked Chromium matrix at 320 and 390 CSS px on `main` `d03c592`, whose
`packages/web` is identical to `f5a9a7a`. No product code was changed.
**No physical phone and no native iOS Safari / Android Chrome were used.
This is desktop-headless Chromium with mobile emulation, not physical iOS/Android
acceptance.** No real backend was involved. Every write went to an in-page
mock. No real period was locked, and no real credential, token or mailbox was
used or contacted. A mock's accept, refuse or dedup behaviour says nothing
about the real server's accounting correctness or idempotency.

A later same-day run re-checked these flows on `main` `ea0b00c`, after the F1
fix (#376) and the landmark change (#378). See
[Re-verification on `main` `ea0b00c`](#re-verification-on-main-ea0b00c).

## Verdict

| Area (issue #301 list)                              | Status                                                                                                                                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Physical iOS/Android browser                        | **NOT RUN** (no device available)                                                                                                                                                                                               |
| Period viewing / closing with fresh proof           | Run (mock), 320 + 390. **Pass**. Root ran the fresh-proof gating and pending-dismiss cases; this run covers server refusal → retry → frozen state                                                                               |
| XML / CSV download                                  | Run (mock), 320 + 390. **Pass**: real browser download events, exact suggested filenames and bodies. 1 cosmetic observation (O1)                                                                                                |
| Correcting a supplier invoice number (INF gap)      | Run (mock), 320 + 390. **Pass**                                                                                                                                                                                                 |
| Settings Save / Clear (failure, pending, refetch)   | Run (mock), 320 + 390. **Pass**. Root ran the AI-model races; this run covers the `public_api_url` key on the device screen                                                                                                     |
| Counterparty creation (Settings → Entities)         | Run (mock), 320 + 390. **Pass**                                                                                                                                                                                                 |
| Mailbox connection (IMAP, OAuth start/return, Sync) | Run (mock), 320 + 390. Mostly pass. **1 proposed, source-derived defect (F1 → [#376](https://github.com/EmpiresHQ/headless-bookkeeping/issues/376))**: an empty IMAP port is sent as `0`. Fixed by `9db60ca`; re-verified below |
| Device connection (enrollment QR)                   | Run (mock), 320 + 390. **Pass**                                                                                                                                                                                                 |
| Issue #301                                          | **Stays OPEN**: the issue asks for a physical pass, and physical-device acceptance is untested                                                                                                                                  |

### Proposed finding (not fixed here)

**F1 → [#376](https://github.com/EmpiresHQ/headless-bookkeeping/issues/376) (filed by root after independently reproducing the model from `AddImapSheet.tsx` and the server controller/service): clearing the IMAP "Port" field still enables "Add mailbox" and sends `port: 0`.** This is a proposed, source-derived finding. The client request was observed in the mocked browser; the server consequence comes from reading source only, with no real backend run. No severity is proposed here.

- Steps (320 and 390): Settings → Mail intake → "Add IMAP mailbox…" → fill IMAP host, Username and App password (fakes) → clear **Port** → "Add mailbox".
- Observed: the button stays enabled (`<input type="number">`, not `required`, `validity.valid === true` when empty). The request body carries `"port":0`, the mock accepts it, the sheet closes and the row is listed.
- Client source: `AddImapSheet.tsx` checks only host, username and secret for `valid`, and sends `port: Number(port)`. `Number('')` is `0`.
- Server source: `mailbox.controller.ts:41-76` types the body inline, with no Zod `schema`. The global `ZodValidationPipe` (`main.ts:13`) therefore passes it through. `mailbox-connector.service.ts:81-101` inserts `port` as given with `status: 'connected'`, and `connectAndSync` runs later and asynchronously. By source reading, a real server would store port 0 and report it `connected` until the background sync fails. This was **not run** against a real server.
- The input has no `inputmode` (`inputMode: ""`). On a phone, `type=number` usually shows a numeric keypad anyway. Not verified on a device.
- Artifacts: `settings-results.json` case `mailbox-imap-empty-port`, `imap-empty-port-{320,390}.png`.

### Observation (no defect claimed)

**O1. Only one download shows busy at a time.** Tapping "Download CSV" while the XML request is still pending moved the busy indicator to CSV, and XML stopped showing busy (`aria-busy` `[null, "true"]`). Both files still arrived with the right name and exact body. The single `busy` slot in `PeriodScreen.tsx` `Downloads` is deliberate: its comment is about not clearing the other format's slot. A second XML tap during that window would only issue another read-only GET. Recorded for completeness.

## Set-up

- **Build:** the existing production build `/tmp/hbk-ui-373/.review-373/root-dist`, served unmodified. Provenance checks:
  - `git diff f5a9a7a..HEAD -- packages/web` in this worktree (HEAD `d03c592`) is empty.
  - `/tmp/hbk-ui-373` is clean at `f5a9a7a`, apart from its untracked `.review-373/`.
  - `diff -rq` of that dist against `/root/.cache/hbk-worktrees/hbk-ui-373/.review-373/root-dist` (the copy root served) reports identical files.
- **Server:** `vite preview` on `127.0.0.1:5368`, PID 461665, stopped by PID afterwards.
- **Browser:** Chromium 153.0.8010.12 (Playwright build), headless, driven by Playwright 1.63.0 on Node 24.21.0 on Linux.
  - Contexts 320×844 and 390×844 CSS px, `isMobile` + `hasTouch`, DPR 1.
  - Env: `TMPDIR=/root/.cache/hbk-browser-tmp`, `LD_LIBRARY_PATH=/tmp/hbk-browser-libs/root/usr/lib`, `FONTCONFIG_FILE=/tmp/hbk-browser-libs/fonts.conf`.
- **Base fixtures (read-only imports):** `/tmp/hbk-252-browser/fixtures.mjs`, which pulls in `base-fixtures.mjs`.
  - Token `review-fixture`; other origins aborted; unknown non-GETs answered 500 "Unexpected mutation"; unknown GETs 503, recorded as page errors. Every case asserts that no page errors occurred.
  - `setup()` first opens `/books/expenses/12`, and every case then navigates on. No write was issued there.
- **Own stateful mock:** `.review-301/agent-evidence/fixtures.mjs`, patterned on `/tmp/hbk-255-browser` (period), `/tmp/hbk-289-browser` (settings) and `/tmp/hbk-263-browser` (entities), with all output paths replaced.
  - Every endpoint has a gate (hold → pending, or fail with status + message).
  - Separately, a `page.on('request')` hook records **every non-GET** under `/api` and `/admin`. `propose-matches` is counted apart and was 0 in every case.
- **Data (all fixtures):**
  - Period #7 `2026-09`, 2026-09-01…30, open. KMD: VAT to pay 624.07 €.
  - Posted expense #12: supplier #1 "Fixture supplier", 1500.00 € gross / 290.32 € VAT, 2026-09-10, `supplier_invoice_number: null`. This makes it an INF gap: its net is ≥ 1000 €.
  - Settings start with `ai_model` and `ai_base_url` only, with no `public_api_url`.
  - Fake credentials only: `FAKE-APP-PASSWORD-301`, `FAKE-ENROLL-TOKEN-n`, hosts `*.fixture.invalid`.

### Mock assumptions checked against server source

| Mocked behaviour                                                               | Server source                                                                                                          |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Download filename `kmd-2026-09.xml` / `.csv`, `attachment; filename="…"`       | `estonia-country.plugin.ts:1066-1079`; `statutory-report.controller.ts` (single artifact → `Content-Disposition`)      |
| Download refusal 409 "…is locked but has no frozen filing state"               | `statutory-report.service.ts:178`                                                                                      |
| Invoice-number PATCH 400 "Cannot post into locked period 2026-09" when locked  | `expenses.service.ts:429-445` → `period-lock.service.ts:129-141`                                                       |
| `supplier_invoice_number` has **no** unique constraint (repeat PATCH is fine)  | migration `036_add_supplier_invoice_number.ts` (plain `text`)                                                          |
| Lock 409 "Cannot file period …: earlier period … is still open"; idempotent    | `reporting-periods.service.ts:260-281`                                                                                 |
| Second `email_push` connector refused (unique partial index)                   | migration `058_create_mailbox_connector.ts` `idx_mailbox_connector_single_push`; controller maps it to 400 via `catch` |
| Device enrollment 500 "Public API URL is not configured…" when unset, else 201 | `mobile-auth.controller.ts:29-56`                                                                                      |
| Entity identifiers **not** unique: a duplicate POST would create a duplicate   | `entities.service.ts:24-85`; entity_identifier tables in migrations 013/054 carry no unique index                      |
| Settings PUT/DELETE per key under `/admin/settings/:key`                       | `api.ts:1127-1145` (mock shape reused from #289)                                                                       |

The download bodies are **fixture strings**, not rendered KMD. They show that the browser saves exactly the bytes served under the server's filename. They say nothing about the content of a real declaration.

## Results

Runner status is the real `node` exit code (output redirected to a log, then `$?`).

| Script         | Cases               | Run     | Exit | Result                  |
| -------------- | ------------------- | ------- | ---- | ----------------------- |
| `reports.mjs`  | 3 × {320, 390} = 6  | initial | n/a¹ | 0 / 6 (harness, below)  |
|                |                     | run2    | 0    | 6 / 6                   |
|                |                     | final   | 0    | **6 / 6**               |
| `settings.mjs` | 5 × {320, 390} = 10 | initial | 1    | 4 / 10 (harness, below) |
|                |                     | run2    | 1    | 8 / 10 (harness, below) |
|                |                     | final   | 0    | **10 / 10**             |

¹ The initial reports run was piped through `tee | grep | head`, so node's exit status was not captured. The log is complete: 72 lines, 6 `FAIL` lines, 6 results recorded. Later runs redirect directly.

### Reports: what was exercised (per width)

1. **`view-downloads`**
   - Setup and layout: Reports list → "September 2026" row → `/reports/periods/7`. No horizontal scroll (`scrollWidth` = viewport width). Download buttons 141×65 at 320 (labels wrap to two lines) and 176×42.5 at 390.
   - **Download XML** / **Download CSV**: a Playwright `download` event fired each time. `suggestedFilename()` was `kmd-2026-09.xml` / `kmd-2026-09.csv`. The saved file bytes equal the served bodies (115 B / 40 B), and `failure()` is `null`.
   - **409 refusal:** an error toast shows "409 Conflict: Reporting period "2026-09" (#7) is locked but has no frozen filing state". It sits inside the viewport at y=16 once the sonner animation settles. **No download event** fires, busy clears, and a manual retry downloads the right file.
   - **Rapid XML → CSV while the first is held:** both files arrive with their correct names and bodies (see O1).
   - Requests: `GET …/statutory-report?format=` `xml, csv, xml(409), xml, xml, csv`. **0 non-GET.**
2. **`fix-invoice-number`**
   - Tapped the INF row "Fixture supplier · office · 10 Sep · no invoice number". Sheet "Fixture supplier"; Save is disabled while the field is empty.
   - Typed `  A-183  `. "Save number" settles at y=765.5 of 844 and is visible without scrolling at both widths.
   - **400 refusal:** toast "400 Bad Request: Cannot post into locked period 2026-09". The sheet stays open and the input keeps `  A-183  `.
   - **Retry held pending:** the input is disabled, a forced second tap and **Escape do not dismiss** the sheet, and exactly one more PATCH goes out. On release: toast "Invoice number saved", the sheet closes, the section refetches and reads "INF annex — no supplier invoice numbers missing in this period."
   - Non-GET: `PATCH /api/expenses/12/document-metadata {"supplier_invoice_number":"A-183"}` × 2 (one refused, one accepted), trimmed.
3. **`close-failure-then-frozen`**
   - "Close period…" → sheet "Close September 2026". Opening it re-read warnings and KMD (reads 1→2 each), and it shows "Declaration amount: … recomputed now".
   - With the INF gap present, no acknowledgement checkbox was demanded. Typed `2026-09`; CTA "Close & freeze · VAT to pay 624.07 €". At 320 the CTA settles below the fold (y≈1211) inside the scrollable sheet and is reached by normal sheet scroll.
   - **409:** toast "409 Conflict: Cannot file period 2026-09: earlier period 2026-08 is still open — file it first". The sheet stays open, the typed name is kept, the CTA stays enabled and the period is still open.
   - **Retry:** toast "September 2026 closed — declaration frozen". The sheet closes, and focus lands on the banner "Frozen — closed 21.09.2026…". "Close period…" is gone, the INF row is no longer a button ("numbers can no longer be edited here"), the downloads note reads "Final files from the frozen declaration." and XML downloads as `kmd-2026-09.xml`.
   - Non-GET: `POST /api/reporting-periods/7/lock` × 2 (one per explicit attempt); 0 PATCH.

### Settings: what was exercised (per width)

1. **`device-enrollment`** (Settings → Mobile device)
   - **Mount mints a token:** the POST is held and the skeleton shows (no "Try again"). On release, the mock's 500 renders "The QR cannot be generated yet" + guidance.
   - **`public_api_url` edit:** typed `https://api.fixture.invalid` → "Unsaved edit — Save stores this field only…".
   - **Save 503:** "Save not confirmed — 503 Service Unavailable: Setting rejected. It may or may not have been stored; your input is kept." The input is kept.
   - **Save retry:** "Saved. Clear deletes the stored value; then: …". "Try again" → QR image (252 px at 320, 256 at 390, within the width) and "Expires 15:00:00 — one-time use". The token is not in the page text. "Regenerate" → new QR `src`.
   - **Clear:** "Stored value removed. The server uses its PUBLIC_API_URL…". Regenerate → guidance again.
   - Non-GET: 4 × `POST /api/device-enrollments` (mount, Try again, Regenerate, Regenerate), plus `PUT` × 2 and `DELETE` × 1 on `/admin/settings/public_api_url`. Every visit to this screen mints a token by design (component docstring).
2. **`mailbox-imap`**
   - An existing `email_push` connector is listed. "Add IMAP mailbox…" → sheet. Mode set to `email_push`; fake host, username and password filled. "Add mailbox" settles at y≈754–765 and is visible.
   - **400:** toast "400 Bad Request: UNIQUE constraint failed: mailbox_connector.channel". The sheet keeps host, user, the 21-char password and the mode.
   - **Retry held:** switched to `email_sync`. The pending form is disabled; a forced second tap and Escape don't dismiss it; exactly one more POST goes out. On release: toast "Mailbox added — qa301@fixture.invalid", and the row appears after refetch. **The fake password is not present in page HTML.**
   - **"Sync qa301@fixture.invalid":** `POST /api/mailbox/connectors/51/sync`, toast "Sync finished", and "last synced …" after refetch. No horizontal scroll.
3. **`mailbox-imap-empty-port`**: see F1 / [#376](https://github.com/EmpiresHQ/headless-bookkeeping/issues/376).
4. **`mailbox-oauth`**
   - "Connect Gmail" with `GET /api/mailbox/oauth/start` refused (400): error toast, no navigation, and the buttons re-enable.
   - Retry: the mock returns a **same-origin** URL `…/settings/mailbox?mailbox=connected`, which stands in for the provider round-trip. The toast "Mailbox connected" shows and the query params are stripped.
   - No real provider page was opened. 0 non-GET.
5. **`entity-create`**
   - Entities → "＋ Add" → "Add entity" (default role `supplier`). Filled: Name `QA 301 Supplier OÜ`, Country `ee`, Registration key `EE-12345678`, services, taxable business. "Add supplier" is reachable at both widths.
   - **400:** toast shows, and name and key are kept.
   - **Retry held:** Escape and a forced second tap don't dismiss; exactly one more POST goes out. That matters because the server would create a real duplicate on a second POST. On release: toast "Supplier added — QA 301 Supplier OÜ" and navigation to `/settings/entities/44`.
   - Body: `{"role":"supplier","name":"QA 301 Supplier OÜ","country":"EE","registrationKey":"EE-12345678","goodsVsServices":"services","taxStatus":"taxable_business"}`. The country was uppercased client-side. Back returns to `/settings/entities`.

Every toast measured (error and success, both widths) was fully inside the viewport after its entrance animation, at y=16 with a 16 px side gutter.

### Root's independent cases (cited, not rerun here)

Root ran its own preview on 5265 against the same build (`/tmp/hbk-301-browser/reports.mjs`, `settings.mjs`) and reported 6 verified observations, no defect:

- **Reports, 4/4** (`reports-results.json`, 320/390):
  - XML/CSV actual download filename + exact bytes; a 503 produces no download, then an explicit retry works.
  - Fresh warning + KMD reads gate the lock; while it is pending, Escape does not dismiss; one POST.
- **Settings, 2/2** (`settings-final-results.json`):
  - A 503 on save keeps the draft; a pending save preserves a newer edit; dirty-Keep and a later Save.
  - Clear acknowledged plus a failed refetch leaves an empty, clean field.
  - Root's initial 320 Clear assertion raced React, because disabled also means pending. Root kept those artifacts, corrected the wait (aria-busy false + read error), and the 320 rerun passed; 390 passed on the first run.

## Harness failures and corrections (initial artifacts kept)

- **Reports initial, 0/6:** every case failed a geometry assertion ("error toast visible in viewport", "Save visible without scrolling"). The harness measured bounding boxes at first attach, while the sonner toast and the vaul sheet were still animating in; the full-page failure shots show the toast mid-fade. Fix: wait for a stable rect (and toast opacity 1) before measuring. Following root's guidance, the sheet criterion is now "reachable by normal sheet scroll". Whether the Save button is visible without scrolling is recorded only as an observation (it was, for the invoice-number, IMAP and entity sheets). No layout defect is claimed.
- **Settings initial, 4/10:**
  - (a) Strict-mode collision: the new username appears in both the toast and the list. Fixed with an exact-text match.
  - (b) The harness expected "Nothing stored" after Clear. The product's acknowledgement is "Stored value removed. …", and the screenshot confirms it. That was my wrong model, not a product issue.
- **Settings run2, 8/10:** the harness expected a Sync of connector 50. The mock numbers the new connector 51 because of the pre-seeded push connector #49, and the UI correctly synced 51. The expectation was fixed.

## Limitations

- Not a physical device: no real iOS Safari or Android Chrome, no OS software keyboard, no real touch or gesture physics, no native download UI (the iOS Files sheet or Android download manager). The downloads were verified only as Chromium `download` events. Whether iOS Safari saves a blob `a[download]` with this filename was **not** tested.
- The emulated viewport height is fixed at 844, so no short-height or keyboard-open variants (covered by other QA runs: #298, #299).
- The OAuth provider round-trip was simulated on the same origin, and the real `/oauth/callback` was not exercised. The QR payload was not decoded or scanned.
- Mock semantics only. No server accounting, locking atomicity, idempotency or KMD content is shown.
- The AI-model Save/Clear races were exercised by root, not re-run here.

## Evidence (untracked, `.review-301/agent-evidence/` in the worktree)

- Scripts: `fixtures.mjs`, `reports.mjs` (final), `reports.initial.mjs` (pre-fix), `settings.mjs`, `probe.mjs`, `probe-settings.mjs`.
- Results: `reports-results.json` (final), `reports-run2-results.json`, `reports-initial-results.json`; `settings-results.json` (final), `settings-run2-results.json`, `settings-initial-results.json`.
- Logs: `reports-initial.log`, `reports-run2.log`, `reports-final.log`, `settings-initial.log`, `settings-run2.log`, `settings-final.log`, `probe-settings.log`, `preview.log`, `preview.pid`.
- Screenshots per width: `period-open`, `download-failure`, `fix-number-{sheet,failure,saved}`, `close-{sheet,failure}`, `period-frozen`, `enroll-{unconfigured,qr}`, `imap-{sheet,failure,empty-port}`, `mailbox-listed`, `entity-{sheet,created}`, plus the `fail-*` shots from the failed runs (`fail-mailbox-imap-{320,390}.png` were overwritten by run2's failure of the same case; the other settings `fail-*` shots are from the initial run).

## Re-verification on `main` `ea0b00c`

Run on 2026-09-24, later the same day. Two web changes landed after the first
run: `9db60ca` (#376, IMAP port validation in `AddImapSheet.tsx`) and `84ca1f7`
(#378, the shell wrapper `div` became `<main>` and the desktop sidebar gained
`<nav aria-label="Primary">`). `git diff d03c592..ea0b00c -- packages/web`
touches only `AddImapSheet.tsx`, `AppLayout.tsx`, `Sidebar.tsx` and their tests.
**No physical phone and no native iOS Safari / Android Chrome were used here
either.** No product code was changed, and no defect was found.

### Set-up

- **Build:** a fresh `tsc -b` (exit 0) and `vite build` (exit 0) from this
  worktree at `ea0b00c`, served by `vite preview` on `127.0.0.1:5391`, then
  stopped by PID. Dependencies came from the `hbk-ui-378` worktree's
  `node_modules`, because the shared checkout's copy has no `pdfjs-dist`.
- **Browser:** Chromium 153.0.8010.12 (Playwright 1.63.0, headless) on Node
  24.21.0 on Linux. Contexts 320×844 and 390×844 CSS px, `isMobile` +
  `hasTouch`, DPR 1. Same environment variables as the first run.
- **Fixtures:** the same read-only bases (`/tmp/hbk-252-browser`,
  `/tmp/hbk-255-browser` period, `/tmp/hbk-289-browser` settings). On top of
  them, a new stateful mock in `mobile-settings.mjs` covers mailbox
  connectors, OAuth start, entities and device enrollment. The first run's
  agent scripts were not kept, so this is a rewrite, not a rerun. Fake values
  only: `FAKE-APP-PASSWORD-301`, `FAKE-ENROLL-TOKEN-n`, `*.fixture.invalid`.
- **Non-GET safety:** a `page.on('request')` hook records every non-GET under
  `/api` and `/admin`, and each case asserts the exact list. Unknown non-GETs
  are answered 500 by the base fixture, and every case asserts that no page
  errors occurred and there is no horizontal scroll.
- **Touch geometry:** each case measures the control's rect after it stops
  moving. The hit extent is found by probing `elementFromPoint` outward from
  the centre, which is why a 42.5 px box reads 43–44.

### Results

| Script                | Cases              | Run     | Exit | Result                   |
| --------------------- | ------------------ | ------- | ---- | ------------------------ |
| `reports.mjs` (root)  | 2 × {320, 390} = 4 | final   | 0    | **4 / 4**                |
| `settings.mjs` (root) | 1 × {320, 390} = 2 | final   | 0    | **2 / 2**                |
| `mobile-settings.mjs` | 7 × {320, 390} =14 | initial | 1    | 12 / 14 (harness, below) |
|                       |                    | run2    | 1    | 12 / 14 (harness, below) |
|                       |                    | final   | 0    | **14 / 14**              |

- **Root `reports.mjs`:**
  - XML/CSV downloads fire real download events with the served filenames and
    bytes. A 409 refusal produces no download, and a manual retry works. 0
    non-GET.
  - Closing the period re-reads KMD and warnings before the lock, and sends
    exactly one `POST …/7/lock`.
- **Root `settings.mjs`:** AI-model Save 503 keeps the draft, the held save
  keeps a newer edit, and Clear works. Writes were `PUT` ×3 and `DELETE` ×1 on
  `ai_model` only.
- **`imap-port-validation` (the #376 fix on a phone):**
  - The Port input has `type=number`, `inputmode=numeric`, `min=1` and
    `max=65535`, and defaults to 993.
  - For `""`, `0`, `70000` and `99999999`, "Add mailbox" is disabled. "Enter a
    port from 1 to 65535" shows inside the viewport, and the input carries
    `aria-invalid="true"` with the message in `aria-describedby`.
  - A forced tap on the disabled button sent **0 POST**. Refilling 993 clears
    the error and enables the button.
  - "Add mailbox" is 272×42.5 at 320 (y 757.5) and 342×42.5 at 390, visible
    without scrolling.
- **`imap-add-refuse-retry-sync`:**
  - Port typed as `" 143 "`; Chromium's number input holds `143`.
  - A 400 refusal shows its toast and the sheet keeps host, mode and the
    21-character password.
  - A held retry disables the fieldset. A forced second tap and Escape do not
    dismiss the sheet, and exactly one more POST leaves.
  - On release: toast "Mailbox added — qa301@fixture.invalid", and the
    password is absent from the page HTML. "Sync …" (73×42.5) posts
    `…/connectors/50/sync`, and "last synced" appears.
  - Bodies carry `port: 143`. Non-GET: `POST /api/mailbox/connectors` ×2, then
    `POST /api/mailbox/connectors/50/sync`.
- **`oauth-start-return`:** a refused OAuth start shows a toast, does not
  navigate and re-enables the buttons. A same-origin stand-in URL with
  `?mailbox=connected` shows "Mailbox connected" and strips the query. 0
  non-GET.
- **`entity-create`:**
  - "＋ Add" is 80×42.5.
  - A 400 refusal keeps name and key. A held retry is not dismissed by Escape
    or a second tap, and exactly one more POST leaves.
  - On release: toast "Supplier added — QA 301 Supplier OÜ",
    `/settings/entities/44` shows the entity, and Back returns to the list,
    which now includes it.
  - Body as in the first run, with country `EE`. Non-GET: `POST /api/entities`
    ×2.
- **`device-enrollment`:**
  - The mint on mount was held: skeleton shown, no "Try again". The 500 then
    shows "The QR cannot be generated yet".
  - Save of `public_api_url`, then "Try again", gives a QR of 252 px at 320
    and 256 px at 390, within the width. The token is not in the page text.
  - Regenerate changes the `src`, and Clear shows "Stored value removed".
  - Non-GET: `POST /api/device-enrollments`, `PUT
/admin/settings/public_api_url`, `POST` ×2, `DELETE
/admin/settings/public_api_url`.
- **`landmarks-settings` (#378 on a phone):**
  - Exactly one `<main>`, with `padding-bottom` 95 px above the tab bar. The
    sidebar's `nav "Primary"` is not displayed at 320/390, and the tab bar's
    `nav` is.
  - Tab links Inbox/Books/Reports/Settings are 46–47×44 at y 792, inside the
    viewport. The "Mail intake" settings row has a 66 px hit height.
- **`route-recovery`:** `/settings/nope` renders "Not found … This address
  does not open a screen" with section links, and its "‹ Back" leads to
  `/inbox`. A reload of `/settings/mailbox` restores the screen. 0 non-GET.

Every toast measured was fully inside the viewport at y 16, 16 px from the
side.

### Not re-run, and why

- The Reports invoice-number correction (`fix-invoice-number`), and the
  first run's close refusal → retry → frozen state, were **not** re-run. Their
  scripts were not kept, and none of their source files changed between
  `d03c592` and `ea0b00c`. The first run's result stands for them, on the
  older build.

### Harness failures and corrections

- **Initial and run2, 12/14:** `entity-create` failed at both widths after the
  POST succeeded and the entity screen rendered. The harness waited for a
  heading "QA 301 Supplier OÜ" (initial), then for a heading "Entity" (run2).
  `EntityScreen` passes no `heading` to `ScreenHeader`, so the title renders
  as a `span`, not an `h1`. That was my wrong model. The screens without a
  heading are already recorded by the #302 report. The final run waits for
  the text "Entity" and the entity's name inside `<main>`.

### Observations (no defect claimed)

- **O2. A toast raised while a sheet is open cannot be touched.** The IMAP 400
  toast is drawn over the top of the sheet. At 320 it covers the sheet title
  for its lifetime, as the `imap-failure-320.png` screenshot shows. It is
  readable, but `elementFromPoint` at its centre does not return the toast. It
  cannot be tapped or swiped away until sonner's default timeout, because the
  app sets no close button (`closeButton={false}`). The sheet keeps the
  input, so nothing is lost.
- **O3.** Primary buttons are 42.5 CSS px tall, slightly under a 44 px goal and
  well over WCAG 2.5.8's 24 px. "‹ Back" on the Not-found screen is 51×22.5,
  already recorded as O3 in the #302 report.

### Limitations

These are the same as the first run's. In short:

- No physical device, OS keyboard, native download UI or real gestures.
  Escape stands in for a dismiss gesture.
- Only the fixed 844 px height was used.
- The OAuth provider round-trip was simulated on the same origin. The QR was
  not decoded.
- Mock semantics only. No server-side port validation (#376's controller
  change) was exercised.

Issue #301 stays **open** for the physical iOS/Android pass.

### Evidence (untracked, `.review-301/agent-evidence/` in this worktree)

- Scripts: `mobile-settings.mjs` (final), `mobile-settings.initial.mjs`, and
  copies of root's `reports.mjs` and `settings.mjs` (output path only
  changed).
- Results: `mobile-settings-results.json`, `-run2-results.json`,
  `-initial-results.json`, `reports-results.json`, `settings-results.json`.
- Logs: `mobile-settings-{initial,run2,final}.log`, `reports.log`,
  `settings.log`, `tsc.log`, `build.log`, `preview.log`.
- Screenshots per width:
  - `imap-port-invalid-cleared`, `imap-failure`, `mailbox-listed`,
    `entity-created`, `enroll-qr`.
  - `settings` (from `landmarks-settings`, which overwrote root's).
  - `downloads`, `closed-period`, plus the downloaded `download-{320,390}.{xml,csv}`.
  - `fail-entity-create-*` (from run2).
