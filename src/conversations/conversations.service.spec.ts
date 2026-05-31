import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { ConversationsService } from './conversations.service';
// Types imported via ConversationsService usage

/**
 * Real-DI integration tests for ConversationsService.
 * Exercises the full DI graph against an in-memory SQLite DB seeded by real migrations.
 */
describe('ConversationsService (integration)', () => {
  let service: ConversationsService;
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
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
        ConversationsService,
      ],
    }).compile();

    service = module.get(ConversationsService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('resolve', () => {
    it('creates a new open conversation for unknown channel+thread_key', async () => {
      const conv = await service.resolve({
        channel: 'telegram',
        thread_key: 'thread-1',
      });

      expect(conv.channel).toBe('telegram');
      expect(conv.thread_key).toBe('thread-1');
      expect(conv.status).toBe('open');
      expect(conv.closed_at).toBeNull();
    });

    it('returns the same conversation on repeated resolve', async () => {
      const first = await service.resolve({
        channel: 'email',
        thread_key: 'msg-abc@example.com',
      });
      const second = await service.resolve({
        channel: 'email',
        thread_key: 'msg-abc@example.com',
      });

      expect(second.id).toBe(first.id);
      expect(second.status).toBe('open');
    });

    it('reopens a closed conversation and logs the transition', async () => {
      const conv = await service.resolve({
        channel: 'slack',
        thread_key: 'C123-T456',
      });

      // Close it.
      await service.close(conv.id);

      // Re-resolve — should reopen.
      const reopened = await service.resolve({
        channel: 'slack',
        thread_key: 'C123-T456',
      });

      expect(reopened.id).toBe(conv.id);
      expect(reopened.status).toBe('open');
      expect(reopened.closed_at).toBeNull();
    });

    it('creates separate conversations for different thread_keys on same channel', async () => {
      const c1 = await service.resolve({
        channel: 'telegram',
        thread_key: 'thread-A',
      });
      const c2 = await service.resolve({
        channel: 'telegram',
        thread_key: 'thread-B',
      });

      expect(c1.id).not.toBe(c2.id);
    });
  });

  describe('appendMessage', () => {
    it('adds a message to an existing conversation', async () => {
      const conv = await service.resolve({
        channel: 'email',
        thread_key: 'msg-001@example.com',
      });

      const msg = await service.appendMessage({
        conversation_id: conv.id,
        direction: 'inbound',
        sender: 'supplier@acme.com',
        body: 'Here is your invoice #123',
        threading_keys: '<msg-001@example.com>',
        dkim_spf_pass: true,
      });

      expect(msg.conversation_id).toBe(conv.id);
      expect(msg.direction).toBe('inbound');
      expect(msg.sender).toBe('supplier@acme.com');
      expect(msg.body).toBe('Here is your invoice #123');
      expect(msg.dkim_spf_pass).toBe(true);
    });

    it('throws NotFoundException for non-existent conversation', async () => {
      await expect(
        service.appendMessage({
          conversation_id: 9999,
          direction: 'inbound',
          sender: 'test',
          body: 'test',
        }),
      ).rejects.toThrow('Conversation 9999 not found');
    });

    it('adds outbound message', async () => {
      const conv = await service.resolve({
        channel: 'telegram',
        thread_key: 'tg-1',
      });

      const msg = await service.appendMessage({
        conversation_id: conv.id,
        direction: 'outbound',
        sender: 'bot',
        body: 'Please confirm this expense',
      });

      expect(msg.direction).toBe('outbound');
      expect(msg.dkim_spf_pass).toBeNull();
    });
  });

  describe('attachArtifact', () => {
    it('attaches an inbound artifact to a conversation', async () => {
      const conv = await service.resolve({
        channel: 'email',
        thread_key: 'msg-attach@example.com',
      });

      const artifact = await service.attachArtifact({
        conversation_id: conv.id,
        kind: 'inbound_attachment',
        storage_path: '/data/docs/1/invoice.pdf',
      });

      expect(artifact.conversation_id).toBe(conv.id);
      expect(artifact.kind).toBe('inbound_attachment');
      expect(artifact.document_id).toBeNull();
    });

    it('attaches an outbound artifact', async () => {
      const conv = await service.resolve({
        channel: 'api',
        thread_key: 'api-1',
      });

      const artifact = await service.attachArtifact({
        conversation_id: conv.id,
        kind: 'outbound_output',
        storage_path: '/data/outputs/1/report.pdf',
      });

      expect(artifact.kind).toBe('outbound_output');
    });

    it('throws NotFoundException for non-existent conversation', async () => {
      await expect(
        service.attachArtifact({
          conversation_id: 9999,
          kind: 'inbound_attachment',
          storage_path: '/tmp/x.pdf',
        }),
      ).rejects.toThrow('Conversation 9999 not found');
    });
  });

  describe('associate', () => {
    it('links a conversation to a business object', async () => {
      const conv = await service.resolve({
        channel: 'telegram',
        thread_key: 'tg-obj-1',
      });

      await service.associate({
        conversation_id: conv.id,
        object_type: 'expense',
        object_id: 42,
      });

      // Verify via getForObject.
      const convs = await service.getForObject('expense', 42);
      expect(convs.length).toBe(1);
      expect(convs[0].id).toBe(conv.id);
    });

    it('is idempotent — duplicate associate is a no-op', async () => {
      const conv = await service.resolve({
        channel: 'email',
        thread_key: 'msg-idem@example.com',
      });

      await service.associate({
        conversation_id: conv.id,
        object_type: 'sales_invoice',
        object_id: 10,
      });
      await service.associate({
        conversation_id: conv.id,
        object_type: 'sales_invoice',
        object_id: 10,
      });

      const convs = await service.getForObject('sales_invoice', 10);
      expect(convs.length).toBe(1);
    });

    it('throws NotFoundException for non-existent conversation', async () => {
      await expect(
        service.associate({
          conversation_id: 9999,
          object_type: 'expense',
          object_id: 1,
        }),
      ).rejects.toThrow('Conversation 9999 not found');
    });
  });

  describe('close', () => {
    it('closes a conversation with no associated objects', async () => {
      const conv = await service.resolve({
        channel: 'api',
        thread_key: 'api-close-1',
      });

      const closed = await service.close(conv.id);

      expect(closed.status).toBe('closed');
      expect(closed.closed_at).not.toBeNull();
    });

    it('blocks close when associated expense is non-terminal (draft)', async () => {
      const conv = await service.resolve({
        channel: 'telegram',
        thread_key: 'tg-close-block',
      });

      // Create a draft expense.
      await db
        .insertInto('expense')
        .values({
          category: 'software',
          gross_amount: 1000,
          vat_amount: 250,
          currency: 'EUR',
          tax_point_date: '2025-01-15',
          status: 'draft',
          created_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        })
        .execute();

      const expenseRow = await db
        .selectFrom('expense')
        .select('id')
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow();

      await service.associate({
        conversation_id: conv.id,
        object_type: 'expense',
        object_id: expenseRow.id,
      });

      await expect(service.close(conv.id)).rejects.toThrow(
        'non-terminal business objects',
      );
    });

    it('blocks close when associated expense is pending', async () => {
      const conv = await service.resolve({
        channel: 'email',
        thread_key: 'msg-pending@example.com',
      });

      await db
        .insertInto('expense')
        .values({
          category: 'transport',
          gross_amount: 500,
          vat_amount: 125,
          currency: 'EUR',
          tax_point_date: '2025-02-01',
          status: 'pending',
          created_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        })
        .execute();

      const expenseRow = await db
        .selectFrom('expense')
        .select('id')
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow();

      await service.associate({
        conversation_id: conv.id,
        object_type: 'expense',
        object_id: expenseRow.id,
      });

      await expect(service.close(conv.id)).rejects.toThrow(
        'non-terminal business objects',
      );
    });

    it('allows close when associated expense is posted (terminal)', async () => {
      const conv = await service.resolve({
        channel: 'slack',
        thread_key: 'C999-T888',
      });

      await db
        .insertInto('expense')
        .values({
          category: 'rent',
          gross_amount: 200000,
          vat_amount: 50000,
          currency: 'EUR',
          tax_point_date: '2025-03-01',
          status: 'posted',
          created_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        })
        .execute();

      const expenseRow = await db
        .selectFrom('expense')
        .select('id')
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow();

      await service.associate({
        conversation_id: conv.id,
        object_type: 'expense',
        object_id: expenseRow.id,
      });

      const closed = await service.close(conv.id);
      expect(closed.status).toBe('closed');
    });

    it('blocks close when associated sales_invoice is non-terminal (draft)', async () => {
      const conv = await service.resolve({
        channel: 'api',
        thread_key: 'api-inv-draft',
      });

      await db
        .insertInto('sales_invoice')
        .values({
          invoice_number: 'INV-001',
          gross_amount: 5000,
          vat_amount: 1250,
          currency: 'EUR',
          tax_point_date: '2025-04-01',
          status: 'draft',
          created_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        })
        .execute();

      const invRow = await db
        .selectFrom('sales_invoice')
        .select('id')
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow();

      await service.associate({
        conversation_id: conv.id,
        object_type: 'sales_invoice',
        object_id: invRow.id,
      });

      await expect(service.close(conv.id)).rejects.toThrow(
        'non-terminal business objects',
      );
    });

    it('allows close when associated sales_invoice is sent (terminal)', async () => {
      const conv = await service.resolve({
        channel: 'email',
        thread_key: 'msg-sent@example.com',
      });

      await db
        .insertInto('sales_invoice')
        .values({
          invoice_number: 'INV-002',
          gross_amount: 3000,
          vat_amount: 750,
          currency: 'EUR',
          tax_point_date: '2025-05-01',
          status: 'posted',
          created_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        })
        .execute();

      const invRow = await db
        .selectFrom('sales_invoice')
        .select('id')
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow();

      await service.associate({
        conversation_id: conv.id,
        object_type: 'sales_invoice',
        object_id: invRow.id,
      });

      const closed = await service.close(conv.id);
      expect(closed.status).toBe('closed');
    });

    it('throws BadRequestException when already closed', async () => {
      const conv = await service.resolve({
        channel: 'telegram',
        thread_key: 'tg-double-close',
      });

      await service.close(conv.id);

      await expect(service.close(conv.id)).rejects.toThrow('already closed');
    });
  });

  describe('getForObject', () => {
    it('returns associated conversations for correction context', async () => {
      const conv = await service.resolve({
        channel: 'email',
        thread_key: 'msg-correction@example.com',
      });

      // Add a message.
      await service.appendMessage({
        conversation_id: conv.id,
        direction: 'inbound',
        sender: 'user@company.com',
        body: 'This expense was miscategorized',
      });

      // Create a posted expense.
      await db
        .insertInto('expense')
        .values({
          category: 'software',
          gross_amount: 1500,
          vat_amount: 375,
          currency: 'EUR',
          tax_point_date: '2025-06-01',
          status: 'posted',
          created_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        })
        .execute();

      const expenseRow = await db
        .selectFrom('expense')
        .select('id')
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow();

      await service.associate({
        conversation_id: conv.id,
        object_type: 'expense',
        object_id: expenseRow.id,
      });

      // Close the conversation.
      await service.close(conv.id);

      // getForObject should return the closed thread for correction context.
      const results = await service.getForObject('expense', expenseRow.id);
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(conv.id);
      expect(results[0].status).toBe('closed');
      expect(results[0].messages.length).toBe(1);
      expect(results[0].messages[0].body).toBe(
        'This expense was miscategorized',
      );
    });

    it('returns empty array when no conversations associated', async () => {
      const results = await service.getForObject('expense', 9999);
      expect(results).toEqual([]);
    });

    it('returns multiple conversations associated with same object', async () => {
      const c1 = await service.resolve({
        channel: 'telegram',
        thread_key: 'tg-multi-1',
      });
      const c2 = await service.resolve({
        channel: 'email',
        thread_key: 'msg-multi@example.com',
      });

      await db
        .insertInto('expense')
        .values({
          category: 'transport',
          gross_amount: 800,
          vat_amount: 200,
          currency: 'EUR',
          tax_point_date: '2025-07-01',
          status: 'posted',
          created_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        })
        .execute();

      const expenseRow = await db
        .selectFrom('expense')
        .select('id')
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow();

      await service.associate({
        conversation_id: c1.id,
        object_type: 'expense',
        object_id: expenseRow.id,
      });
      await service.associate({
        conversation_id: c2.id,
        object_type: 'expense',
        object_id: expenseRow.id,
      });

      const results = await service.getForObject('expense', expenseRow.id);
      expect(results.length).toBe(2);
    });
  });

  describe('getById', () => {
    it('returns a conversation with hydrated messages and artifacts', async () => {
      const conv = await service.resolve({
        channel: 'api',
        thread_key: 'api-detail-1',
      });

      await service.appendMessage({
        conversation_id: conv.id,
        direction: 'inbound',
        sender: 'user',
        body: 'Hello',
      });

      await service.attachArtifact({
        conversation_id: conv.id,
        kind: 'inbound_attachment',
        storage_path: '/data/docs/1/receipt.pdf',
      });

      const detail = await service.getById(conv.id);

      expect(detail.id).toBe(conv.id);
      expect(detail.messages.length).toBe(1);
      expect(detail.artifacts.length).toBe(1);
    });

    it('throws NotFoundException for missing id', async () => {
      await expect(service.getById(9999)).rejects.toThrow(
        'Conversation 9999 not found',
      );
    });
  });

  describe('list', () => {
    it('lists conversations in descending order', async () => {
      await service.resolve({ channel: 'telegram', thread_key: 'tg-list-1' });
      // Small delay to ensure different timestamps.
      await new Promise((r) => setTimeout(r, 10));
      await service.resolve({ channel: 'telegram', thread_key: 'tg-list-2' });

      const list = await service.list();
      expect(list.length).toBe(2);
      // Most recent first (by id, since created_at may be same second).
      expect(list[0].id).toBeGreaterThan(list[1].id);
    });
  });
});
