import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, Transaction } from 'kysely';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Database } from '../database/types';
import { DocumentsService } from '../documents/documents.service';
import { crc32 } from '../common/crc32.util';
import { dataDir } from '../common/paths';
import {
  DocumentTranscriber,
  type OcrOutcome,
} from './document-transcriber.port';

// Pass-1 transcription vocabulary now lives with the port that produces it.
// Re-exported so existing importers (IntakeWorkflowService) need no change.
export type {
  OcrFailureCategory,
  OcrSuccess,
  OcrFailure,
  OcrOutcome,
} from './document-transcriber.port';

/**
 * The cache-only read of the persisted OCR evidence (issue #404): the stored
 * markdown validated without EVER invoking the transcription port, or a
 * typed refusal naming why the persisted evidence cannot be trusted
 * (`missing` — no artifact row; `unreadable` — the file cannot be read or
 * fails its stored CRC32). The caller parks honestly on a refusal; it never
 * re-reads the document and never overwrites the stored evidence.
 */
export type PersistedOcrRead =
  | { ok: true; markdown: string }
  | { ok: false; reason: 'missing' | 'unreadable'; detail: string };

@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);

  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly documentsService: DocumentsService,
    private readonly transcriber: DocumentTranscriber,
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
   * Returns a discriminated {@link OcrOutcome} — symmetric with
   * {@link Pass2Outcome} — so a transcription failure routes to a human through
   * the SAME seam as a classification failure (ADR-0024), instead of an
   * exception escaping the workflow. A missing Document is the one exception:
   * it is a precondition violation (no object to route) and stays a throw.
   *
   * @param documentId The Document to transcribe.
   * @returns An {@link OcrOutcome} — success with markdown, or a typed failure.
   */
  async transcribe(documentId: number): Promise<OcrOutcome> {
    // 1. Look up the document. A missing Document is a precondition violation
    //    (no object to route) — it throws, OUTSIDE the typed-failure boundary.
    await this.documentsService.getById(documentId);

    try {
      // 2. Fast path: an OCR markdown artifact already exists. Use the stored
      //    CRC32 to detect on-disk tampering — a matching CRC reuses the stored
      //    markdown (idempotent); a mismatch re-transcribes, overwrites the
      //    file, and updates the row. A legacy artifact with no CRC is reused.
      const existingArtifact = await this.findExistingOcrArtifact(documentId);
      if (existingArtifact) {
        const storedMarkdown = readFileSync(
          existingArtifact.storage_path,
          'utf-8',
        );
        if (existingArtifact.crc32 !== null) {
          const currentCrc = crc32(storedMarkdown);
          if (currentCrc === existingArtifact.crc32) {
            return { ok: true, markdown: storedMarkdown };
          }
          // CRC mismatch: content changed on disk → re-transcribe authoritative
          // markdown, overwrite the file + update the row. A transcription
          // failure here short-circuits (no persistence) with its typed category.
          const result = await this.callTranscriber(documentId);
          if (!result.ok) return result;
          const markdown = result.markdown;
          const computedCrc = crc32(markdown);
          writeFileSync(existingArtifact.storage_path, markdown, 'utf-8');
          await this.db
            .updateTable('artifact')
            .set({
              crc32: computedCrc,
              created_at: Math.floor(Date.now() / 1000),
            })
            .where('id', '=', existingArtifact.id)
            .execute();
          return { ok: true, markdown };
        }
        // Legacy artifact without CRC: return stored markdown but don't block.
        return { ok: true, markdown: storedMarkdown };
      }

      // 3. Transcribe via the port and compute the markdown's CRC32. A typed
      //    transcription failure short-circuits before any file/artifact write.
      const result = await this.callTranscriber(documentId);
      if (!result.ok) return result;
      const markdown = result.markdown;
      const computedCrc = crc32(markdown);

      // 4. Write markdown to filesystem. The path is deterministic per document
      //    (`{id}.md`) and the content is deterministic, so a concurrent/retried
      //    write is idempotent (same bytes, same path) — no race on the file.
      const artifactsDir = join(dataDir(), 'artifacts', 'ocr');
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
            crc32: computedCrc,
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

      return { ok: true, markdown };
    } catch (error) {
      // IO/transient faults (a stored artifact file vanished, an fs blip, a
      // write failure) become a typed transient failure rather than escaping
      // uncaught. The faux model itself is pure and never throws; with a real
      // OCR provider this is where its outages/garbage map to a category.
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(
        `Pass 1 transcription failed for document ${documentId}: ${err.message}`,
      );
      return { ok: false, category: 'transient', detail: err.message };
    }
  }

  /**
   * Cache-only read of the PERSISTED OCR markdown (issue #404): validates
   * the stored artifact the same way {@link transcribe}'s fast path does
   * (row exists, file readable, stored CRC32 matches) but NEVER invokes the
   * transcription port — a missing or tampered artifact is a typed failure,
   * never a fresh provider call, and never an overwrite/replacement of the
   * stored evidence.
   *
   * The strict-persisted-evidence seam for the missing-fact confirmation's
   * resume: re-classification must run from the evidence persisted at intake
   * time (ADR-0039), and when that evidence is unavailable or untrusted the
   * caller parks the document honestly instead of re-reading it.
   */
  async readPersistedMarkdown(documentId: number): Promise<PersistedOcrRead> {
    // A missing Document is a precondition violation (no object to read) —
    // it throws, outside the typed-failure boundary, exactly like
    // transcribe().
    await this.documentsService.getById(documentId);

    const artifact = await this.findExistingOcrArtifact(documentId);
    if (!artifact) {
      return {
        ok: false,
        reason: 'missing',
        detail: `no persisted ocr_markdown artifact for document ${documentId}`,
      };
    }

    let storedMarkdown: string;
    try {
      storedMarkdown = readFileSync(artifact.storage_path, 'utf-8');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        ok: false,
        reason: 'unreadable',
        detail:
          `persisted ocr_markdown artifact for document ${documentId} ` +
          `could not be read: ${err.message}`,
      };
    }

    if (artifact.crc32 !== null) {
      const currentCrc = crc32(storedMarkdown);
      if (currentCrc !== artifact.crc32) {
        return {
          ok: false,
          reason: 'unreadable',
          detail:
            `persisted ocr_markdown artifact for document ${documentId} ` +
            `fails its stored CRC32 check — the stored evidence changed on disk ` +
            `and cannot be trusted for re-classification`,
        };
      }
    }

    // A legacy artifact without CRC is reused, exactly like the fast path.
    return { ok: true, markdown: storedMarkdown };
  }

  // --- Private helpers ---

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

  /**
   * Find an existing ocr_markdown artifact for a document.
   */
  private async findExistingOcrArtifact(
    documentId: number,
  ): Promise<
    { id: number; storage_path: string; crc32: number | null } | undefined
  > {
    return this.db
      .selectFrom('artifact')
      .select(['id', 'storage_path', 'crc32'])
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
