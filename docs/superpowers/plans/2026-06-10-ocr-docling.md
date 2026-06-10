# Proper Pass-1 OCR via Docling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the faux Pass-1 OCR model with a real document→markdown transcription engine (Docling, run as a `docling-serve` sidecar), behind a testable port, without touching `OcrService`'s persistence / CRC32 / idempotency / race-safety / `OcrOutcome` / needs_triage-routing machinery.

**Architecture:** A new `DocumentTranscriber` port (abstract class as DI token, mirroring `TelegramApi`) owns the single concern "document bytes → markdown | typed failure". Its one real adapter, `DoclingTranscriber`, POSTs the document file to `docling-serve` (`POST {DOCLING_BASE_URL}/v1alpha/convert/file`, `to_formats=md`) using Node 24 global `fetch`/`FormData`/`Blob`, parses `document.md_content`, and maps HTTP/status outcomes to the existing `OcrFailureCategory`. `OcrService` fetches the document bytes (`DocumentsService.getFile`) only on the non-idempotent path and delegates transcription to the port; everything else it already does stays byte-for-byte the same. The faux model and the dead `extract()` stub are deleted. `DOCLING_BASE_URL` comes from env (matching the `process.env` precedent in `dev.agent.ts` / `main.ts`).

**Tech Stack:** NestJS 11, Kysely over better-sqlite3, Jest 30, TypeScript strict (zero `any`/`as`), Node 24 (global fetch/FormData/Blob), Docling `docling-serve` (official CPU Docker image).

**Engine decision (resolved in design interview):** Docling subsumes the tiered "born-digital text-layer + OCR-fallback" design in one HTTP call — it extracts the embedded text layer for digital PDFs (no model), OCRs scanned/image documents (easyocr default, enabled by default), and reconstructs tables → markdown. Chosen over dots.ocr (OCR-only VLM, no table semantics, GPU) and over a hand-rolled `pdf-parse` + rasterizer + dots.ocr pipeline (rebuilds what Docling gives for free). See ADR-0032 (Task 6).

---

## Node environment

**Every shell in this plan must start with:**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null;
```

Node 22 breaks better-sqlite3 (NODE_MODULE_VERSION mismatch). Run all commands from the worktree root `/Users/alekseirevin/test/hb-ocr`.

## File Structure

- **Create** `src/triage/document-transcriber.port.ts` — the `DocumentTranscriber` abstract port + the transcription-outcome vocabulary (`OcrOutcome`, `OcrSuccess`, `OcrFailure`, `OcrFailureCategory`), moved here from `ocr.service.ts` so the port and the service share one source of truth without a circular import.
- **Create** `src/triage/docling-transcriber.ts` — `DoclingTranscriber` (the one real adapter).
- **Create** `src/triage/docling-transcriber.spec.ts` — adapter unit tests (global `fetch` mocked; no DB, no Nest).
- **Modify** `src/triage/ocr.service.ts` — inject the port, delete `fauxOcrModel` + `extract()`, re-export the outcome types from the port, delegate transcription.
- **Modify** `src/triage/ocr.module.ts` — provide `DocumentTranscriber` → `DoclingTranscriber`.
- **Modify** `src/triage/ocr.service.spec.ts` — stub the port, write real document bytes in `seedDocument`, drop the `extract` tests, replace faux-content assertions with stubbed markdown.
- **Modify** `docker-compose.yml` — add the `docling` service + `DOCLING_BASE_URL` on `app`.
- **Create** `.env.example` — document `DOCLING_BASE_URL`.
- **Create** `docs/adr/0032-docling-pass1-transcription-sidecar.md` — record the engine + sidecar decision.
- **Modify** `docs/adr/0024-ai-ingestion-mastra-two-pass-ocr-durable-hitl.md` — point Pass-1 at Docling.

Untouched on purpose: `src/ai/intake-workflow.service.ts` (the Pass-1→Pass-2 seam is unchanged — it still calls `ocrService.transcribe` and reads `OcrOutcome`) and `src/ai/intake-workflow.service.spec.ts` (it mocks `OcrService.transcribe` directly).

---

## Task 1: Define the `DocumentTranscriber` port and move the outcome vocabulary

**Files:**
- Create: `src/triage/document-transcriber.port.ts`
- Modify: `src/triage/ocr.service.ts:32-52` (remove the type block; re-export from the port)

The port owns "bytes → markdown | typed failure". It returns the SAME `OcrOutcome` the service already exposes, so no mapping layer is needed. The types move to the port file to avoid a circular import (`ocr.service` will import the port, and the port must not import `ocr.service`).

- [ ] **Step 1: Create the port file with the moved vocabulary**

Create `src/triage/document-transcriber.port.ts`:

```ts
// src/triage/document-transcriber.port.ts

