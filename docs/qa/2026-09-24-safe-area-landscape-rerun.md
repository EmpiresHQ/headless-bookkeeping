# QA-003 re-run: safe area, landscape and standalone (issue #296), 2026-09-24

A fresh verification on `main` `225df1f`, which includes #362, #295, #305 and
the ConfirmDialog height bound. It follows the 2026-09-23 report
(`2026-09-23-safe-area.md`, built at `effb488`). Scope is the web UI only;
the native iOS app is out of scope.

**Result: no product defect was reproduced, and no product code changed.**
Nothing here is a device result. Every number comes from headless Chromium
with emulated insets and mocked data. **#296 stays open** for the
physical-device matrix in the 2026-09-23 report, which this run does not
replace.

## What is real and what is a proxy

| Condition                              | How it was exercised                                                                                                                                               | Real?                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `env(safe-area-inset-*)` values        | CDP `Emulation.setSafeAreaInsetsOverride`, re-applied after every resize, checked on a probe element                                                               | **Proxy.** It feeds CSS `env()` only. Nothing is drawn over the bands                               |
| Notch, home indicator, status bar      | Harness-side "bands" of the forced inset size. A control overlapping a band is **flagged**                                                                         | **Proxy.** No occlusion, so hit-tests pass inside a band                                            |
| Inset values                           | iPhone 14-class model: portrait t47/b34, landscape l47/r47/b21                                                                                                     | **Model, not measured**                                                                             |
| Portrait ↔ landscape rotation          | `setViewportSize` 390×844 ↔ 844×390 with the insets swapped                                                                                                        | **Proxy.** A layout resize, not a device rotation. No toolbar change                                |
| Browser toolbars (collapse/expand)     | **Not emulated.** In headless Chromium, `vh` = `innerHeight` = visual height                                                                                       | **NOT RUN** (see Risk R1)                                                                           |
| Installed / `display-mode: standalone` | CDP media emulation **ignores** `display-mode` in this Chromium (checked: `prefers-color-scheme` works). Used a JS `matchMedia` stub plus an iOS Safari UA instead | **Proxy.** It reaches JS callers only; CSS `@media (display-mode)` is unaffected (the app has none) |
| `viewport-fit` gating                  | Probe with the shipped meta and with test-only `cover` / `contain`                                                                                                 | Shows the proxy's gap (below)                                                                       |
| Data                                   | Route-mocked `/api` and `/admin`, in-page preview bitmaps, other origins aborted                                                                                   | Local mock. **0 writes** reached the mock in all 29 scenarios (every write answers 503)             |

**Applicability gap** (`evidence/probe.log`): the override gives the same
`env()` = 47/0/34/0 under the shipped meta (no `viewport-fit`), under
`viewport-fit=cover` and under `viewport-fit=contain`. Chromium's override
ignores `viewport-fit`. On real platforms, non-zero insets reach a page only
under `viewport-fit=cover`, which this app does not set; the page is then
laid out inside the safe area. That is documented platform behaviour, not
measured here. So a flagged band overlap means "would overlap **if** the
page received these insets". It is not a reproduced overlap.

## Source contracts at `225df1f` (changes since `effb488` in bold)

