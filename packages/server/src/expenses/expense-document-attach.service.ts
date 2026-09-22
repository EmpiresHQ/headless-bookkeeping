import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { basename } from 'path';
import { Database } from '../database/types';
import {
  DocumentsService,
  computeSha256,
} from '../documents/documents.service';
import { DocumentStorageService } from '../documents/document-storage.service';
import { PreviewRenderer } from '../documents/preview-renderer';
import type { Document } from '../documents/types';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ExpensesService } from './expenses.service';
import type { Expense } from './types';

/** The action the intake workflow writes when it files an extra receipt. */
const RECEIPT_MATCHED_ACTION = 'document.duplicate_guard.receipt_matched';

/**
 * Document statuses an attach may claim. `pending` only while idle (no worker
 * or manual run has stamped `processing_since`); `needs_triage` is the normal
 * case — a late receipt the intake could not place on its own.
 */
const ATTACHABLE_STATUSES = ['pending', 'needs_triage'] as const;

export interface AttachableDocument {
  id: number;
  filename: string;
  mime_type: string;
  status: 'pending' | 'needs_triage';
  created_at: number;
  /** The open needs_triage reason, so the operator sees what they pick. */
  reason: string | null;
}

export interface AttachDocumentResult {
  outcome: 'attached' | 'already_attached';
  expense: Expense;
  document: Document;
}

interface NewFileInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

type DocRow = {
  id: number;
  status: string;
  storage_path: string | null;
  processing_since: number | null;
  claimant_id: number | null;
};

/** Thrown inside the new-file transaction when the hash appeared meanwhile. */
class HashNowKnown extends Error {
  constructor(readonly documentId: number) {
    super(`document hash already stored as #${documentId}`);
  }
}

/**
 * Attach a late source document to an EXISTING expense (issue #248).
 *
 * The one deliberate write that fills an empty `expense.document_id`. It is
 * additive evidence: the expense keeps its id, amounts, status, voucher,
 * reconciliation and approval history, and no voucher, VAT report or period
 * state is touched — so it is allowed for every expense status and inside a
 * locked period (ADR-0009: late items must not dead-end; unlike
 * `setDocumentMetadata`, nothing already recorded is rewritten). An existing
 * source is never replaced. VAT is NOT re-derived from the receipt: claiming
 * input VAT a "no receipt" entry left out is a correction, not an attach.
 *
 * Safety against a second expense:
 * - an existing document is claimed only from `pending` (idle) or
 *   `needs_triage`, and only when no business object or filed-receipt trace
 *   uses it ({@link refusalFor} — the SAME rule the candidate list applies);
 *   the claim moves it to `processed`, which the worker never claims and the
 *   workflow replays onto this expense (`findExistingDraft`);
 * - the whole check-and-claim holds the document's exclusion shared with the
 *   intake workflow, and re-asserts every condition in its conditional UPDATEs;
 * - a fresh upload is inserted as `processed` inside the same transaction as
 *   the link, so it is never intake work and never outlives a failed attach.
 */
