import { ParsedAttachment } from './types';

export interface ImapConnectionConfig {
  host: string;
  port: number;
  username: string;
  // exactly one is set:
  password?: string;
  accessToken?: string; // XOAUTH2
}

export interface FetchedMessage {
  uid: number;
  subject: string;
  bodyText: string;
  attachments: ParsedAttachment[];
}

export interface IdleHandle {
  close(): Promise<void>;
}

export abstract class ImapClient {
  abstract fetchSince(
    conn: ImapConnectionConfig,
    folder: string,
    sinceUid: number,
  ): Promise<{ uidvalidity: number; messages: FetchedMessage[] }>;

  /** Return current uidvalidity and the latest assigned UID without fetching any messages. */
  abstract getLatestUid(
    conn: ImapConnectionConfig,
    folder: string,
  ): Promise<{ uidvalidity: number; latestUid: number }>;

  abstract idle(
    conn: ImapConnectionConfig,
    folder: string,
    onNew: () => void,
  ): Promise<IdleHandle>;
}
