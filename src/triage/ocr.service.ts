import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, Transaction } from 'kysely';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Database } from '../database/types';
import { DocumentsService } from '../documents/documents.service';
import { TriageResult } from './types';

/**
 * Faux OCR model output — deterministic markdown derived from document metadata.
 *
 * In v1 there is no real vision model API wired. This faux model returns
 * structured-looking markdown based on the document's filename and id,
 * enabling deterministic tests and pipeline integration.
 *
 * When a real OCR provider is connected, this method will call the `ocr` LLM
 * profile (CONFIG.md §4) and return the raw markdown response.
 */
function fauxOcrModel(documentId: number, filename: string): string {
  const lower = filename.toLowerCase();
  // Filename takes precedence; fall back to id parity for ambiguous names.
  // Determine document type from filename keywords.
  // Fall back to id parity for ambiguous names that aren't clearly receipts or invoices.
  const isReceipt =
    lower.includes('receipt') ||
    (!lower.includes('invoice') && documentId % 2 === 1);

  if (isReceipt) {
    return `# Receipt

**Supplier:** Bolt
**Date:** 2025-01-15
**Amount:** €15.25
**VAT:** €2.85
**Category:** Transport
**Document VAT:** IE_INPUT_23

---

Bolt Europe Ltd.
Receipt for ride on 2025-01-15
Total: €15.25 (incl. VAT €2.85)
Payment method: Corporate card ending 4242
`;
  }

  return `# Invoice

**Supplier:** Acme Ltd
**Date:** 2025-01-20
**Amount:** €123.00
**VAT:** €23.00
**Category:** Revenue
**Document VAT:** IE_OUTPUT_23

---

Acme Ltd
Invoice #INV-2025-001
Date: 2025-01-20
Subtotal: €100.00
VAT (23%): €23.00
Total: €123.00
`;
}

