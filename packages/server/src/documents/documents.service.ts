import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, sql } from 'kysely';
import { createHash } from 'crypto';
import { Database } from '../database/types';
import { triageResultSchema, TriageResult } from '../triage/types';
import { DocumentStorageService } from './document-storage.service';
import {
  Document,
  DocumentSource,
  DocumentWithSources,
  DocumentStatus,
  Channel,
  UploadDocumentInput,
  UploadDocumentResult,
} from './types';

export function computeSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

@Injectable()
export class DocumentsService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly storage: DocumentStorageService,
  ) {}

  async upload(input: UploadDocumentInput): Promise<UploadDocumentResult> {
    const hash = computeSha256(input.buffer);
    const sizeBytes = input.buffer.length;
    const now = Math.floor(Date.now() / 1000);

    const existing = await this.db
      .selectFrom('document')
      .selectAll()
      .where('hash', '=', hash)
      .executeTakeFirst();

    if (existing) {
      const { channel, sourceIdentifier } = input;
      await this.db
        .insertInto('document_source')
        .values({
          document_id: existing.id,
          channel,
          source_identifier: sourceIdentifier ?? null,
          received_at: now,
          captured_at: input.capturedAt ?? null,
          precheck_json: input.precheckJson ?? null,
        })
        .execute();

      return {
        document: this.mapDocumentRow(existing),
        deduplicated: true,
      };
    }

    const { filename, mimeType } = input;
    const docRow = await this.db
      .insertInto('document')
      .values({
        hash,
        filename,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        storage_path: null,
        status: 'pending',
        created_at: now,
        claimant_id: input.claimantId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const storagePath = await this.storage.saveFile(
      docRow.id,
      input.filename,
      input.buffer,
    );

    await this.db
      .updateTable('document')
      .set({ storage_path: storagePath })
      .where('id', '=', docRow.id)
      .execute();

    const { channel, sourceIdentifier } = input;
    await this.db
      .insertInto('document_source')
      .values({
        document_id: docRow.id,
        channel,
        source_identifier: sourceIdentifier ?? null,
        received_at: now,
        captured_at: input.capturedAt ?? null,
        precheck_json: input.precheckJson ?? null,
      })
      .execute();

    return {
      document: this.mapDocumentRow({ ...docRow, storage_path: storagePath }),
      deduplicated: false,
    };
  }

  async list(): Promise<Document[]> {
    const rows = await this.db
      .selectFrom('document')
      .selectAll()
      .orderBy('id', 'desc')
      .execute();
    return rows.map((r) => this.mapDocumentRow(r));
  }

  async getById(id: number): Promise<Document> {
    const row = await this.db
      .selectFrom('document')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundException(`Document ${id} not found`);
    }

    return this.mapDocumentRow(row);
  }

  /**
   * Read back the raw stored bytes of a document along with the metadata
   * needed to serve them (filename + MIME type). Throws NotFoundException if
   * the document is unknown or its bytes were never persisted.
   */
  async getFile(
    id: number,
  ): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
    const doc = await this.getById(id);
    if (!doc.storage_path) {
      throw new NotFoundException(`Document ${id} has no stored file`);
    }
    const buffer = await this.storage.readFile(doc.storage_path);
    return { buffer, filename: doc.filename, mimeType: doc.mime_type };
  }

  async setStatus(id: number, status: DocumentStatus): Promise<void> {
    await this.db
      .updateTable('document')
      .set({ status })
      .where('id', '=', id)
      .execute();
  }

  /** Stamp processing_since = now, guarding idempotency. */
  async markProcessing(id: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .updateTable('document')
      .set({ processing_since: now })
      .where('id', '=', id)
      .execute();
  }

  /** Clear processing_since after triage completes (success or failure). */
  async clearProcessing(id: number): Promise<void> {
    await this.db
      .updateTable('document')
      .set({ processing_since: null })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Atomically claim the oldest claimable 'pending' document for processing.
   *
   * Claimable = status 'pending', attempts below the cap, and not currently
   * in flight (processing_since NULL or older than `staleSeconds` — the latter
   * reclaims a document stranded by a crash). On a win it stamps
   * processing_since = now and increments processing_attempts, then returns the
   * id. Returns null when the queue is empty or another claimer won the race.
   */
  async claimNextPending(
    staleSeconds: number,
    maxAttempts: number,
  ): Promise<{ id: number; claimant_id: number | null } | null> {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - staleSeconds;

    const candidate = await this.db
      .selectFrom('document')
      .select(['id', 'claimant_id'])
      .where('status', '=', 'pending')
      .where('processing_attempts', '<', maxAttempts)
      .where((eb) =>
        eb.or([
          eb('processing_since', 'is', null),
          eb('processing_since', '<', cutoff),
        ]),
      )
      .orderBy('created_at', 'asc')
      .limit(1)
      .executeTakeFirst();

    if (!candidate) {
      return null;
    }

    const res = await this.db
      .updateTable('document')
      .set({
        processing_since: now,
        processing_attempts: sql`processing_attempts + 1`,
      })
      .where('id', '=', candidate.id)
      .where('status', '=', 'pending')
      .where('processing_attempts', '<', maxAttempts)
      .where((eb) =>
        eb.or([
          eb('processing_since', 'is', null),
          eb('processing_since', '<', cutoff),
        ]),
      )
      .executeTakeFirst();

    if (!res) return null;
    if (Number(res.numUpdatedRows) !== 1) return null;
    return { id: candidate.id, claimant_id: candidate.claimant_id ?? null };
  }

  /**
   * Store (or clear) the TriageResult that blocked this document on the
   * supplier-unresolved route. Pass `null` to clear it. Kept off the mapped
   * `Document` type on purpose: it is operational AI scratch data read only by
   * the resolution flow, never shipped in `list()`.
   */
  async setPendingTriageResult(
    id: number,
    result: TriageResult | null,
  ): Promise<void> {
    await this.db
      .updateTable('document')
      .set({
        pending_triage_result: result !== null ? JSON.stringify(result) : null,
      })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Read back the stored proposal as a validated TriageResult, or null if the
   * document has none. Re-validates with the Zod schema so a malformed/stale
   * blob fails loudly rather than feeding a half-shaped object into the kernel.
   */
  async getPendingTriageResult(id: number): Promise<TriageResult | null> {
    const row = await this.db
      .selectFrom('document')
      .select('pending_triage_result')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row || row.pending_triage_result == null) {
      return null;
    }
    return triageResultSchema.parse(JSON.parse(row.pending_triage_result));
  }

  /**
   * Step 1 of 2 for claimant expense approval.
   * Sets whether the Claimant paid out of pocket.
   *
   * - paidByClaimant=true  → keep claimant_id; SPA then calls manual-classify
   *                           to build the Expense from stored Pass-2 artefacts.
   * - paidByClaimant=false → clear claimant_id; document re-routes as normal
   *                           supplier expense (Cr AP).
   *
   * This method does NOT create an Expense — that is the manual-classify step.
   */
  async confirmPayment(
    documentId: number,
    paidByClaimant: boolean,
  ): Promise<void> {
    const doc = await this.db
      .selectFrom('document')
      .select('id')
      .where('id', '=', documentId)
      .executeTakeFirst();
    if (!doc) {
      throw new NotFoundException(`Document ${documentId} not found`);
    }

    if (!paidByClaimant) {
      await this.db
        .updateTable('document')
        .set({ claimant_id: null })
        .where('id', '=', documentId)
        .execute();
    }
    // paidByClaimant=true: claimant_id was already set at upload time; no change needed.
  }

  /**
   * Delete a document and its owned dependents (sources, OCR/artifact rows, the
   * internal OCR conversation, and the stored files). Atomic. The SPA is the
   * operator's admin surface, so the only block is data integrity: a document
   * that is still evidence for an expense is refused (409) — detach/reverse the
   * expense first. Real user threads (Telegram/email) are UNLINKED, not deleted.
   * Throws 404 if the document does not exist.
   */
  async deleteDocument(id: number): Promise<void> {
    const filePaths = await this.db.transaction().execute(async (trx) => {
      const doc = await trx
        .selectFrom('document')
        .select(['id', 'storage_path'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!doc) throw new NotFoundException(`Document ${id} not found`);

      const expense = await trx
        .selectFrom('expense')
        .select('id')
        .where('document_id', '=', id)
        .executeTakeFirst();
      if (expense) {
        throw new ConflictException(
          `Document ${id} is attached to expense #${expense.id} and cannot be deleted`,
        );
      }
      // The SPA is the operator's admin surface — a document can always be
      // deleted. The intake/OCR pipeline creates an INTERNAL conversation per
      // document (channel 'api', thread_key 'ocr:<id>') just to hold the OCR
      // artifact — that is part of the document and is cascade-deleted with it.
      // A REAL user thread (Telegram/email) is merely UNLINKED (its messages and
      // history are preserved); only the document↔thread attachment is removed.
      const links = await trx
        .selectFrom('conversation_document as cd')
        .innerJoin('conversation as c', 'c.id', 'cd.conversation_id')
        .select(['c.id as conversation_id', 'c.channel'])
        .where('cd.document_id', '=', id)
        .execute();
      const ocrConvIds = links
        .filter((l) => l.channel === 'api')
        .map((l) => l.conversation_id);

      const artifacts = await trx
        .selectFrom('artifact')
        .select('storage_path')
        .where((eb) =>
          eb.or([
            eb('document_id', '=', id),
            ...(ocrConvIds.length
              ? [eb('conversation_id', 'in', ocrConvIds)]
              : []),
          ]),
        )
        .execute();
      const paths = [
        doc.storage_path,
        ...artifacts.map((a) => a.storage_path),
      ].filter((p): p is string => p !== null);

      // Delete in FK-safe order: artifacts/messages/business-object links first,
      // then the document↔conversation links, the internal conversation, the
      // document's sources, and finally the document.
      await trx
        .deleteFrom('artifact')
        .where((eb) =>
          eb.or([
            eb('document_id', '=', id),
            ...(ocrConvIds.length
              ? [eb('conversation_id', 'in', ocrConvIds)]
              : []),
          ]),
        )
        .execute();
      if (ocrConvIds.length) {
        await trx
          .deleteFrom('message')
          .where('conversation_id', 'in', ocrConvIds)
          .execute();
        await trx
          .deleteFrom('conversation_business_object')
          .where('conversation_id', 'in', ocrConvIds)
          .execute();
      }
      await trx
        .deleteFrom('conversation_document')
        .where('document_id', '=', id)
        .execute();
      if (ocrConvIds.length) {
        await trx
          .deleteFrom('conversation')
          .where('id', 'in', ocrConvIds)
          .execute();
      }
      await trx
        .deleteFrom('document_source')
        .where('document_id', '=', id)
        .execute();
      await trx.deleteFrom('document').where('id', '=', id).execute();
      return paths;
    });

    // Best-effort file cleanup once the rows are committed.
    for (const p of filePaths) {
      await this.storage.deleteFile(p);
    }
  }

  async hydrate(document: Document): Promise<DocumentWithSources> {
    const sources = await this.db
      .selectFrom('document_source')
      .selectAll()
      .where('document_id', '=', document.id)
      .execute();

    return {
      ...document,
      sources: sources.map((s) => this.mapSourceRow(s)),
    };
  }

  private mapDocumentRow(row: {
    id: number;
    hash: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    storage_path: string | null;
    status: string;
    processing_since: number | null;
    created_at: number;
    claimant_id?: number | null;
  }): Document {
    return {
      id: row.id,
      hash: row.hash,
      filename: row.filename,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      storage_path: row.storage_path,
      status: this.validateDocumentStatus(row.status),
      processing_since: row.processing_since,
      created_at: row.created_at,
      claimant_id: row.claimant_id ?? null,
    };
  }

  private mapSourceRow(row: {
    id: number;
    document_id: number;
    channel: string;
    source_identifier: string | null;
    received_at: number;
    captured_at: number | null;
    precheck_json: string | null;
  }): DocumentSource {
    return {
      id: row.id,
      document_id: row.document_id,
      channel: this.validateChannel(row.channel),
      source_identifier: row.source_identifier,
      received_at: row.received_at,
      captured_at: row.captured_at,
      precheck_json: row.precheck_json,
    };
  }

  private validateDocumentStatus(status: string): DocumentStatus {
    if (
      status === 'pending' ||
      status === 'triaged' ||
      status === 'needs_triage' ||
      status === 'processed' ||
      status === 'error'
    ) {
      return status;
    }
    throw new Error(`Invalid document status: ${status}`);
  }

  private validateChannel(channel: string): Channel {
    if (
      channel === 'upload' ||
      channel === 'telegram' ||
      channel === 'email' ||
      channel === 'drive' ||
      channel === 'ios_photo_library'
    ) {
      return channel;
    }
    throw new Error(`Invalid channel: ${channel}`);
  }
}
