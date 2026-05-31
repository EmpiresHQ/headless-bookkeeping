import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import {
  Conversation,
  Message,
  Artifact,
  ConversationWithDetails,
  ConversationStatus,
  ResolveInput,
  AppendMessageInput,
  AttachArtifactInput,
  AssociateInput,
  AssociateDocumentInput,
  BusinessObjectType,
} from './types';

@Injectable()
export class ConversationsService {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  /**
   * Deterministic resolution by (channel, thread_key).
   * Returns existing Conversation (reopening if closed + logging) or creates new open one.
   */
  async resolve(input: ResolveInput): Promise<Conversation> {
    const { channel, thread_key } = input;
    const now = Math.floor(Date.now() / 1000);

    const existing = await this.db
      .selectFrom('conversation')
      .selectAll()
      .where('channel', '=', channel)
      .where('thread_key', '=', thread_key)
      .executeTakeFirst();

    if (existing) {
      // Reopen if closed — log the transition.
      if (existing.status === 'closed') {
        console.log(
          `[Conversation] Reopening closed conversation ${existing.id} ` +
            `(channel=${channel}, thread_key=${thread_key})`,
        );
        const updated = await this.db
          .updateTable('conversation')
          .set({ status: 'open', closed_at: null, updated_at: now })
          .where('id', '=', existing.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return this.mapConversation(updated);
      }
      return this.mapConversation(existing);
    }

    // Create new open conversation.
    const created = await this.db
      .insertInto('conversation')
      .values({
        channel,
        thread_key,
        status: 'open',
        created_at: now,
        updated_at: now,
        closed_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.mapConversation(created);
  }

  /**
   * Append a Message to a Conversation.
   */
  async appendMessage(input: AppendMessageInput): Promise<Message> {
    const {
      conversation_id,
      direction,
      sender,
      body,
      threading_keys,
      dkim_spf_pass,
    } = input;
    const now = Math.floor(Date.now() / 1000);

    // Verify conversation exists.
    const conv = await this.db
      .selectFrom('conversation')
      .select('id')
      .where('id', '=', conversation_id)
      .executeTakeFirst();
    if (!conv) {
      throw new NotFoundException(`Conversation ${conversation_id} not found`);
    }

    const row = await this.db
      .insertInto('message')
      .values({
        conversation_id,
        direction,
        sender,
        body,
        threading_keys: threading_keys ?? null,
        dkim_spf_pass: dkim_spf_pass ? 1 : dkim_spf_pass === false ? 0 : null,
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Update conversation's updated_at.
    await this.db
      .updateTable('conversation')
      .set({ updated_at: now })
      .where('id', '=', conversation_id)
      .execute();

    return this.mapMessage(row);
  }

  /**
   * Attach an Artifact to a Conversation.
   * Inbound attachments feed Document dedup via DocumentsService (caller handles).
   */
  async attachArtifact(input: AttachArtifactInput): Promise<Artifact> {
    const { conversation_id, kind, storage_path, document_id } = input;
    const now = Math.floor(Date.now() / 1000);

    // Verify conversation exists.
    const conv = await this.db
      .selectFrom('conversation')
      .select('id')
      .where('id', '=', conversation_id)
      .executeTakeFirst();
    if (!conv) {
      throw new NotFoundException(`Conversation ${conversation_id} not found`);
    }

    const row = await this.db
      .insertInto('artifact')
      .values({
        conversation_id,
        kind,
        storage_path,
        document_id: document_id ?? null,
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Update conversation's updated_at.
    await this.db
      .updateTable('conversation')
      .set({ updated_at: now })
      .where('id', '=', conversation_id)
      .execute();

    return this.mapArtifact(row);
  }

  /**
   * M:N link a Conversation to a business object (Expense, SalesInvoice).
   */
  async associate(input: AssociateInput): Promise<void> {
    const { conversation_id, object_type, object_id } = input;

    // Verify conversation exists.
    const conv = await this.db
      .selectFrom('conversation')
      .select('id')
      .where('id', '=', conversation_id)
      .executeTakeFirst();
    if (!conv) {
      throw new NotFoundException(`Conversation ${conversation_id} not found`);
    }

    // Idempotent insert (ON CONFLICT do nothing).
    await this.db
      .insertInto('conversation_business_object')
      .values({
        conversation_id,
        object_type,
        object_id,
      })
      .ignore()
      .execute();
  }

  /**
   * M:N link a Conversation to a Document.
   */
  async associateDocument(input: AssociateDocumentInput): Promise<void> {
    const { conversation_id, document_id } = input;

    // Verify conversation exists.
    const conv = await this.db
      .selectFrom('conversation')
      .select('id')
      .where('id', '=', conversation_id)
      .executeTakeFirst();
    if (!conv) {
      throw new NotFoundException(`Conversation ${conversation_id} not found`);
    }

    // Idempotent insert.
    await this.db
      .insertInto('conversation_document')
      .values({ conversation_id, document_id })
      .ignore()
      .execute();
  }

  /**
   * Close a Conversation.
   * Allowed only when all associated in-flight business objects are terminal (posted/rejected).
   */
  async close(conversation_id: number): Promise<Conversation> {
    const now = Math.floor(Date.now() / 1000);

    // Verify conversation exists and is open.
    const conv = await this.db
      .selectFrom('conversation')
      .selectAll()
      .where('id', '=', conversation_id)
      .executeTakeFirst();
    if (!conv) {
      throw new NotFoundException(`Conversation ${conversation_id} not found`);
    }
    if (conv.status === 'closed') {
      throw new BadRequestException(
        `Conversation ${conversation_id} is already closed`,
      );
    }

    // Check for non-terminal associated business objects.
    const nonTerminal = await this.checkNonTerminalObjects(conversation_id);
    if (nonTerminal.length > 0) {
      const details = nonTerminal
        .map((o) => `${o.object_type}:${o.object_id}`)
        .join(', ');
      throw new ConflictException(
        `Cannot close conversation ${conversation_id}: ` +
          `non-terminal business objects: ${details}`,
      );
    }

    const updated = await this.db
      .updateTable('conversation')
      .set({ status: 'closed', closed_at: now, updated_at: now })
      .where('id', '=', conversation_id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.mapConversation(updated);
  }

  /**
   * Returns associated Conversations for a business object (correction context).
   * Includes closed threads — they are retained and retrievable by association.
   */
  async getForObject(
    object_type: BusinessObjectType,
    object_id: number,
  ): Promise<ConversationWithDetails[]> {
    const rows = await this.db
      .selectFrom('conversation_business_object as cbo')
      .innerJoin('conversation', 'conversation.id', 'cbo.conversation_id')
      .select([
        'conversation.id',
        'conversation.channel',
        'conversation.thread_key',
        'conversation.status',
        'conversation.created_at',
        'conversation.updated_at',
        'conversation.closed_at',
      ])
      .where('cbo.object_type', '=', object_type)
      .where('cbo.object_id', '=', object_id)
      .execute();

    const conversations = rows.map((r) => this.mapConversation(r));

    // Hydrate messages and artifacts for each conversation.
    const results: ConversationWithDetails[] = [];
    for (const conv of conversations) {
      const messages = await this.db
        .selectFrom('message')
        .selectAll()
        .where('conversation_id', '=', conv.id)
        .orderBy('created_at', 'asc')
        .execute();

      const artifacts = await this.db
        .selectFrom('artifact')
        .selectAll()
        .where('conversation_id', '=', conv.id)
        .orderBy('created_at', 'asc')
        .execute();

      results.push({
        ...conv,
        messages: messages.map((m) => this.mapMessage(m)),
        artifacts: artifacts.map((a) => this.mapArtifact(a)),
      });
    }

    return results;
  }

  /**
   * Get a Conversation by ID with details.
   */
  async getById(id: number): Promise<ConversationWithDetails> {
    const conv = await this.db
      .selectFrom('conversation')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!conv) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    const messages = await this.db
      .selectFrom('message')
      .selectAll()
      .where('conversation_id', '=', id)
      .orderBy('created_at', 'asc')
      .execute();

    const artifacts = await this.db
      .selectFrom('artifact')
      .selectAll()
      .where('conversation_id', '=', id)
      .orderBy('created_at', 'asc')
      .execute();

    return {
      ...this.mapConversation(conv),
      messages: messages.map((m) => this.mapMessage(m)),
      artifacts: artifacts.map((a) => this.mapArtifact(a)),
    };
  }

  /**
   * List all Conversations.
   */
  async list(): Promise<Conversation[]> {
    const rows = await this.db
      .selectFrom('conversation')
      .selectAll()
      .orderBy('id', 'desc')
      .execute();
    return rows.map((r) => this.mapConversation(r));
  }

  // --- Private helpers ---

  private async checkNonTerminalObjects(
    conversation_id: number,
  ): Promise<{ object_type: string; object_id: number }[]> {
    const associations = await this.db
      .selectFrom('conversation_business_object')
      .select(['object_type', 'object_id'])
      .where('conversation_id', '=', conversation_id)
      .execute();

    const nonTerminal: { object_type: string; object_id: number }[] = [];

    for (const assoc of associations) {
      let isTerminal = false;

      if (assoc.object_type === 'expense') {
        const expense = await this.db
          .selectFrom('expense')
          .select('status')
          .where('id', '=', assoc.object_id)
          .executeTakeFirst();
        // Terminal: posted, reversed
        isTerminal =
          expense !== undefined &&
          (expense.status === 'posted' || expense.status === 'reversed');
      } else if (assoc.object_type === 'sales_invoice') {
        const invoice = await this.db
          .selectFrom('sales_invoice')
          .select('status')
          .where('id', '=', assoc.object_id)
          .executeTakeFirst();
        // Terminal: posted, reversed
        isTerminal =
          invoice !== undefined &&
          (invoice.status === 'posted' || invoice.status === 'reversed');
      }
      // Unknown object types are considered terminal (no status to check).

      if (!isTerminal) {
        nonTerminal.push(assoc);
      }
    }

    return nonTerminal;
  }

  private mapConversation(row: {
    id: number;
    channel: string;
    thread_key: string;
    status: string;
    created_at: number;
    updated_at: number;
    closed_at: number | null;
  }): Conversation {
    return {
      id: row.id,
      channel: row.channel as Conversation['channel'],
      thread_key: row.thread_key,
      status: row.status as ConversationStatus,
      created_at: row.created_at,
      updated_at: row.updated_at,
      closed_at: row.closed_at,
    };
  }

  private mapMessage(row: {
    id: number;
    conversation_id: number;
    direction: string;
    sender: string;
    body: string;
    threading_keys: string | null;
    dkim_spf_pass: number | null;
    created_at: number;
  }): Message {
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      direction: row.direction as Message['direction'],
      sender: row.sender,
      body: row.body,
      threading_keys: row.threading_keys,
      dkim_spf_pass:
        row.dkim_spf_pass === 1 ? true : row.dkim_spf_pass === 0 ? false : null,
      created_at: row.created_at,
    };
  }

  private mapArtifact(row: {
    id: number;
    conversation_id: number;
    kind: string;
    document_id: number | null;
    storage_path: string;
    created_at: number;
  }): Artifact {
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      kind: row.kind as Artifact['kind'],
      document_id: row.document_id,
      storage_path: row.storage_path,
      created_at: row.created_at,
    };
  }
}
