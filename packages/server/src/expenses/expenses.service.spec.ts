import { fxTestProviders } from '../../test/fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect, sql } from 'kysely';
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
import { ExpensesService } from './expenses.service';
import { EntitiesService } from '../entities/entities.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CategoryService } from '../categories/category.service';
import { AuditLogService } from '../audit-log/audit-log.service';

describe('ExpensesService (integration)', () => {
  let db: Kysely<Database>;
  let service: ExpensesService;
  let entitiesService: EntitiesService;
  let organizationService: OrganizationService;
  let auditLog: AuditLogService;
  let rawDb: SqliteDb.Database;

  beforeEach(async () => {
    rawDb = new SqliteDb(':memory:');
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
        ...fxTestProviders(),
        PluginLoader,
        OrgContextResolver,
        CurrencyService,
        VoucherProjectionService,
        EntitiesService,
        PeriodLockService,
        {
          provide: CategoryService,
          useValue: {
            assertValid: async () => {},
          },
        },
        AuditLogService,
        ExpensesService,
      ],
    }).compile();

    service = module.get(ExpensesService);
    entitiesService = module.get(EntitiesService);
    organizationService = module.get(OrganizationService);
    auditLog = module.get(AuditLogService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  const sampleDto = () => ({
    category: 'software',
    gross_amount: 12300,
    vat_amount: 2300,
    currency: 'EUR',
    tax_point_date: '2026-03-15',
  });

  describe('createExpense', () => {
    it('creates an expense in draft status', async () => {
      const expense = await service.createExpense(sampleDto());
      expect(expense.status).toBe('draft');
      expect(expense.category).toBe('software');
      expect(expense.gross_amount).toBe(12300);
      expect(expense.vat_amount).toBe(2300);
      expect(expense.currency).toBe('EUR');
      expect(expense.voucher_id).toBeNull();
      expect(expense.created_at).toBeGreaterThan(0);
    });

    it('accepts optional document_id and supplier_id', async () => {
      const supplier = await entitiesService.onboard({
        role: 'supplier',
        country: 'DK',
        name: 'Test Supplier',
        registrationKey: 'DK12345',
      });

      const expense = await service.createExpense({
        ...sampleDto(),
        document_id: null,
        supplier_id: supplier.id,
      });
      expect(expense.document_id).toBeNull();
      expect(expense.supplier_id).toBe(supplier.id);
    });
  });

  describe('getExpenses', () => {
    it('returns all expenses in order', async () => {
      await service.createExpense(sampleDto());
      await service.createExpense({
        ...sampleDto(),
        category: 'transport',
      });

      const expenses = await service.getExpenses();
      expect(expenses).toHaveLength(2);
      expect(expenses[0].category).toBe('software');
      expect(expenses[1].category).toBe('transport');
    });

    it('returns an empty array when no expenses exist', async () => {
      const expenses = await service.getExpenses();
      expect(expenses).toEqual([]);
    });

    it('flags an expense whose voucher is matched to a bank transaction as reconciled', async () => {
      const now = Math.floor(Date.now() / 1000);
      // Relax FKs so we can stage a posted expense + a match against its
      // voucher without building the whole voucher/bank chain — getExpenses
      // joins on voucher_id only.
      await sql`PRAGMA foreign_keys = OFF`.execute(db);
      const posted = await db
        .insertInto('expense')
        .values({
          category: 'transport',
          gross_amount: 1000,
          vat_amount: 0,
          currency: 'EUR',
          tax_point_date: '2026-05-01',
          status: 'posted',
          voucher_id: 4242,
          document_id: null,
          supplier_id: null,
          document_vat_marking: null,
          created_at: now,
          updated_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('reconciliation_match')
        .values({
          bank_transaction_id: 1,
          voucher_id: 4242,
          match_type: 'exact',
          amount_matched: 1000,
          created_at: now,
        })
        .execute();
      await sql`PRAGMA foreign_keys = ON`.execute(db);

      // A plain draft (no voucher) is not reconciled.
      const draft = await service.createExpense(sampleDto());

      const list = await service.getExpenses();
      expect(list.find((e) => e.id === posted.id)?.reconciled).toBe(true);
      expect(list.find((e) => e.id === draft.id)?.reconciled).toBe(false);
    });
  });

  describe('getExpenseById', () => {
    it('returns the requested expense', async () => {
      const created = await service.createExpense(sampleDto());
      const found = await service.getExpenseById(created.id);
      expect(found.id).toBe(created.id);
      expect(found.category).toBe('software');
    });

    it('throws NotFoundException for unknown id', async () => {
      await expect(service.getExpenseById(999)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('generateDraftVoucher', () => {
    it('returns a transient draft voucher with accrual lines', async () => {
      // The VAT_RECEIVABLE leg below exists only because the organisation is a
      // registered person with a full deduction right (issue #211); the seeded
      // default is not registered, so the fixture says so explicitly.
      await organizationService.updateOrganization({ vat_registered: true });
      const expense = await service.createExpense(sampleDto());
      const draft = await service.generateDraftVoucher(expense.id);

      expect(draft.voucher_number).toBe('PENDING');
      expect(draft.tax_point_date).toBe('2026-03-15');
      expect(draft.lines).toHaveLength(3);

      // Dr Expense (net)
      const expenseLine = draft.lines.find(
        (l) => l.account_code === 'EXPENSE_SOFTWARE' && l.is_debit,
      );
      expect(expenseLine).toBeDefined();
      expect(expenseLine!.amount).toBe(10000); // 12300 - 2300
      expect(expenseLine!.currency).toBe('EUR');
      expect(expenseLine!.base_amount).toBe(10000);
      expect(expenseLine!.fx_rate).toBe(1);
      expect(expenseLine!.vat_code).toBe('IE_INPUT_23');

      // Dr VAT_RECEIVABLE
      const vatLine = draft.lines.find(
        (l) => l.account_code === 'VAT_RECEIVABLE' && l.is_debit,
      );
      expect(vatLine).toBeDefined();
      expect(vatLine!.amount).toBe(2300);
      expect(vatLine!.currency).toBe('EUR');
      expect(vatLine!.base_amount).toBe(2300);
      expect(vatLine!.fx_rate).toBe(1);
      expect(vatLine!.vat_code).toBe('IE_INPUT_23');

      // Cr AP (gross)
      const apLine = draft.lines.find(
        (l) => l.account_code === 'AP' && !l.is_debit,
      );
      expect(apLine).toBeDefined();
      expect(apLine!.amount).toBe(12300);
      expect(apLine!.currency).toBe('EUR');
      expect(apLine!.base_amount).toBe(12300);
      expect(apLine!.fx_rate).toBe(1);
      expect(apLine!.vat_code).toBeNull();
    });

    it('balances in base currency (debits == credits)', async () => {
      const expense = await service.createExpense(sampleDto());
      const draft = await service.generateDraftVoucher(expense.id);

      const debitTotal = draft.lines
        .filter((l) => l.is_debit)
        .reduce((sum, l) => sum + l.base_amount, 0);
      const creditTotal = draft.lines
        .filter((l) => !l.is_debit)
        .reduce((sum, l) => sum + l.base_amount, 0);

      expect(debitTotal).toBe(creditTotal);
      expect(debitTotal).toBe(12300);
    });

    it('falls back to EXPENSE_OTHER for unknown categories', async () => {
      const expense = await service.createExpense({
        ...sampleDto(),
        category: 'unknown-category-xyz',
      });
      const draft = await service.generateDraftVoucher(expense.id);

      const expenseLine = draft.lines.find(
        (l) => l.is_debit && l.account_code.startsWith('EXPENSE_'),
      );
      expect(expenseLine!.account_code).toBe('EXPENSE_OTHER');
    });

    it('does NOT write a voucher to the database', async () => {
      const expense = await service.createExpense(sampleDto());
      await service.generateDraftVoucher(expense.id);

      const vouchers = await db.selectFrom('voucher').selectAll().execute();
      expect(vouchers).toHaveLength(0);

      const lines = await db.selectFrom('voucher_line').selectAll().execute();
      expect(lines).toHaveLength(0);
    });

    it('throws NotFoundException for non-existent expense', async () => {
      await expect(service.generateDraftVoucher(999)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('skips VAT_RECEIVABLE line when vat_amount is zero', async () => {
      const expense = await service.createExpense({
        ...sampleDto(),
        vat_amount: 0,
        gross_amount: 10000,
      });
      const draft = await service.generateDraftVoucher(expense.id);

      // Only 2 lines: Dr Expense + Cr AP (no VAT_RECEIVABLE)
      expect(draft.lines).toHaveLength(2);

      const vatLine = draft.lines.find(
        (l) => l.account_code === 'VAT_RECEIVABLE',
      );
      expect(vatLine).toBeUndefined();

      // Verify balance with zero VAT
      const debitTotal = draft.lines
        .filter((l) => l.is_debit)
        .reduce((sum, l) => sum + l.base_amount, 0);
      const creditTotal = draft.lines
        .filter((l) => !l.is_debit)
        .reduce((sum, l) => sum + l.base_amount, 0);
      expect(debitTotal).toBe(creditTotal);
      expect(debitTotal).toBe(10000);
    });
  });

  describe('deleteDraft', () => {
    it('removes a draft expense', async () => {
      const e = await service.createExpense(sampleDto());
      await service.deleteDraft(e.id);
      expect(await service.getExpenses()).toHaveLength(0);
    });

    it('refuses to delete a non-draft expense', async () => {
      const e = await service.createExpense(sampleDto());
      await db
        .updateTable('expense')
        .set({ status: 'pending' })
        .where('id', '=', e.id)
        .execute();
      await expect(service.deleteDraft(e.id)).rejects.toThrow(/only a draft/i);
    });
  });

  describe('updateDraft', () => {
    it('moves a pending expense back to draft and supersedes its pending approval', async () => {
      const expense = await service.createExpense(sampleDto());
      const now = Math.floor(Date.now() / 1000);
      await db
        .updateTable('expense')
        .set({ status: 'pending' })
        .where('id', '=', expense.id)
        .execute();
      const approval = await db
        .insertInto('approval')
        .values({
          object_type: 'expense',
          object_id: expense.id,
          status: 'pending',
          requested_by: 'policy',
          approved_by: null,
          rejected_reason: null,
          superseded_by: null,
          created_at: now,
          resolved_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const finding = await db
        .insertInto('audit_finding')
        .values({
          finding_type: 'pending_approval',
          severity: 'medium',
          description: `Approval ${approval.id} is waiting for a decision`,
          referenced_object_type: 'approval',
          referenced_object_id: approval.id,
          status: 'open',
          created_at: now,
          resolved_at: null,
          snoozed_at: null,
          transitioned_by: null,
          transition_reason: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const updated = await service.updateDraft(expense.id, {
        gross_amount: 15000,
        vat_amount: 2500,
        category: 'transport',
      });

      expect(updated.status).toBe('draft');
      expect(updated.gross_amount).toBe(15000);
      expect(updated.vat_amount).toBe(2500);
      expect(updated.category).toBe('transport');

      const resolvedApproval = await db
        .selectFrom('approval')
        .selectAll()
        .where('id', '=', approval.id)
        .executeTakeFirstOrThrow();
      expect(resolvedApproval.status).toBe('superseded');
      expect(resolvedApproval.resolved_at).not.toBeNull();

      const resolvedFinding = await db
        .selectFrom('audit_finding')
        .selectAll()
        .where('id', '=', finding.id)
        .executeTakeFirstOrThrow();
      expect(resolvedFinding.status).toBe('resolved');
      expect(resolvedFinding.resolved_at).not.toBeNull();
    });
  });

  describe('updateDraft hardening (issue #247)', () => {
    async function makeVoucher(number: string): Promise<number> {
      const v = await db
        .insertInto('voucher')
        .values({
          voucher_number: number,
          tax_point_date: '2026-03-15',
          posted_at: 1,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return v.id;
    }

    async function supplier(name: string, key: string) {
      return entitiesService.onboard({
        role: 'supplier',
        country: 'EE',
        name,
        registrationKey: key,
      });
    }

    it('edits every editable fact of a draft in place, keeping provenance', async () => {
      const s = await supplier('Edit Supplier', 'EE100000001');
      const e = await service.createExpense({
        ...sampleDto(),
        ai_confidence: 0.7,
        ai_document_type: 'receipt',
        document_vat_marking: '24%',
      });
      const updated = await service.updateDraft(e.id, {
        category: 'transport',
        supplier_id: s.id,
        gross_amount: 6200,
        vat_amount: 1200,
        currency: 'USD',
        tax_point_date: '2026-04-01',
        supplier_invoice_number: 'S-1',
        company_addressed_receipt: true,
      });
      expect(updated).toMatchObject({
        id: e.id,
        status: 'draft',
        category: 'transport',
        supplier_id: s.id,
        gross_amount: 6200,
        vat_amount: 1200,
        currency: 'USD',
        tax_point_date: '2026-04-01',
        supplier_invoice_number: 'S-1',
        company_addressed_receipt: true,
        ai_confidence: 0.7,
        ai_document_type: 'receipt',
        document_vat_marking: '24%',
      });
    });

    it('refuses a posted or reversed expense and writes nothing', async () => {
      for (const status of ['posted', 'reversed'] as const) {
        const e = await service.createExpense(sampleDto());
        const v = await makeVoucher(`V-${status}`);
        await service.updateExpenseStatus(e.id, status, v);
        const before = await service.getExpenseById(e.id);
        await expect(
          service.updateDraft(e.id, { gross_amount: 1 }),
        ).rejects.toThrow(new RegExp(`is ${status}`));
        expect(await service.getExpenseById(e.id)).toEqual(before);
      }
    });

    it('refuses a voucher-backed "draft" row (the claim requires voucher_id IS NULL)', async () => {
      const e = await service.createExpense(sampleDto());
      const v = await makeVoucher('V-ORPHAN');
      await db
        .updateTable('expense')
        .set({ voucher_id: v })
        .where('id', '=', e.id)
        .execute();
      await expect(
        service.updateDraft(e.id, { gross_amount: 1000, vat_amount: 0 }),
      ).rejects.toThrow(/changed while this edit was being applied/);
      const after = await service.getExpenseById(e.id);
      expect(after.gross_amount).toBe(12300);
      expect(after.voucher_id).toBe(v);
    });

    it('does NOT overwrite an expense that gets posted mid-edit (conditional claim)', async () => {
      const e = await service.createExpense(sampleDto());
      const voucherId = await makeVoucher('V-MID-EDIT');
      // Interleave a post between the in-transaction read and the UPDATE on
      // the single connection the transaction holds.
      const flip = jest
        .spyOn(
          service as unknown as { assertMergedAmounts: () => void },
          'assertMergedAmounts',
        )
        .mockImplementation(() => {
          rawDb
            .prepare(
              "UPDATE expense SET status = 'posted', voucher_id = ? WHERE id = ?",
            )
            .run(voucherId, e.id);
        });
      await expect(
        service.updateDraft(e.id, {
          gross_amount: 99900,
          category: 'transport',
        }),
      ).rejects.toThrow(/changed while this edit was being applied/);
      flip.mockRestore();
      const after = await service.getExpenseById(e.id);
      expect(after.gross_amount).toBe(12300);
      expect(after.category).toBe('software');
    });

    it('validates the MERGED amounts, not just the fields sent', async () => {
      const e = await service.createExpense(sampleDto());
      await expect(
        service.updateDraft(e.id, { vat_amount: 50000 }),
      ).rejects.toThrow(/would exceed gross_amount/);
      await expect(
        service.updateDraft(e.id, { gross_amount: 1000 }),
      ).rejects.toThrow(/would exceed gross_amount/);
    });

    it('an edit of a newly editable fact makes a prepared draft stale', async () => {
      const s = await supplier('Fingerprint Supplier', 'EE100000002');
      const e = await service.createExpense(sampleDto());
      for (const patch of [
        { supplier_id: s.id },
        { currency: 'USD' },
        { tax_point_date: '2026-03-16' },
        { company_addressed_receipt: true },
      ]) {
        const before = await service.draftFactsFingerprint(e.id);
        await service.updateDraft(e.id, patch);
        await expect(
          service.assertDraftFactsUnchangedTx(db, e.id, before),
        ).rejects.toThrow(/changed while it was being posted/);
      }
    });

    it('rolls the edit back when the duplicate-override audit entry fails', async () => {
      const s = await supplier('Dup Supplier', 'EE100000003');
      await service.createExpense({
        ...sampleDto(),
        supplier_id: s.id,
        supplier_invoice_number: 'N-1',
      });
      const b = await service.createExpense({
        ...sampleDto(),
        supplier_id: s.id,
        supplier_invoice_number: 'N-2',
      });
      const record = jest
        .spyOn(auditLog, 'record')
        .mockRejectedValueOnce(new Error('audit_log unavailable'));
      await expect(
        service.updateDraft(b.id, {
          supplier_invoice_number: 'N-1',
          category: 'transport',
          allow_duplicate: true,
        }),
      ).rejects.toThrow(/audit_log unavailable/);
      record.mockRestore();
      const after = await service.getExpenseById(b.id);
      expect(after.supplier_invoice_number).toBe('N-2');
      expect(after.category).toBe('software');
      expect(
        await db.selectFrom('audit_log').select('id').execute(),
      ).toHaveLength(0);
    });
  });

  describe('supplier_invoice_number', () => {
    it('persists supplier_invoice_number on create', async () => {
      const e = await service.createExpense({
        category: 'software',
        gross_amount: 12000,
        vat_amount: 2000,
        currency: 'EUR',
        tax_point_date: '2026-05-10',
        supplier_invoice_number: 'SUP-77',
      });
      const fetched = await service.getExpenseById(e.id);
      expect(fetched.supplier_invoice_number).toBe('SUP-77');
    });

    it('defaults supplier_invoice_number to null when omitted', async () => {
      const e = await service.createExpense({
        category: 'software',
        gross_amount: 12000,
        vat_amount: 2000,
        currency: 'EUR',
        tax_point_date: '2026-05-10',
      });
      expect(e.supplier_invoice_number).toBeNull();
    });
  });

  describe('createExpense category validation', () => {
    it('rejects an unknown category with BadRequestException', async () => {
      const rawDb2 = new SqliteDb(':memory:');
      rawDb2.pragma('foreign_keys = ON');
      const db2 = new Kysely<Database>({
        dialect: new SqliteDialect({ database: rawDb2 }),
      });
      const migrator2 = new Migrator({
        db: db2,
        provider: { getMigrations: () => Promise.resolve(migrations) },
      });
      const { error } = await migrator2.migrateToLatest();
      if (error)
        throw error instanceof Error ? error : new Error('Migration failed');

      const strictCategoryService = {
        assertValid: (c: string) =>
          c === 'software'
            ? Promise.resolve()
            : Promise.reject(
                new BadRequestException(`Unknown category '${c}'.`),
              ),
        isValid: (c: string) => Promise.resolve(c === 'software'),
      };

      const strictModule = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db2 },
          OrganizationService,
          NullCountryPlugin,
          EstoniaCountryPlugin,
          ...fxTestProviders(),
          PluginLoader,
          OrgContextResolver,
          CurrencyService,
          VoucherProjectionService,
          EntitiesService,
          PeriodLockService,
          { provide: CategoryService, useValue: strictCategoryService },
          AuditLogService,
          ExpensesService,
        ],
      }).compile();

      const strictService = strictModule.get(ExpensesService);

      await expect(
        strictService.createExpense({
          category: 'garbage',
          gross_amount: 1000,
          vat_amount: 0,
          currency: 'EUR',
          tax_point_date: '2026-01-01',
          supplier_id: null,
          document_id: null,
          document_vat_marking: null,
          supplier_invoice_number: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await db2.destroy();
    });

    it('accepts a valid category without throwing', async () => {
      await expect(
        service.createExpense({
          category: 'software',
          gross_amount: 1000,
          vat_amount: 0,
          currency: 'EUR',
          tax_point_date: '2026-01-01',
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('reverse charge on imported services (EE org)', () => {
    it('books self-assessed output + input VAT for a US service supplier', async () => {
      // Switch the org to Estonia so the EstoniaCountryPlugin is active, and
      // register it: a reverse charge is self-assessed by anyone who receives
      // the supply, but it is only DEDUCTIBLE for a registered person with a
      // deduction right (issue #211). This test is about the ordinary,
      // fully-entitled case.
      await organizationService.updateOrganization({
        country: 'EE',
        vat_registered: true,
      });

      const supplier = await entitiesService.onboard({
        role: 'supplier',
        country: 'US',
        name: 'OpenRouter',
        registrationKey: 'US-OR-1',
        goodsVsServices: 'services',
        // The supplier is a person engaged in business — the fact that makes
        // this a self-assessed acquisition at all (issue #210).
        taxStatus: 'taxable_business',
      });

      // $16 imported service, no VAT on the document.
      const expense = await service.createExpense({
        category: 'software',
        gross_amount: 1600,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-05-31',
        supplier_id: supplier.id,
      });

      const draft = await service.generateDraftVoucher(expense.id);

      // Dr expense / Dr VAT_RECEIVABLE / Cr AP / Cr VAT_PAYABLE
      expect(draft.lines).toHaveLength(4);

      const output = draft.lines.find(
        (l) => l.account_code === 'VAT_PAYABLE' && !l.is_debit,
      );
      const input = draft.lines.find(
        (l) => l.account_code === 'VAT_RECEIVABLE' && l.is_debit,
      );
      expect(output).toBeDefined();
      expect(input).toBeDefined();
      expect(output!.amount).toBe(384); // 24% of 1600
      expect(input!.amount).toBe(384);
      expect(output!.vat_code).toBe('EE_REVERSE_CHARGE_3RD_COUNTRY');
      expect(input!.vat_code).toBe('EE_REVERSE_CHARGE_3RD_COUNTRY');

      // Balanced; the VAT legs cancel so only the gross is owed.
      const debit = draft.lines
        .filter((l) => l.is_debit)
        .reduce((s, l) => s + l.base_amount, 0);
      const credit = draft.lines
        .filter((l) => !l.is_debit)
        .reduce((s, l) => s + l.base_amount, 0);
      expect(debit).toBe(credit);
    });
  });
  describe('the draft-facts guard sees OUR OWN VAT facts (issue #211)', () => {
    it('refuses a prepared draft after the entitlement changed underneath it', async () => {
      await organizationService.updateOrganization({ vat_registered: true });
      const expense = await service.createExpense(sampleDto());

      // What a caller captures before generating the draft.
      const before = await service.draftFactsFingerprint(expense.id);

      // Neither the expense nor any supplier moves — only the proportion we may
      // deduct, which decides what the legs ARE. Without this in the
      // fingerprint the stale draft would post a deduction nobody is entitled
      // to any more.
      await organizationService.updateOrganization({
        input_vat_entitlement: 'partial',
        input_vat_deduction_permille: 500,
      });

      expect(await service.draftFactsFingerprint(expense.id)).not.toBe(before);
      await expect(
        service.assertDraftFactsUnchangedTx(db, expense.id, before),
      ).rejects.toThrow(/input-VAT deduction/);
    });
  });
});
