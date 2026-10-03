# QA-011: Switching documents while a preview loads (issue #304)

## Re-run on `main` `4f583f4` (2026-09-24, after #303 and #378)

A second, independent pass over the same question, on current `main`
(`4f583f4`, which includes the #303 fast-search fix and the #378 app-shell
landmarks). The first run's harness was never committed and was gone, so
a new one was written and is now committed under
`.review-304/rerun-2026-09-24/h/`. **Mocked and read-only:** every `/api`
request was answered by a Playwright route mock and every `/preview` by an
in-page `fetch` mock. The static server has no proxy, so no request could
reach a real backend. The only writes were mocked
`POST /api/documents/:id/complete` (79 per build); 0 held, 0 unhandled, 0
page errors. **Native iOS, Safari/WebKit, Firefox and physical devices were
not run.**

### Verdict

| Check                                                                     | Result                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A preview of another object is ever visible (S1–S13, 3 viewports)         | **Pass**, both builds. 0 wrong-object samples in 23 975–24 266 image checks over ~11 450 rAF frames per build (blob identity and decoded-pixel identity both checked)                  |
| Stale late answers (thumb and lg)                                         | **Pass**. Revoked 0–1 ms after creation, never placed in an `<img>` (checked with a per-URL "shown" flag)                                                                              |
| Errors on the new fetch are surfaced (500, 404, network error, bad bytes) | **Pass**. The row says "preview failed to load" / "no preview"; the lightbox says "The preview couldn’t be loaded." + Retry, or "No preview is available…"; Retry recovers             |
| Object URL cleanup                                                        | **Pass**. 1415 of 1415 created URLs revoked per build after leaving through the app; 0 live                                                                                            |
| **D1** Books › Documents persistent broken image                          | **Reproduced on `4f583f4`** (row 32002 broken in 20 of 20 sampled frames at every viewport). **Fixed in this commit**: after the fix the row shows the fallback glyph, 0 broken frames |
| **D2** one painted frame of a broken `<img>` before the error state       | **Still present, not fixed** (see below): unchanged by this commit                                                                                                                     |
| #303 fast search (`?q=`-bound) and #378 landmarks                         | **No regression**. 12 of 12 typing runs intact per build; 1 `main` everywhere and the desktop `Primary` nav                                                                            |

### Set-up

- **Builds:** `vite build` of `packages/web` at `4f583f4` ("before",
  `index.html` sha256 `26d5c9e…8886`, `index-BVh8m1g_.js`) and the same
  tree with the D1 fix ("after", `1fd7cb2…fbf`, `index-DpiddmlL.js`).
  They were served by `.review-303/h/serve.mjs` (static, no `/api` proxy) on
  `127.0.0.1:5374` and `127.0.0.1:5375`. Both servers are stopped. Worktree
  `node_modules` is an ignored symlink to an existing install. There was no
  `npm install`.
- **Browser:** Playwright 1.63.0, headless Chromium (`chromium_headless_shell-1243`),
  `--no-sandbox`. Viewports: **1440×900** and **1920×1080** desktop (DPR 1, no
  touch), and **390×844** mobile emulation (`isMobile`, touch, DPR 3). One
  browser at a time. The final before and after runs were made back to back
  on an otherwise idle machine. Linux, Intel Core i5-7400T (4 cores),
  7 GB RAM, Node 24.21.0.
- **Fixtures:** triage documents `31001`–`31006` (`31001`–`31030` for the
  soak), reasons `low_confidence` / `category_unresolved`, file names
  `qa-doc-<id>.pdf`. Archive documents `32001`–`32003` for Books. No
  real financial data.
- **Preview mock (`inpage.js`):** per `<id>:thumb|lg`, a FIFO plan of `ok`,
  `500`, `404`, `neterr` (a rejected fetch), `broken` (200 `image/png`, not a
  PNG) or `slowbody` (headers at once, body trickled over 200–1500 ms), with
  an optional delay and/or a gate that the harness releases. An `ok` body is
  a PNG whose width encodes the document (thumb 60 + id % 100, lg 600 + id % 100),
  with the request's identity appended after `IEND`.
  - Plans are added only after the Inbox list has made its own thumb
    requests. Otherwise the list would consume them. This was found in the
    first dev run.
