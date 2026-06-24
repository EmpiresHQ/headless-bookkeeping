// src/interaction/router/interaction-router.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../../database/types';
import { migrations } from '../../database/migrations';
import { ConversationsService } from '../../conversations/conversations.service';
import { DocumentsService } from '../../documents/documents.service';
import {
  DocumentStorageService,
  DOCUMENT_STORAGE_ROOT,
} from '../../documents/document-storage.service';
import { PreviewRenderer } from '../../documents/preview-renderer';
import { InteractionConfigService } from '../config/interaction-config.service';
import { PrincipalResolverService } from '../principal/principal-resolver.service';
import { IntentClassifierService } from './intent-classifier.service';
import { RecordingFlowDispatcher, FlowDispatcher } from './flow-dispatcher';
import {
  TransportRegistryService,
  INTERACTION_TRANSPORTS,
} from '../transport/transport-registry.service';
import { InteractionTransport, OutboundMessage } from '../transport/types';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { InteractionGateService } from './interaction-gate.service';
import { InteractionRouterService } from './interaction-router.service';
import { AgentConfigService } from '../../ai/agent-config.service';
import { UnifiedEnvelope } from '../envelope/types';
import { promises as fs } from 'fs';
import { join } from 'path';

class RecordingTransport implements InteractionTransport {
  readonly channel = 'telegram' as const;
  readonly sent: OutboundMessage[] = [];
  send(out: OutboundMessage): Promise<void> {
    this.sent.push(out);
    return Promise.resolve();
  }
}