/**
 * Why a Pass-1 transcription failed. The intake workflow routes a transcription
 * failure to a human through the SAME typed-outcome seam as a Pass-2
 * classification failure (ADR-0024) — instead of an exception escaping and
 * leaving the Document stuck in `pending` with no AuditFinding.
 *
 *  - 'provider-unavailable': the transcription service (docling-serve) is not
 *                            configured (no DOCLING_BASE_URL) or is unreachable
 *                            (connection refused) — no transcription attempted.
 *  - 'unreadable':           the document was sent but cannot be transcribed
 *                            (corrupt, blank, unsupported format, empty result)
 *                            — a permanent content problem.
 *  - 'transient':            an IO/temporary fault (timeout, 5xx, a stored
 *                            artifact file went missing) — likely retryable.
 *
 * A missing Document is NOT a category: it is a precondition violation (the
 * caller handed a bad id) with no object to route, so `OcrService.transcribe`
 * throws for that case before ever reaching the port.
 */
export type OcrFailureCategory =
  | 'provider-unavailable'
  | 'unreadable'
  | 'transient';

/** A successful Pass-1 transcription. */
export interface OcrSuccess {
  ok: true;
  markdown: string;
}

/** A Pass-1 failure carrying an explicit, observable category. */
export interface OcrFailure {
  ok: false;
  category: OcrFailureCategory;
  /** Human-readable detail (the underlying error message). */
  detail: string;
}

/** Discriminated outcome of a Pass-1 transcription attempt. */
export type OcrOutcome = OcrSuccess | OcrFailure;

/** The raw document handed to a transcriber: bytes plus the metadata a
 *  multipart upload needs. Matches DocumentsService.getFile's return shape. */
export interface TranscribableFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

/**
 * The Pass-1 transcription edge: document bytes → markdown | typed failure.
 *
 * Mocked in every OcrService test; only the real adapter (DoclingTranscriber)
 * does network I/O. This is the single seam where the OCR engine is chosen —
 * OcrService's persistence/CRC/idempotency/race-safety machinery sits ENTIRELY
 * on the OcrOutcome contract and is engine-agnostic.
 */
export abstract class DocumentTranscriber {
  abstract transcribe(file: TranscribableFile): Promise<OcrOutcome>;
}
```

- [ ] **Step 2: Run typecheck to verify the new file compiles**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; npx tsc --noEmit`
Expected: PASS (no references yet beyond the new file).

- [ ] **Step 3: Re-export the types from `ocr.service.ts` and delete the local block**

In `src/triage/ocr.service.ts`, delete the entire type block (the `OcrFailureCategory`, `OcrSuccess`, `OcrFailure`, `OcrOutcome` declarations, currently lines ~11-52 including their doc comment) and replace with a re-export so existing importers (`intake-workflow.service.ts` imports `OcrFailureCategory` from here) keep working:

```ts
// Pass-1 transcription vocabulary now lives with the port that produces it.
// Re-exported so existing importers (IntakeWorkflowService) need no change.
export type {
  OcrFailureCategory,
  OcrSuccess,
  OcrFailure,
  OcrOutcome,
} from './document-transcriber.port';
```

(Leave the `import` lines and the rest of the file for Task 3.)