- **Monitor:** on every rAF (pre-paint), DOM mutation and image
  `load`/`error`, every `blob:` `<img>` is checked. The expected document
  for each image is:
  - in a lightbox, the document it was opened for;
  - in a list row, the row's single document link;
  - otherwise, the rendered `h1` file name (not the URL).

  A failure is one of three things: a different object by blob marker, a
  different object by pixel width, or a URL revoked before the image
  decoded. Broken images are counted only at rAF samples.

### Timing and fault matrix (every case at every viewport, both builds)

| Case | What                                                                                                                                                    | Faults / timing                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| S1   | Slow thumb of A; Archive moves the same screen to B; A answers after the switch, then B                                                                 | Gates                                                   |
| S2   | A→B→C→D in ~425–440 ms; answers B, D, then C after D                                                                                                    | Gates, out of order                                     |
| S3   | Slow lg: open, close, reopen while pending (still 1 lg request), answer while open, reopen shows lg on the first frame                                  | Gate                                                    |
| S4   | A's lg pending when the row switches to B; B opened with thumb and lg pending; A answers late                                                           | Gates                                                   |
| S5   | New document's thumb and lg 500 (600 ms) → Retry; next 404; next network error                                                                          | 500 / 404 / `neterr`                                    |
| S6   | New document's thumb and lg undecodable → Retry; next lg undecodable with thumb ok                                                                      | `broken`                                                |
| S7   | Inbox list lightbox (`DocThumbLightbox`): open A, close, open B, A's lg answers, reopen A (refetches)                                                   | Gates                                                   |
| S8   | Books › Documents, row 32002 undecodable (D1)                                                                                                           | `broken`                                                |
| S9   | **New.** Leave and re-enter by Back/Forward with thumbs pending (unmount/remount); Back while the lightbox is open closes only the lightbox             | Gates                                                   |
| S10  | **New.** Slow body download across a switch and across close/reopen of the lightbox                                                                     | `slowbody` 600–1500 ms                                  |
| S11  | **New.** Seeded soak: 40 random actions (advance, open, close, Back, leave and re-enter) with no settling, over 30 documents, random per-request faults | `ok`/`slowbody`/`500`/`404`/`broken`/`neterr`, 0–500 ms |
| S12  | #378 landmarks on `/inbox`, `/inbox/doc/:id`, `/books`; #303 typing into Inbox and Books search at 0 and 30 ms per key                                  | —                                                       |
| S13  | D2 repeat: 25 cycles of open document (thumb `broken`) + open preview (lg `broken`)                                                                     | `broken`, 50–210 ms                                     |

All scripted assertions passed on both builds, except S8 on "before" (D1).
Selected values (after, 1440):

