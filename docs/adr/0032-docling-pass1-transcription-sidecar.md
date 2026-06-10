# Pass-1 OCR is mime-routed: in-process pdf-parse text layer + external vision OCR (LiteLLM/dots.ocr)

## Status
Accepted (2026-06-10). Supersedes the original revision of this ADR, which chose a Docling sidecar (see History).

## Context
Pass-1 (ADR-0024) turns a Document into markdown for Pass-2 to classify. The
target deployment is a **$5 VPS (≈1 GB RAM, 1 vCPU)**. Documents are a mix of
born-digital PDFs (embedded text layer), photographed receipts (images), and
the occasional scanned PDF (image-only, no text layer).

A Docling `docling-serve` sidecar was prototyped and **rejected on the RAM
budget**: it loads torch + an OCR model (easyocr) into memory (GBs) and OOMs on
a 1 GB host — and even Docling's PDF path runs a torch layout model, so it can't
serve as a lightweight text extractor either. The operator already runs an
external OCR model — **dots.ocr behind a LiteLLM proxy** (OpenAI-compatible) —
off-box, which is the right place for the heavy work.

## Decision
Pass-1 routes by **MIME**, behind the existing `DocumentTranscriber` port
(`MimeRoutingTranscriber`):

- **Born-digital PDF** → `PdfTextExtractor`: in-process embedded-text extraction
  with `pdf-parse` (pure JS, no ML, tens of MB) — the common case (software
  invoices) is handled locally, free, with no network call.
- **Image (`image/*`)** → `LlmVisionTranscriber`: an OpenAI-compatible vision
  call (`POST {ai_base_url}/chat/completions`, image as a base64 data URL) to the
  operator's LiteLLM/dots.ocr endpoint. Returns `choices[0].message.content`.
- **Scanned PDF** (PDF whose extracted text is below a small threshold) →
  `PdfRasterizer` renders it to PNG per page with poppler's `pdftoppm` (a tiny,
  fast system binary), then each page goes through `LlmVisionTranscriber`; the
  pages' markdown is concatenated.
- Any other MIME → typed `unreadable`.

Config is **reused** from the AI inference profile — `ai_base_url` + `ai_api_key`
(already operator-set in the SPA) plus a new `ai_model.ocr` for the OCR model id.
dots.ocr ignores the prompt, so there is **no `prompt.ocr` setting** (a fixed
throwaway text satisfies the chat content shape). The `DocumentTranscriber` port
made swapping the engine a leaf change: `OcrService`'s persistence, CRC32,
idempotency, race-safety, `OcrOutcome` contract, and needs_triage routing are
untouched and engine-agnostic.

## Consequences
- The host stays light: Node + `pdf-parse` (JS) + `poppler-utils` (a few MB).
  No torch, no canvas, no OCR sidecar — fits a $5 VPS. All heavy OCR is off-box.
- An external OCR endpoint becomes a hard dependency for images and scanned PDFs.
  When `ai_base_url`/`ai_model.ocr` is unset or the endpoint is unreachable,
  Pass-1 returns `provider-unavailable` and the Document routes to `needs_triage`
  (ADR-0024) — it never strands in `pending`.
- `poppler-utils` is a runtime system dependency (installed in the app image);
  if absent, scanned PDFs map to `unreadable` rather than crashing.
- **Table-structure reconstruction** (a Docling perk) is given up for the RAM
  budget. dots.ocr's own layout handling covers images/scans; born-digital PDFs
  yield their raw text layer (Pass-2 reasons over the text).
- The convert path and response shape are dots.ocr/LiteLLM's standard
  chat/completions — no bespoke contract to re-verify on upgrades.

## Alternatives rejected
- **Docling sidecar** (original decision): torch/easyocr OOM on the target VPS.
- **Plug the external OCR into Docling** (KServe v2 / custom Python OCR plugin):
  requires KServe compatibility or baking a Python plugin into the image — and
  Docling itself still can't run on the host.
- **node-canvas / pdfjs+@napi-rs/canvas rasterisation**: heavier RAM and native
  build vs. the `pdftoppm` system binary.

## History
- 2026-06-10 (earlier): chose Docling via a `docling-serve` CPU sidecar, with a
  `DoclingTranscriber` HTTP adapter. Reverted the same day once the $5 VPS RAM
  constraint surfaced — Docling cannot load on the target host.