- [ ] **Step 4: Run typecheck**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; npx tsc --noEmit`
Expected: PASS — `intake-workflow.service.ts`'s `import { OcrFailureCategory } from '../triage/ocr.service'` still resolves via the re-export. (`ocr.service.ts` itself will still type-check because `fauxOcrModel` returns `string`; it's replaced in Task 3.)

- [ ] **Step 5: Commit**

```bash
git add src/triage/document-transcriber.port.ts src/triage/ocr.service.ts
git commit -m "refactor(ocr): extract DocumentTranscriber port + outcome vocabulary"
```

---

## Task 2: Implement and test the `DoclingTranscriber` HTTP adapter

**Files:**
- Create: `src/triage/docling-transcriber.ts`
- Test: `src/triage/docling-transcriber.spec.ts`

The adapter is pure I/O: it reads `process.env.DOCLING_BASE_URL` at call time (precedent: `dev.agent.ts` reads `process.env.DEV_AGENT_ENABLED`), POSTs a multipart body, and maps the response to `OcrOutcome`. It must NEVER throw — all faults become a typed `OcrFailure`.

**docling-serve contract (verified against docs):**
- `POST {base}/v1alpha/convert/file`, `multipart/form-data` with fields `files` (the document, with its MIME type) and `to_formats=md`.
- Response JSON: `{ "document": { "md_content": "..." }, "status": "success|partial_success|skipped|failure", "errors": [...] }`.

**Failure mapping:**
| Situation | Category |
|---|---|
| `DOCLING_BASE_URL` unset/empty | `provider-unavailable` |
| `fetch` rejects, `err.name` is `AbortError`/`TimeoutError` | `transient` |
| `fetch` rejects otherwise (connection refused / DNS) | `provider-unavailable` |
| HTTP 5xx | `transient` |
| HTTP 4xx | `unreadable` |
| HTTP 200 but `status === 'failure'` or `'skipped'`, or `md_content` empty/whitespace | `unreadable` |
| HTTP 200, `status` `success`/`partial_success`, non-empty `md_content` | `ok` (markdown) |

- [ ] **Step 1: Write the failing adapter tests**

Create `src/triage/docling-transcriber.spec.ts`:

```ts
import { DoclingTranscriber } from './docling-transcriber';
import { TranscribableFile } from './document-transcriber.port';