- **Stale answers:** S1 A revoked 0 ms after creation; S2 B/C 1 ms; S4 A's lg 0 ms; S10 A's slow body 0 ms. None was ever shown.
- **S3:** 1 lg request over two opens; the first frame after reopen is the lg (601 px).
- **S5:** "loading preview" → "preview failed to load", then Retry → lg. 404 → "no preview" / "No preview is available for this document. You can still try Open original.". A network error → "preview failed to load".
- **S9:** Back with the lightbox open stayed on `/inbox/doc/31004` and closed the preview.
- **S11:** it settled on the last document, with that document's own thumb (1440: 31030, 1920: 31027, 390: 31028).
- **S12:**
  - **Search:** the field and `?q=` were intact for `qa-doc-31004` and `Põhja-Eesti 1234.56` at 0 and 30 ms per key.
  - **Landmarks:** 1 `main` on every page, plus the `Primary` nav on desktop. On mobile the only nav is the unnamed tab bar (#378 names the desktop nav).

Rendered `<img>` samples with a broken image at a painted frame:

| Build  | Viewport  | S6           | S8 (D1)      | S11 (Inbox list row 34×34) | S13 row thumb / lightbox (cycles of 25) |
| ------ | --------- | ------------ | ------------ | -------------------------- | --------------------------------------- |
| before | 1440×900  | 1 (lightbox) | **20 (all)** | 0                          | 4 / 3                                   |
| before | 1920×1080 | 1 (lightbox) | **20 (all)** | 2                          | 3 / 2                                   |
| before | 390×844   | 1 (row)      | **20 (all)** | 0                          | 6 / 1                                   |
| after  | 1440×900  | 0            | **0**        | 0                          | 1 / 6                                   |
| after  | 1920×1080 | 1 (lightbox) | **0**        | 1                          | 2 / 2                                   |
| after  | 390×844   | 0            | **0**        | 0                          | 4 / 1                                   |

### D1: fixed (`packages/web/src/books/DocThumb.tsx`)

`DocThumb` now has an `onError` handler. Bytes that download but do not decode switch the row to
its fallback (the built-in glyph, or the caller's `fallback`), as
`DocPreviewRow` and `DocThumbLightbox` already do. The result is also
bound to the `id` it was fetched for, so the latent "previous id's image
while the new one loads" case (first report, D1 note) cannot happen either.
Regression tests in `DocThumb.test.tsx` cover the glyph fallback, the custom
fallback and the id switch. All 3 fail on the unfixed component and pass
with the fix. In the browser, row 32002 now shows the glyph at all three
viewports (screenshots `before-`/`after-s8-books-documents-*.jpg`).

### D2: still open (suggested P4, follow-up, not fixed here)

D2 was reproduced again on both builds. Undecodable bytes produce a broken `<img>`
for about one painted frame before `reportBroken` swaps in the error state:

- **S13:** 1–6 of 25 cycles per surface.
- **Soak and list:** once or twice in the S11 soak, including the Inbox list thumbnail (`DocThumbLightbox`, 34×34), which the first report had not seen.
- **Books row (after the fix):** `DocThumb`'s new fallback has the same one-frame window in principle. It was not observed there (0 of 3 viewports).

The final state is always the correct error + Retry. A fix belongs in the shared
`usePreviewObjectUrl` (decode before `ready`, or keep the `<img>` hidden
until `load`). That is wider than this QA pass and touches every preview
test, so it is left as a follow-up. No issue was filed.

### Harness notes (not product)

- **S2 timing flake.** In the first full "before" run, S2 failed its old
  "revoked within 1 ms" assertion at 1440 and at 390; the per-URL detail
  was not recorded. A concurrent `vitest` run later gave 2–3 ms. In every
  such run the monitor saw 0 wrong-object samples. The assertion is now
  "revoked and never shown in an `<img>`". S2 then passed 15 of 15 extra
  runs and the final runs.
- **Same-instance check.** The S1 check (does the same Source row node survive the advance?) did not find the row with this
  harness's selector (`sameNode: false` means "untagged", not "remounted"). So this run
  does not re-establish that the same `DocPreviewRow` instance was reused.
  The first report did.
- **Under load.** While `vitest` ran in parallel, four long Inbox/router
  tests timed out (52–229 s). Run alone, the same files pass, and the full
  suite passes (below).

### Observations (not defects)

- **O3 (mobile 390×844).** In the lightbox, the dimmed page and the tab bar
  show through behind the bottom status line. After a queue advance, the
  "Archived without booking" toast sits above the open lightbox
  (`after-s5-error-retry-390x844m.jpg`). This is cosmetic and outside this
  issue.
- O1 (stale requests are not aborted) and O2 (the thumb → lg swap) from
  the first run still apply. The code is unchanged.

### Checks

`packages/web`: `vitest run` 146 files, 1489 tests passed (run alone);
`tsc -b` clean; `eslint` and `prettier --check` clean on the changed files.

### Limits (untested)

- **Scope:**
  - Real backend and real corrupt or partial PNGs; HTTP/1.1 connection limits.
  - `ApprovalScreen` and `books/DocumentScreen` previews were not driven separately. `DocumentSourcePane` was not driven.
  - Sign-out during a pending preview.
- **Environment:** WebKit/Safari, Firefox, native iOS, physical devices. Mobile was Chromium emulation only.

### Evidence

`.review-304/rerun-2026-09-24/`:

- the harness `h/`;
- `final-before.log` and `final-after.log`;
- `summary-*.txt`;
- `final-*-compact.json` (per-case steps, request start/settle, URL counters, monitor results);
- `shots/`.

Full results with per-frame timelines and both builds are kept locally in
`.review-304/work/` (untracked).

## First run (main `db30995`)

The sections below are the original run, kept as recorded. D1 is fixed by
the re-run above. D2 is still open.

This was a verification task, not an assumed bug. The run was a bounded,
mocked Chromium matrix at **1440×900** and **1920×1080** CSS px, DPR 1, on
`main` `db30995`. No product code, tests, configs or app assets were changed.
**No real backend was involved.** Every `/preview` request was answered by an
in-page `fetch` mock with explicit gates, so it resolved exactly when the
harness said. Every other `/api` request was answered by a Playwright route
mock. The only writes were mocked `POST /api/documents/:id/complete` (Archive
without booking), used to move the queue to the next document. **Native iOS is
out of scope for this issue and was not run. No physical device and no
Safari, Firefox or Edge were used.**

Related closed issues: UI-026 #270 (loading, unavailable and error told apart)
and UI-027 #271 (object URL kept after a document switch). This run checks
their fixes in a real browser.

## Verdict

| Area                                                                                             | Status                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slow thumb, then the same screen switches to another document before the answer (S1)             | Run, 1440 + 1920. **Pass**. The late answer's object URL is revoked in the same ms. It is never shown                                                                                                      |
| Fast switching A→B→C→D, answers out of order (S2)                                                | Run, 1440 + 1920. **Pass**. Only D is ever shown. Stale B and C are revoked on arrival, including C arriving after D                                                                                       |
| Slow lg: close and reopen while pending, answer while open, reopen after (S3)                    | Run, 1440 + 1920. **Pass**. One lg request per opened document. The thumb is the placeholder. A reopen shows the cached lg on its first frame                                                              |
| lg of A still pending when the row switches to B; B opened with thumb + lg pending (S4)          | Run, 1440 + 1920. **Pass**. A's late lg never enters B's lightbox and is revoked at once                                                                                                                   |
| Error on the new document's fetch (500), Retry, then 404 (S5)                                    | Run, 1440 + 1920. **Pass**. There is no image from A. The UI shows "preview failed to load", then "The preview couldn't be loaded." with Retry, and Retry recovers. A 404 shows "No preview is available…" |
| Inbox list thumbnails (`DocThumbLightbox`): open A, close, open B, A answers late, reopen A (S7) | Run, 1440 + 1920. **Pass**. B's lightbox is unaffected. Reopening A refetches lg, with the thumb placeholder, never a revoked URL                                                                          |
| "A preview from another object is never visible" (all cases)                                     | **Pass**. 0 wrong-object samples in 3 203 checks and 2 043 frames (main matrix), plus 1 546 frames (repeat run)                                                                                            |
| Object URL cleanup                                                                               | **Pass**. Every URL created was revoked after leaving through the app: 134 of 134 in the main matrix (both widths), and 3 of 3 per S8 run                                                                  |
| Undecodable preview bytes (200 `image/png`), Inbox preview row and lightbox (S6 + repeat)        | **Confirmed minor defect D2.** The `<img>` becomes the Retry/error state, but a broken `<img>` was sometimes present at a painted frame first: 5 of 100 repeat cycles, and 1 of the 2 final S6 runs        |
| Undecodable preview bytes, **Books › Documents** archive rows (S8)                               | **Confirmed defect D1.** A **persistent** broken-image icon (screenshot)                                                                                                                                   |
| Real backend, real corrupt/slow previews, HTTP/1.1 connection limits, slow body read             | **NOT TESTED** (see Limits)                                                                                                                                                                                |
| Native iOS, other desktop browsers, physical devices                                             | **NOT TESTED**                                                                                                                                                                                             |

**Confirmed product defects: D1 (suggested P3) and D2 (suggested P4).** Both are about undecodable preview bytes,
not about the switch race itself. **The race the issue asks about (a preview
from another object) was not reproduced.** Per the instructions for this task, **no
follow-up issues were filed**. The drafts under Findings are ready for a
maintainer to file.

## Set-up

- **Build:** a fresh production build of `packages/web` at `db30995`:
  `vite build --outDir ../../.review-304/dist` (exit 0, 7.0 s). `index.html`
  sha256 `0088245…f430`; `assets/index-B89dC_Y3.js` sha256 `3a68762…37fb`.
  These are byte-identical to the QA-010 build (`f83cee8`), because the commits between are docs-only. The build
  was served by `vite preview` on `127.0.0.1:5372` (`REVIEW_BASE`) and
  stopped afterwards. Port 5372 is free, and no Chromium process is left.
  - `vite.config.ts` resolves `pdfjs-dist` from `packages/web`, and this
    worktree had none. An **ignored** symlink
    `packages/web/node_modules/pdfjs-dist` → the existing
    `/tmp/hbk-ui-257/.review-257/pdf-deps` install fixed it. QA-010 used the
    same fix. There was no `npm install`.
  - `vite preview` proxies `/api` to `localhost:3000`, which has a live
    server on this host. The harness answered **every** `/api` and `/admin`
    request itself and aborted other origins. Nothing was proxied. (`networkPreview` = 0 in
    every case, so no `/preview` request reached even the route layer.)
- **Browser:** Playwright 1.63.0 with bundled headless Chromium 153.0.8010.12
  (`chromium_headless_shell-1243`), `--no-sandbox`, desktop contexts, no
  touch, DPR 1. Env: `TMPDIR=/root/.cache/hbk-browser-tmp`,
  `LD_LIBRARY_PATH=/tmp/hbk-browser-libs/root/usr/lib`,
  `FONTCONFIG_FILE=/tmp/hbk-browser-libs/fonts.conf`. One browser at a time.
- **Machine:** Linux, Intel Core i5-7400T @ 2.40 GHz (4 cores), 7 GB RAM,
  Node 24.21.0. App: React 18.3, react-router 7.

### Fixtures and mocks

- **Documents:** 6 triage items `31001`–`31006` (reason
  `low_confidence` / `category_unresolved`, all with "Archive without
  booking") and 3 archive documents `32001`–`32003` (S8 only).
- **Preview mock (`inpage.js`, injected before the app):** `window.fetch`
  answers `/api/documents/:id/preview[?size=lg]` in the page. Each request
  takes the next step of a per-key plan (`<id>:thumb` or `<id>:lg`): `ok`,
  `500`, `404` or `broken` (200 `image/png` whose body is the text `this is not a png`),
  with an optional fixed `delay` and/or a **gate** that the harness releases
  explicitly. Without a plan, the request answers `ok` at once. An `ok` body is a PNG drawn on
  an OffscreenCanvas whose **width encodes the identity**: thumb = 60 + id % 100,
  lg = 600 + id % 100 px (the id and variant are also printed on it).
- **Identity tracking:** `URL.createObjectURL` / `revokeObjectURL` are
  wrapped. Each blob URL is mapped to `{id, variant, request seq}` with
  its create and revoke times (`performance.now()` ms since document start).
- **Monitor:** every `<img>` is checked on every `requestAnimationFrame`
  (pre-paint), on every DOM mutation and on every `load`/`error` event.
  The expected document for each image is:
  - in a lightbox, the document it was opened for;
  - in an Inbox row, that row's link;
  - elsewhere, the filename the screen currently renders (not the URL, see
    Harness issues).

  A failure at **any** checkpoint is one of three things: a different
  object by blob map, a different object by decoded pixel width, a blob URL
  the mock did not create, or a URL revoked before the image decoded. A
  broken image (`complete && naturalWidth === 0`) counts as a failure only
  when a **rAF sample** sees it, because no task can run between rAF
  callbacks and that frame's paint. A broken image seen only at a DOM or
  event checkpoint is recorded but not failed.

- **Same-instance check:** before each queue advance, the harness tagged the
  "Source document" row node. It was the same node after the advance in
  S1, S2 and S4, at both widths (logged in S1/S2, asserted in S4). So the **same** `DocPreviewRow` got the new
  `documentId` (the issue's scenario), not a remount.

## Steps and exact timing (1440; 1920 identical assertions, all passed)

Times are ms since the page's document start. `#n` is the preview request
number in that context.

| Case | Steps                                                                                                                                                                                                                                                                                            | Requests (start → settle)                                                                                          | Object URLs (created / revoked)                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| S1   | Open 31001 from the Inbox (thumb gated), so the row shows the "loading preview" placeholder. At ~906, Archive moves to 31002 (thumb gated). At 965, release A. At 1208, B still shows the placeholder. Release B: B's thumb                                                                      | #7 31001:thumb gate 510 → 939; #8 31002:thumb gate 922 → 1192                                                      | #7 944 / **944**; #8 1197 / 1551 (on leaving)            |
| S2   | From 31001 (shown), 3 archive advances in 508 ms wall-clock to 31004, every thumb gated. Release B (stale), then D (current), then C (stale, after D)                                                                                                                                            | #8 31002 500 → 890; #10 31004 870 → 1142; #9 31003 654 → 1426                                                      | #8 901 / **901**; #10 1153 / 1768; #9 1435 / **1435**    |
| S3   | 31001 lg gated. Open: thumb + "Loading full-size preview…". Close, reopen: still 1 lg request. Release while open: lg. Close, reopen: lg on the first frame, still 1 request                                                                                                                     | #8 31001:lg gate 421 → 1098                                                                                        | #8 1122 / 1611 (on leaving)                              |
| S4   | 31001: open, lg gated, close. Archive to 31002 (thumb + lg gated). Open: "Loading preview…", no image. Release A's lg (1200): unchanged. Release B's thumb: placeholder + note. Release B's lg: lg                                                                                               | #8 31001:lg gate 435 → 938; #9 31002:thumb 641 → 1243; #10 31002:lg 682 → 1516                                     | #8 950 / **950**; #9 1246 / 1911; #10 1532 / 1911        |
| S5   | Archive to 31002: thumb 500 after 600 ms, so "loading preview" → "preview failed to load". Open: lg 500 after 600 ms, so "The preview couldn't be loaded." + Retry. Retry: "Retrying…", then thumb + lg (300 ms each). Archive to 31003: 404 → "no preview" / "No preview is available…" + Retry | #8 thumb 500 507 → 1107; #9 lg 500 1177 → 1777; #10 thumb ok 2135 → 2435; #11 lg ok 2135 → 2436; #12/#13 31003 404 | #10 2448 / 2927; #11 2457 / 2927 (switch to C)           |
| S6   | Archive to 31002: thumb `broken` after 200 ms, so "preview failed to load". Open: lg `broken` gives the error + Retry. Retry: lg ok. Archive to 31003: thumb ok, lg `broken` → "The full-size preview couldn't be loaded — showing a smaller one." with the thumb shown                          | #8 thumb broken 522 → 722; #9 lg broken 1059 → 1260; #11 lg ok 1595 → 1795; #13 31003:lg broken 2317 → 2518        | all 13 revoked; broken URLs revoked on retry/switch      |
| S7   | Inbox list: open 31001's thumb (lg gated), close. Open 31002's (lg gated). Release A's lg: B unchanged. Release B's lg. Close. Reopen 31001: new lg request (gated), thumb + note. Release: lg                                                                                                   | #7 31001:lg 280 → 909; #8 31002:lg 660 → 1167; #9 31001:lg 1559 → 1579                                             | #7 934 / **934**; #8 1187 / 1519 (close); #9 1593 / 1899 |

Bold revoke times equal their create times: a stale result is turned into
a URL and dropped in the same callback. It is never set as an `<img>` src.

Mocked writes per width: S1 1, S2 3, S4 1, S5 2, S6 2 `POST …/complete`.
There were 0 page errors in every case.

Screenshots: `s3-lg-loading-1440.jpg`, `s4-after-stale-lg-1440.jpg` (B's
lightbox after A's late lg: still only "Loading preview…"),
`s5-error-retry-1440.jpg`, `s8-books-broken-thumb-1440.jpg`.

## Findings

### D1: Books › Documents rows show a persistent broken image (confirmed, suggested P3)

- **Where:** `packages/web/src/books/DocThumb.tsx` (used by
  `books/DocumentsSegment.tsx`). The component sets `src` from the fetched
  object URL. It has **no `onError`** and catches only fetch failures
  (`.catch(() => undefined)`), so a response that downloads but does not
  decode stays on screen as a broken image.
- **Repro (S8):** open `/books`, then the Documents segment. Answer
  `/api/documents/32002/preview` with 200 `image/png` and undecodable bytes.
  Result, 1440 and 1920: row 32002 keeps a 36×48 `<img>` with
  `complete: true, naturalWidth: 0`. It was broken in 84 of 118 (1440) and
  82 of 119 (1920) rAF samples, that is, from arrival until the harness left the
  page. Rows 32001 and 32003 were fine. See `s8-books-broken-thumb-1440.jpg`.
- **Expected (the issue's criterion "no broken image"):** the fallback glyph, as
  `DocThumbLightbox` and `DocPreviewRow` do through `reportBroken`.
- **Reachability caveat:** the server renders these PNGs itself, so corrupt
  bytes need a server-side render or storage fault. This is why P3 is
  suggested rather than P2. The real-backend frequency was not tested.
- **Latent, not reproduced:** `DocThumb` does not reset `src` when `id`
  changes. Its only caller keys rows by `d.id`, so an id change on a mounted
  instance cannot happen today. This is a code observation only.

### D2: A broken `<img>` can reach one painted frame before the error state (confirmed, intermittent, suggested P4)

- **Where:** `inbox/DocumentPreviewLightbox.tsx` (`usePreviewObjectUrl` +
  `reportBroken`), as used by `DocPreviewRow` and the lightbox. `ready` is
  set when the object URL exists, before the bytes are known to decode.
  The `<img>`'s `onError` → `reportBroken` flips the state to `error`, but
  that re-render can land after the next frame.
- **Evidence:**
  - Repeat run: 25 cycles per width of "open 31002 with thumb + lg
    `broken`". A rAF (pre-paint) sample saw the broken `<img>` in **3 of 25**
    lightbox-lg cycles at 1440 (a 167×24 box, i.e. an icon plus alt text) and
    **2 of 25** row-thumb cycles at 1920 (a 36×48 box). The other 2 surface
    combinations had 0 of 25.
  - Main matrix: S6 at 1440 had 1 painted sample (row thumb, 36×48). S6 at 1920 had 0.
  - In `dev2`, both the thumb and the lg were seen once.
  - The gap between the `error` event and React's commit was 2–6 ms, for example
    795 → 800 ms and 1328 → 1332 ms. The broken state lasts at most one frame,
    and then the documented error + Retry state follows.
- **Not visually captured:** it is a single frame. The claim rests on the rAF
  ordering described above, in headless Chromium only.
- **Possible direction (not a prescription):** decode before `ready`
  (`createImageBitmap` / `img.decode()`), or keep the `<img>` hidden until
  `load`.

### Observations (not defects)

- **O1: stale requests are ignored, not aborted.** `fetchDocumentPreviewObjectUrl`
  takes no `AbortSignal`. A stale request runs to completion, becomes an object URL and is revoked
  at once. There is no visual effect. The cost is the network and blob
  work of every abandoned preview.
- **O2: the thumb → lg swap in the lightbox.** The thumb `<img>` is replaced by
  the lg `<img>`, which is 0×0 until it decodes. This showed 16 times at DOM
  checkpoints and **0** times at rAF, so no blank painted frame was seen with
  local instant bodies. A slow body read (not modelled) could make it
  visible.

## Harness issues (not product)

- **Fixture shape.** The first probe opened a `supplier_unresolved` item with
  a `pending-draft` body missing `supplier_proposal`, which crashed the screen
  ("This screen stopped working", `reading 'kind'`). The fixtures were changed
  to reasons that do not read a draft.
- **URL ≠ rendered document.** With a replace-navigation advance,
  `location.pathname` changes one commit before React renders the new
  document. The first monitor took the URL as the expected identity and
  reported the Inbox list (and then the previous document) as "another
  object". The monitor now reads the rendered filename. Re-checked: the
  screen showed the old document's thumb only together with the old
  document's filename.
- **Locator.** S8 first waited for a filename span that is `xl:hidden` at
  these widths. It now waits for the row link.
- **Broken bytes seen at DOM checkpoints.** An undecodable `<img>` is in
  the DOM while it loads (0×0) and at its `error` event. These are recorded
  (`brokenDomOnly`, `brokenBytesImgChecks`) but are not failures, which is why D2 counts only rAF samples.
- **Build.** The `pdfjs-dist` resolution in this worktree is described under Set-up.

## Limits (untested)

- Real backend: real render latency, real corrupt or partial PNGs, 404 vs
  render failure, and HTTP/1.1 per-host connection limits (6 thumbs plus lg are
  queued differently on a real network).
- **Slow body read:** the mock delays before the `Response`, and the body
  is then instant. The `readOwnedBlob` path and a long download of lg were
  not stressed.
- Switching documents while the lightbox is **open**: the modal covers
  Archive, and this run found no way to do it through the UI. Back while it is
  open was not driven.
- The same `DocPreviewRow` on `ApprovalScreen` (approval queue advance) and
  `books/DocumentScreen` was not driven separately. The classify sheets'
  `DocumentSourcePane` (original file viewer, `useObjectUrl`) was not tested.
- A session change (sign-out) during a pending preview was not tested.
- Native iOS, Safari/WebKit, Firefox, Edge, physical devices, DPR ≠ 1.

## Evidence

Frozen under `.review-304/`. See `MANIFEST` for the committed files, the
untracked harness (with sha256) and the build.
