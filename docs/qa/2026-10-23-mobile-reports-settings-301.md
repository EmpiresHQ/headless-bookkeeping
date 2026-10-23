# #301 — mobile Reports and Settings with real isolated domain effects

**No product defect was confirmed; no product code changed.** Real Chromium
mobile-emulated flows exercised Reports, invoice-number correction, Settings
Save/Clear and counterparty creation against an isolated backend. Browser files
were downloaded, parsed and checked against the pinned KMD XSD. Mailbox uses an
explicitly fake local IMAP service; device enrollment uses a simulated protocol
client, not a physical phone. **#301 remains OPEN for its physical-device and
real-provider requirements.** These limits are not converted into passes.

## Environment and data

- Fresh worktree `/root/.cache/hbk-worktrees/issue-301`, base
  `eb92556f578f410ad5eed4be0a79d879e6a0b164` from `origin/main`.
  Branch **`qa/301-mobile-reports-settings-rerun`**: the prescribed name was
  already owned by the old September `hbk-ui-301` worktree, which was preserved.
- Own dependencies, DB, browser contexts, test CA and helper ports. **Node24.21.0**
  explicitly used throughout. Nothing in the dirty original checkout or #420
  worktree/dependencies/processes was changed. Expense creation idempotency was
  not edited or evaluated as part of this QA.
- Fresh production `tsc -b && vite build` and Nest build. Web index SHA256:
  `8964d03fe3262e31c4cd54d2d70a03c2dccf140c60022cf8abf277b6169d63dc`.
  Logs: `web-build.txt`, `server-build.txt`.
- Chromium **153.0.8010.12**, Playwright **1.63.0**, Linux headless,
  **320×844 and390×844 CSS px**, DPR1, mobile/touch emulation. Local Adwaita
  fonts/libraries; no physical device, OS keyboard, Safari or native download UI.
- Real Nest/SQLite API on **4301**, production SPA/static proxy on **5301**.
  Requests go over real loopback HTTP. Other browser HTTP origins are blocked;
  none were attempted. No response fixtures replace normal application reads or
  writes. One warning-read503 is explicitly injected below.
- Synthetic fixture bootstrap writes only a local auth token in SQL; organization,
  supplier, periods, Expenses, posting and approvals use normal REST/domain paths.
  `fixtures.json` records IDs and exact amounts. All company/person/credential
  values are **SYNTHETIC**, never copied from production. Registry/VAT format
  examples come from the repository's existing statutory-report test fixture,
  not from a live business-register lookup.

| Synthetic fixture                | Value                                                                       |
| -------------------------------- | --------------------------------------------------------------------------- |
| Organization                     | EE, VAT-registered, `SYNTHETIC QA301 OÜ`; registry17499653                  |
| Supplier                         | `SYNTHETIC 301 Supplier OÜ`, services, taxable business                     |
| Earlier period                   | Existing seeded `2024-Q1`, initially open and empty                         |
| August2026                       | Expense1, Voucher1: net2000.00 EUR, VAT480.00, gross2480.00                 |
| September2026                    | Expense2, Voucher2: net3000.00 EUR, VAT720.00, gross3720.00                 |
| Initial supplier invoice numbers | Missing on both posted Expenses, so INF correction is actionable            |
| UI-created counterparties        | `SYNTHETIC QA301 Counterparty 320` and `390`                                |
| Mailboxes                        | Two fake `synthetic-*@fixture.invalid` users on127.0.0.1:14301, empty INBOX |

Only these local periods were closed. After QA, backend contains3 locked periods,
3 VAT snapshots,3 filing payloads and3 prepared submission events. There are still
only2 Expenses and2 posted Vouchers; invoice-number changes preserve their Voucher
IDs and amounts. Entities total3; mailbox connectors total2; Documents0; settings
are empty after Clear; foreign-key check returned no violations. See
[backend-after.json](issue-301/backend-after.json). No production books, remote
mailbox, real device, real tax submission or external AI ingestion was used.

## Reports — actual mobile UI and real domain effects

At each width, Reports list → August/September2026 → period detail:

1. The page showed the real KMD/INF gap. The supplier row opened the number
   sheet; Save number PATCHed `  SYNTHETIC301-2026-08-INV-001  ` (September09).
   The backend stored the trimmed value, the sheet closed and the gap disappeared.
   The Expense remains posted with its original Voucher and figures. Both PATCHes
   completed during the initial run; resumed Reports verified persistence instead
   of submitting duplicate corrections.
2. XML and CSV were obtained through real browser download events, with
   `failure() === null` and server suggested names
   `kmd-2026-08.xml/.csv` and `kmd-2026-09.xml/.csv`. Draft and frozen artifacts
   are retained as files; XML861bytes, CSV143bytes for each period.
3. Earlier-period gating was real: Close was absent while2024-Q1 was open, with
   `File Q1 2024 first`. The320 follow-up navigated to that period, typed its
   name and closed it through the actual UI, then returned to August. No UI or
   server chronology guard was bypassed.
