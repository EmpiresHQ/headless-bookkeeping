import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Database } from '../database/types';
import { DocumentsService } from '../documents/documents.service';
import { ConversationsService } from '../conversations/conversations.service';
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
  const isReceipt =
    lower.includes('receipt') ||
    lower.includes('bolt') ||
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
    private readonly conversationsService: ConversationsService,
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

    // 2. Check for existing OCR markdown artifact (idempotency).
    const existingArtifact = await this.findExistingOcrArtifact(documentId);
    if (existingArtifact) {
      return readFileSync(existingArtifact.storage_path, 'utf-8');
    }

    // 3. Call the OCR model (faux for v1).
    const markdown = fauxOcrModel(documentId, document.filename);

    // 4. Write markdown to filesystem.
    const artifactsDir = join(process.cwd(), 'data', 'artifacts', 'ocr');
    if (!existsSync(artifactsDir)) {
      mkdirSync(artifactsDir, { recursive: true });
    }
    const storagePath = join(artifactsDir, `${documentId}.md`);
    writeFileSync(storagePath, markdown, 'utf-8');

    // 5. Find or create a Conversation for the document, then attach artifact.
    const conversation = await this.resolveConversation(documentId);
    await this.conversationsService.attachArtifact({
      conversation_id: conversation.id,
      kind: 'ocr_markdown',
      storage_path: storagePath,
      document_id: documentId,
    });

    // 6. Also associate the conversation with the document.
    await this.conversationsService.associateDocument({
      conversation_id: conversation.id,
      document_id: documentId,
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
   * Resolve or create a Conversation for a document's OCR transcription.
   *
   * Uses channel='api' and thread_key='ocr:{documentId}' for deterministic
   * resolution. This creates a dedicated conversation per document for the
   * OCR pass.
   */
  private async resolveConversation(documentId: number) {
    return this.conversationsService.resolve({
      channel: 'api',
      thread_key: `ocr:${documentId}`,
    });
  }
}
