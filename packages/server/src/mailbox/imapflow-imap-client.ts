import { Injectable, Logger } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import {
  ImapClient,
  ImapConnectionConfig,
  FetchedMessage,
  IdleHandle,
} from './imap-client.port';
import { ParsedAttachment } from './types';

function buildClient(conn: ImapConnectionConfig): ImapFlow {
  const auth = conn.accessToken
    ? { user: conn.username, accessToken: conn.accessToken }
    : { user: conn.username, pass: conn.password! };
  return new ImapFlow({
    host: conn.host,
    port: conn.port,
    secure: true,
    auth,
    logger: false,
    connectionTimeout: 15000,  // 15s to establish TCP+TLS
    greetingTimeout: 10000,    // 10s for server greeting after connect
    socketTimeout: 30000,      // 30s idle before declaring connection dead
  });
}

async function parseMessage(source: Buffer): Promise<{
  subject: string;
  bodyText: string;
  attachments: ParsedAttachment[];
}> {
  const mail = await simpleParser(source);
  const attachments: ParsedAttachment[] = (mail.attachments ?? []).map((a) => ({
    filename: a.filename ?? 'unnamed',
    contentType: (a.contentType ?? 'application/octet-stream').toLowerCase(),
    size: a.size ?? a.content.length,
    disposition:
      (a.contentDisposition as 'attachment' | 'inline' | undefined) ?? null,
    contentId: a.contentId ?? (a.cid ? `<${a.cid}>` : null),
    content: a.content,
  }));
  return {
    subject: mail.subject ?? '',
    bodyText: mail.text ?? '',
    attachments,
  };
}

const OPERATION_TIMEOUT_MS = 60_000; // 60s hard cap for any IMAP operation

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`IMAP operation timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}

@Injectable()
export class ImapflowImapClient extends ImapClient {
  private readonly logger = new Logger(ImapflowImapClient.name);

  async fetchSince(
    conn: ImapConnectionConfig,
    folder: string,
    sinceUid: number,
  ): Promise<{ uidvalidity: number; messages: FetchedMessage[] }> {
    const c = buildClient(conn);
    await withTimeout(c.connect(), OPERATION_TIMEOUT_MS);
    try {
      const lock = await c.getMailboxLock(folder, { readOnly: true });
      try {
        // c.mailbox is MailboxObject | false; after getMailboxLock it is always MailboxObject
        const mb = c.mailbox as { uidValidity: bigint };
        const uidvalidity = Number(mb.uidValidity);
        const messages: FetchedMessage[] = [];
        // Fetch UIDs strictly greater than the cursor.
        // range is a SequenceString; uid:true in FetchOptions enables UID-mode.
        // '*' on an empty mailbox returns nothing; on a non-empty mailbox
        // '(sinceUid+1):*' may echo the boundary UID — guard below.
        for await (const msg of c.fetch(
          `${sinceUid + 1}:*`,
          { uid: true, source: true },
          { uid: true },
        )) {
          if (msg.uid <= sinceUid) continue; // guard: '*' can echo the last-known message
          if (!msg.source) continue;
          const parsed = await parseMessage(msg.source);
          messages.push({ uid: msg.uid, ...parsed });
        }
        return { uidvalidity, messages };
      } finally {
        lock.release();
      }
    } finally {
      await c.logout();
    }
  }

  async getLatestUid(
    conn: ImapConnectionConfig,
    folder: string,
  ): Promise<{ uidvalidity: number; latestUid: number }> {
    const c = buildClient(conn);
    await withTimeout(c.connect(), OPERATION_TIMEOUT_MS);
    try {
      const lock = await c.getMailboxLock(folder, { readOnly: true });
      try {
        const mb = c.mailbox as { uidValidity: bigint; uidNext: number };
        return {
          uidvalidity: Number(mb.uidValidity),
          latestUid: Math.max(0, mb.uidNext - 1),
        };
      } finally {
        lock.release();
      }
    } finally {
      await c.logout();
    }
  }

  async idle(
    conn: ImapConnectionConfig,
    folder: string,
    onNew: () => void,
  ): Promise<IdleHandle> {
    const c = buildClient(conn);
    await withTimeout(c.connect(), OPERATION_TIMEOUT_MS);
    await withTimeout(c.mailboxOpen(folder, { readOnly: true }), OPERATION_TIMEOUT_MS);
    c.on('exists', () => onNew());
    // imapflow auto-renews IDLE; kick once to enter IDLE state
    void c.idle().catch((err) => {
      this.logger.error(`[mailbox] IDLE failed for ${folder}:`, err);
    });
    return {
      close: async () => {
        try {
          await c.logout();
        } catch {
          // already closed — ignore
        }
      },
    };
  }
}
