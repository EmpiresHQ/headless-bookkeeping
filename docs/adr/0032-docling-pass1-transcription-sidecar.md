# Pass-1 transcription is Docling, run as a docling-serve sidecar, behind a port

## Status
Accepted (2026-06-10)

## Context
Pass-1 (ADR-0024) turns a Document into markdown for Pass-2 to classify. The v1
implementation used a faux model returning fixed markdown by id parity. We need
a real engine. Documents are a mix of born-digital PDFs (embedded text layer) and
scanned/photographed receipts (pixels only). Three options were weighed:

1. A dedicated LLM-OCR VLM (e.g. dots.ocr) for everything.
2. A hand-rolled tiered pipeline: direct text-layer extraction (pdf-parse) for
   digital PDFs, rasterize + LLM-OCR fallback for scans.
3. Docling — one tool that does born-digital text extraction, OCR of scanned/image
   content (easyocr/tesseract/rapidocr, on by default), AND table reconstruction →
   markdown, exposed over HTTP by `docling-serve`.

## Decision
Use **Docling** via a **`docling-serve` sidecar**, reached over HTTP by a single
adapter (`DoclingTranscriber`) behind the **`DocumentTranscriber` port**. The base
URL is an env var (`DOCLING_BASE_URL`). Docling is Python, so it is NOT in-process;
it is a container alongside the app (CPU image for v1; a `docling-serve-cu*` tag
swaps in GPU). The official images pre-bake the models (no cold-start download).

Docling subsumes the tiered design of option 2 in one HTTP call and adds table
reconstruction (critical for invoice line items), which a bare OCR VLM (option 1)
does not give. The port keeps the engine swappable: `OcrService`'s persistence,
CRC32 tamper-detection, idempotency, race-safety, `OcrOutcome` contract, and
needs_triage routing are all engine-agnostic and unchanged.

## Consequences
- A new runtime dependency: the deployment must run the `docling-serve` container.
  When `DOCLING_BASE_URL` is unset or the sidecar is down, Pass-1 returns
  `provider-unavailable` and the Document routes to `needs_triage` (ADR-0024) —
  it never strands in `pending`.
- CPU OCR of large scanned PDFs is slow; the adapter caps each request (120s) and
  maps a timeout to `transient`.
- The convert endpoint path (`/v1/convert/file`, verified by probing the pinned
  `docling-serve-cpu` image) is tied to the image tag and must be re-verified when
  the tag is bumped.

## Alternatives rejected
- **dots.ocr / bare VLM**: OCR-only, no table semantics, GPU-bound — more cost for
  less structure than Docling on born-digital PDFs (the common case).
- **Hand-rolled tiered pipeline**: rebuilds, and then maintains, text extraction +
  rasterization + an OCR fallback that Docling already ships and tests.