4. Related #255,320 only: while opening August's Close sheet, Playwright returned
   **one explicitly synthetic unavailable warning-read503 condition**. The typed
   name remained, Close was disabled, Retry was available and an incomplete-check
   acknowledgement was offered unchecked. The test did not acknowledge missing
   checks. Removing the fault and pressing Retry completed the real checks and
   enabled Close. Other reads/writes remained real HTTP throughout.
5. Typing the actual period name and pressing Close & freeze locked August,
   then September on390. Backend `status=locked` and non-null snapshot bindings
   agree with the UI's frozen banner; Close disappears. The sheet's button was
   reachable by scrolling, fully visible and center-hit at both widths.
6. Frozen XML/CSV were downloaded, and a second frozen XML download matched the
   first byte-for-byte for each period. This is replay of real local frozen
   payloads, not a mock returning a fixed string.

### Independent file checks

[check-files.py](issue-301/check-files.py) uses Python XML parsing and semicolon
CSV parsing against the exact fixture expectations. All10 downloaded artifacts
match: year2026/month8 or9; declarant registry17499653; input VAT480.00/720.00;
invoice sums2480.00/3720.00; corrected invoice numbers; UTF-8 supplier name with
`OÜ` intact. CSV has actual CRLF,2 record types (`KMD6` header with17fields,
`B` purchase row with8), not escaped literal newline text. Hashes are in
[file-checks.json](issue-301/file-checks.json).

[check-xsd.cjs](issue-301/check-xsd.cjs) additionally validated all6 XML files
against `packages/server/test/fixtures/vatdeclaration.xsd` using local libxmljs2:
**6/6 valid, zero validation errors**. Schema SHA256
`51cf0546c2ea48be7660e3be4f918a4fb61d60193aa76e047fc759198cd1b17d`.
This checks the pinned schema and fixture values; it is not an e-MTA upload or
acceptance result, and exercises only this simple EE purchase scenario.

## Settings — actual persistence and local integration boundaries

### Organization and counterparty, both widths

Organization Name changed to `SYNTHETIC QA301 saved organization <width>` via
**Save organization**. Reload and an independent GET returned that value. Country,
VAT basis and other financial settings were not altered after posting.

Settings → Entities → Add entity created a supplier with country typed `ee`,
registration key `SYNTHETIC301-<width>-REG`, services/taxable business. The real
backend returned a new ID, the app navigated to its detail, country persisted as
`EE`, and the exact synthetic name was present. No duplicate-click/idempotency
claim or #420 change is involved. Both runs passed on the first attempt.

### Save/Clear and device protocol, both widths

On `/settings/enroll`, unset `public_api_url` produced the real backend500 and
visible configuration guidance. Typing the local dev URL5301 showed **Unsaved
edit — Save stores this field only**. Save persisted the override and displayed
Saved; independent GET agreed. Clear removed it, displayed **Stored value
removed**, and GET correctly returned **200 with `value:null`**. Regenerate after
Clear returned the unconfigured guidance again. These are actual Settings writes,
not mocked success or an assertion that a missing key returns404.

Try again and Regenerate each produced an actual enrollment QR. At both widths
the PNG was decoded through canvas/jsQR; version1 and the local API address
matched the contract, and the decoded enrollment token was exchanged against the
real backend. The final390 harness additionally waits for the new response and
new image and compares its decoded token to that response. Plaintext tokens are
not stored in evidence. For each of the two QR generations per successful
case, an explicitly simulated HTTP client then:

- Exchanged the enrollment token for a session: **201**.
- Reused that enrollment token: **401**, as intended for one-time use.
- Read organization with the session: **200**.
- Revoked the session: **204**; a subsequent read returned **401**.

Final evidence retains enrollment fingerprints and statuses, not access tokens.
Screenshots of the successful QR are taken after consumption/session revocation.
Across all attempts9 sessions were created and all9 revoked; extra enrollments
from partial runs remain local ephemeral test records. This is **not camera
scanning, a real app installation or physical device connection**. The QR PNG
source was decoded, not photographed from the rendered screen.

### Mailbox, both widths

Actual Add IMAP forms were submitted to the backend; empty Port disabled Add.
Port14301, loopback host, fake credentials and email_sync were used. A fake
**TLS IMAP server bound only to127.0.0.1** accepts a synthetic account and exposes
an empty INBOX. Its self-signed test CA is trusted only by this backend via
`NODE_EXTRA_CA_CERTS`; TLS verification was not globally disabled. The mailbox
secret key is local test configuration, not production configuration.

The real backend encrypted/stored each connector, connected to the fake service
and Sync finished. Backend status is `connected`, `last_synced_at` is populated,
`last_error=null`; no messages/attachments were offered, so no Documents were
created. The fake server records command names only, not authentication payloads:
[imap-observation.json](issue-301/imap-observation.json). Its live logs are local;
this committed snapshot is frozen. Fake behavior is intentionally limited, not a
claim about Gmail/Outlook authentication, real MIME ingestion or live mailbox
interoperability.