describe('DoclingTranscriber', () => {
  const file: TranscribableFile = {
    buffer: Buffer.from('%PDF-1.4 fake'),
    filename: 'invoice.pdf',
    mimeType: 'application/pdf',
  };
  const ENV = process.env.DOCLING_BASE_URL;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.DOCLING_BASE_URL = 'http://docling:5001';
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    if (ENV === undefined) delete process.env.DOCLING_BASE_URL;
    else process.env.DOCLING_BASE_URL = ENV;
    jest.restoreAllMocks();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response;
  }

  it('POSTs a multipart convert request and returns the markdown on success', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ document: { md_content: '# Invoice\nAcme Ltd' }, status: 'success', errors: [] }),
    );
    const out = await new DoclingTranscriber().transcribe(file);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.markdown).toBe('# Invoice\nAcme Ltd');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://docling:5001/v1alpha/convert/file');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get('to_formats')).toBe('md');
    expect(form.get('files')).toBeInstanceOf(Blob);
  });

  it('accepts partial_success', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ document: { md_content: '# x' }, status: 'partial_success', errors: [] }),
    );
    const out = await new DoclingTranscriber().transcribe(file);
    expect(out.ok).toBe(true);
  });

  it('maps empty md_content to unreadable', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ document: { md_content: '   ' }, status: 'success', errors: [] }),
    );
    const out = await new DoclingTranscriber().transcribe(file);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('unreadable');
  });

  it('maps status=failure to unreadable', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ document: { md_content: '' }, status: 'failure', errors: ['bad pdf'] }),
    );
    const out = await new DoclingTranscriber().transcribe(file);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('unreadable');
  });

  it('maps HTTP 4xx to unreadable', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 422));
    const out = await new DoclingTranscriber().transcribe(file);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('unreadable');
  });

  it('maps HTTP 5xx to transient', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 503));
    const out = await new DoclingTranscriber().transcribe(file);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('transient');
  });

  it('maps a connection error to provider-unavailable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const out = await new DoclingTranscriber().transcribe(file);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('provider-unavailable');
  });

  it('maps a timeout (AbortError) to transient', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    fetchMock.mockRejectedValue(abort);
    const out = await new DoclingTranscriber().transcribe(file);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('transient');
  });

  it('maps a missing DOCLING_BASE_URL to provider-unavailable without calling fetch', async () => {
    delete process.env.DOCLING_BASE_URL;
    const out = await new DoclingTranscriber().transcribe(file);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('provider-unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; npx jest src/triage/docling-transcriber.spec.ts`
Expected: FAIL — `Cannot find module './docling-transcriber'`.

- [ ] **Step 3: Implement the adapter**

Create `src/triage/docling-transcriber.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import {
  DocumentTranscriber,
  OcrOutcome,
  TranscribableFile,
} from './document-transcriber.port';

/** Path of the docling-serve convert endpoint, relative to DOCLING_BASE_URL.
 *  Verified against the pinned docling-serve image tag (see docker-compose). */
const CONVERT_PATH = '/v1alpha/convert/file';

/** Per-request ceiling. OCR of a scanned multi-page PDF on CPU is slow; give it
 *  room but cap it so a hung sidecar surfaces as a transient failure. */
const REQUEST_TIMEOUT_MS = 120_000;

/** Shape of the slice of the docling-serve response we read. */
interface DoclingConvertResponse {
  document?: { md_content?: string };
  status?: string;
  errors?: unknown[];
}

/**
 * Real Pass-1 transcriber — sends the document to a `docling-serve` sidecar and
 * returns its markdown. Uses Node 24 global fetch/FormData/Blob; never throws
 * (all faults map to a typed OcrFailure). The base URL is read from the
 * environment at call time (precedent: dev.agent.ts reads process.env).
 */
@Injectable()
export class DoclingTranscriber extends DocumentTranscriber {
  private readonly logger = new Logger(DoclingTranscriber.name);

  async transcribe(file: TranscribableFile): Promise<OcrOutcome> {
    const base = process.env.DOCLING_BASE_URL?.trim();
    if (!base) {
      this.logger.warn('DOCLING_BASE_URL unset — cannot transcribe');
      return {
        ok: false,
        category: 'provider-unavailable',
        detail: 'DOCLING_BASE_URL is not configured',
      };
    }

    const form = new FormData();
    form.append(
      'files',
      new Blob([file.buffer], { type: file.mimeType }),
      file.filename,
    );
    form.append('to_formats', 'md');

    let response: Response;
    try {
      response = await fetch(`${base}${CONVERT_PATH}`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const timedOut = err.name === 'AbortError' || err.name === 'TimeoutError';
      const category = timedOut ? 'transient' : 'provider-unavailable';
      this.logger.warn(`docling-serve unreachable (${category}): ${err.message}`);
      return { ok: false, category, detail: err.message };
    }

    if (!response.ok) {
      // 5xx = server-side blip (retryable); 4xx = the document/request is bad.
      const category = response.status >= 500 ? 'transient' : 'unreadable';
      const detail = `docling-serve returned HTTP ${response.status}`;
      this.logger.warn(`${detail} (${category})`);
      return { ok: false, category, detail };
    }

    const body = (await response.json()) as DoclingConvertResponse;
    const markdown = body.document?.md_content ?? '';
    const failed = body.status === 'failure' || body.status === 'skipped';

    if (failed || markdown.trim().length === 0) {
      const detail = `docling-serve produced no markdown (status=${body.status ?? 'unknown'})`;
      this.logger.warn(detail);
      return { ok: false, category: 'unreadable', detail };
    }

    return { ok: true, markdown };
  }
}
```

- [ ] **Step 4: Run the adapter tests to verify they pass**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; npx jest src/triage/docling-transcriber.spec.ts`
Expected: PASS (9/9).

- [ ] **Step 5: Commit**

```bash
git add src/triage/docling-transcriber.ts src/triage/docling-transcriber.spec.ts
git commit -m "feat(ocr): add DoclingTranscriber adapter for docling-serve"
```

---

## Task 3: Wire `OcrService` to the port; delete the faux model and dead `extract()`

**Files:**
- Modify: `src/triage/ocr.service.ts`
- Modify: `src/triage/ocr.module.ts`

`OcrService` keeps every line of its persistence / CRC32 / idempotency / race-safety / catch→transient logic. Only the source of `markdown` changes: from the sync pure `fauxOcrModel(documentId, filename)` to the async `this.transcriber.transcribe(await this.documentsService.getFile(documentId))`. Because the port returns the same `OcrOutcome`, a port failure short-circuits with no persistence. The dead `extract()` (no non-test callers — verified by grep) is removed.

- [ ] **Step 1: Update imports, constructor, and delete `fauxOcrModel` + `extract()`**

In `src/triage/ocr.service.ts`:

1. Add the port import (keep the existing `TriageResult` import removal — it's only used by `extract`, which is being deleted):

```ts
import { DocumentTranscriber } from './document-transcriber.port';
```

Remove the now-unused `import { TriageResult } from './types';`.

2. Inject the port in the constructor:

```ts
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly documentsService: DocumentsService,
    private readonly transcriber: DocumentTranscriber,
  ) {}
```

3. Delete the entire `fauxOcrModel` function (the `function fauxOcrModel(...) { ... }` block and its doc comment).

4. Delete the entire `extract(documentId): TriageResult { ... }` method and its doc comment.

- [ ] **Step 2: Add the private `callTranscriber` helper and route both transcription sites through it**

Add this private helper (next to the other private helpers):

```ts
  /**
   * Fetch the document bytes and hand them to the transcription port. Used by
   * the two non-idempotent paths (no artifact yet; CRC mismatch). The
   * idempotent fast path never calls this — it reuses stored markdown, so a
   * re-run of an already-transcribed Document never re-hits the engine.
   */
  private async callTranscriber(documentId: number): Promise<OcrOutcome> {
    const file = await this.documentsService.getFile(documentId);
    return this.transcriber.transcribe(file);
  }
```

`OcrOutcome` is available in this file via the Task 1 re-export — keep that `export type { ... } from './document-transcriber.port'`. Add a value-free type import if `tsc` flags it as unreferenced in the local scope:

```ts
import type { OcrOutcome } from './document-transcriber.port';
```

(If the re-export already brings the name into scope for annotation, skip the extra import — let `tsc --noEmit` decide.)

- [ ] **Step 3: Replace the two `fauxOcrModel(...)` call sites with the port**

In `transcribe()`:

**CRC-mismatch branch** — replace:

```ts
          // CRC mismatch: content changed on disk → overwrite + update row.
          const markdown = fauxOcrModel(documentId, document.filename);
          const computedCrc = crc32(markdown);
```

with:

```ts
          // CRC mismatch: content changed on disk → re-transcribe authoritative
          // markdown, overwrite the file + update the row. A transcription
          // failure here short-circuits (no persistence) with its typed category.
          const result = await this.callTranscriber(documentId);
          if (!result.ok) return result;
          const markdown = result.markdown;
          const computedCrc = crc32(markdown);
```

**No-artifact branch** — replace:

```ts
      // 3. Call the OCR model (faux for v1) and compute its CRC32.
      const markdown = fauxOcrModel(documentId, document.filename);
      const computedCrc = crc32(markdown);
```

with:

```ts
      // 3. Transcribe via the port and compute the markdown's CRC32. A typed
      //    transcription failure short-circuits before any file/artifact write.
      const result = await this.callTranscriber(documentId);
      if (!result.ok) return result;
      const markdown = result.markdown;
      const computedCrc = crc32(markdown);
```

The surrounding catch block stays — `getFile` ENOENT / a stored-file vanish / an fs write fault still becomes `{ ok: false, category: 'transient', detail }`. The `document` variable from `getById` may now be unused; if `tsc` flags it, keep the `getById` call (it is the precondition throw for a missing Document — a tested contract) but drop the unused binding: `await this.documentsService.getById(documentId);`.

- [ ] **Step 4: Wire the provider in `OcrModule`**

In `src/triage/ocr.module.ts`, provide the port→adapter binding:

```ts
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DocumentsModule } from '../documents/documents.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { OcrService } from './ocr.service';
import { DocumentTranscriber } from './document-transcriber.port';
import { DoclingTranscriber } from './docling-transcriber';

/**
 * OcrModule — provides OcrService (Pass 1 OCR transcription) and binds the
 * DocumentTranscriber port to its real adapter (DoclingTranscriber → docling-serve).
 *
 * Extracted from TriageModule to break the circular dependency:
 * AiModule → TriageModule → AiModule.
 */
@Module({
  imports: [DatabaseModule, DocumentsModule, ConversationsModule],
  providers: [
    OcrService,
    { provide: DocumentTranscriber, useClass: DoclingTranscriber },
  ],
  exports: [OcrService],
})
export class OcrModule {}
```

- [ ] **Step 5: Run typecheck**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; npx tsc --noEmit`
Expected: PASS. (`ocr.service.spec.ts` will not compile yet — that is Task 4. `tsc --noEmit` covers the whole project including specs, so it MAY report errors only in `ocr.service.spec.ts`. That is expected; confirm the only errors are in that spec file. If so, proceed — Task 4 fixes them. If there are errors in non-spec files, fix them here.)

- [ ] **Step 6: Commit**

```bash
git add src/triage/ocr.service.ts src/triage/ocr.module.ts
git commit -m "feat(ocr): route Pass-1 transcription through the DocumentTranscriber port"
```

---

## Task 4: Rewrite `ocr.service.spec.ts` against a stubbed port

**Files:**
- Modify: `src/triage/ocr.service.spec.ts`

The spec must (a) provide a stub `DocumentTranscriber`, (b) write real document bytes in `seedDocument` (the service now reads them via `getFile` before transcribing), (c) drop the three `extract` tests (method deleted), and (d) replace faux-content assertions ("# Receipt"/Bolt/"# Invoice"/Acme) with the stub's markdown. The idempotency test additionally asserts the port is hit exactly once.

- [ ] **Step 1: Replace the test module setup and `seedDocument` to inject the stub port and persist bytes**

In `src/triage/ocr.service.spec.ts`:

1. Add imports near the top:

```ts
import { DocumentTranscriber } from './document-transcriber.port';
import type { OcrOutcome, TranscribableFile } from './document-transcriber.port';
```

2. Add a controllable stub above the test module. The default returns fixed markdown; tests can override `impl` per case and inspect `calls`:

```ts
  const STUB_MARKDOWN = '# Transcribed\n\nSupplier: Acme Ltd\nTotal: €123.00';

  class StubTranscriber extends DocumentTranscriber {
    calls: TranscribableFile[] = [];
    impl: (file: TranscribableFile) => OcrOutcome = () => ({
      ok: true,
      markdown: STUB_MARKDOWN,
    });
    transcribe(file: TranscribableFile): Promise<OcrOutcome> {
      this.calls.push(file);
      return Promise.resolve(this.impl(file));
    }
  }
```

3. Declare `let transcriber: StubTranscriber;` alongside the other `let` bindings, and add a temp storage root so `getFile` can read seeded bytes. Replace the `providers` array to inject the stub and a `DOCUMENT_STORAGE_ROOT`:

```ts
    transcriber = new StubTranscriber();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        { provide: DOCUMENT_STORAGE_ROOT, useValue: storageRoot },
        DocumentStorageService,
        DocumentsService,
        ConversationsService,
        OcrService,
        { provide: DocumentTranscriber, useValue: transcriber },
      ],
    }).compile();
```

Add the storage-root imports and lifecycle at the top of `describe`:

```ts
import { DOCUMENT_STORAGE_ROOT } from '../documents/document-storage.service';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
```

```ts
  let storageRoot: string;
```

In `beforeEach`, before building the module: `storageRoot = mkdtempSync(join(tmpdir(), 'ocr-spec-'));`
In `afterEach`, after `db.destroy()`: `rmSync(storageRoot, { recursive: true, force: true });`

4. Rewrite `seedDocument` to write real bytes under the storage root and record the relative `storage_path` (so `DocumentsService.getFile` → `DocumentStorageService.readFile` resolves):

```ts
    async function seedDocument(filename: string) {
      const now = Math.floor(Date.now() / 1000);
      const doc = await db
        .insertInto('document')
        .values({
          hash: `hash-${filename}`,
          filename,
          mime_type: 'application/pdf',
          size_bytes: 1000,
          storage_path: null,
          status: 'pending',
          created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      // Persist real bytes so OcrService.getFile can read them before transcribe.
      const storage = module.get(DocumentStorageService);
      const relPath = await storage.saveFile(
        doc.id,
        filename,
        Buffer.from(`%PDF-1.4 ${filename}`),
      );
      await db
        .updateTable('document')
        .set({ storage_path: relPath })
        .where('id', '=', doc.id)
        .execute();
      return doc.id;
    }
```

(`module` must be accessible in `seedDocument`; hoist `let module: TestingModule;` to the `describe` scope and assign it in `beforeEach`.)

- [ ] **Step 2: Delete the three `extract` tests**

Remove the entire `describe('extract', () => { ... })` block (the three `it(...)` cases for odd/even/deterministic). `extract()` no longer exists.

- [ ] **Step 3: Rewrite the content assertions to the stub markdown**

Replace the two faux-content cases with the stub's output. Replace:

```ts
    it('returns markdown for a receipt-like document (odd id)', async () => {
      const docId = await seedDocument('receipt-bolt.pdf');
      const outcome = await service.transcribe(docId);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.markdown).toContain('# Receipt');
      expect(outcome.markdown).toContain('Bolt');
      expect(outcome.markdown).toContain('€15.25');
    });

    it('returns markdown for an invoice-like document (even id)', async () => {
      const docId = await seedDocument('invoice-acme.pdf');
      const outcome = await service.transcribe(docId);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.markdown).toContain('# Invoice');
      expect(outcome.markdown).toContain('Acme Ltd');
      expect(outcome.markdown).toContain('€123.00');
    });
```

with:

```ts
    it('returns the transcriber markdown for a document', async () => {
      const docId = await seedDocument('invoice-acme.pdf');
      const outcome = await service.transcribe(docId);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.markdown).toBe(STUB_MARKDOWN);
      // The transcriber received the seeded bytes + metadata.
      expect(transcriber.calls).toHaveLength(1);
      expect(transcriber.calls[0].filename).toBe('invoice-acme.pdf');
      expect(transcriber.calls[0].mimeType).toBe('application/pdf');
    });

    it('routes a typed transcriber failure straight through (no persistence)', async () => {
      const docId = await seedDocument('broken.pdf');
      transcriber.impl = () => ({
        ok: false,
        category: 'unreadable',
        detail: 'docling-serve produced no markdown',
      });

      const outcome = await service.transcribe(docId);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.category).toBe('unreadable');

      // No artifact was written for a failed transcription.
      const count = await db
        .selectFrom('artifact')
        .select(db.fn.count('id').as('cnt'))
        .where('kind', '=', 'ocr_markdown')
        .where('document_id', '=', docId)
        .executeTakeFirst();
      expect(Number(count!.cnt)).toBe(0);
    });
```

Then in the remaining cases that asserted faux content, swap the assertion: in `'returns an ok outcome carrying the markdown on success'` replace `expect(outcome.markdown).toContain('# Receipt');` with `expect(outcome.markdown).toBe(STUB_MARKDOWN);`. The artifact/conversation/association/NotFound/transient/race tests keep their structure — they assert persistence, not content — and now exercise the stub. The `crc32` artifact test still passes (`crc32` is computed over `STUB_MARKDOWN`).

- [ ] **Step 4: Strengthen the idempotency test to assert one engine call**

In `'is idempotent — re-running reads stored markdown without re-calling model'`, after the two `transcribe` calls add:

```ts
      // The engine was hit once; the second call served from the stored artifact.
      expect(transcriber.calls).toHaveLength(1);
```

In `'detects content changes via crc32 mismatch and re-transcribes'`, the stub is hit twice (initial + after tamper). After the second `transcribe`, add:

```ts
      expect(transcriber.calls).toHaveLength(2);
```

(The CRC-mismatch branch re-reads bytes and re-calls the port; the stub returns `STUB_MARKDOWN` both times, so `second.markdown === first.markdown` holds and the tamper is overwritten.)

- [ ] **Step 5: Run the OcrService spec**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; npx jest src/triage/ocr.service.spec.ts`
Expected: PASS — all transcribe cases plus the two new ones; no `extract` block.

- [ ] **Step 6: Commit**

```bash
git add src/triage/ocr.service.spec.ts
git commit -m "test(ocr): exercise OcrService through a stubbed DocumentTranscriber"
```

---

## Task 5: Add the `docling-serve` sidecar to compose + document the env

**Files:**
- Modify: `docker-compose.yml`
- Create: `.env.example`

- [ ] **Step 1: Add the `docling` service and wire `DOCLING_BASE_URL`**

Edit `docker-compose.yml` to add the sidecar and point `app` at it:

```yaml
services:
  app:
    build:
      context: .
      target: production
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DOCLING_BASE_URL=http://docling:5001
    depends_on:
      - docling
    volumes:
      - ./data:/app/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  # Pass-1 OCR engine (ADR-0032): born-digital text-layer extraction + OCR of
  # scanned/image documents + table reconstruction → markdown, over HTTP. CPU
  # image (models pre-baked). Swap to a docling-serve-cu* tag for GPU.
  docling:
    image: quay.io/docling-project/docling-serve-cpu:latest
    ports:
      - "5001:5001"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5001/health"]
      interval: 30s
      timeout: 10s
      retries: 5

  test:
    build:
      context: .
      target: test
    command: ["npm", "run", "test"]
    environment:
      - NODE_ENV=test
```

- [ ] **Step 2: Create `.env.example`**

```bash
# Pass-1 OCR transcription engine (docling-serve sidecar). Unset → Pass-1 reports
# provider-unavailable and the document routes to needs_triage (ADR-0024/0032).
DOCLING_BASE_URL=http://localhost:5001
```

- [ ] **Step 3: Verify the convert endpoint path against the pinned image (manual, best-effort)**

If Docker is available, confirm the path the adapter targets:

```bash
docker run -d --rm -p 5001:5001 --name docling-verify quay.io/docling-project/docling-serve-cpu:latest
# wait for health, then:
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:5001/v1alpha/convert/file \
  -F 'files=@README.md;type=text/markdown' -F 'to_formats=md'
docker stop docling-verify
```

Expected: a 2xx (or 422 for the trivial input) — NOT 404. A 404 means the pinned tag uses `/v1/convert/file`; if so, update `CONVERT_PATH` in `src/triage/docling-transcriber.ts` and its spec URL assertion, then re-run `npx jest src/triage/docling-transcriber.spec.ts`. If Docker is unavailable, note this verification as deferred in the commit body.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "ops(ocr): add docling-serve sidecar + DOCLING_BASE_URL"
```

---

## Task 6: Record the decision (ADR-0032) and update ADR-0024

**Files:**
- Create: `docs/adr/0032-docling-pass1-transcription-sidecar.md`
- Modify: `docs/adr/0024-ai-ingestion-mastra-two-pass-ocr-durable-hitl.md`

- [ ] **Step 1: Write ADR-0032**

Create `docs/adr/0032-docling-pass1-transcription-sidecar.md`:

```markdown
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
- The convert endpoint path (`/v1alpha/convert/file`) is pinned to the image tag
  and must be re-verified when the tag is bumped.

## Alternatives rejected
- **dots.ocr / bare VLM**: OCR-only, no table semantics, GPU-bound — more cost for
  less structure than Docling on born-digital PDFs (the common case).
- **Hand-rolled tiered pipeline**: rebuilds, and then maintains, text extraction +
  rasterization + an OCR fallback that Docling already ships and tests.
```

- [ ] **Step 2: Update ADR-0024's Pass-1 description**

In `docs/adr/0024-ai-ingestion-mastra-two-pass-ocr-durable-hitl.md`, find the Pass-1 sentence describing transcription by "a vision/OCR model (per the `ocr` LLM profile, CONFIG)" and replace the engine clause so it reads (keep surrounding text intact):

> Pass-1 transcribes the Document to markdown via the **`DocumentTranscriber` port**, whose real adapter calls a **Docling `docling-serve` sidecar** (ADR-0032) — born-digital text-layer extraction, OCR of scanned/image content, and table reconstruction in one call; the engine is told to transcribe, not structure. The markdown is stored as a Conversation Artifact (`kind='ocr_markdown'`).

If the exact wording differs, preserve the paragraph's meaning and only swap the engine description; add the `(ADR-0032)` cross-reference.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0032-docling-pass1-transcription-sidecar.md docs/adr/0024-ai-ingestion-mastra-two-pass-ocr-durable-hitl.md
git commit -m "docs(adr): record Docling Pass-1 transcription sidecar (ADR-0032)"
```

---

## Task 7: Full gate — typecheck, lint, full suite

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole project**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; npx tsc --noEmit`
Expected: PASS (zero errors).

- [ ] **Step 2: Lint**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; npm run lint`
Expected: PASS (no `any`/`as` introduced — guardrail G5).

- [ ] **Step 3: Run the full unit suite**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; npm test`
Expected: PASS — including `intake-workflow.service.spec.ts` (untouched; it mocks `OcrService.transcribe`), `docling-transcriber.spec.ts`, and `ocr.service.spec.ts`.

- [ ] **Step 4: Run any e2e/integration that touches intake**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; npx jest src/triage/triage.integration.spec.ts`
Expected: PASS. (If this integration drives a real `OcrService.transcribe` without a stubbed port, it will hit `DoclingTranscriber` with `DOCLING_BASE_URL` unset → `provider-unavailable` → `needs_triage`. If the test asserted a draft was proposed from faux content, update it to either stub the port or assert the `needs_triage` route. Inspect before changing — do not weaken a real assertion.)

- [ ] **Step 5: Final commit if any integration fix was needed**

```bash
git add -A
git commit -m "test(ocr): align triage integration with port-based Pass-1"
```

---

## Self-Review checklist (run before handing off)

1. **Spec coverage:** Engine behind a port ✓ (Task 1-2), `OcrService` machinery untouched ✓ (Task 3 only swaps the markdown source), env config ✓ (Task 2/5), failure mapping ✓ (Task 2), tests rewritten ✓ (Task 4), sidecar + docs ✓ (Task 5-6).
2. **Placeholder scan:** none.
3. **Type consistency:** `DocumentTranscriber.transcribe(file: TranscribableFile): Promise<OcrOutcome>` is used identically in the adapter (Task 2), the service helper (Task 3), and the stub (Task 4). `OcrOutcome`/`OcrFailureCategory` have one definition (port, Task 1), re-exported from `ocr.service.ts` for `IntakeWorkflowService`.
4. **Untouched seams confirmed:** `intake-workflow.service.ts` reads `OcrOutcome` — unchanged; its spec mocks `transcribe` — unchanged.
