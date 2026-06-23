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

@Injectable()
export class MailSyncWorker implements OnModuleInit {
  private readonly logger = new Logger(MailSyncWorker.name);
  private readonly idleHandles = new Map<number, IdleHandle>();
  private readonly inFlight = new Set<number>();

  constructor(
    private readonly connectors: MailboxConnectorService,
    private readonly imap: ImapClient,
    @Inject('HARVEST') private readonly harvest: HarvestService,
    @Inject('OAUTH') private readonly oauth: OAuthService,
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
    for (const c of connectors) {
      await this.syncOnce(c.id).catch((e) =>
        this.logger.warn(`initial sync ${c.id}: ${e}`),
      );
      await this.openIdle(c.id).catch((e) =>
        this.logger.warn(`idle ${c.id}: ${e}`),
      );
    }
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async sweep(): Promise<void> {
    for (const c of await this.connectors.list()) {
      await this.syncOnce(c.id).catch((e) =>
        this.logger.warn(`sweep ${c.id}: ${e}`),
      );
    }
  }

  async syncOnce(connectorId: number): Promise<void> {
    if (this.inFlight.has(connectorId)) return; // single-flight guard per connector
    this.inFlight.add(connectorId);
    try {
      const [conn] = (await this.connectors.list()).filter(
        (c) => c.id === connectorId,
      );
      if (!conn) return;
      const cfg = await this.connection(connectorId);
      const { uidvalidity, messages } = await this.imap.fetchSince(
        cfg,
        conn.folder,
        conn.last_uid,
      );

      if (conn.uidvalidity !== null && conn.uidvalidity !== uidvalidity) {
        // Mailbox renumbered — re-baseline forward, do NOT re-harvest history.
        // Use the max UID from the new fetch (ignoring the old cursor from the old namespace).
        const maxUid =
          messages.length > 0
            ? messages.reduce((m, x) => Math.max(m, x.uid), 0)
            : conn.last_uid; // renumbered mailbox returned nothing: keep prior cursor, don't reset to 0 (avoids a full-folder re-fetch)
        await this.connectors.advanceCursor(connectorId, uidvalidity, maxUid);
        return;
      }

      let lastUid = conn.last_uid;
      for (const msg of messages.sort((a, b) => a.uid - b.uid)) {
        await this.harvest.harvestMessage(conn.channel, msg);
        lastUid = Math.max(lastUid, msg.uid);
      }
      await this.connectors.advanceCursor(connectorId, uidvalidity, lastUid);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /AUTH|token|credential|login/i.test(msg)
        ? 'auth_failed'
        : 'error';
      await this.connectors.markStatus(connectorId, status, msg);
    } finally {
      this.inFlight.delete(connectorId);
    }
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
