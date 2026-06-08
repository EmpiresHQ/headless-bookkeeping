import { Kysely, sql } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  // Conversation: the durable, auditable thread of Messages on a single channel.
  // Identified by (channel, thread_key) — deterministic router resolution.
  await db.schema
    .createTable('conversation')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    // enum: 'telegram' | 'email' | 'slack' | 'api'
    .addColumn('channel', 'text', (col) =>
      col
        .notNull()
        .check(sql`channel IN ('telegram', 'email', 'slack', 'api')`),
    )
    // Channel-specific thread key (email Message-ID/References, chat thread id).
    .addColumn('thread_key', 'text', (col) => col.notNull())
    // enum: 'open' | 'closed'
    .addColumn('status', 'text', (col) =>
      col
        .notNull()
        .defaultTo('open')
        .check(sql`status IN ('open', 'closed')`),
    )
    .addColumn('created_at', 'integer', (col) =>
      col.notNull().defaultTo(sql`(unixepoch())`),
    )
    .addColumn('updated_at', 'integer', (col) =>
      col.notNull().defaultTo(sql`(unixepoch())`),
    )
    .addColumn('closed_at', 'integer')
    // Unique constraint for deterministic resolution.
    .addUniqueConstraint('uq_conversation_channel_thread', [
      'channel',
      'thread_key',
    ])
    .execute();

  // Message: one turn in a Conversation.
  await db.schema
    .createTable('message')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('conversation_id', 'integer', (col) =>
      col.notNull().references('conversation.id'),
    )
    // enum: 'inbound' | 'outbound'
    .addColumn('direction', 'text', (col) =>
      col.notNull().check(sql`direction IN ('inbound', 'outbound')`),
    )
    .addColumn('sender', 'text', (col) => col.notNull())
    .addColumn('body', 'text', (col) => col.notNull())
    // Threading keys (email References, chat thread id) for deterministic routing.
    .addColumn('threading_keys', 'text')
    // DKIM/SPF pass result (email only).
    .addColumn('dkim_spf_pass', 'integer')
    .addColumn('created_at', 'integer', (col) =>
      col.notNull().defaultTo(sql`(unixepoch())`),
    )
    .execute();

  // Artifact: a file bound to a Conversation — inbound attachment or outbound output.
  await db.schema
    .createTable('artifact')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('conversation_id', 'integer', (col) =>
      col.notNull().references('conversation.id'),
    )
    // enum: 'inbound_attachment' | 'outbound_output'
    .addColumn('kind', 'text', (col) =>
      col
        .notNull()
        .check(sql`kind IN ('inbound_attachment', 'outbound_output')`),
    )
    // FK to Document (nullable — outbound outputs have no Document).
    .addColumn('document_id', 'integer', (col) => col.references('document.id'))
    .addColumn('storage_path', 'text', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) =>
      col.notNull().defaultTo(sql`(unixepoch())`),
    )
    .execute();

  // M:N: Conversation ↔ Document
  await db.schema
    .createTable('conversation_document')
    .ifNotExists()
    .addColumn('conversation_id', 'integer', (col) =>
      col.notNull().references('conversation.id'),
    )
    .addColumn('document_id', 'integer', (col) =>
      col.notNull().references('document.id'),
    )
    .addPrimaryKeyConstraint('pk_conversation_document', [
      'conversation_id',
      'document_id',
    ])
    .execute();

  // M:N: Conversation ↔ Business object (Expense, SalesInvoice, etc.)
  await db.schema
    .createTable('conversation_business_object')
    .ifNotExists()
    .addColumn('conversation_id', 'integer', (col) =>
      col.notNull().references('conversation.id'),
    )
    .addColumn('object_type', 'text', (col) => col.notNull())
    .addColumn('object_id', 'integer', (col) => col.notNull())
    .addPrimaryKeyConstraint('pk_conversation_business_object', [
      'conversation_id',
      'object_type',
      'object_id',
    ])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .dropTable('conversation_business_object')
    .ifExists()
    .execute();
  await db.schema.dropTable('conversation_document').ifExists().execute();
  await db.schema.dropTable('artifact').ifExists().execute();
  await db.schema.dropTable('message').ifExists().execute();
  await db.schema.dropTable('conversation').ifExists().execute();
}