@Injectable()
export class ExpenseDocumentAttachService {
  private readonly logger = new Logger(ExpenseDocumentAttachService.name);

  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly documents: DocumentsService,
    private readonly storage: DocumentStorageService,
    private readonly previewRenderer: PreviewRenderer,
    private readonly periodLock: PeriodLockService,
    private readonly auditLog: AuditLogService,
    private readonly expenses: ExpensesService,
  ) {}

  /**
   * Documents that may be attached to expense `expenseId` right now. Empty when
   * the expense already has a source. Advisory: the attach re-checks the same
   * rule under the document's exclusion.
   */
  async listAttachable(expenseId: number): Promise<AttachableDocument[]> {
    const expense = await this.db
      .selectFrom('expense')
      .select(['id', 'document_id'])
      .where('id', '=', expenseId)
      .executeTakeFirst();
    if (!expense) throw new NotFoundException(`Expense ${expenseId} not found`);
    if (expense.document_id !== null) return [];

    const rows = await this.db
      .selectFrom('document as d')
      .leftJoin('audit_finding as af', (join) =>
        join
          .onRef('af.referenced_object_id', '=', 'd.id')
          .on('af.referenced_object_type', '=', 'document')
          .on('af.finding_type', '=', 'needs_triage')
          .on('af.status', '=', 'open'),
      )
      .select([
        'd.id',
        'd.filename',
        'd.mime_type',
        'd.status',
        'd.created_at',
        'd.storage_path',
        'd.processing_since',
        'd.claimant_id',
        'af.description as reason',
      ])
      .where('d.status', 'in', [...ATTACHABLE_STATUSES])
      .orderBy('d.created_at', 'desc')
      .orderBy('d.id', 'desc')
      .execute();

    const out: AttachableDocument[] = [];
    const seen = new Set<number>();
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      if ((await this.refusalFor(this.db, r)) !== null) continue;
      out.push({
        id: r.id,
        filename: r.filename,
        mime_type: r.mime_type,
        status: r.status as AttachableDocument['status'],
        created_at: r.created_at,
        reason: r.reason ?? null,
      });
    }
    return out;
  }

  /** Attach an already-stored document to the expense. */
  async attachExisting(
    expenseId: number,
    documentId: number,
  ): Promise<AttachDocumentResult> {
    const outcome = await this.documents.tryRunExclusive(
      documentId,
      () =>
        this.db
          .transaction()
          .execute((trx) =>
            this.claimExistingTx(trx, expenseId, documentId, false),
          ),
      () => this.inFlight(documentId),
    );
    return this.result(outcome, expenseId, documentId);
  }

  /**
   * Upload a new receipt and attach it in one step. Byte-identical content
   * already on file is the SAME document (ADR-0010 hash anchor) and goes
   * through the existing-document rule instead — so a retry of an attach that
   * succeeded reports `already_attached`, and a file that is evidence
   * elsewhere is refused rather than duplicated.
   */
  async attachNewFile(
    expenseId: number,
    file: NewFileInput,
  ): Promise<AttachDocumentResult> {
    if (file.buffer.length === 0) {
      throw new BadRequestException('The uploaded file is empty');
    }
    const hash = computeSha256(file.buffer);
    const known = await this.db
      .selectFrom('document')
      .select('id')
      .where('hash', '=', hash)
      .executeTakeFirst();
    if (known) return this.attachKnownUpload(expenseId, known.id);

    // Fail fast before storing any bytes; re-asserted inside the transaction.
    await this.assertExpenseAcceptsSource(this.db, expenseId);

    const filename = basename(file.filename) || 'receipt';
    let created: number;
    try {
      created = await this.db.transaction().execute(async (trx) => {
        // Re-check inside the transaction: a concurrent upload of the same
        // bytes may have committed since the read above.
        const raced = await trx
          .selectFrom('document')
          .select('id')
          .where('hash', '=', hash)
          .executeTakeFirst();
        if (raced) throw new HashNowKnown(raced.id);

        await this.assertExpenseAcceptsSource(trx, expenseId);

        const now = Math.floor(Date.now() / 1000);
        const doc = await trx
          .insertInto('document')
          .values({
            hash,
            filename,
            mime_type: file.mimeType,
            size_bytes: file.buffer.length,
            storage_path: null,
            // Never `pending`: this document is not intake work.
            status: 'processed',
            created_at: now,
            claimant_id: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        // Only file IO and this transaction's own executor from here on: the
        // single SQLite connection is held by `trx`, so any service reading
        // through the root connection would deadlock.
        // Owned from BEFORE the write: a write that fails part-way can still
        // leave bytes at this path.
        const ownedPath = this.storage.pathFor(doc.id, filename);
        try {
          const storedPath = await this.storage.saveFile(
            doc.id,
            filename,
            file.buffer,
          );
          if (storedPath !== ownedPath) {
            throw new Error(
              `storage wrote ${storedPath}, expected ${ownedPath}`,
            );
          }
          await trx
            .updateTable('document')
            .set({ storage_path: ownedPath })
            .where('id', '=', doc.id)
            .execute();
          await trx
            .insertInto('document_source')
            .values({
              document_id: doc.id,
              channel: 'upload',
              source_identifier: null,
              received_at: now,
              captured_at: null,
              precheck_json: null,
            })
            .execute();
          await this.linkTx(trx, expenseId, doc.id, {
            source: 'upload',
            prior_document_status: null,
            resolved_finding_ids: [],
          });
        } catch (err) {
          // Remove exactly the file THIS call wrote, before the rollback
          // releases the connection: a rolled-back AUTOINCREMENT id is reused
          // by the next insert, so cleaning up afterwards could delete a later
          // upload's bytes.
          await this.storage.deleteFile(ownedPath).catch((cleanupErr) => {
            this.logger.error(
              `attach: could not remove ${ownedPath} after a failed attach: ${String(cleanupErr)}`,
            );
          });
          throw err;
        }
        return doc.id;
      });
    } catch (err) {
      if (err instanceof HashNowKnown) {
        return this.attachKnownUpload(expenseId, err.documentId);
      }
      throw err;
    }

    // Thumbnail after commit, best-effort — getPreview renders lazily anyway.
    try {
      const doc = await this.documents.getById(created);
      const previewPath = await this.previewRenderer.render(doc, file.buffer);
      if (previewPath !== null) {
        await this.db
          .updateTable('document')
          .set({ preview_path: previewPath })
          .where('id', '=', created)
          .execute();
      }
    } catch (err) {
      this.logger.warn(
        `attach: preview render failed for document ${created}: ${String(err)}`,
      );
    }
    return this.result('attached', expenseId, created);
  }

  /** Same bytes already stored: record this arrival only if it attaches. */
  private async attachKnownUpload(
    expenseId: number,
    documentId: number,
  ): Promise<AttachDocumentResult> {
    const outcome = await this.documents.tryRunExclusive(
      documentId,
      () =>
        this.db
          .transaction()
          .execute((trx) =>
            this.claimExistingTx(trx, expenseId, documentId, true),
          ),
      () => this.inFlight(documentId),
    );
    return this.result(outcome, expenseId, documentId);
  }

  private async claimExistingTx(
    trx: Kysely<Database>,
    expenseId: number,
    documentId: number,
    uploadArrival: boolean,
  ): Promise<'attached' | 'already_attached'> {
    const expense = await trx
      .selectFrom('expense')
      .select(['id', 'document_id'])
      .where('id', '=', expenseId)
      .executeTakeFirst();
    if (!expense) throw new NotFoundException(`Expense ${expenseId} not found`);

    const doc = await trx
      .selectFrom('document')
      .select([
        'id',
        'status',
        'storage_path',
        'processing_since',
        'claimant_id',
      ])
      .where('id', '=', documentId)
      .executeTakeFirst();
    if (!doc) throw new NotFoundException(`Document ${documentId} not found`);

    // Idempotent retry: this exact link already holds.
    if (expense.document_id === documentId) return 'already_attached';
    await this.assertExpenseAcceptsSource(trx, expenseId);

    const refusal = await this.refusalFor(trx, doc);
    if (refusal !== null) {
      throw new ConflictException(
        `${uploadArrival ? 'This file is already on file as document' : 'Document'} ` +
          `#${documentId} cannot be attached: ${refusal}. Nothing was changed.`,
      );
    }

    const claimed = await trx
      .updateTable('document')
      .set({
        status: 'processed',
        pending_triage_result: null,
        pending_triage_enrichment: null,
      })
      .where('id', '=', documentId)
      .where('status', 'in', [...ATTACHABLE_STATUSES])
      .where('processing_since', 'is', null)
      .where('storage_path', 'is not', null)
      .where('claimant_id', 'is', null)
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) !== 1) {
      throw this.inFlight(documentId);
    }

    const now = Math.floor(Date.now() / 1000);
    const findings = await trx
      .selectFrom('audit_finding')
      .select('id')
      .where('finding_type', '=', 'needs_triage')
      .where('referenced_object_type', '=', 'document')
      .where('referenced_object_id', '=', documentId)
      .where('status', 'in', ['open', 'snoozed'])
      .execute();
    const findingIds = findings.map((f) => f.id);
    if (findingIds.length > 0) {
      await trx
        .updateTable('audit_finding')
        .set({
          status: 'resolved',
          resolved_at: now,
          transitioned_by: 'operator',
          transition_reason: `attached to expense #${expenseId} as its source document`,
        })
        .where('id', 'in', findingIds)
        .execute();
    }

    if (uploadArrival) {
      await trx
        .insertInto('document_source')
        .values({
          document_id: documentId,
          channel: 'upload',
          source_identifier: null,
          received_at: now,
          captured_at: null,
          precheck_json: null,
        })
        .execute();
    }

    await this.linkTx(trx, expenseId, documentId, {
      source: uploadArrival ? 'upload_deduplicated' : 'existing',
      prior_document_status: doc.status,
      resolved_finding_ids: findingIds,
    });
    return 'attached';
  }

  /**
   * Fill the empty source link and leave the trace. The conditional UPDATE is
   * the last word: a source that appeared meanwhile is never overwritten.
   */
  private async linkTx(
    trx: Kysely<Database>,
    expenseId: number,
    documentId: number,
    detail: {
      source: 'existing' | 'upload' | 'upload_deduplicated';
      prior_document_status: string | null;
      resolved_finding_ids: number[];
    },
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const linked = await trx
      .updateTable('expense')
      .set({ document_id: documentId, updated_at: now })
      .where('id', '=', expenseId)
      .where('document_id', 'is', null)
      .executeTakeFirst();
    if (Number(linked.numUpdatedRows) !== 1) {
      throw new ConflictException(
        `Expense ${expenseId} received a source document meanwhile — it is ` +
          `never replaced. Nothing was changed.`,
      );
    }

    const expense = await trx
      .selectFrom('expense')
      .select(['status', 'voucher_id', 'tax_point_date'])
      .where('id', '=', expenseId)
      .executeTakeFirstOrThrow();
    const locked = await this.periodLock.findLockedPeriod(
      expense.tax_point_date,
      trx,
    );

    await this.auditLog.record(
      {
        actor: 'operator',
        action: 'expense.document_attached',
        outcome: 'attached',
        target_type: 'expense',
        target_id: expenseId,
        detail: {
          document_id: documentId,
          ...detail,
          expense_status: expense.status,
          voucher_id: expense.voucher_id,
          // Additive evidence may land in a filed period: say so, so the
          // trail shows it happened after the lock and changed no entry.
          locked_period: locked ? locked.name : null,
        },
      },
      trx,
    );
  }

  private async assertExpenseAcceptsSource(
    executor: Kysely<Database>,
    expenseId: number,
  ): Promise<void> {
    const expense = await executor
      .selectFrom('expense')
      .select(['id', 'document_id'])
      .where('id', '=', expenseId)
      .executeTakeFirst();
    if (!expense) throw new NotFoundException(`Expense ${expenseId} not found`);
    if (expense.document_id !== null) {
      throw new ConflictException(
        `Expense ${expenseId} already has source document #${expense.document_id} ` +
          `— an attached source is never replaced. Nothing was changed.`,
      );
    }
  }

  /**
   * Why `doc` may NOT become an expense's source, or null when it may. The one
   * rule shared by the candidate list and the attach itself. A missing
   * archive `expense_id` does not make a document unused: it may be a sales
   * invoice's source, an allowance's evidence, or a receipt the intake filed
   * against another expense with only an audit trace.
   */
  private async refusalFor(
    executor: Kysely<Database>,
    doc: DocRow,
  ): Promise<string | null> {
    const expense = await executor
      .selectFrom('expense')
      .select('id')
      .where('document_id', '=', doc.id)
      .executeTakeFirst();
    if (expense) return `it is already the source of expense #${expense.id}`;

    const invoice = await executor
      .selectFrom('sales_invoice')
      .select('id')
      .where('document_id', '=', doc.id)
      .executeTakeFirst();
    if (invoice) return `it is the source of sales invoice #${invoice.id}`;

    const allowance = await executor
      .selectFrom('allowance')
      .select('id')
      .where('supporting_document_id', '=', doc.id)
      .executeTakeFirst();
    if (allowance) return `it is the evidence for allowance #${allowance.id}`;

    const filed = await executor
      .selectFrom('audit_log')
      .select('detail')
      .where('action', '=', RECEIPT_MATCHED_ACTION)
      .where('target_type', '=', 'document')
      .where('target_id', '=', doc.id)
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (filed) {
      const other = parseExpenseId(filed.detail);
      return other !== null
        ? `intake already filed it as a receipt for expense #${other}`
        : 'intake already filed it as a receipt for another expense';
    }

    if (doc.claimant_id !== null) {
      return 'it was submitted by a claimant — confirm the payment in the Inbox first';
    }
    switch (doc.status) {
      case 'pending':
      case 'needs_triage':
        break;
      case 'triaged':
        return 'intake already turned it into a draft';
      case 'processed':
        return 'it is already filed';
      default:
        return `its status is '${doc.status}'`;
    }
    if (doc.processing_since !== null) {
      return 'intake is processing it right now — try again when it finishes';
    }
    if (doc.storage_path === null) {
      return 'its file is still being stored — try again in a moment';
    }
    return null;
  }

  private inFlight(documentId: number): ConflictException {
    return new ConflictException(
      `Document ${documentId} is being processed or changed right now — ` +
        `nothing was attached. Try again when it finishes.`,
    );
  }

  private async result(
    outcome: 'attached' | 'already_attached',
    expenseId: number,
    documentId: number,
  ): Promise<AttachDocumentResult> {
    return {
      outcome,
      expense: await this.expenses.getExpenseById(expenseId),
      document: await this.documents.getById(documentId),
    };
  }
}

function parseExpenseId(detail: string | null): number | null {
  if (detail === null) return null;
  try {
    const v = (JSON.parse(detail) as { expense_id?: unknown }).expense_id;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}
