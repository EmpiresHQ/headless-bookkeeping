import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { decryptSecret, encryptSecret } from './secret-cipher';
import { MailboxChannel } from './types';

export type ConnectorStatus = 'connected' | 'auth_failed' | 'disconnected' | 'error';
export type AuthMode = 'password' | 'oauth';
export type Provider = 'gmail' | 'outlook' | 'imap';

export interface CreateConnectorInput {
  channel: MailboxChannel;
  authMode: AuthMode;
  provider: Provider;
  host: string;
  port: number;
  username: string;
  secret: string; // plaintext password or OAuth refresh-token; encrypted here
  folder?: string;
}

export interface MailboxConnector {
  id: number;
  channel: MailboxChannel;
  auth_mode: AuthMode;
  provider: Provider;
  host: string;
  port: number;
  username: string;
  folder: string;
  uidvalidity: number | null;
  last_uid: number;
  status: ConnectorStatus;
  last_synced_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function key(): string {
  const k = process.env.MAILBOX_SECRET_KEY;
  if (!k) throw new Error('MAILBOX_SECRET_KEY is not set');
  return k;
}

const now = () => Math.floor(Date.now() / 1000);

const PUBLIC = [
  'id',
  'channel',
  'auth_mode',
  'provider',
  'host',
  'port',
  'username',
  'folder',
  'uidvalidity',
  'last_uid',
  'status',
  'last_synced_at',
  'last_error',
  'created_at',
  'updated_at',
] as const;

/**
 * Manages mailbox connector rows. Connector secrets (passwords / OAuth refresh tokens) are
 * encrypted at rest with AES-256-GCM using MAILBOX_SECRET_KEY (32-byte hex, 64 chars).
 * The key is required to read any stored credential. Rotating or losing MAILBOX_SECRET_KEY
 * invalidates every stored secret — all connectors must be deleted and re-enrolled afterward.
 */
@Injectable()
export class MailboxConnectorService {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  async create(input: CreateConnectorInput): Promise<MailboxConnector> {
    const ts = now();
    const row = await this.db
      .insertInto('mailbox_connector')
      .values({
        channel: input.channel,
        auth_mode: input.authMode,
        provider: input.provider,
        host: input.host,
        port: input.port,
        username: input.username,
        secret_cipher: encryptSecret(input.secret, key()),
        folder: input.folder ?? 'INBOX',
        status: 'connected',
        created_at: ts,
        updated_at: ts,
      })
      .returning(PUBLIC)
      .executeTakeFirstOrThrow();
    return row as MailboxConnector;
  }

  async list(): Promise<MailboxConnector[]> {
    return (await this.db
      .selectFrom('mailbox_connector')
      .select(PUBLIC)
      .orderBy('id')
      .execute()) as MailboxConnector[];
  }

  async remove(id: number): Promise<void> {
    await this.db
      .deleteFrom('mailbox_connector')
      .where('id', '=', id)
      .execute();
  }

  async getDecryptedSecret(id: number): Promise<string> {
    const row = await this.db
      .selectFrom('mailbox_connector')
      .select('secret_cipher')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException(`Connector ${id} not found`);
    return decryptSecret(row.secret_cipher, key());
  }

  async advanceCursor(
    id: number,
    uidvalidity: number,
    lastUid: number,
  ): Promise<void> {
    await this.db
      .updateTable('mailbox_connector')
      .set({
        uidvalidity,
        last_uid: lastUid,
        last_synced_at: now(),
        status: 'connected',
        last_error: null,
        updated_at: now(),
      })
      .where('id', '=', id)
      .execute();
  }

  async markStatus(
    id: number,
    status: ConnectorStatus,
    error: string | null = null,
  ): Promise<void> {
    await this.db
      .updateTable('mailbox_connector')
      .set({ status, last_error: error, updated_at: now() })
      .where('id', '=', id)
      .execute();
  }
}