Connect Gmail was also clicked. The real unconfigured OAuth start returned400
and stayed on the page with guidance. **No OAuth consent/callback round-trip was
performed**; no real provider credentials or mailbox were connected. Both mailbox
cases passed on their initial run.

## Measured mobile geometry

Bounding boxes were sampled after sheet movement settled and after scrolling
controls into view. Every table entry was inside the viewport, center-hit and
had no page horizontal overflow at measurement. These are observed controls,
not a universal touch-target or whole-app accessibility audit.

| Control             | 320×844             | 390×844             |
| ------------------- | ------------------- | ------------------- |
| Close & freeze      | 272×65px, bottom808 | 342×65px, bottom808 |
| Save organization   | 260×42.5px          | 330×42.5px          |
| Add supplier        | 272×42.5px          | 342×42.5px          |
| Add mailbox         | 283×42.5px          | 342×42.5px          |
| Device Save / Clear | 68×42.5 /77×42.5px  | 68×42.5 /77×42.5px  |
| Rendered QR         | 252×252px           | 256×256px           |

Screenshots include earlier-period/proof gates, frozen periods, created entities,
connected fake mailboxes and consumed enrollment QR/cleared configuration states.
No real OS keyboard, native file picker/download manager, touch drag, physical
screen or spoken screen-reader output was tested.

## Run history, failures and limits

Raw run outputs are preserved separately; failures are not overwritten into
passes:

| Artifact                                       | Actual outcome                                                                                                                                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initial-results.json` / `initial-run.txt`     | 4/8 passed: organization+counterparty and mailbox at both widths. Reports had already saved numbers/downloaded drafts but wrongly expected Close before the earlier period; Device had completed protocol exchange but wrongly expected404 after Clear. |
| `remaining-results.json` / `remaining-run.txt` | 3/4 passed: Reports at both widths and Device320. Device390 decoded a stale already-consumed QR immediately after Regenerate and got401; this was a harness synchronization error.                                                                      |
| `device390-final.json` / `device390-final.txt` | 1/1 passed: only Device390 retried, waiting for both the new enrollment response and image. Successful other scenarios were not repeated.                                                                                                               |

These artifacts together verify all8 bounded flow/viewport combinations. There
was **no single invented all8-pass execution**. Browser page errors and attempted
external browser origins were empty in every run. Expected HTTP failures are
recorded: unconfigured enrollment500, unconfigured OAuth400, replay/revoked
session401, and the explicitly injected warnings503. The initial wrong Close,
Clear-status and stale-QR assumptions are not product findings; archived initial
runner variants/failure shots are in this worktree's `.qa-tools/archive/`.

No confirmed in-scope product defect means no fix or linked-defect draft was
manufactured. The remaining material limits are physical iOS/Android browser,
real native download UI, actual device app/camera use and real-provider OAuth/
mailbox behavior. **#301 should remain OPEN for those physical/integration checks.**
The coordinator owns independent Standards/Spec review, publication, CI, merge,
deploy and issue status. Worker did not push, publish, merge, deploy or close.

## Reproduction

Evidence/scripts/files are in [issue-301/](issue-301/); `MANIFEST.sha256` records
hashes. Use Node24 and fresh own data/dependencies only. The server builds and
browser observations are the task checks; no unrelated unit/full suite was run
because product code is unchanged. Script syntax, formatting, independent file
checks and manifest verification were performed.

From repo root, select Node24, run `npm ci`, install browser helpers with
`npm install --prefix .qa-tools playwright@1.63.0 jsqr@1.4.0`, and build the web
and server workspaces. Use your own available Chromium libraries/fonts. Generate
a local test TLS identity (private key stays ignored):

```sh
mkdir -p .qa-tools .qa-data
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout .qa-tools/imap-key.pem -out .qa-tools/imap-cert.pem \
  -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1 -days 2
node docs/qa/issue-301/fake-imap.cjs
# Separate shell; this key is a known local-only fixture, never production:
DATA_DIR="$PWD/.qa-data" PORT=4301 \
NODE_EXTRA_CA_CERTS="$PWD/.qa-tools/imap-cert.pem" \
MAILBOX_SECRET_KEY=3030303030303030303030303030303030303030303030303030303030303030 \
node packages/server/dist/main.js
# After migrations, a separate shell:
node docs/qa/issue-301/seed.cjs "$PWD/.qa-data/app.sqlite"
node docs/qa/issue-301/serve.cjs
# Separate shell, with matching Node24 and local browser libs/fonts:
FONTCONFIG_FILE="$PWD/.qa-tools/fonts.conf" \
LD_LIBRARY_PATH="$PWD/.qa-tools/libs/usr/lib" \
node docs/qa/issue-301/browser.cjs
python docs/qa/issue-301/check-files.py
node docs/qa/issue-301/check-xsd.cjs
```

Do not seed an existing or production DB. The final harness supports `ONLY`,
`WIDTH` and `REPORT` for a failed case on existing fixtures; Reports detects an
already saved invoice number. A completed locked-period run itself requires
fresh data to repeat its close operation. The fake IMAP helper writes live events
under `.qa-data`; snapshot them separately to keep committed evidence immutable.
