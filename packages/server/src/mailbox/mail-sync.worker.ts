import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MailboxConnectorService } from './mailbox-connector.service';
import {
  ImapClient,
  ImapConnectionConfig,
  IdleHandle,
} from './imap-client.port';
import { HarvestService } from './harvest.service';
import { OAuthService } from './oauth.service';
import { SettingsService } from '../admin/settings.service';

// Bounded connect retries for a transient IMAP failure. 5 attempts with
// exponential backoff (1s, 2s, 4s, 8s between them); after the last the
// connector is marked `error`.
const MAX_CONNECT_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000;
// How many recent messages to harvest on first connect (when last_uid=0).
// The operator can override this via the mailbox_initial_fetch_count setting.
const DEFAULT_INITIAL_FETCH_COUNT = 200;

@Injectable()
export class MailSyncWorker implements OnModuleInit {
  private readonly logger = new Logger(MailSyncWorker.name);
  private readonly idleHandles = new Map<number, IdleHandle>();
  private readonly inFlight = new Map<number, Promise<void>>();

  constructor(
    private readonly connectors: MailboxConnectorService,
    private readonly imap: ImapClient,
    @Inject('HARVEST') private readonly harvest: HarvestService,
    @Inject('OAUTH') private readonly oauth: OAuthService,
    private readonly settings: SettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Best-effort: catch-up + open IDLE per connector. Skipped cleanly under test
    // if no connectors exist. Live IDLE is the unit-untested edge.
    const connectors = await this.connectors.list();
    if (connectors.length > 0) {
      const keyValid =
        Buffer.from(process.env.MAILBOX_SECRET_KEY ?? '', 'hex').length === 32;
      if (!keyValid) {
        this.logger.error(
          `MAILBOX_SECRET_KEY is missing or not a 32-byte hex string; ${connectors.length} mailbox connector(s) cannot sync until it is restored. Rotating this key invalidates all stored credentials — connectors must be re-enrolled.`,
        );
        for (const c of connectors) {
          await this.connectors.markStatus(
            c.id,
            'auth_failed',
            'MAILBOX_SECRET_KEY missing or invalid',
          );
        }
        return;
      }
    }
    // Do NOT await IMAP work during bootstrap: a slow or unreachable mail server
    // would block onModuleInit and stall NestJS startup (the HTTP listener never
    // binds). Kick each connector off in the background — the @Cron sweep is the
    // backstop and openIdle reconnects on its own.
    this.logger.log(
      `startup: kicking off initial sync for ${connectors.length} connector(s)`,
    );
    for (const c of connectors) {
      void this.syncOnce(c.id)
        .then(() => this.openIdle(c.id))
        .catch((e) => this.logger.warn(`initial sync/idle ${c.id}: ${e}`));
    }
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async sweep(): Promise<void> {
    const connectors = await this.connectors.list();
    this.logger.log(`sweep: checking ${connectors.length} connector(s)`);
    for (const c of connectors) {
      await this.syncOnce(c.id).catch((e) =>
        this.logger.warn(`sweep ${c.id}: ${e}`),
      );
    }
  }

  async syncOnce(connectorId: number): Promise<void> {
    const running = this.inFlight.get(connectorId);
    if (running) return running; // coalesce: wait for the in-flight sync to finish
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.inFlight.set(connectorId, promise);
    try {
      const [conn] = (await this.connectors.list()).filter(
        (c) => c.id === connectorId,
      );
      if (!conn) return;
      this.logger.log(
        `sync start connector=${connectorId} (${conn.username}) last_uid=${conn.last_uid}`,
      );

      // First-time sync: baseline cursor + harvest last N messages only.
      // Avoids downloading the entire mailbox history (could be 100k+ messages).
      if (conn.last_uid === 0) {
        await this.initialSync(connectorId, conn);
        return;
      }

      // Connect + fetch with bounded retries & backoff. Transient failures
      // (network, timeout, server busy) are retried; auth failures fail fast.
      const { uidvalidity, messages } = await this.withConnectRetry(
        connectorId,
        async () => {
          const cfg = await this.connection(connectorId);
          return this.imap.fetchSince(cfg, conn.folder, conn.last_uid);
        },
      );

      if (conn.uidvalidity !== null && conn.uidvalidity !== uidvalidity) {
        // Mailbox renumbered — re-baseline forward, do NOT re-harvest history.
        // Use the max UID from the new fetch (ignoring the old cursor from the old namespace).
        const maxUid =
          messages.length > 0
            ? messages.reduce((m, x) => Math.max(m, x.uid), 0)
            : conn.last_uid; // renumbered mailbox returned nothing: keep prior cursor, don't reset to 0 (avoids a full-folder re-fetch)
        this.logger.warn(
          `connector=${connectorId} uidvalidity changed — re-baselined to uid=${maxUid}`,
        );
        await this.connectors.advanceCursor(connectorId, uidvalidity, maxUid);
        return;
      }

      let lastUid = conn.last_uid;
      for (const msg of messages.sort((a, b) => a.uid - b.uid)) {
        await this.harvest.harvestMessage(conn.channel, msg);
        lastUid = Math.max(lastUid, msg.uid);
      }
      this.logger.log(
        `sync done connector=${connectorId} harvested=${messages.length} last_uid=${lastUid}`,
      );
      await this.connectors.advanceCursor(connectorId, uidvalidity, lastUid);
    } catch (err) {
      // All retries exhausted (or an auth failure failed fast): drop the
      // connector into an error state with the reason so the operator sees it.
      const status = this.isAuthError(err) ? 'auth_failed' : 'error';
      const detail = this.describeError(err);
      this.logger.error(
        `sync failed connector=${connectorId} status=${status} error=${detail}`,
      );
      const msg = err instanceof Error ? err.message : String(err);
      await this.connectors.markStatus(connectorId, status, msg);
    } finally {
      this.inFlight.delete(connectorId);
      resolve();
    }
  }

  private async initialSync(
    connectorId: number,
    conn: Awaited<ReturnType<MailboxConnectorService['list']>>[number],
  ): Promise<void> {
    const { uidvalidity, latestUid } = await this.withConnectRetry(
      connectorId,
      async () => {
        const cfg = await this.connection(connectorId);
        return this.imap.getLatestUid(cfg, conn.folder);
      },
    );

    const raw = await this.settings
      .get('mailbox_initial_fetch_count')
      .catch(() => null);
    const count = Math.max(0, Number(raw ?? DEFAULT_INITIAL_FETCH_COUNT));
    const sinceUid = count > 0 ? Math.max(0, latestUid - count) : latestUid;

    let harvested = 0;
    if (sinceUid < latestUid && count > 0) {
      const { messages } = await this.withConnectRetry(
        connectorId,
        async () => {
          const cfg = await this.connection(connectorId);
          return this.imap.fetchSince(cfg, conn.folder, sinceUid);
        },
      );
      for (const msg of messages.sort((a, b) => a.uid - b.uid)) {
        await this.harvest.harvestMessage(conn.channel, msg);
      }
      harvested = messages.length;
    }

    this.logger.log(
      `baseline connector=${connectorId} latestUid=${latestUid} harvested=${harvested} initial_fetch_count=${count}`,
    );
    await this.connectors.advanceCursor(connectorId, uidvalidity, latestUid);
  }

  private isAuthError(err: unknown): boolean {
    // imapflow sets authenticationFailed=true on XOAUTH2/LOGIN rejections.
    if (
      err &&
      typeof err === 'object' &&
      (err as Record<string, unknown>).authenticationFailed
    )
      return true;
    const msg = err instanceof Error ? err.message : String(err);
    // OAuth refresh failures ("OAuth refresh failed") also match /auth/.
    return /auth|token|credential|login|password/i.test(msg);
  }

  private describeError(err: unknown): string {
    if (!err || typeof err !== 'object') return String(err);
    const e = err as Record<string, unknown>;
    const parts: string[] = [err instanceof Error ? err.message : String(err)];
    if (e.serverResponseCode) parts.push(`code=${e.serverResponseCode}`);
    if (e.response) parts.push(`response=${e.response}`);
    if (e.oauthError)
      parts.push(
        `oauthError=${typeof e.oauthError === 'object' ? JSON.stringify(e.oauthError) : e.oauthError}`,
      );
    return parts.join(' | ');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Run an IMAP operation with bounded retries and exponential backoff.
   * Auth errors are NOT retried (a wrong credential won't fix itself) — they
   * throw immediately. Transient errors retry up to MAX_CONNECT_ATTEMPTS
   * (backoff 1s, 2s, 4s, 8s); the last error is rethrown after the final attempt
   * so the caller marks the connector `error`.
   */
  private async withConnectRetry<T>(
    connectorId: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (this.isAuthError(e)) throw e; // fail fast — do not retry auth errors
        if (attempt < MAX_CONNECT_ATTEMPTS) {
          const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);
          const desc = e instanceof Error ? e.message : String(e);
          this.logger.warn(
            `mailbox ${connectorId} connect attempt ${attempt}/${MAX_CONNECT_ATTEMPTS} failed (${desc}); retrying in ${backoff}ms`,
          );
          await this.delay(backoff);
        }
      }
    }
    throw lastErr;
  }

