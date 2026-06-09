import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { createHash } from 'crypto';
import { Database } from '../database/types';
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

  async setStatus(id: number, status: DocumentStatus): Promise<void> {
    await this.db
      .updateTable('document')
      .set({ status })
      .where('id', '=', id)
      .execute();
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
    created_at: number;
  }): Document {
    return {
      id: row.id,
      hash: row.hash,
      filename: row.filename,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      storage_path: row.storage_path,
      status: this.validateDocumentStatus(row.status),
      created_at: row.created_at,
    };
  }

  private mapSourceRow(row: {
    id: number;
    document_id: number;
    channel: string;
    source_identifier: string | null;
    received_at: number;
  }): DocumentSource {
    return {
      id: row.id,
      document_id: row.document_id,
      channel: this.validateChannel(row.channel),
      source_identifier: row.source_identifier,
      received_at: row.received_at,
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
      channel === 'drive'
    ) {
      return channel;
    }
    throw new Error(`Invalid channel: ${channel}`);
  }
}
