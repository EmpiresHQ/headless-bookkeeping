import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import Database from 'better-sqlite3';
import { Database as DBType } from '../database/types';
import { migrations } from '../database/migrations';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { ConversationsService } from '../conversations/conversations.service';
import { ExpensesService } from '../expenses/expenses.service';
import { InteractionConfigService } from '../interaction/config/interaction-config.service';
import { TelegramApprovalSupportService } from '../interaction/telegram-approval-support.service';
import { TransportRegistryService } from '../interaction/transport/transport-registry.service';
import { AuditAgent } from './audit.agent';
import { SecretaryAgent } from './secretary.agent';
import { DevAgent } from './dev.agent';

type SeedApprovalInput = {
  readonly objectType:
    | 'expense'
    | 'sales_invoice'
    | 'allowance'
    | 'reconciliation_match';
  readonly objectId: number;
};

describe('Agents (real-DI)', () => {
  let db: Kysely<DBType>;
  let auditFindingsService: AuditFindingsService;
  let auditAgent: AuditAgent;
  let secretaryAgent: SecretaryAgent;
  let conversationsService: ConversationsService;
  let transportRegistry: { send: jest.Mock<Promise<void>, [unknown]> };

  beforeEach(async () => {
    const rawDb = new Database(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<DBType>({
      dialect: new SqliteDialect({ database: rawDb }),
    });

    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('Migration failed');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        AuditFindingsService,
        ConversationsService,
        InteractionConfigService,
        TelegramApprovalSupportService,
        {
          provide: ExpensesService,
          useValue: { generateDraftVoucher: jest.fn() },
        },
        {
          provide: TransportRegistryService,
          useValue: {
            send: jest
              .fn<Promise<void>, [unknown]>()
              .mockResolvedValue(undefined),
          },
        },
        AuditAgent,
        SecretaryAgent,
        DevAgent,
      ],
    }).compile();

    auditFindingsService =
      module.get<AuditFindingsService>(AuditFindingsService);
    auditAgent = module.get<AuditAgent>(AuditAgent);
    secretaryAgent = module.get<SecretaryAgent>(SecretaryAgent);
    conversationsService =
      module.get<ConversationsService>(ConversationsService);
    transportRegistry = module.get(TransportRegistryService);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db.destroy();
  });

  const setSetting = async (key: string, value: string): Promise<void> => {
    await db
      .insertInto('setting')
      .values({ key, value, updated_at: Math.floor(Date.now() / 1000) })
      .execute();
  };

  const seedApproval = async ({
    objectType,
    objectId,
  }: SeedApprovalInput): Promise<number> => {
    const now = Math.floor(Date.now() / 1000);
    const approval = await db
      .insertInto('approval')
      .values({
        object_type: objectType,
        object_id: objectId,
        status: 'pending',
        requested_by: 'policy',
        approved_by: null,
        rejected_reason: null,
        policy_reason: 'manual review',
        superseded_by: null,
        created_at: now,
        resolved_at: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return approval.id;
  };

  const seedPendingApprovalFinding = async (approvalId: number) =>
    auditFindingsService.create({
      finding_type: 'pending_approval',
      severity: 'high',
      description: `Approval ${approvalId} is waiting for a decision`,
      referenced_object_type: 'approval',
      referenced_object_id: approvalId,
    });

  const resolveTelegramConversation = async (approverId: string) =>
    conversationsService.resolve({
      channel: 'telegram',
      thread_key: `tg:${approverId}`,
    });

  describe('AuditAgent', () => {
    it('sweep() is a no-op — it never fabricates findings on the live cron', async () => {
      const before = await auditFindingsService.list();
      expect(before).toHaveLength(0);

      auditAgent.sweep();

      // The scheduled sweep must write nothing (an hourly INSERT would flood
      // audit_finding). Demo findings come only from a seed/fixture.
      const after = await auditFindingsService.list();
      expect(after).toHaveLength(0);
    });
  });

  describe('SecretaryAgent', () => {
    it('notify() logs non-approval findings and remains transport-free', async () => {
      await auditFindingsService.create({
        finding_type: 'missing_receipt',
        severity: 'high',
        description: 'Test description',
      });

      const loggerSpy = jest
        .spyOn(secretaryAgent['logger'], 'log')
        .mockImplementation();

      await secretaryAgent.notify();

      expect(transportRegistry.send).not.toHaveBeenCalled();
      expect(loggerSpy).toHaveBeenNthCalledWith(
        1,
        'SecretaryAgent: 1 open finding(s) to notify',
      );
      expect(loggerSpy).toHaveBeenNthCalledWith(
        2,
        '  [HIGH] Missing receipt — upload one for Test description',
      );
    });

    it('notify() handles no open findings gracefully', async () => {
      const loggerSpy = jest
        .spyOn(secretaryAgent['logger'], 'log')
        .mockImplementation();

      await secretaryAgent.notify();

      expect(transportRegistry.send).not.toHaveBeenCalled();
      expect(loggerSpy).toHaveBeenCalledWith(
        'SecretaryAgent: no open findings',
      );
    });

    it('branches its nag copy on the typed finding kind', async () => {
      const triage = await auditFindingsService.create({
        finding_type: 'needs_triage',
        severity: 'medium',
        description: 'doc 7',
        referenced_object_type: 'document',
        referenced_object_id: 7,
      });
      const receipt = await auditFindingsService.create({
        finding_type: 'missing_receipt',
        severity: 'medium',
        description: 'expense 3',
        referenced_object_type: 'expense',
        referenced_object_id: 3,
      });
      const hold = await auditFindingsService.create({
        finding_type: 'policy_hold',
        severity: 'medium',
        description: 'draft 9',
      });

      const triageNag = secretaryAgent.nagFor(triage);
      const receiptNag = secretaryAgent.nagFor(receipt);
      const holdNag = secretaryAgent.nagFor(hold);

      // Each kind produces distinct, kind-specific phrasing — the buffer is no
      // longer flattened into one identical nag line.
      expect(triageNag).toContain('triage');
      expect(receiptNag).toContain('receipt');
      expect(holdNag).toContain('Policy hold');
      expect(new Set([triageNag, receiptNag, holdNag]).size).toBe(3);
      // The typed reference is surfaced when present.
      expect(triageNag).toContain('document #7');
    });

    it('sends one Telegram nag with approve/reject buttons for a supported pending approval and persists the outbound message', async () => {
      await setSetting('approvers', '999');
      await setSetting('telegram_allowlist', '999');
      const approvalId = await seedApproval({
        objectType: 'sales_invoice',
        objectId: 42,
      });
      const finding = await seedPendingApprovalFinding(approvalId);
      const conversation = await resolveTelegramConversation('999');

      await secretaryAgent.notify();

      expect(transportRegistry.send).toHaveBeenCalledTimes(1);
      expect(transportRegistry.send).toHaveBeenCalledWith({
        channel: 'telegram',
        convKey: 'tg:999',
        text: secretaryAgent.nagFor(finding),
        actionPoints: [
          { id: `approve:${approvalId}`, label: 'Approve' },
          { id: `reject:${approvalId}`, label: 'Reject' },
        ],
      });

      const persisted = await conversationsService.getById(conversation.id);
      expect(persisted.messages).toHaveLength(1);
      expect(persisted.messages[0]).toMatchObject({
        direction: 'outbound',
        body: secretaryAgent.nagFor(finding),
      });
    });

    it('does not send actionable Telegram nags for unsupported approvals', async () => {
      await setSetting('approvers', '999');
      await setSetting('telegram_allowlist', '999');
      const approvalId = await seedApproval({
        objectType: 'allowance',
        objectId: 7,
      });
      await seedPendingApprovalFinding(approvalId);
      const conversation = await resolveTelegramConversation('999');

      await secretaryAgent.notify();

      expect(transportRegistry.send).not.toHaveBeenCalled();
      const persisted = await conversationsService.getById(conversation.id);
      expect(persisted.messages).toHaveLength(0);
    });

    it('does nothing until the approver has an existing private Telegram conversation with the bot', async () => {
      await setSetting('approvers', '999');
      await setSetting('telegram_allowlist', '999');
      const approvalId = await seedApproval({
        objectType: 'sales_invoice',
        objectId: 42,
      });
      await seedPendingApprovalFinding(approvalId);

      await secretaryAgent.notify();

      expect(transportRegistry.send).not.toHaveBeenCalled();
      expect(await conversationsService.list()).toHaveLength(0);
    });

    it('does nothing when approvers and telegram allowlist do not intersect', async () => {
      await setSetting('approvers', '999');
      await setSetting('telegram_allowlist', '555');
      const approvalId = await seedApproval({
        objectType: 'sales_invoice',
        objectId: 42,
      });
      await seedPendingApprovalFinding(approvalId);
      const conversation = await resolveTelegramConversation('999');

      await secretaryAgent.notify();

      expect(transportRegistry.send).not.toHaveBeenCalled();
      const persisted = await conversationsService.getById(conversation.id);
      expect(persisted.messages).toHaveLength(0);
    });
  });

  describe('DevAgent', () => {
    it('is disabled by default', () => {
      const agent = new DevAgent();
      expect(agent.isEnabled()).toBe(false);
    });

    it('can be enabled via environment variable', () => {
      const original = process.env.DEV_AGENT_ENABLED;
      try {
        process.env.DEV_AGENT_ENABLED = 'true';
        const agent = new DevAgent();
        expect(agent.isEnabled()).toBe(true);
      } finally {
        process.env.DEV_AGENT_ENABLED = original;
      }
    });
  });
});