- `index.html`: `width=device-width, initial-scale=1.0`. No `viewport-fit`, no `apple-mobile-web-app-*`, no `theme-color` meta. `site.webmanifest`: `"display": "standalone"`, SVG icons only.
- The only `env()` term in the built CSS is `--safe-bottom: env(safe-area-inset-bottom, 0px)`. It feeds `--tabbar-h`, which the TabBar, the main padding, the ActionBar `bottom` and (**#305**) `html { scroll-padding-bottom }` use.
- `ui/Sheet.tsx`: form `max-h-[92vh] pb-6`, source `h-[92vh] pb-3`, no safe-area term. **#362/#295:** the inline height/bottom are released or fitted from `visualViewport`, but only while a keyboard, zoom or pan separates it from the layout viewport.
- **`ui/ConfirmDialog.tsx`: now `max-h-[calc(100vh-32px)]`, or `100dvh` where supported, with `overflow-y-auto`** (was unbounded, row P1 of the 09-23 matrix).
- Lightbox (`inbox/DocumentPreviewLightbox.tsx`): `fixed inset-0`, top bar `px-3 py-2.5`, no safe-area term.
- **No app source reads `display-mode` or `navigator.standalone`.** The only branch in the bundle is in vaul 1.1.2's `usePositionFixed`, a Safari-only `body{position:fixed;top:-scrollY}` pin that is skipped in standalone. It runs only after vaul's `hasBeenOpened`, which vaul sets from Radix's `onOpenChange(true)`, i.e. an uncontrolled `Drawer.Trigger`. Every app sheet is opened with the controlled `open` prop, so **the branch never runs in either mode**. Confirmed in-browser: with an iOS Safari UA and a scrolled page, `body` never got `position: fixed` (H rows).

## Set-up

- `main` `225df1f`, own production build (`vite build`, unmodified), served by `vite preview` on `localhost:5496`.
- Chromium 153.0.8010.12 (Playwright 1.63.0), headless Linux, `isMobile` + `hasTouch`, DPR 2. The default UA is desktop-Linux Chromium; the H rows also use an iOS 18 Safari UA.
- Fixtures: the #305/#295 harness (entities, categories, EE VAT org, 40 triage docs, bank statement 1 / tx 501, preview bitmaps), plus an optional 40-row Books expense list for the scrolled-page rows.

## Results (`evidence/safearea.log`, full rects in `evidence/safearea.json`)

Rects are CSS px, `x..right × y..bottom`. "Band" is px overlapping a forced
band on that side. "Hit" is `elementFromPoint` at the centre.

| #   | Surface                                             | Portrait 390×844: none → forced t47/b34                                                                                                         | Landscape 844×390: none → forced l47/r47/b21                                                                                   |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A   | TabBar (`/books`)                                   | Bar 789..844, pb 8 → 763..844, pb 34. Links y 792..836 → 766..810, clear of the band. Hit OK                                                    | Bar 335..390 → 322..390, pb 21. Links y 325..369, x within 61..783 (inside 47..797). Clear, hit OK                             |
| A   | Page header (h1, ＋)                                | h1 y 20..63.5, ＋ 21.5..65.5: **band t 27 / 25.5** under forced                                                                                 | h1 x 58, ＋ x 748..792: clear                                                                                                  |
| B   | Bank tx 501 ActionBar CTA, max scroll               | y 549.3..595.3 → 523.3..569.3, above the TabBar (789 → 763). Clear, hit OK                                                                      | y 110.8..156.8 → 97.8..143.8, x 54..790. Clear, hit OK                                                                         |
| C   | New expense sheet                                   | Drawer 173.5..844, pb 24. Close 181.5..225.5. CTA 757.5..800. Clear, hit OK                                                                     | Drawer x 134..710, y 31.2..390. CTA below the fold (599..642); after a sheet scroll, 323.2..365.7: clear, hit OK               |
| C   | Discard ConfirmDialog (dirty sheet → Close)         | 24..366 × 335.8..508.3. Keep editing / Discard hit OK. Value kept (45.67)                                                                       | 230..614 × 108.8..281.3. Both hit OK. Value kept                                                                               |
| D   | Classify (source Verify) sheet, Form view           | Drawer 67.5..844, pb 12. Close 75.5..119.5. CTA 766.5..809. Clear, hit OK                                                                       | Full-width drawer. Close x 792..836: **band r 39**. CTA after scroll x 20..824, y 335.7..378.2: **band l/r 27, b 9.2**. Hit OK |
| E   | Preview lightbox (`/inbox/doc/31001`)               | Close preview y 10..50 and Open original y 11.5..48.5: **band t 37 / 35.5**. Image 193..711. Hit OK                                             | Close preview x 792..832: **band r 35**. Open original clear. Image y 72..378: band b 9. Hit OK                                |
| F   | Rotation P→L→P→L→P, New expense with Gross typed    | Every P step equals the fresh drawer (173.5..844, inline `\|` empty). Gross 45.67 kept throughout                                               | Every L step equals the fresh L drawer. CTA reachable by a sheet scroll                                                        |
| G   | Rotation P→L→P, lightbox open; then Escape          | Buttons identical to row E per orientation, hit OK                                                                                              | Escape closed the lightbox                                                                                                     |
| G2  | Rotation P→L→P, Classify sheet                      | Returns to 67.5..844, Close 75.5..119.5                                                                                                         | As row D                                                                                                                       |
| H   | Scrolled Books list (40 rows) → New expense → Close | Chromium UA, iOS Safari UA, and iOS Safari UA + standalone stub: identical. scrollY 900 → 900, `body` never `position: fixed`, TabBar unchanged | Same, scrollY 600 → 600                                                                                                        |

Expected flags that the log still shows, and which are not findings:

- Sheet Close and CTA fail hit-tests while the ConfirmDialog covers them.
- A landscape sheet CTA is off-screen until the sheet body scrolls.

## Findings

No defect was reproduced. This is not an all-clear for devices.

1. **Forced-inset overlaps are unchanged since 09-23, and still conditional.** Controls without an `env()` term fall in the synthetic bands:
   - page headers (portrait top);
   - the lightbox top bar (portrait top, landscape right);
   - the Classify sheet's Close and CTA (landscape sides and bottom).

   With the shipped meta (no `viewport-fit=cover`), real platforms should not report these insets to the page. So this is **not a reproduced defect** and no fix was made.
   **Precondition for any future change:** anyone who adds `viewport-fit=cover` (for example, for an edge-to-edge installed app) must add `env()` padding to at least these surfaces. Otherwise the flags above become real overlaps.

2. **Bottom contract holds under forced insets.** The TabBar links, the ActionBar CTA and the New expense CTA stay above the bottom band, portrait and landscape, and are hit-testable.
3. **Rotation.** Sheet and lightbox geometry returns exactly to the fresh-open values after 4 rotations. Typed values are kept, and Escape still closes the lightbox.
4. **Standalone.** No app code differs between tab and installed display. The one dependency branch (vaul's Safari body pin) is unreachable, because the app's sheets are controlled. Page scroll under an open sheet is kept in all three UA/mode combinations.
5. **ConfirmDialog** is now height-bounded (`100dvh - 32px`, scrollable), which closes the source-level half of 09-23 row P1. Long-body behaviour on a short viewport is covered by `2026-09-24-short-height-confirmations.md`; this run measured only the short discard dialog.

### Risk R1: browser toolbars against `92vh` sheets (unmeasured, no defect claimed)

`vh` resolves against the **large** viewport (toolbars collapsed), while a
`bottom: 0` sheet sits in the visible area. With toolbars expanded, a
`92vh` sheet is taller than the visible area whenever `svh < 0.92 · lvh`,
i.e. when the toolbars take more than about 8% of the large viewport. The
overflow falls at the **top**: the drag handle, title and Close (top-2,
44px) would start above the visible area.

Headless Chromium has no browser controls (`vh` = `innerHeight`), so this
could not be reproduced or measured, and **no fix was made**. Check it on
device rows B2/B3 of the 09-23 matrix, and record `innerHeight`, `100svh`,
`100lvh` and the sheet's top against `visualViewport.offsetTop`. If it
reproduces, the narrow fix is `92dvh`, or `svh` with a `vh` fallback, in
`Sheet.tsx`, as `ConfirmDialog` already does with `100dvh`.

## Tests

No product code changed, so the web unit suite was not re-run. The browser
harness is the test for this report:

- 29 scenarios (`evidence/safearea.log`);
- 0 writes, 0 page errors;
- the only unanswered fixture request is `network /api/documents/31001/file`, the Classify sheet's hidden Source pane. It is answered 599 by design, and it does not affect the measured Form view.

## Limitations

- No physical device, no real notch or home indicator, no real browser toolbar, no install flow. Every row of the 09-23 physical-device matrix (B1–B3, L1–L4, S1–S4, P1) is still **NOT RUN**.
- The inset values are a model. Real values under the shipped meta, which are expected to be 0 with the content inset by the platform, are unmeasured.
- The standalone proxy is a JS stub. It proves the code paths match; it proves nothing about how an installed app is laid out.
- Rotation is a layout resize, and Android Chrome was not emulated separately.
- Widths ≥ 1024px (Sidebar) are out of scope.

## Reproduce

Harness: `.review-296-rerun/harness/` (`probe.mjs`, `safearea.mjs`, fixtures
in `common.mjs` / `inpage.js`, adapted from the #295 re-run). See
`.review-296-rerun/MANIFEST` for the build, serve and run commands.