describe('InteractionRouterService (integration)', () => {
  let db: Kysely<Database>;
  let router: InteractionRouterService;
  let classifier: IntentClassifierService;
  let dispatcher: RecordingFlowDispatcher;
  let transport: RecordingTransport;
  let storageRoot: string;

  function envelope(over: Partial<UnifiedEnvelope>): UnifiedEnvelope {
    return {
      channel: 'telegram',
      sender: '999',
      convKey: 'tg:999',
      message: 'hello',
      attachments: [],
      metadata: {},
      auth: { senderId: '999', transportVerified: true },
      ...over,
    };
  }

  beforeEach(async () => {
    storageRoot = join('/tmp', 'interaction-router-test', `${Date.now()}`);
    await fs.mkdir(storageRoot, { recursive: true });
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('migrate failed');

    transport = new RecordingTransport();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        { provide: DOCUMENT_STORAGE_ROOT, useValue: storageRoot },
        DocumentStorageService,
        { provide: PreviewRenderer, useValue: { render: jest.fn().mockResolvedValue(null) } },
        ConversationsService,
        DocumentsService,
        InteractionConfigService,
        PrincipalResolverService,
        AgentConfigService,
        IntentClassifierService,
        { provide: FlowDispatcher, useClass: RecordingFlowDispatcher },
        { provide: INTERACTION_TRANSPORTS, useValue: [transport] },
        TransportRegistryService,
        AuditLogService,
        InteractionGateService,
        InteractionRouterService,
      ],
    }).compile();

    router = module.get(InteractionRouterService);
    classifier = module.get(IntentClassifierService);
    dispatcher = module.get(FlowDispatcher);

    // approver 999 on both allowlists
    await db
      .insertInto('setting')
      .values({ key: 'telegram_allowlist', value: '999', updated_at: 0 })
      .execute();
    await db
      .insertInto('setting')
      .values({ key: 'approvers', value: '999', updated_at: 0 })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  it('resolves a Conversation and persists the inbound message', async () => {
    jest.spyOn(classifier, 'classify').mockResolvedValue({ kind: 'advisory' });
    const outcome = await router.handle(envelope({}));
    expect(outcome.conversation_id).toBeGreaterThan(0);
    const convo = await db
      .selectFrom('conversation')
      .selectAll()
      .where('thread_key', '=', 'tg:999')
      .executeTakeFirstOrThrow();
    expect(convo.channel).toBe('telegram');
    const msgs = await db
      .selectFrom('message')
      .selectAll()
      .where('conversation_id', '=', convo.id)
      .execute();
    expect(
      msgs.some((m) => m.direction === 'inbound' && m.body === 'hello'),
    ).toBe(true);
  });

  it('dispatches a non-clarify intent to the FlowDispatcher', async () => {
    jest.spyOn(classifier, 'classify').mockResolvedValue({
      kind: 'action',
      actionIntent: 'create_sales_invoice',
      fields: {},
    });
    const outcome = await router.handle(envelope({}));
    expect(outcome.dispatched).toBe(true);
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0].intent).toEqual({
      kind: 'action',
      actionIntent: 'create_sales_invoice',
      fields: {},
    });
  });

  it('sends a clarify question over the transport and does NOT dispatch', async () => {
    jest
      .spyOn(classifier, 'classify')
      .mockResolvedValue({ kind: 'clarify', question: 'Which customer?' });
    const outcome = await router.handle(envelope({}));
    expect(outcome.dispatched).toBe(false);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].text).toBe('Which customer?');
    // the clarify is also persisted as an outbound Message
    const msgs = await db
      .selectFrom('message')
      .selectAll()
      .where('conversation_id', '=', outcome.conversation_id)
      .execute();
    expect(
      msgs.some(
        (m) => m.direction === 'outbound' && m.body === 'Which customer?',
      ),
    ).toBe(true);
  });

  it('ignores (no classify, no dispatch) a non-approver message', async () => {
    const spy = jest.spyOn(classifier, 'classify');
    const outcome = await router.handle(
      envelope({
        sender: '123',
        convKey: 'tg:123',
        auth: { senderId: '123', transportVerified: true },
      }),
    );
    expect(outcome.gated_in).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(dispatcher.calls).toHaveLength(0);
  });

  it('treats a button tap (callbackData) as a deterministic action — no classifier call', async () => {
    const spy = jest.spyOn(classifier, 'classify');
    await router.handle(
      envelope({ message: null, metadata: { callbackData: 'approve:42' } }),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0].intent).toEqual({
      kind: 'action',
      actionIntent: 'approve',
      fields: { ref: '42' },
    });
  });

  it('ingests an attachment through DocumentsService and binds it to the Conversation', async () => {
    jest.spyOn(classifier, 'classify').mockResolvedValue({ kind: 'advisory' });
    const outcome = await router.handle(
      envelope({
        message: null,
        attachments: [
          {
            buffer: Buffer.from('PDFBYTES'),
            filename: 'r.pdf',
            mimeType: 'application/pdf',
          },
        ],
      }),
    );
    expect(outcome.ingested).toBe(1);
    const arts = await db
      .selectFrom('artifact')
      .selectAll()
      .where('conversation_id', '=', outcome.conversation_id)
      .execute();
    expect(
      arts.some(
        (a) => a.kind === 'inbound_attachment' && a.document_id !== null,
      ),
    ).toBe(true);
  });

  it('audit-logs a denied converse from a non-approver', async () => {
    await router.handle(
      envelope({
        sender: '123',
        convKey: 'tg:123',
        auth: { senderId: '123', transportVerified: true },
      }),
    );
    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'interaction.gate.converse_denied')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('denied');
    expect(rows[0].actor).toBe('123');
  });

  it('audit-logs an action-point commit from a button tap', async () => {
    await router.handle(
      envelope({ message: null, metadata: { callbackData: 'approve:42' } }),
    );
    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'interaction.action_point.commit')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('accepted');
    expect(JSON.parse(rows[0].detail ?? '{}')).toEqual({
      callbackData: 'approve:42',
    });
  });

  it('non-approver button tap is denied', async () => {
    const outcome = await router.handle(
      envelope({
        sender: '123',
        convKey: 'tg:123',
        message: null,
        metadata: { callbackData: 'approve:42' },
        auth: { senderId: '123', transportVerified: true },
      }),
    );
    expect(outcome.dispatched).toBe(false);
    expect(outcome.gated_in).toBe(false);
    expect(dispatcher.calls).toHaveLength(0);
    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'interaction.action_point.commit')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('denied');
  });

  it('approver button tap with transportVerified:false is denied', async () => {
    const outcome = await router.handle(
      envelope({
        message: null,
        metadata: { callbackData: 'approve:42' },
        auth: { senderId: '999', transportVerified: false },
      }),
    );
    expect(outcome.dispatched).toBe(false);
    expect(outcome.gated_in).toBe(false);
    expect(dispatcher.calls).toHaveLength(0);
    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'interaction.action_point.commit')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('denied');
  });

  it('unknown callback token from an approver is audited rejected', async () => {
    const outcome = await router.handle(
      envelope({
        message: null,
        metadata: { callbackData: 'bogus:1' },
        auth: { senderId: '999', transportVerified: true },
      }),
    );
    expect(dispatcher.calls).toHaveLength(0);
    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'interaction.action_point.unknown_callback')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('rejected');
    // gated_in stays true (principal was allowed; token was stale)
    expect(outcome.gated_in).toBe(true);
  });
});
