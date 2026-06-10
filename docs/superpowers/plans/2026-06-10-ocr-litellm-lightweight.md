# Lightweight Pass-1 OCR (pdfjs + LiteLLM/dots.ocr, mime-routed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the Docling sidecar (too heavy for a $5 VPS — torch/easyocr need GBs of RAM) with a lightweight, mime-routed Pass-1: born-digital PDFs are text-extracted in-process with pdfjs (pure JS, no ML); images and scanned PDFs are OCR'd by an EXTERNAL OpenAI-compatible vision endpoint (LiteLLM proxying dots.ocr), reusing the existing `ai_base_url`/`ai_api_key` inference config. Scanned PDFs are rasterised to PNG with poppler's `pdftoppm` before OCR. The `DocumentTranscriber` port and ALL of `OcrService`'s machinery (CRC32 / idempotency / race-safety / `OcrOutcome` / needs_triage routing) are unchanged — only what sits behind the port changes.

**Architecture:**
```
DocumentTranscriber (port)
  └─ MimeRoutingTranscriber (the bound adapter)
       ├─ image/*          → LlmVisionTranscriber  (POST {ai_base_url}/chat/completions,
       │                       image as base64 data URL → dots.ocr → choices[0].message.content)
       └─ application/pdf  → PdfTextExtractor  (pdfjs getTextContent, in-process)
                              └─ text empty/too-short (scanned) → PdfRasterizer (pdftoppm -png)
                                                                   → LlmVisionTranscriber per page → concat
       └─ (other mime)     → unreadable
```

**Tech Stack:** NestJS 11, Kysely/better-sqlite3, Jest 30, TS strict (zero `any`/`as`), Node 24 (global fetch/FormData/Blob). New deps: `pdfjs-dist` (PDF text, pure JS). System dep: `poppler-utils` (`pdftoppm`). External: an OpenAI-compatible vision endpoint (LiteLLM + dots.ocr) configured via existing settings.