@Injectable()
export class OcrService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly documentsService: DocumentsService,
  ) {}

  /**
   * Pass 1 — OCR → markdown.
   *
   * Transcribes a document into markdown using a vision/OCR model.
   * The markdown is stored as a Conversation Artifact with kind='ocr_markdown'.
   *
   * Idempotent: if an ocr_markdown artifact already exists for the document,
   * reads and returns the stored markdown without re-calling the model.
   *
   * @param documentId The Document to transcribe.
   * @returns The markdown string.
   */
  async transcribe(documentId: number): Promise<string> {
    // 1. Look up the document.
    const document = await this.documentsService.getById(documentId);

    // 2. Fast path: an OCR markdown artifact already exists (idempotency).
    const existingArtifact = await this.findExistingOcrArtifact(documentId);
    if (existingArtifact) {
      return readFileSync(existingArtifact.storage_path, 'utf-8');
    }

    // 3. Call the OCR model (faux for v1).
    const markdown = fauxOcrModel(documentId, document.filename);

    // 4. Write markdown to filesystem. The path is deterministic per document
    //    (`{id}.md`) and the content is deterministic, so a concurrent/retried
    //    write is idempotent (same bytes, same path) — no race on the file.
    const artifactsDir = join(process.cwd(), 'data', 'artifacts', 'ocr');
    if (!existsSync(artifactsDir)) {
      mkdirSync(artifactsDir, { recursive: true });
    }
    const storagePath = join(artifactsDir, `${documentId}.md`);
    writeFileSync(storagePath, markdown, 'utf-8');

    // 5. Race-safe find-or-create of the artifact + conversation. Two
    //    concurrent/retried transcribe() calls both saw no artifact at step 2;
    //    without a guard both would attach a duplicate ocr_markdown artifact.
    //    We re-check inside a single write transaction (better-sqlite3
    //    serializes write transactions, so the re-check + insert is atomic):
    //    the loser of the race sees the committed artifact and reuses it.
    await this.db.transaction().execute(async (trx) => {
      const racedArtifact = await trx
        .selectFrom('artifact')
        .select('id')
        .where('kind', '=', 'ocr_markdown')
        .where('document_id', '=', documentId)
        .executeTakeFirst();
      if (racedArtifact) {
        // Another call won — leave its artifact untouched (no duplicate).
        return;
      }

      // Find or create the per-document OCR conversation inside the txn.
      const conversation = await this.resolveConversationTx(trx, documentId);

      const now = Math.floor(Date.now() / 1000);
      await trx
        .insertInto('artifact')
        .values({
          conversation_id: conversation.id,
          kind: 'ocr_markdown',
          storage_path: storagePath,
          document_id: documentId,
          created_at: now,
        })
        .execute();

      // Associate the conversation with the document (idempotent insert).
      await trx
        .insertInto('conversation_document')
        .values({ conversation_id: conversation.id, document_id: documentId })
        .ignore()
        .execute();

      await trx
        .updateTable('conversation')
        .set({ updated_at: now })
        .where('id', '=', conversation.id)
        .execute();
    });

    return markdown;
  }

  /**
   * Stub OCR: deterministic odd/even by document id.
   *
   * IE/EUR defaults (ADR-0004) with VAT codes NullCountryPlugin accepts
   * (ADR-0002), so triaged drafts pass semantic validation without override.
   *
   * Odd id  -> receipt / Bolt / 1525 gross / 285 vat / transport / IE_INPUT_23 / 0.94 confidence
   * Even id -> invoice / Acme Ltd / 12300 gross / 2300 vat / revenue / IE_OUTPUT_23 / 0.98 confidence
   *            (a sales invoice carries output VAT; the draft generator resolves
   *             'revenue' -> IE_OUTPUT_23 regardless, ADR-0002)
   */
  extract(documentId: number): TriageResult {
    if (documentId % 2 === 1) {
      return {
        kind: 'new_expense',
        document_type: 'receipt',
        gross_amount: 1525,
        vat_amount: 285,
        currency: 'EUR',
        tax_point_date: '2025-01-15',
        category: 'transport',
        document_vat_marking: 'IE_INPUT_23',
        confidence: 0.94,
      };
    }

    return {
      kind: 'new_expense',
      document_type: 'invoice',
      gross_amount: 12300,
      vat_amount: 2300,
      currency: 'EUR',
      tax_point_date: '2025-01-20',
      category: 'revenue',
      document_vat_marking: 'IE_OUTPUT_23',
      confidence: 0.98,
    };
  }

  // --- Private helpers ---

  /**
   * Find an existing ocr_markdown artifact for a document.
   */
  private async findExistingOcrArtifact(
    documentId: number,
  ): Promise<{ storage_path: string } | undefined> {
    return this.db
      .selectFrom('artifact')
      .select('storage_path')
      .where('kind', '=', 'ocr_markdown')
      .where('document_id', '=', documentId)
      .executeTakeFirst();
  }

  /**
   * Resolve or create the per-document OCR Conversation INSIDE a transaction.
   *
   * Mirrors ConversationsService.resolve (deterministic by channel='api' +
   * thread_key='ocr:{documentId}'), but operates on the transaction handle so
   * the conversation find-or-create shares atomicity with the artifact insert
   * in transcribe(). Keeps the single-call path behavior-identical.
   */
  private async resolveConversationTx(
    trx: Transaction<Database>,
    documentId: number,
  ): Promise<{ id: number }> {
    const channel = 'api';
    const threadKey = `ocr:${documentId}`;

    const existing = await trx
      .selectFrom('conversation')
      .select('id')
      .where('channel', '=', channel)
      .where('thread_key', '=', threadKey)
      .executeTakeFirst();
    if (existing) {
      return { id: existing.id };
    }

    const now = Math.floor(Date.now() / 1000);
    const created = await trx
      .insertInto('conversation')
      .values({
        channel,
        thread_key: threadKey,
        status: 'open',
        created_at: now,
        updated_at: now,
        closed_at: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { id: created.id };
  }
}