  private async connection(connectorId: number): Promise<ImapConnectionConfig> {
    const [conn] = (await this.connectors.list()).filter(
      (c) => c.id === connectorId,
    );
    const secret = await this.connectors.getDecryptedSecret(connectorId);
    if (conn.auth_mode === 'oauth') {
      const provider = conn.provider === 'gmail' ? 'gmail' : 'outlook';
      const accessToken = await this.oauth.accessToken(provider, secret);
      return {
        host: conn.host,
        port: conn.port,
        username: conn.username,
        accessToken,
      };
    }
    return {
      host: conn.host,
      port: conn.port,
      username: conn.username,
      password: secret,
    };
  }

  async connectAndSync(connectorId: number): Promise<void> {
    await this.syncOnce(connectorId);
    await this.openIdle(connectorId);
  }

  private async openIdle(connectorId: number): Promise<void> {
    const [conn] = (await this.connectors.list()).filter(
      (c) => c.id === connectorId,
    );
    if (!conn) return;
    const existing = this.idleHandles.get(connectorId);
    if (existing) await existing.close().catch(() => undefined);
    const cfg = await this.connection(connectorId);
    const handle = await this.imap.idle(cfg, conn.folder, () => {
      void this.syncOnce(connectorId).catch((e) =>
        this.logger.warn(`idle-sync ${connectorId}: ${e}`),
      );
    });
    this.idleHandles.set(connectorId, handle);
  }
}