**Engine decision (supersedes ADR-0032's Docling choice):** Docling-serve cannot run on the target $5 VPS (1 GB RAM) — torch + easyocr OOM on load, and even Docling's PDF path uses a torch layout model. So: digital PDFs → in-process pdfjs text-layer extraction (no ML); real OCR (images + scanned PDFs) → offloaded to the operator's existing LiteLLM/dots.ocr endpoint (off-box). dots.ocr ignores the prompt, so no `prompt.ocr` setting — only a model id (`ai_model.ocr`).

---

## Node environment

Every shell: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null;` — run from `/Users/alekseirevin/test/hb-ocr`. Backend source typecheck gate: `npx tsc -p tsconfig.build.json --noEmit` (excludes specs + frontend). Spec typecheck happens in `npm test` (unit) and `npm run test:e2e` (e2e). **Run BOTH test commands in the final gate** — `npm test` does NOT run `test/*.e2e-spec.ts`.

## File Structure

- **Remove** `src/triage/docling-transcriber.ts` + `src/triage/docling-transcriber.spec.ts` (Docling adapter — replaced).
- **Create** `src/triage/pdf-text-extractor.ts` (+ `.spec.ts`) — pdfjs text-layer extraction.
- **Create** `src/triage/pdf-rasterizer.ts` (+ `.spec.ts`) — `pdftoppm` PDF→PNG[].
- **Create** `src/triage/llm-vision-transcriber.ts` (+ `.spec.ts`) — OpenAI-compatible vision OCR call.
- **Create** `src/triage/mime-routing-transcriber.ts` (+ `.spec.ts`) — the bound `DocumentTranscriber`; routes by mime + scanned-PDF fallback.
- **Modify** `src/triage/ocr.module.ts` — bind `DocumentTranscriber` → `MimeRoutingTranscriber`; provide the three sub-adapters; import `AgentConfigModule`.
- **Modify** `src/ai/agent-config.ts` — add `'ocr'` to `AgentKey`; add `AGENT_PROMPTS.ocr` (fixed, ignored by dots.ocr).
- **Modify** `src/admin/settings.registry.ts` — add `ai_model.ocr`.
- **Modify** `docker-compose.yml` — remove the `docling` service + `DOCLING_BASE_URL`.
- **Modify** `Dockerfile` — `apk add --no-cache poppler-utils` in the production stage.
- **Modify** `package.json` — add `pdfjs-dist`.
- **Rewrite** `docs/adr/0032-docling-pass1-transcription-sidecar.md` → the lightweight decision (rename heading; keep the file/number).
- **Modify** `docs/adr/0024-...md` — re-point Pass-1 at the mime-routed lightweight engine.

Unchanged: `src/triage/ocr.service.ts` + `ocr.service.spec.ts` (port-based; stub already used), `src/ai/intake-workflow.service.ts`, `test/intake.e2e-spec.ts` (already stubs `DocumentTranscriber`), `src/triage/document-transcriber.port.ts` (the port + `OcrOutcome`/`TranscribableFile` vocabulary).

---

## Task 1: Remove the Docling adapter

**Files:** delete `src/triage/docling-transcriber.ts`, `src/triage/docling-transcriber.spec.ts`.

- [ ] **Step 1: Delete the two files**

```bash
git rm src/triage/docling-transcriber.ts src/triage/docling-transcriber.spec.ts
```

- [ ] **Step 2: Confirm no remaining references**

Run: `grep -rn "docling-transcriber\|DoclingTranscriber\|DOCLING_BASE_URL" src/ test/ docker-compose.yml` — expect matches ONLY in `ocr.module.ts` (fixed in Task 6) and `docker-compose.yml` (fixed in Task 7). Note them; do not fix yet.

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(ocr): remove Docling adapter (too heavy for target VPS)"
```

---

## Task 2: Add the OCR model config seam (`ocr` agent key + `ai_model.ocr` setting)

**Files:** `src/ai/agent-config.ts`, `src/admin/settings.registry.ts`.

`LlmVisionTranscriber` resolves its endpoint via the existing `AgentConfigService.resolveModelConfig('ocr')`, which reads `ai_model.ocr` → `ai_model` → `DEFAULT_MODEL` for the model id, and pairs it with `ai_base_url` + `ai_api_key`. Adding `'ocr'` to `AgentKey` makes that call type-check. dots.ocr ignores prompts, so `AGENT_PROMPTS.ocr` is a fixed throwaway and `prompt.ocr` is NOT a settable key.

- [ ] **Step 1: Extend `AgentKey` and `AGENT_PROMPTS`**

In `src/ai/agent-config.ts`:

```ts
export type AgentKey = 'triage' | 'intent_classifier' | 'ocr';
```

Add to the `AGENT_PROMPTS` record (any key order):

```ts
  // dots.ocr (served via LiteLLM) ignores the prompt — it transcribes layout
  // regardless. This text is sent only to satisfy the chat/completions content
  // shape (a vision message needs a text part); it is not operator-overridable.
  ocr: 'Transcribe this document to markdown.',
```

- [ ] **Step 2: Register the `ai_model.ocr` setting**

In `src/admin/settings.registry.ts`, add inside `KNOWN_SETTINGS` (next to the other `ai_model.*` keys):

```ts
  'ai_model.ocr': {
    description: 'Model id for the OCR vision endpoint (e.g. a dots.ocr model on LiteLLM)',
    validate: nonEmpty,
  },
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.build.json --noEmit` — expect CLEAN. (`agent-config.service.ts` already maps any `AgentKey`; `AGENT_PROMPTS` is now exhaustive for the widened union.)

- [ ] **Step 4: Commit**

```bash
git add src/ai/agent-config.ts src/admin/settings.registry.ts
git commit -m "feat(ocr): add 'ocr' agent key + ai_model.ocr setting for the vision endpoint"
```

---

## Task 3: `LlmVisionTranscriber` — OpenAI-compatible vision OCR call

**Files:** create `src/triage/llm-vision-transcriber.ts` (+ `.spec.ts`).

This adapter transcribes ONE image (png/jpeg bytes) by calling an OpenAI-compatible `/chat/completions` with a vision message. It is NOT a `DocumentTranscriber` itself — it's a lower-level "image → markdown" collaborator used by the router (for `image/*`) and by the rasterised-PDF fallback. Config comes from `AgentConfigService.resolveModelConfig('ocr')`: a bare-string result (no `ai_base_url`) → `provider-unavailable`. Never throws.

**Request** (`{base}/chat/completions`, `Authorization: Bearer {apiKey}`):
```json
{ "model": "<id>", "messages": [{ "role": "user", "content": [
  { "type": "text", "text": "<AGENT_PROMPTS.ocr>" },
  { "type": "image_url", "image_url": { "url": "data:<mime>;base64,<b64>" } } ]}] }
```
**Response:** `choices[0].message.content` (string) → markdown.

- [ ] **Step 1: Write the failing tests**

Create `src/triage/llm-vision-transcriber.spec.ts`:

```ts
import { LlmVisionTranscriber } from './llm-vision-transcriber';
import { AgentConfigService } from '../ai/agent-config.service';

describe('LlmVisionTranscriber', () => {
  const image = { buffer: Buffer.from('PNGDATA'), mimeType: 'image/png' };
  let fetchMock: jest.Mock;

  function withConfig(cfg: unknown): AgentConfigService {
    return {
      resolveModelConfig: () => Promise.resolve(cfg),
      resolveInstructions: () => Promise.resolve('Transcribe this document to markdown.'),
    } as unknown as AgentConfigService;
  }
  function chatResponse(content: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve({ choices: [{ message: { content } }] }),
    } as unknown as Response;
  }

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => jest.restoreAllMocks());

  it('POSTs a vision chat request and returns the message content', async () => {
    fetchMock.mockResolvedValue(chatResponse('# Receipt\nBolt €15.25'));
    const t = new LlmVisionTranscriber(
      withConfig({ id: 'rednote/dots.ocr', url: 'http://litellm:4000/v1', apiKey: 'k' }),
    );
    const out = await t.transcribeImage(image);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.markdown).toBe('# Receipt\nBolt €15.25');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://litellm:4000/v1/chat/completions');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer k');
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: { content: { type: string; image_url?: { url: string } }[] }[];
    };
    expect(body.model).toBe('rednote/dots.ocr');
    const parts = body.messages[0].content;
    expect(parts.find((p) => p.type === 'text')).toBeDefined();
    const img = parts.find((p) => p.type === 'image_url');
    expect(img?.image_url?.url).toBe(`data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`);
  });

  it('maps a bare-string model config (no base url) to provider-unavailable', async () => {
    const t = new LlmVisionTranscriber(withConfig('openai/gpt-4o-mini'));
    const out = await t.transcribeImage(image);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('provider-unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps empty content to unreadable', async () => {
    fetchMock.mockResolvedValue(chatResponse('   '));
    const t = new LlmVisionTranscriber(withConfig({ id: 'm/x', url: 'http://h/v1', apiKey: 'k' }));
    const out = await t.transcribeImage(image);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('unreadable');
  });

  it('maps HTTP 5xx to transient and 4xx to unreadable', async () => {
    const t = new LlmVisionTranscriber(withConfig({ id: 'm/x', url: 'http://h/v1', apiKey: 'k' }));
    fetchMock.mockResolvedValue(chatResponse(null, 503));
    expect((await t.transcribeImage(image) as { category: string }).category).toBe('transient');
    fetchMock.mockResolvedValue(chatResponse(null, 400));
    expect((await t.transcribeImage(image) as { category: string }).category).toBe('unreadable');
  });

  it('maps a connection error to provider-unavailable and a timeout to transient', async () => {
    const t = new LlmVisionTranscriber(withConfig({ id: 'm/x', url: 'http://h/v1', apiKey: 'k' }));
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect((await t.transcribeImage(image) as { category: string }).category).toBe('provider-unavailable');
    const abort = new Error('aborted'); abort.name = 'AbortError';
    fetchMock.mockRejectedValue(abort);
    expect((await t.transcribeImage(image) as { category: string }).category).toBe('transient');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/triage/llm-vision-transcriber.spec.ts` — FAIL (module missing).

- [ ] **Step 3: Implement**

Create `src/triage/llm-vision-transcriber.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { AgentConfigService } from '../ai/agent-config.service';
import { OcrOutcome } from './document-transcriber.port';

/** One raster image to transcribe. */
export interface OcrImage {
  buffer: Buffer;
  mimeType: string;
}

const REQUEST_TIMEOUT_MS = 120_000;

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * Transcribes a single image to markdown via an OpenAI-compatible vision
 * endpoint (LiteLLM proxying dots.ocr). Config (base URL, key, model) is reused
 * from the `ocr` agent profile — `ai_base_url`/`ai_api_key` + `ai_model.ocr`.
 * Not a DocumentTranscriber: the router calls this for image/* and for each
 * rasterised PDF page. Never throws — all faults become a typed OcrFailure.
 */
@Injectable()
export class LlmVisionTranscriber {
  private readonly logger = new Logger(LlmVisionTranscriber.name);

  constructor(private readonly config: AgentConfigService) {}

  async transcribeImage(image: OcrImage): Promise<OcrOutcome> {
    const model = await this.config.resolveModelConfig('ocr');
    if (typeof model === 'string') {
      // No ai_base_url configured → no endpoint to reach.
      this.logger.warn('ai_base_url unset — OCR vision endpoint not configured');
      return {
        ok: false,
        category: 'provider-unavailable',
        detail: 'OCR vision endpoint not configured (ai_base_url unset)',
      };
    }

    const instructions = await this.config.resolveInstructions('ocr');
    const b64 = image.buffer.toString('base64');
    const payload = {
      model: model.id,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: instructions },
            {
              type: 'image_url',
              image_url: { url: `data:${image.mimeType};base64,${b64}` },
            },
          ],
        },
      ],
    };

    let response: Response;
    try {
      response = await fetch(`${model.url}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const timedOut = err.name === 'AbortError' || err.name === 'TimeoutError';
      const category = timedOut ? 'transient' : 'provider-unavailable';
      this.logger.warn(`OCR endpoint unreachable (${category}): ${err.message}`);
      return { ok: false, category, detail: err.message };
    }

    if (!response.ok) {
      const category = response.status >= 500 ? 'transient' : 'unreadable';
      const detail = `OCR endpoint returned HTTP ${response.status}`;
      this.logger.warn(`${detail} (${category})`);
      return { ok: false, category, detail };
    }

    let body: ChatCompletionResponse;
    try {
      body = (await response.json()) as ChatCompletionResponse;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        ok: false,
        category: 'transient',
        detail: `OCR endpoint returned a non-JSON body: ${err.message}`,
      };
    }

    const markdown = body.choices?.[0]?.message?.content ?? '';
    if (markdown.trim().length === 0) {
      return {
        ok: false,
        category: 'unreadable',
        detail: 'OCR endpoint returned empty content',
      };
    }
    return { ok: true, markdown };
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/triage/llm-vision-transcriber.spec.ts` — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/triage/llm-vision-transcriber.ts src/triage/llm-vision-transcriber.spec.ts
git commit -m "feat(ocr): add LlmVisionTranscriber (OpenAI-compatible vision OCR via LiteLLM)"
```

---

## Task 4: `PdfTextExtractor` — in-process born-digital PDF text layer

**Files:** create `src/triage/pdf-text-extractor.ts` (+ `.spec.ts`); add `pdfjs-dist` to deps.

Pure-JS text-layer extraction. pdfjs-dist v4 is ESM; the Nest build is CJS, so load it via dynamic `import()`. Returns the concatenated page text. The CALLER (router) decides "empty ⇒ scanned ⇒ fallback"; this module just extracts.

- [ ] **Step 1: Add the dependency**

Run: `npm install pdfjs-dist@^4` then verify `package.json` lists it under `dependencies`.

- [ ] **Step 2: Write the failing test**

Create `src/triage/pdf-text-extractor.spec.ts`. It builds a tiny real one-page PDF with an embedded text layer at runtime (no fixture file) and asserts extraction; and asserts a non-PDF/garbage buffer yields empty text (not a throw):

```ts
import { PdfTextExtractor } from './pdf-text-extractor';

// A minimal valid single-page PDF containing the literal text "HELLO PDF".
// (Hand-built classic PDF: catalog, pages, page, a Helvetica font, a content
// stream drawing the text.) Kept inline so the test needs no binary fixture.
function helloPdf(): Buffer {
  const objs: string[] = [];
  objs.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objs.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  objs.push(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
  );
  objs.push(
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  );
  const stream = 'BT /F1 24 Tf 30 100 Td (HELLO PDF) Tj ET';
  objs.push(
    `5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
  );
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const o of objs) {
    offsets.push(pdf.length);
    pdf += o;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets)
    pdf += `${off.toString().padStart(10, '0')} 00000 n \n`;
  pdf +=
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

describe('PdfTextExtractor', () => {
  it('extracts the embedded text layer of a born-digital PDF', async () => {
    const text = await new PdfTextExtractor().extract(helloPdf());
    expect(text.replace(/\s+/g, ' ')).toContain('HELLO PDF');
  });

  it('returns empty string for a buffer with no usable text layer', async () => {
    const text = await new PdfTextExtractor().extract(Buffer.from('not a pdf'));
    expect(text.trim()).toBe('');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx jest src/triage/pdf-text-extractor.spec.ts` — FAIL (module missing).

- [ ] **Step 4: Implement**

Create `src/triage/pdf-text-extractor.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';

/** Minimal shape of the pdfjs text-content items we read. */
interface PdfTextItem {
  str: string;
}

/**
 * Extracts the embedded text layer of a born-digital PDF, in-process, with no
 * ML and minimal memory (pure JS pdfjs) — the cheap path that keeps a $5 VPS
 * idle for software-generated invoices. Returns the concatenated page text; an
 * empty/near-empty result signals a scanned PDF, which the router sends to OCR.
 * Never throws: a corrupt/non-PDF buffer yields ''.
 */
@Injectable()
export class PdfTextExtractor {
  private readonly logger = new Logger(PdfTextExtractor.name);

  async extract(pdf: Buffer): Promise<string> {
    try {
      // pdfjs-dist v4 is ESM; the Nest build is CJS → load via dynamic import.
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const doc = await pdfjs.getDocument({
        data: new Uint8Array(pdf),
        // No worker / no eval / no system fonts → safe & light in Node.
        isEvalSupported: false,
        useSystemFonts: false,
      }).promise;

      const pages: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const items = content.items as PdfTextItem[];
        pages.push(items.map((it) => it.str).join(' '));
      }
      await doc.destroy();
      return pages.join('\n\n').trim();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.debug(`PDF text extraction yielded nothing: ${err.message}`);
      return '';
    }
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx jest src/triage/pdf-text-extractor.spec.ts` — expect PASS. If pdfjs needs `standardFontDataUrl` warnings, they are harmless for text extraction; the test only checks text. If the dynamic import path errors under ts-jest, fall back to `import('pdfjs-dist/legacy/build/pdf.js')` (CJS legacy build) and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/triage/pdf-text-extractor.ts src/triage/pdf-text-extractor.spec.ts package.json package-lock.json
git commit -m "feat(ocr): add in-process PdfTextExtractor (pdfjs text layer)"
```

---

## Task 5: `PdfRasterizer` — scanned-PDF → PNG[] via poppler `pdftoppm`

**Files:** create `src/triage/pdf-rasterizer.ts` (+ `.spec.ts`).

Shells out to `pdftoppm` (poppler-utils). Writes the PDF to a temp dir, renders `-png -r 200`, reads the page PNGs back, cleans up. Returns one PNG buffer per page. Never throws → returns `[]` on failure (the router maps `[]` to a typed failure). The unit test gates on `pdftoppm` being present and is skipped (with a logged note) if it is not, so the suite stays green on dev machines without poppler; CI/Docker has it.

- [ ] **Step 1: Write the test**

Create `src/triage/pdf-rasterizer.spec.ts`:

```ts
import { execFileSync } from 'child_process';
import { PdfRasterizer } from './pdf-rasterizer';

function hasPdftoppm(): boolean {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// A minimal one-page PDF (no text needed — we only check it rasterises).
function blankPdf(): Buffer {
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const o of objs) { offsets.push(pdf.length); pdf += o; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${off.toString().padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

const maybe = hasPdftoppm() ? describe : describe.skip;

maybe('PdfRasterizer (requires poppler pdftoppm)', () => {
  it('renders a PDF to one PNG buffer per page', async () => {
    const pages = await new PdfRasterizer().toPngPages(blankPdf());
    expect(pages.length).toBe(1);
    // PNG magic number.
    expect(pages[0].subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  });

  it('returns [] for a non-PDF buffer (never throws)', async () => {
    const pages = await new PdfRasterizer().toPngPages(Buffer.from('garbage'));
    expect(pages).toEqual([]);
  });
});

if (!hasPdftoppm()) {
  // eslint-disable-next-line no-console
  console.warn('[pdf-rasterizer.spec] pdftoppm not found — rasterizer tests skipped');
}
```

- [ ] **Step 2: Run (expect skip locally if no poppler, or pass if installed)**

Run: `npx jest src/triage/pdf-rasterizer.spec.ts` — PASS or SKIP. (Module still must exist to import; create it next, then re-run.)

- [ ] **Step 3: Implement**

Create `src/triage/pdf-rasterizer.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);

/** Render DPI for OCR. 200 balances OCR accuracy against memory on a small VPS. */
const RENDER_DPI = '200';
/** Hard cap on pages rasterised — guards against a pathological multi-hundred-page scan. */
const MAX_PAGES = 20;

/**
 * Rasterises a (scanned) PDF to one PNG per page using poppler's `pdftoppm` —
 * a tiny, fast system binary, far lighter than node-canvas or a torch pipeline.
 * Used only on the fallback path (a PDF with no extractable text layer). Never
 * throws: returns [] on any failure (the router maps that to a typed failure).
 */
@Injectable()
export class PdfRasterizer {
  private readonly logger = new Logger(PdfRasterizer.name);

  async toPngPages(pdf: Buffer): Promise<Buffer[]> {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'ocr-raster-'));
      const inPath = join(dir, 'in.pdf');
      await writeFile(inPath, pdf);

      // pdftoppm -png -r 200 -l MAX_PAGES in.pdf <dir>/page  →  page-1.png, page-2.png, ...
      await execFileAsync('pdftoppm', [
        '-png',
        '-r', RENDER_DPI,
        '-l', String(MAX_PAGES),
        inPath,
        join(dir, 'page'),
      ]);

      const files = (await readdir(dir))
        .filter((f) => f.startsWith('page') && f.endsWith('.png'))
        .sort(); // page-1.png < page-2.png ... (zero-free; pdftoppm pads consistently)
      const pages: Buffer[] = [];
      for (const f of files) pages.push(await readFile(join(dir, f)));
      return pages;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(`PDF rasterisation failed: ${err.message}`);
      return [];
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
```

Note on sort order: `pdftoppm` pads the page number to the width of the page count (e.g. `page-1.png` for <10 pages, `page-01.png` for 10–99). A lexicographic `.sort()` is correct within a single render because the pad width is constant per run. Keep the comment.

- [ ] **Step 4: Re-run the rasterizer test**

Run: `npx jest src/triage/pdf-rasterizer.spec.ts` — PASS (or SKIP without poppler).

- [ ] **Step 5: Commit**

```bash
git add src/triage/pdf-rasterizer.ts src/triage/pdf-rasterizer.spec.ts
git commit -m "feat(ocr): add PdfRasterizer (poppler pdftoppm) for scanned-PDF fallback"
```

---

## Task 6: `MimeRoutingTranscriber` — the bound `DocumentTranscriber`

**Files:** create `src/triage/mime-routing-transcriber.ts` (+ `.spec.ts`); rewrite `src/triage/ocr.module.ts`.

This IS the `DocumentTranscriber` bound in the module. Routing:
- `image/*` → `LlmVisionTranscriber.transcribeImage({buffer, mimeType})`.
- `application/pdf` → `PdfTextExtractor.extract`; if non-empty → `{ok, markdown}`; if empty → `PdfRasterizer.toPngPages`; `[]` → `unreadable`; else OCR each page via `LlmVisionTranscriber` (PNG), concat with `\n\n---\n\n`; if every page failed → propagate the first failure; partial success → join the ok pages.
- any other mime → `unreadable`.

- [ ] **Step 1: Write the failing tests**

Create `src/triage/mime-routing-transcriber.spec.ts`:

```ts
import { MimeRoutingTranscriber } from './mime-routing-transcriber';
import { LlmVisionTranscriber } from './llm-vision-transcriber';
import { PdfTextExtractor } from './pdf-text-extractor';
import { PdfRasterizer } from './pdf-rasterizer';
import { OcrOutcome } from './document-transcriber.port';

function make(opts: {
  vision?: (mime: string) => OcrOutcome;
  pdfText?: string;
  pages?: Buffer[];
}) {
  const vision = {
    transcribeImage: jest.fn((img: { mimeType: string }) =>
      Promise.resolve(opts.vision ? opts.vision(img.mimeType) : { ok: true, markdown: 'IMG-OCR' }),
    ),
  } as unknown as LlmVisionTranscriber;
  const pdfText = {
    extract: jest.fn(() => Promise.resolve(opts.pdfText ?? '')),
  } as unknown as PdfTextExtractor;
  const raster = {
    toPngPages: jest.fn(() => Promise.resolve(opts.pages ?? [])),
  } as unknown as PdfRasterizer;
  return { t: new MimeRoutingTranscriber(vision, pdfText, raster), vision, pdfText, raster };
}

const file = (mimeType: string) => ({ buffer: Buffer.from('x'), filename: 'f', mimeType });

describe('MimeRoutingTranscriber', () => {
  it('routes image/* straight to the vision OCR', async () => {
    const { t, vision, pdfText } = make({});
    const out = await t.transcribe(file('image/jpeg'));
    expect(out).toEqual({ ok: true, markdown: 'IMG-OCR' });
    expect(vision.transcribeImage).toHaveBeenCalledTimes(1);
    expect(pdfText.extract).not.toHaveBeenCalled();
  });

  it('uses the embedded text layer for a born-digital PDF (no OCR, no raster)', async () => {
    const { t, vision, raster } = make({ pdfText: '# Invoice\nAcme Ltd' });
    const out = await t.transcribe(file('application/pdf'));
    expect(out).toEqual({ ok: true, markdown: '# Invoice\nAcme Ltd' });
    expect(raster.toPngPages).not.toHaveBeenCalled();
    expect(vision.transcribeImage).not.toHaveBeenCalled();
  });

  it('falls back to raster + per-page OCR for a scanned PDF (empty text layer)', async () => {
    const { t, vision, raster } = make({
      pdfText: '   ',
      pages: [Buffer.from('p1'), Buffer.from('p2')],
    });
    const out = await t.transcribe(file('application/pdf'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.markdown).toBe('IMG-OCR\n\n---\n\nIMG-OCR');
    expect(raster.toPngPages).toHaveBeenCalledTimes(1);
    expect(vision.transcribeImage).toHaveBeenCalledTimes(2);
  });

  it('maps a scanned PDF that will not rasterise to unreadable', async () => {
    const { t } = make({ pdfText: '', pages: [] });
    const out = await t.transcribe(file('application/pdf'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('unreadable');
  });

  it('propagates a vision failure when every scanned page fails', async () => {
    const { t } = make({
      pdfText: '',
      pages: [Buffer.from('p1')],
      vision: () => ({ ok: false, category: 'transient', detail: 'down' }),
    });
    const out = await t.transcribe(file('application/pdf'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('transient');
  });

  it('maps an unsupported mime to unreadable', async () => {
    const { t } = make({});
    const out = await t.transcribe(file('application/zip'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('unreadable');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/triage/mime-routing-transcriber.spec.ts` — FAIL (module missing).

- [ ] **Step 3: Implement**

Create `src/triage/mime-routing-transcriber.ts`:

```ts
import { Injectable } from '@nestjs/common';
import {
  DocumentTranscriber,
  OcrOutcome,
  TranscribableFile,
} from './document-transcriber.port';
import { LlmVisionTranscriber } from './llm-vision-transcriber';
import { PdfTextExtractor } from './pdf-text-extractor';
import { PdfRasterizer } from './pdf-rasterizer';

/** A born-digital text layer shorter than this is treated as "no real text"
 *  (a scanned PDF whose only glyphs are noise) → OCR fallback. */
const MIN_TEXT_CHARS = 16;
/** Page separator in the concatenated OCR of a multi-page scanned PDF. */
const PAGE_SEPARATOR = '\n\n---\n\n';

/**
 * The Pass-1 engine, routed by MIME (ADR-0032). Born-digital PDFs are text-
 * extracted in-process (no ML, no network); images and scanned PDFs are OCR'd
 * by the external vision endpoint. Keeps the heavy work off the host entirely.
 * Never throws — every path yields a typed OcrOutcome.
 */
@Injectable()
export class MimeRoutingTranscriber extends DocumentTranscriber {
  constructor(
    private readonly vision: LlmVisionTranscriber,
    private readonly pdfText: PdfTextExtractor,
    private readonly rasterizer: PdfRasterizer,
  ) {
    super();
  }

  async transcribe(file: TranscribableFile): Promise<OcrOutcome> {
    const mime = file.mimeType.toLowerCase();

    if (mime.startsWith('image/')) {
      return this.vision.transcribeImage({
        buffer: file.buffer,
        mimeType: file.mimeType,
      });
    }

    if (mime === 'application/pdf') {
      return this.transcribePdf(file.buffer);
    }

    return {
      ok: false,
      category: 'unreadable',
      detail: `Unsupported document type for OCR: ${file.mimeType}`,
    };
  }

  /** Digital PDF → text layer; scanned PDF → raster + per-page vision OCR. */
  private async transcribePdf(pdf: Buffer): Promise<OcrOutcome> {
    const text = await this.pdfText.extract(pdf);
    if (text.trim().length >= MIN_TEXT_CHARS) {
      return { ok: true, markdown: text };
    }

    // No usable text layer → scanned PDF. Rasterise and OCR each page.
    const pages = await this.rasterizer.toPngPages(pdf);
    if (pages.length === 0) {
      return {
        ok: false,
        category: 'unreadable',
        detail: 'PDF has no text layer and could not be rasterised for OCR',
      };
    }

    const markdowns: string[] = [];
    let firstFailure: OcrOutcome | null = null;
    for (const page of pages) {
      const out = await this.vision.transcribeImage({
        buffer: page,
        mimeType: 'image/png',
      });
      if (out.ok) markdowns.push(out.markdown);
      else if (!firstFailure) firstFailure = out;
    }

    if (markdowns.length === 0) {
      // Every page failed — surface the first typed failure (e.g. transient).
      return (
        firstFailure ?? {
          ok: false,
          category: 'unreadable',
          detail: 'OCR produced no text for any page',
        }
      );
    }
    return { ok: true, markdown: markdowns.join(PAGE_SEPARATOR) };
  }
}
```

- [ ] **Step 4: Run the router tests**

Run: `npx jest src/triage/mime-routing-transcriber.spec.ts` — expect PASS.

- [ ] **Step 5: Rewrite `ocr.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DocumentsModule } from '../documents/documents.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { AgentConfigModule } from '../ai/agent-config.module';
import { OcrService } from './ocr.service';
import { DocumentTranscriber } from './document-transcriber.port';
import { MimeRoutingTranscriber } from './mime-routing-transcriber';
import { LlmVisionTranscriber } from './llm-vision-transcriber';
import { PdfTextExtractor } from './pdf-text-extractor';
import { PdfRasterizer } from './pdf-rasterizer';

/**
 * OcrModule — provides OcrService (Pass 1) and binds the DocumentTranscriber
 * port to the mime-routing engine (ADR-0032): in-process pdfjs text extraction
 * for born-digital PDFs, external vision OCR (LiteLLM/dots.ocr) for images and
 * scanned PDFs (rasterised via poppler).
 *
 * Extracted from TriageModule to break the AiModule → TriageModule cycle.
 */
@Module({
  imports: [DatabaseModule, DocumentsModule, ConversationsModule, AgentConfigModule],
  providers: [
    OcrService,
    LlmVisionTranscriber,
    PdfTextExtractor,
    PdfRasterizer,
    { provide: DocumentTranscriber, useClass: MimeRoutingTranscriber },
  ],
  exports: [OcrService],
})
export class OcrModule {}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p tsconfig.build.json --noEmit` — expect CLEAN.

- [ ] **Step 7: Commit**

```bash
git add src/triage/mime-routing-transcriber.ts src/triage/mime-routing-transcriber.spec.ts src/triage/ocr.module.ts
git commit -m "feat(ocr): mime-routing transcriber (pdf text vs external vision OCR) + module wiring"
```

---

## Task 7: Ops — drop the docling sidecar, add poppler to the image

**Files:** `docker-compose.yml`, `Dockerfile`, `.env.example`.

- [ ] **Step 1: Remove the `docling` service + `DOCLING_BASE_URL` from compose**

In `docker-compose.yml`: delete the entire `docling:` service block, and from `app` remove the `DOCLING_BASE_URL=...` environment line and the `depends_on: [docling]`.

- [ ] **Step 2: Install poppler in the production image**

In `Dockerfile`, the production stage currently runs `apk add --no-cache python3 make g++ curl && ...`. Add `poppler-utils`:

```dockerfile
RUN apk add --no-cache python3 make g++ curl poppler-utils && \
```

(Keep the rest of that `RUN` unchanged.)

- [ ] **Step 3: Replace `.env.example`**

Overwrite `.env.example`:

```bash
# Pass-1 OCR uses the same OpenAI-compatible inference endpoint as the AI agents
# (LiteLLM proxying dots.ocr). Configure via admin settings, not env:
#   ai_base_url   — LiteLLM base URL (…/v1)
#   ai_api_key    — LiteLLM key
#   ai_model.ocr  — the dots.ocr model id LiteLLM routes to
# Born-digital PDFs are text-extracted in-process (pdfjs); scanned PDFs are
# rasterised with poppler (pdftoppm) before OCR. No OCR sidecar to run.
```

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml Dockerfile .env.example
git commit -m "ops(ocr): drop docling sidecar; install poppler-utils for rasterisation"
```

---

## Task 8: Docs — rewrite ADR-0032, update ADR-0024

**Files:** `docs/adr/0032-docling-pass1-transcription-sidecar.md`, `docs/adr/0024-...md`.

- [ ] **Step 1: Rewrite ADR-0032**

Replace the whole file with the lightweight decision. Rename the heading to `# Pass-1 OCR is mime-routed: in-process pdfjs text layer + external vision OCR (LiteLLM/dots.ocr)`. Body must record: target is a $5 VPS (≈1 GB RAM); Docling-serve was prototyped and REJECTED because torch+easyocr OOM (and its PDF path also uses a torch layout model); the chosen design routes by MIME — born-digital PDF → in-process pdfjs (no ML), images + scanned PDFs → external OpenAI-compatible vision endpoint (LiteLLM proxying dots.ocr) reusing `ai_base_url`/`ai_api_key`+`ai_model.ocr`; scanned PDFs rasterised by poppler `pdftoppm`; the `DocumentTranscriber` port made the swap a leaf change. Consequences: an external OCR endpoint is now a hard dependency for images/scans (unset → `provider-unavailable` → `needs_triage`); poppler-utils is a runtime system dep; dots.ocr ignores the prompt (no `prompt.ocr`); table-structure reconstruction (a Docling perk) is given up for the RAM budget. Keep a short "History" note that an earlier revision of this ADR chose Docling.

- [ ] **Step 2: Update ADR-0024's Pass-1 paragraph**

Re-point the Pass-1 sentence: transcription is via the `DocumentTranscriber` port, whose bound adapter routes by MIME — in-process pdfjs text extraction for born-digital PDFs, and an external OpenAI-compatible vision model (LiteLLM/dots.ocr) for images and rasterised scanned PDFs (ADR-0032). Keep the rest intact.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0032-docling-pass1-transcription-sidecar.md docs/adr/0024-ai-ingestion-mastra-two-pass-ocr-durable-hitl.md
git commit -m "docs(adr): rewrite ADR-0032 for the lightweight mime-routed Pass-1"
```

---

## Task 9: Full gate

- [ ] **Step 1: Typecheck** — `npx tsc -p tsconfig.build.json --noEmit` → CLEAN.
- [ ] **Step 2: Lint** — `npm run lint` → CLEAN (G5: zero `any`). After lint, `git checkout -- src/admin/settings.registry.ts` ONLY IF the sole diff there is the known cosmetic `ai_base_url` line-wrap AND your `ai_model.ocr` addition is preserved — otherwise re-add the key. (Inspect `git diff` first.)
- [ ] **Step 3: Unit suite** — `npm test` → all green (incl. `ocr.service.spec.ts` via the stubbed port, the four new adapter specs; `pdf-rasterizer.spec` passes or skips by poppler presence).
- [ ] **Step 4: E2E suite** — `npm run test:e2e` → all green. `test/intake.e2e-spec.ts` already overrides `DocumentTranscriber` with a stub, so it is engine-agnostic and needs no change. **This step is mandatory — `npm test` does not run it.**
- [ ] **Step 5: Confirm no Docling residue** — `grep -rn "docling\|Docling\|DOCLING" src/ test/ docker-compose.yml Dockerfile` → only the ADR-0032 filename/History mention remains.

## Self-Review checklist

1. Port unchanged; `OcrService` + its spec + intake e2e untouched (all engine-agnostic via the stubbed port).
2. `MimeRoutingTranscriber` is the only `DocumentTranscriber`; sub-adapters are plain providers.
3. `LlmVisionTranscriber` config flows from `resolveModelConfig('ocr')` → bare string (no base URL) maps to `provider-unavailable`.
4. Never-throws holds in every adapter (fetch, json, child_process, pdfjs all guarded).
5. Zero `any`; the only casts are typed `unknown`→local-interface JSON narrowings, consistent with the codebase.
6. Footprint: pdfjs (JS) + poppler (system) only; no torch/canvas/sidecar — fits a $5 VPS.
