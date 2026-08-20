import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { CurrencyService } from '../currency/currency.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { EntitiesService } from '../entities/entities.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { CategoryService } from '../categories/category.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ExpensesService } from './expenses.service';
import { DuplicateExpenseException } from './duplicate-expense.exception';

/**
 * ExpensesService duplicate guard (issue #195).
 *
 * `createExpense` is the single choke point covering all three creation paths
 * (POST /api/expenses, AI intake, manual-classify), so the guard lives there
 * and REFUSES creation — nothing enters the books, so there is nothing to
 * reverse later. The only way past it is an explicit operator override, which
 * leaves an audit_log trace.
 */
describe('ExpensesService duplicate guard (integration)', () => {
  let db: Kysely<Database>;
  let service: ExpensesService;
  let entitiesService: EntitiesService;

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
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        PluginLoader,
        OrgContextResolver,
        CurrencyService,
        VoucherProjectionService,
        EntitiesService,
        PeriodLockService,
        AuditLogService,
        { provide: CategoryService, useValue: { assertValid: async () => {} } },
        ExpensesService,
      ],
    }).compile();

    service = module.get(ExpensesService);
    entitiesService = module.get(EntitiesService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  let registrationSeq = 0;
  const newSupplier = async (name: string) => {
    registrationSeq += 1;
    return entitiesService.onboard({
      role: 'supplier',
      country: 'IE',
      name,
      registrationKey: `IE9900${String(registrationSeq).padStart(4, '0')}`,
    });
  };

  const dto = (over: Record<string, unknown> = {}) => ({
    category: 'software',
    gross_amount: 1600,
    vat_amount: 300,
    currency: 'EUR',
    tax_point_date: '2026-05-31',
    ...over,
  });

  const expenseCount = async () => {
    const rows = await db.selectFrom('expense').select(['id']).execute();
    return rows.length;
  };

  const auditRows = async (action: string) =>
    db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', action)
      .execute();

  describe('refusal', () => {
    it('refuses a second expense with the same supplier and invoice number', async () => {
      const supplier = await newSupplier('Anomaly');
      const first = await service.createExpense(
        dto({
          supplier_id: supplier.id,
          supplier_invoice_number: 'RI7USPNX0013',
        }),
      );

      await expect(
        service.createExpense(
          dto({
            supplier_id: supplier.id,
            supplier_invoice_number: 'RI7USPNX0013',
          }),
        ),
      ).rejects.toThrow(DuplicateExpenseException);

      expect(await expenseCount()).toBe(1);

      // The refusal carries the original expense id, as a 409.
      let caught: DuplicateExpenseException | undefined;
      try {
        await service.createExpense(
          dto({
            supplier_id: supplier.id,
            supplier_invoice_number: 'RI7USPNX0013',
          }),
        );
      } catch (e) {
        caught = e as DuplicateExpenseException;
      }
      expect(caught).toBeInstanceOf(DuplicateExpenseException);
      expect(caught?.getStatus()).toBe(409);
      expect(caught?.existingExpenseId).toBe(first.id);
      expect(caught?.matchedOn).toBe('invoice_number');
      expect(caught?.message).toContain(
        `possible duplicate of expense #${first.id}`,
      );
    });

    it('refuses through OCR damage (production pair 72 / 73)', async () => {
      const supplier = await newSupplier('Anomaly OCR');
      await service.createExpense(
        dto({
          supplier_id: supplier.id,
          supplier_invoice_number: 'RI7USPNX0014',
        }),
      );

      await expect(
        service.createExpense(
          dto({
            supplier_id: supplier.id,
            supplier_invoice_number: 'R17USPNX-0014',
          }),
        ),
      ).rejects.toThrow(DuplicateExpenseException);
      expect(await expenseCount()).toBe(1);
    });

    it('refuses via the amount/date fallback when a number is missing (pair 96 / 97)', async () => {
      const supplier = await newSupplier('X Corp');
      const first = await service.createExpense(
        dto({
          supplier_id: supplier.id,
          supplier_invoice_number: '2AUEKTA30001',
          gross_amount: 1100,
          tax_point_date: '2026-07-15',
        }),
      );

      let caught: DuplicateExpenseException | undefined;
      try {
        await service.createExpense(
          dto({
            supplier_id: supplier.id,
            supplier_invoice_number: null,
            gross_amount: 1100,
            tax_point_date: '2026-07-15',
          }),
        );
      } catch (e) {
        caught = e as DuplicateExpenseException;
      }
      expect(caught?.existingExpenseId).toBe(first.id);
      expect(caught?.matchedOn).toBe('amount_and_date');
      expect(await expenseCount()).toBe(1);
    });
  });

  describe('false positives it must NOT create', () => {
    it('accepts the five legitimate Anomaly invoices of 16.00 on 2026-05-31', async () => {
      const supplier = await newSupplier('Anomaly Legit');
      for (const n of [
        'RI7USPNX0006',
        'RI7USPNX0007',
        'RI7USPNX0008',
        'RI7USPNX0009',
        'RI7USPNX0010',
      ]) {
        await service.createExpense(
          dto({ supplier_id: supplier.id, supplier_invoice_number: n }),
        );
      }
      expect(await expenseCount()).toBe(5);
    });

    it('does not let a reversed expense block re-entry', async () => {
      const supplier = await newSupplier('Reversed Co');
      const first = await service.createExpense(
        dto({ supplier_id: supplier.id, supplier_invoice_number: 'INV-1' }),
      );
      await service.updateExpenseStatus(first.id, 'reversed', null);

      const second = await service.createExpense(
        dto({ supplier_id: supplier.id, supplier_invoice_number: 'INV-1' }),
      );
      expect(second.id).not.toBe(first.id);
      expect(await expenseCount()).toBe(2);
    });

    it('never groups expenses that have no supplier', async () => {
      await service.createExpense(dto());
      await service.createExpense(dto());
      expect(await expenseCount()).toBe(2);
    });

    it('lets a numbered invoice through when an earlier numberless expense shares its amount and date', async () => {
      // Production replay of the OCR failure of pair 96/97 landing on the FIRST
      // arrival: Anomaly's five 16.00 invoices of 2026-05-31, the earliest one
      // booked before its number was extracted. If the fallback fired whenever
      // a number is missing on EITHER side, that single numberless row would
      // refuse all four numbered peers — the exact collapse issue #195 rejects.
      const supplier = await newSupplier('Anomaly Unextracted');
      await service.createExpense(
        dto({ supplier_id: supplier.id, supplier_invoice_number: null }),
      );
      for (const n of [
        'RI7USPNX0007',
        'RI7USPNX0008',
        'RI7USPNX0009',
        'RI7USPNX0010',
      ]) {
        await service.createExpense(
          dto({ supplier_id: supplier.id, supplier_invoice_number: n }),
        );
      }
      expect(await expenseCount()).toBe(5);
    });

    it('does not collapse two claimants buying the same thing on the same day', async () => {
      const supplier = await newSupplier('Cafe Two Employees');
      const alice = await entitiesService.onboard({
        role: 'employee',
        country: 'IE',
        name: 'Alice',
        email: 'alice@example.com',
      });
      const bob = await entitiesService.onboard({
        role: 'employee',
        country: 'IE',
        name: 'Bob',
        email: 'bob@example.com',
      });

      await service.createExpense(
        dto({
          supplier_id: supplier.id,
          supplier_invoice_number: null,
          claimant_id: alice.id,
        }),
      );
      await service.createExpense(
        dto({
          supplier_id: supplier.id,
          supplier_invoice_number: null,
          claimant_id: bob.id,
        }),
      );
      expect(await expenseCount()).toBe(2);

      // The SAME claimant twice on one day is still refused.
      await expect(
        service.createExpense(
          dto({
            supplier_id: supplier.id,
            supplier_invoice_number: null,
            claimant_id: alice.id,
          }),
        ),
      ).rejects.toThrow(DuplicateExpenseException);
      expect(await expenseCount()).toBe(2);
    });

    it('does not match equal minor-unit amounts in different currencies', async () => {
      const supplier = await newSupplier('Dual Currency Co');
      await service.createExpense(
        dto({
          supplier_id: supplier.id,
          supplier_invoice_number: null,
          currency: 'USD',
          gross_amount: 10000,
        }),
      );
      await service.createExpense(
        dto({
          supplier_id: supplier.id,
          supplier_invoice_number: null,
          currency: 'EUR',
          gross_amount: 10000,
        }),
      );
      expect(await expenseCount()).toBe(2);
    });

    it('does not cross supplier boundaries', async () => {
      const a = await newSupplier('Supplier A');
      const b = await newSupplier('Supplier B');
      await service.createExpense(
        dto({ supplier_id: a.id, supplier_invoice_number: 'SAME-1' }),
      );
      await service.createExpense(
        dto({ supplier_id: b.id, supplier_invoice_number: 'SAME-1' }),
      );
      expect(await expenseCount()).toBe(2);
    });
  });

  describe('allow_duplicate escape hatch', () => {
    it('creates the expense and records an audit_log entry when overridden', async () => {
      const supplier = await newSupplier('Override Co');
      const first = await service.createExpense(
        dto({ supplier_id: supplier.id, supplier_invoice_number: 'DUP-9' }),
      );

      const second = await service.createExpense(
        dto({
          supplier_id: supplier.id,
          supplier_invoice_number: 'DUP-9',
          allow_duplicate: true,
        }),
      );

      expect(second.id).not.toBe(first.id);
      expect(await expenseCount()).toBe(2);

      const entries = await auditRows('expense.duplicate_guard.override');
      expect(entries).toHaveLength(1);
      expect(entries[0].target_type).toBe('expense');
      expect(entries[0].target_id).toBe(second.id);
      expect(entries[0].outcome).toBe('allowed');
      const detail = JSON.parse(entries[0].detail ?? '{}') as Record<
        string,
        unknown
      >;
      expect(detail.duplicate_of_expense_id).toBe(first.id);
      expect(detail.matched_on).toBe('invoice_number');
    });

    it('does not persist allow_duplicate on the expense row', async () => {
      const supplier = await newSupplier('No Column Co');
      const created = await service.createExpense(
        dto({
          supplier_id: supplier.id,
          supplier_invoice_number: 'FLAG-1',
          allow_duplicate: true,
        }),
      );
      const row = await db
        .selectFrom('expense')
        .selectAll()
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow();
      expect('allow_duplicate' in row).toBe(false);
    });

    it('writes no audit entry when the override was not actually needed', async () => {
      const supplier = await newSupplier('Unneeded Override Co');
      await service.createExpense(
        dto({
          supplier_id: supplier.id,
          supplier_invoice_number: 'ONLY-1',
          allow_duplicate: true,
        }),
      );
      expect(await auditRows('expense.duplicate_guard.override')).toHaveLength(
        0,
      );
    });

    it('allow_duplicate: false behaves like an absent flag', async () => {
      const supplier = await newSupplier('Explicit False Co');
      await service.createExpense(
        dto({ supplier_id: supplier.id, supplier_invoice_number: 'FALSE-1' }),
      );
      await expect(
        service.createExpense(
          dto({
            supplier_id: supplier.id,
            supplier_invoice_number: 'FALSE-1',
            allow_duplicate: false,
          }),
        ),
      ).rejects.toThrow(DuplicateExpenseException);
    });
  });
});
