import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { ConflictException } from '@nestjs/common';
import SqliteDb from 'better-sqlite3';
import { Database } from '../../database/types';
import { migrations } from '../../database/migrations';
import { BusinessObjectStatus } from '../../common/types/business-object-status';
import {
  StatusTransitionService,
  IllegalStatusTransitionError,
  TransitionableObjectType,
} from './status-transition.service';

describe('StatusTransitionService', () => {
  let db: Kysely<Database>;
  let svc: StatusTransitionService;

  const seedExpense = async (
    status: BusinessObjectStatus,
    voucherId: number | null = null,
  ): Promise<number> => {
    const now = Math.floor(Date.now() / 1000);
    const row = await db
      .insertInto('expense')
      .values({
        document_id: null,
        supplier_id: null,
        category: 'software',
        gross_amount: 10000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-03-15',
        status,
        voucher_id: voucherId,
        created_at: now,
        updated_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  };

  const statusOf = async (
    type: TransitionableObjectType,
    id: number,
  ): Promise<string | undefined> => {
    const row = await db
      .selectFrom(type)
      .select('status')
      .where('id', '=', id)
      .executeTakeFirst();
    return row?.status;
  };

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
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
        StatusTransitionService,
      ],
    }).compile();

    svc = module.get(StatusTransitionService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ── Legal transition graph ────────────────────────────────────
  describe('legal transitions', () => {
    const legal: [BusinessObjectStatus, BusinessObjectStatus][] = [
      ['draft', 'pending'],
      ['draft', 'posted'],
      ['pending', 'posted'],
      ['pending', 'draft'],
      ['posted', 'reversed'],
    ];

    it.each(legal)('allows %s → %s and claims the row', async (from, to) => {
      const id = await seedExpense(from);
      await db
        .transaction()
        .execute((trx) => svc.transition(trx, 'expense', id, from, to));
      expect(await statusOf('expense', id)).toBe(to);
    });

    it('isLegal mirrors the graph', () => {
      for (const [from, to] of legal) {
        expect(svc.isLegal(from, to)).toBe(true);
      }
    });

    it('co-writes voucher_id atomically on posted → reversed', async () => {
      const id = await seedExpense('posted', 1);
      await db.transaction().execute((trx) =>
        svc.transition(trx, 'expense', id, 'posted', 'reversed', {
          extras: { voucher_id: 99 },
        }),
      );
      const row = await db
        .selectFrom('expense')
        .select(['status', 'voucher_id'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('reversed');
      expect(row.voucher_id).toBe(99);
    });
  });

  // ── Illegal transitions are rejected (the ONE added behavior) ──
  describe('illegal transitions', () => {
    const illegal: [BusinessObjectStatus, BusinessObjectStatus][] = [
      ['posted', 'draft'],
      ['posted', 'pending'],
      ['reversed', 'posted'],
      ['reversed', 'draft'],
      ['draft', 'reversed'],
      ['pending', 'reversed'],
    ];

    it.each(illegal)('rejects %s → %s and writes NOTHING', async (from, to) => {
      const id = await seedExpense(from);
      await expect(
        db
          .transaction()
          .execute((trx) => svc.transition(trx, 'expense', id, from, to)),
      ).rejects.toBeInstanceOf(IllegalStatusTransitionError);
      // the row is untouched
      expect(await statusOf('expense', id)).toBe(from);
    });

    it('isLegal is false for illegal pairs and rejects before any UPDATE', () => {
      for (const [from, to] of illegal) {
        expect(svc.isLegal(from, to)).toBe(false);
      }
    });
  });

  // ── Idempotency clash still throws Conflict (ADR-0021) ─────────
  describe('atomic idempotency claim (ADR-0021)', () => {
    it('throws ConflictException when the object is not in the expected from-state', async () => {
      // legal transition shape (draft → posted) but the row is already posted:
      // nothing is claimed → Conflict, exactly the old claimObjectStatus.
      const id = await seedExpense('posted');
      await expect(
        db
          .transaction()
          .execute((trx) =>
            svc.transition(trx, 'expense', id, 'draft', 'posted'),
          ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('a second draft → posted claim throws Conflict (no double-claim)', async () => {
      const id = await seedExpense('draft');
      await db
        .transaction()
        .execute((trx) =>
          svc.transition(trx, 'expense', id, 'draft', 'posted'),
        );
      await expect(
        db
          .transaction()
          .execute((trx) =>
            svc.transition(trx, 'expense', id, 'draft', 'posted'),
          ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('uses the custom conflictMessage when supplied', async () => {
      const id = await seedExpense('posted');
      await expect(
        db.transaction().execute((trx) =>
          svc.transition(trx, 'expense', id, 'draft', 'posted', {
            conflictMessage: (actual) => `nope, it is ${actual}`,
          }),
        ),
      ).rejects.toThrow('nope, it is posted');
    });

    it('works on the sales_invoice table too', async () => {
      const now = Math.floor(Date.now() / 1000);
      const inv = await db
        .insertInto('sales_invoice')
        .values({
          customer_id: null,
          invoice_number: 'INV-1',
          gross_amount: 10000,
          vat_amount: 0,
          currency: 'EUR',
          tax_point_date: '2026-03-15',
          due_date: null,
          status: 'draft',
          sent_at: null,
          voucher_id: null,
          document_vat_marking: null,
          created_at: now,
          updated_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await db
        .transaction()
        .execute((trx) =>
          svc.transition(trx, 'sales_invoice', inv.id, 'draft', 'pending'),
        );
      expect(await statusOf('sales_invoice', inv.id)).toBe('pending');
    });
  });
});
