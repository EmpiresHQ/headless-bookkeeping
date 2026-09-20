import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { OutstandingVoucherService } from './outstanding-voucher.service';
import { PrepaymentAllocationRepository } from './prepayment-allocation.repository';

/**
 * Focused integration tests for the consolidated outstanding-voucher query
 * module — the single source of "outstanding AR/AP candidate Vouchers for
 * reconciliation" plus their remaining balance.
 */
describe('OutstandingVoucherService', () => {
  let db: Kysely<Database>;
  let service: OutstandingVoucherService;
  let voucherCounter = 0;

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
        LedgerBalanceService,
        OutstandingVoucherService,
        PrepaymentAllocationRepository,
      ],
    }).compile();

    service = module.get(OutstandingVoucherService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ── Helpers ────────────────────────────────────────────────────────────

  async function accountId(code: string): Promise<number> {
    const a = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    return a.id;
  }

  async function insertVoucher(taxPointDate: string): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    voucherCounter++;
    const voucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: `V-2025-${String(voucherCounter).padStart(6, '0')}`,
        tax_point_date: taxPointDate,
        posted_at: now,
        previous_hash: null,
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return voucher.id;
  }

  /** A posted counter-voucher reversing `reversesId`. */
  async function insertReversalVoucher(
    taxPointDate: string,
    reversesId: number,
  ): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    voucherCounter++;
    const voucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: `V-2025-${String(voucherCounter).padStart(6, '0')}-REV`,
        tax_point_date: taxPointDate,
        posted_at: now,
        previous_hash: null,
        reverses_id: reversesId,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: 'reversal',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return voucher.id;
  }

  async function insertLine(
    voucherId: number,
    code: string,
    baseAmount: number,
    isDebit: 0 | 1,
  ): Promise<void> {
    await db
      .insertInto('voucher_line')
      .values({
        voucher_id: voucherId,
        account_id: await accountId(code),
        amount: baseAmount,
        currency: 'EUR',
        base_amount: baseAmount,
        fx_rate: 1,
        vat_code: null,
        is_debit: isDebit,
      })
      .execute();
  }

  async function seedCustomer(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const c = await db
      .insertInto('entity')
      .values({
        role: 'customer',
        country: 'IE',
        name: 'Cust Ltd',
        goods_vs_services: 'services',
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return c.id;
  }

  async function seedSupplier(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const s = await db
      .insertInto('entity')
      .values({
        role: 'supplier',
        country: 'IE',
        name: 'Supp Co',
        goods_vs_services: 'goods',
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return s.id;
  }

  /** Posted SalesInvoice + AR-debit/Revenue-credit Voucher. */
  async function seedArInvoice(
    customerId: number,
    grossCents: number,
    invoiceNumber: string,
    taxPointDate: string,
  ): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const voucherId = await insertVoucher(taxPointDate);
    await db
      .insertInto('sales_invoice')
      .values({
        customer_id: customerId,
        invoice_number: invoiceNumber,
        gross_amount: grossCents,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: taxPointDate,
        due_date: taxPointDate,
        status: 'posted',
        voucher_id: voucherId,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await insertLine(voucherId, 'AR', grossCents, 1);
    await insertLine(voucherId, 'REVENUE', grossCents, 0);
    return voucherId;
  }

  /** Posted Expense + Expense-debit/AP-credit Voucher. */
  async function seedApExpense(
    supplierId: number,
    grossCents: number,
    taxPointDate: string,
  ): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const voucherId = await insertVoucher(taxPointDate);
    await db
      .insertInto('expense')
      .values({
        document_id: null,
        supplier_id: supplierId,
        category: 'software',
        gross_amount: grossCents,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: taxPointDate,
        status: 'posted',
        voucher_id: voucherId,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await insertLine(voucherId, 'EXPENSE_SOFTWARE', grossCents, 1);
    await insertLine(voucherId, 'AP', grossCents, 0);
    return voucherId;
  }

  async function insertMatch(voucherId: number, amount: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const stmt = await db
      .insertInto('bank_statement')
      .values({
        account_id: await accountId('BANK_EUR'),
        start_date: '2025-01-01',
        end_date: '2025-01-31',
        uploaded_at: now,
        file_path: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const txn = await db
      .insertInto('bank_transaction')
      .values({
        statement_id: stmt.id,
        transaction_date: '2025-01-12',
        description: null,
        amount,
        currency: 'EUR',
        source_currency: null,
        source_amount: null,
        fx_rate: null,
        reference: null,
        counterparty_iban: null,
        counterparty_descriptor: null,
        status: 'open',
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto('reconciliation_match')
      .values({
        bank_transaction_id: txn.id,
        voucher_id: voucherId,
        match_type: 'partial',
        amount_matched: amount,
        created_at: now,
      })
      .execute();
  }

  // ── AR candidate set ─────────────────────────────────────────────────

  describe('findArCandidatesByCounterparty', () => {
    it('returns the AR voucher for the customer with its full remaining balance', async () => {
      const customerId = await seedCustomer();
      const voucherId = await seedArInvoice(
        customerId,
        50000,
        'INV-1',
        '2025-01-10',
      );

      const candidates =
        await service.findArCandidatesByCounterparty(customerId);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].voucherId).toBe(voucherId);
      expect(candidates[0].accountCode).toBe('AR');
      expect(candidates[0].isPrepayment).toBe(false);
      expect(candidates[0].remainingBalance).toBe(50000);
      expect(candidates[0].entityId).toBe(customerId);
    });

    it('subtracts already-matched amounts from the remaining balance', async () => {
      const customerId = await seedCustomer();
      const voucherId = await seedArInvoice(
        customerId,
        50000,
        'INV-2',
        '2025-01-10',
      );
      await insertMatch(voucherId, 20000);

      const [candidate] =
        await service.findArCandidatesByCounterparty(customerId);

      expect(candidate.alreadyMatched).toBe(20000);
      expect(candidate.remainingBalance).toBe(30000);
    });

    it('does not return another customer’s AR voucher', async () => {
      const customerA = await seedCustomer();
      const customerB = await seedCustomer();
      await seedArInvoice(customerA, 50000, 'INV-A', '2025-01-10');

      const candidates =
        await service.findArCandidatesByCounterparty(customerB);

      expect(candidates).toHaveLength(0);
    });
  });

  // ── AP candidate set ─────────────────────────────────────────────────

  describe('findApCandidatesByCounterparty', () => {
    it('returns the AP voucher for the supplier with its full remaining balance', async () => {
      const supplierId = await seedSupplier();
      const voucherId = await seedApExpense(supplierId, 42000, '2025-01-10');

      const candidates =
        await service.findApCandidatesByCounterparty(supplierId);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].voucherId).toBe(voucherId);
      expect(candidates[0].accountCode).toBe('AP');
      expect(candidates[0].isPrepayment).toBe(false);
      expect(candidates[0].remainingBalance).toBe(42000);
      expect(candidates[0].entityId).toBe(supplierId);
    });
  });

  // ── Amount + date window ───────────────────────────────────────────────

  describe('findArCandidatesByAmountAndDate', () => {
    it('includes AR vouchers inside the ±7-day window and excludes those outside', async () => {
      const customerId = await seedCustomer();
      const inWindow = await seedArInvoice(
        customerId,
        25000,
        'INV-IN',
        '2025-01-10',
      );
      await seedArInvoice(customerId, 15000, 'INV-OUT', '2024-12-01');

      const candidates =
        await service.findArCandidatesByAmountAndDate('2025-01-12');

      const ids = candidates.map((c) => c.voucherId);
      expect(ids).toContain(inWindow);
      expect(candidates).toHaveLength(1);
    });
  });

  // ── Remaining balance via the single path (multi-line voucher) ─────────

  describe('getRemainingVoucherBalance — single canonical path', () => {
    it('nets a multi-line AR voucher to its true AR magnitude, not a single line', async () => {
      // A voucher whose AR is split across two debit lines (e.g. two amounts)
      // plus a contra AR credit. The single-line `base_amount` would have read
      // only ONE of these; the canonical net is 30000 + 30000 - 10000 = 50000.
      const voucherId = await insertVoucher('2025-01-10');
      await insertLine(voucherId, 'AR', 30000, 1);
      await insertLine(voucherId, 'AR', 30000, 1);
      await insertLine(voucherId, 'AR', 10000, 0); // contra credit
      await insertLine(voucherId, 'REVENUE', 50000, 0);

      const remaining = await service.getRemainingVoucherBalance(voucherId);

      expect(remaining).toBe(50000);
    });

    it('nets an AR debit against an AP credit on the same voucher to zero', async () => {
      const voucherId = await insertVoucher('2025-01-10');
      await insertLine(voucherId, 'AR', 10000, 1);
      await insertLine(voucherId, 'AP', 10000, 0);

      const remaining = await service.getRemainingVoucherBalance(voucherId);

      expect(remaining).toBe(0);
    });

    it('subtracts already-matched from the canonical net', async () => {
      const voucherId = await insertVoucher('2025-01-10');
      await insertLine(voucherId, 'AR', 50000, 1);
      await insertLine(voucherId, 'REVENUE', 50000, 0);
      await insertMatch(voucherId, 20000);

      const remaining = await service.getRemainingVoucherBalance(voucherId);

      expect(remaining).toBe(30000);
    });
  });

  // ── Prepayment candidate set ───────────────────────────────────────────

  describe('findCustomerPrepaymentCandidates', () => {
    /** Register a posted prepayment voucher as an OWNED advance (issue #201). */
    async function registerAdvance(
      voucherId: number,
      entityId: number | null,
      baseAmount: number,
      opts: { needsReview?: boolean } = {},
    ): Promise<void> {
      await db
        .insertInto('prepayment_advance')
        .values({
          voucher_id: voucherId,
          kind: 'customer',
          account_code: 'CUSTOMER_PREPAYMENTS',
          entity_id: entityId,
          bank_transaction_id: null,
          original_base_amount: baseAmount,
          currency: 'EUR',
          needs_review: opts.needsReview ? 1 : 0,
          origin: 'service',
          created_at: Math.floor(Date.now() / 1000),
        })
        .execute();
    }

    async function seedAdvanceVoucher(amount: number): Promise<number> {
      const voucherId = await insertVoucher('2025-01-10');
      await insertLine(voucherId, 'BANK_EUR', amount, 1);
      await insertLine(voucherId, 'CUSTOMER_PREPAYMENTS', amount, 0);
      return voucherId;
    }

    it('returns the undrawn CUSTOMER_PREPAYMENTS credit owned by that customer', async () => {
      const customerId = await seedCustomer();
      // Dr BANK_EUR / Cr CUSTOMER_PREPAYMENTS — money received on account.
      const voucherId = await seedAdvanceVoucher(40000);
      await registerAdvance(voucherId, customerId, 40000);

      const candidates =
        await service.findCustomerPrepaymentCandidates(customerId);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].voucherId).toBe(voucherId);
      expect(candidates[0].isPrepayment).toBe(true);
      expect(candidates[0].accountCode).toBe('CUSTOMER_PREPAYMENTS');
      expect(candidates[0].entityId).toBe(customerId);
      expect(candidates[0].remainingBalance).toBe(40000);
    });

    it('does NOT offer another customer an advance it does not own', async () => {
      const owner = await seedCustomer();
      const other = await seedCustomer();
      const voucherId = await seedAdvanceVoucher(40000);
      await registerAdvance(voucherId, owner, 40000);

      // Before #201 this query returned EVERY prepayment voucher with the
      // caller's entity id stamped onto it.
      await expect(
        service.findCustomerPrepaymentCandidates(other),
      ).resolves.toEqual([]);
    });

    it('does NOT offer an advance with no resolved owner', async () => {
      const customerId = await seedCustomer();
      const voucherId = await seedAdvanceVoucher(40000);
      await registerAdvance(voucherId, null, 40000);

      await expect(
        service.findCustomerPrepaymentCandidates(customerId),
      ).resolves.toEqual([]);
    });

    it('does NOT offer an advance whose balance is unverified', async () => {
      const customerId = await seedCustomer();
      const voucherId = await seedAdvanceVoucher(40000);
      await registerAdvance(voucherId, customerId, 40000, {
        needsReview: true,
      });

      await expect(
        service.findCustomerPrepaymentCandidates(customerId),
      ).resolves.toEqual([]);
    });

    it('does NOT offer an advance whose own voucher was reversed', async () => {
      const customerId = await seedCustomer();
      const voucherId = await seedAdvanceVoucher(40000);
      await registerAdvance(voucherId, customerId, 40000);

      const reversalId = await insertReversalVoucher('2025-01-11', voucherId);
      await insertLine(reversalId, 'CUSTOMER_PREPAYMENTS', 40000, 1);
      await insertLine(reversalId, 'BANK_EUR', 40000, 0);

      await expect(
        service.findCustomerPrepaymentCandidates(customerId),
      ).resolves.toEqual([]);
    });

    it('nets an active allocation out of the advance remaining balance', async () => {
      const customerId = await seedCustomer();
      const voucherId = await seedAdvanceVoucher(40000);
      await registerAdvance(voucherId, customerId, 40000);

      const invoiceId = await insertVoucher('2025-01-12');
      await insertLine(invoiceId, 'AR', 40000, 1);
      await insertLine(invoiceId, 'REVENUE', 40000, 0);

      const clearingId = await insertVoucher('2025-01-13');
      await insertLine(clearingId, 'CUSTOMER_PREPAYMENTS', 15000, 1);
      await insertLine(clearingId, 'AR', 15000, 0);

      const advance = await db
        .selectFrom('prepayment_advance')
        .select('id')
        .where('voucher_id', '=', voucherId)
        .executeTakeFirstOrThrow();
      await db
        .insertInto('prepayment_allocation')
        .values({
          advance_id: advance.id,
          invoice_voucher_id: invoiceId,
          entity_id: customerId,
          base_amount: 15000,
          currency: 'EUR',
          allocation_voucher_id: clearingId,
          origin: 'service',
          created_at: Math.floor(Date.now() / 1000),
        })
        .execute();

      const candidates =
        await service.findCustomerPrepaymentCandidates(customerId);
      expect(candidates[0].remainingBalance).toBe(25000);

      // The SAME allocation is netted out of the invoice's own outstanding, so
      // a cash match cannot settle what the prepayment already relieved.
      await expect(service.getRemainingVoucherBalance(invoiceId)).resolves.toBe(
        25000,
      );
    });
  });
});
