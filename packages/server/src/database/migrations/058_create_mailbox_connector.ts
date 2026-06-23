import { Kysely, sql } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    CREATE TABLE mailbox_connector (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL CHECK (channel IN ('email_sync', 'email_push')),
      auth_mode TEXT NOT NULL CHECK (auth_mode IN ('password', 'oauth')),
      provider TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook', 'imap')),
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT NOT NULL,
      secret_cipher TEXT NOT NULL,
      folder TEXT NOT NULL DEFAULT 'INBOX',
      uidvalidity INTEGER,
      last_uid INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'connected'
        CHECK (status IN ('connected', 'auth_failed', 'disconnected', 'error')),
      last_synced_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `.execute(db);
  // email_push is singleton; email_sync may be many.
  await sql`
    CREATE UNIQUE INDEX idx_mailbox_connector_single_push
      ON mailbox_connector (channel) WHERE channel = 'email_push'
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`DROP TABLE mailbox_connector`.execute(db);
}
