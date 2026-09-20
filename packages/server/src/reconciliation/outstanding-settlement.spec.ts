import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AccountService } from '../ledger/account/account.service';
import { BankStatementService } from '../bank/bank-statement.service';
import { BankTransactionRepository } from '../bank/bank-transaction.repository';
import { EntitiesService } from '../entities/entities.service';
import { PostingService } from '../ledger/posting/posting.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { OrganizationService } from '../organization/organization.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CurrencyService } from '../currency/currency.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { VoucherRepository } from '../ledger/voucher/voucher.repository';
import { VoucherLineRepository } from '../ledger/voucher/voucher-line.repository';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
import { ExpensesService } from '../expenses/expenses.service';
import { CategoryService } from '../categories/category.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CreditNotesService } from '../credit-notes/credit-notes.service';
import { DraftVoucherLine } from '../ledger/voucher/types';
import { ReconciliationService } from './reconciliation.service';
import { OutstandingVoucherService } from './outstanding-voucher.service';
import { PrepaymentAllocationRepository } from './prepayment-allocation.repository';
import { PrepaymentService } from './prepayment.service';
import { FXRealizedService } from './fx-realized.service';

/**
 * Issue #202 — an outstanding **Receivable** / **Payable** is consumed by THREE
 * linked settlement types, not one: cash (`reconciliation_match`), an advance
 * (`prepayment_allocation`, issue #201) and a **Credit note** (its own posted
 * Voucher). Before the fix only the first two were netted, so a fully credited
 * invoice whose ledger AR was already zero was still offered — and settleable —
 * at its full gross.
 *
 * Everything here runs against real migrated SQLite and the real services:
 * invoices/expenses post through their own services, credit notes through
 * {@link CreditNotesService}, advances and draw-downs through
 * {@link PrepaymentService}, and cash through {@link ReconciliationService}'s
 * draft → activate seam. No voucher is hand-written to make a balance tie; the
 * one exception is a credit note's REVERSAL, which has no service path of its
 * own and is posted as a real mirrored counter-voucher through
 * {@link PostingService}.
 */
describe('outstanding balance across every linked settlement (#202)', () => {
  let db: Kysely<Database>;
  let outstanding: OutstandingVoucherService;
  let reconciliation: ReconciliationService;
  let creditNotes: CreditNotesService;
  let salesInvoices: SalesInvoicesService;
  let expenses: ExpensesService;
  let posting: PostingService;
  let lineRepo: VoucherLineRepository;
  let accounts: AccountService;
  let entities: EntitiesService;
  let banks: BankStatementService;
  let prepayments: PrepaymentService;
  let ledgerBalance: LedgerBalanceService;

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
        AccountService,
        BankTransactionRepository,
        BankStatementService,
        EntitiesService,
        LedgerValidationService,
        PostingService,
        PeriodLockService,
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        PluginLoader,
        CurrencyService,
        FXRealizedService,
        LedgerBalanceService,
        OutstandingVoucherService,
        PrepaymentAllocationRepository,
        PrepaymentService,
        OrgContextResolver,
        ReconciliationService,
        VoucherRepository,
        VoucherLineRepository,
        VoucherProjectionService,
        SalesInvoicesService,
        CategoryService,
        AuditLogService,
        ExpensesService,
        CreditNotesService,
      ],
    }).compile();

    outstanding = module.get(OutstandingVoucherService);
    reconciliation = module.get(ReconciliationService);
    creditNotes = module.get(CreditNotesService);
    salesInvoices = module.get(SalesInvoicesService);
    expenses = module.get(ExpensesService);
    posting = module.get(PostingService);
    lineRepo = module.get(VoucherLineRepository);
    accounts = module.get(AccountService);
    entities = module.get(EntitiesService);
    banks = module.get(BankStatementService);
    prepayments = module.get(PrepaymentService);
    ledgerBalance = module.get(LedgerBalanceService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ── Helpers (real services only) ──────────────────────────────────────

  let entityCounter = 0;

  async function seedCustomer(name = 'Cust Ltd'): Promise<number> {
    entityCounter++;
    const c = await entities.onboard({
      role: 'customer',
      country: 'IE',
      name,
      registrationKey: `IE${1000000 + entityCounter}T`,
      goodsVsServices: 'services',
    });
    return c.id;
  }

  async function seedSupplier(name = 'Supp Co'): Promise<number> {
    entityCounter++;
    const s = await entities.onboard({
      role: 'supplier',
      country: 'IE',
      name,
      registrationKey: `IE${2000000 + entityCounter}X`,
      goodsVsServices: 'goods',
    });
    return s.id;
  }

  let invoiceCounter = 0;

  /** A posted SalesInvoice (Dr AR / Cr Revenue [+ Cr output VAT]). */
  async function postInvoice(
    customerId: number,
    gross: number,
    vat = 0,
  ): Promise<{ invoiceId: number; voucherId: number }> {
    invoiceCounter++;
    const invoice = await salesInvoices.createInvoice({
      customer_id: customerId,
      invoice_number: `INV-${invoiceCounter}`,
      gross_amount: gross,
      vat_amount: vat,
      currency: 'EUR',
      tax_point_date: '2026-05-15',
      due_date: null,
    });
    const draft = await salesInvoices.generateDraftVoucher(invoice.id);
    const posted = await posting.postVoucher(draft);
    await salesInvoices.updateInvoiceStatus(invoice.id, 'posted', posted.id);
    return { invoiceId: invoice.id, voucherId: posted.id };
  }

  /** A posted Expense (Dr expense [+ Dr input VAT] / Cr AP). */
  async function postExpense(
    supplierId: number,
    gross: number,
    vat = 0,
  ): Promise<{ expenseId: number; voucherId: number }> {
    invoiceCounter++;
    const expense = await expenses.createExpense({
      supplier_id: supplierId,
      category: 'software',
      gross_amount: gross,
      vat_amount: vat,
      currency: 'EUR',
      tax_point_date: '2026-05-15',
      supplier_invoice_number: `SUP-${invoiceCounter}`,
    });
    const draft = await expenses.generateDraftVoucher(expense.id);
    const posted = await posting.postVoucher(draft);
    await expenses.updateExpenseStatus(expense.id, 'posted', posted.id);
    return { expenseId: expense.id, voucherId: posted.id };
  }

  let creditCounter = 0;

  async function creditNote(
    type: 'sales_invoice' | 'expense',
    objectId: number,
    gross: number,
    vat = 0,
  ): Promise<number> {
    creditCounter++;
    const note = await creditNotes.create({
      credits_object_type: type,
      credits_object_id: objectId,
      credit_note_number: `CN-${creditCounter}`,
      gross_amount: gross,
      vat_amount: vat,
      tax_point_date: '2026-05-20',
    });
    if (note.voucher_id === null) throw new Error('credit note not posted');
    return note.voucher_id;
  }

  /**
   * Post a real mirrored counter-voucher (`reverses_id`) for a voucher — the
   * ledger fact every settlement type's release is read from. Used for the
   * credit note, which has no reversal service of its own.
   */
  async function reverseVoucher(voucherId: number): Promise<number> {
    const original = await db
      .selectFrom('voucher')
      .select(['tax_point_date', 'voucher_number'])
      .where('id', '=', voucherId)
      .executeTakeFirstOrThrow();
    const originalLines = await lineRepo.getLinesByVoucherId(voucherId);
    const ids = [...new Set(originalLines.map((l) => l.account_id))];
    const byId = new Map(
      (await accounts.getAccountsByIds(ids)).map((a) => [a.id, a]),
    );
    const lines: DraftVoucherLine[] = originalLines.map((l) => {
      const account = byId.get(l.account_id);
      if (!account) throw new Error(`Account ${l.account_id} not found`);
      return {
        account_code: account.code,
        amount: l.amount,
        currency: l.currency,
        base_amount: l.base_amount,
        fx_rate: l.fx_rate,
        vat_code: l.vat_code,
        is_debit: !l.is_debit,
      };
    });
    const posted = await posting.postVoucher({
      voucher_number: `${original.voucher_number}-REV`,
      tax_point_date: original.tax_point_date,
      lines,
      reverses_id: voucherId,
      reason: 'reversal',
    });
    return posted.id;
  }

  /** One bank line on its own statement; returns statement + transaction ids. */
  async function bankLine(
    amount: number,
    description = 'payment',
  ): Promise<{ statementId: number; transactionId: number }> {
    const stmt = await banks.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2026-05-01',
      end_date: '2026-05-31',
      transactions: [
        {
          transaction_date: '2026-05-18',
          description,
          amount,
          currency: 'EUR',
          status: 'open',
        },
      ],
    });
    return {
      statementId: stmt.statement.id,
      transactionId: stmt.transactions[0].id,
    };
  }

  /** Stage a cash match and approve it — the real draft → active settlement. */
  async function settleWithCash(
    voucherId: number,
    amount: number,
    incoming: boolean,
  ): Promise<number> {
    const { transactionId } = await bankLine(
      incoming ? amount : -amount,
      'settlement',
    );
    const { records } = await reconciliation.executeMatch([
      {
        bankTransactionId: transactionId,
        voucherId,
        matchType: 'partial',
        amountMatched: amount,
        confidence: 'high',
        signal: 'manual',
      },
    ]);
    await reconciliation.activateMatch(records[0].id);
    return records[0].id;
  }

  /** An advance for `entityId` of `amount`, drawn down against `invoiceVoucherId`. */
  async function allocateAdvance(
    entityId: number,
    kind: 'customer' | 'supplier',
    amount: number,
    invoiceVoucherId: number,
    drawn = amount,
  ): Promise<{ advanceVoucherId: number; allocationVoucherId: number }> {
    const { transactionId } = await bankLine(
      kind === 'customer' ? amount : -amount,
      'advance',
    );
    const advance =
      kind === 'customer'
        ? await prepayments.createCustomerPrepayment(transactionId, entityId)
        : await prepayments.createSupplierPrepayment(transactionId, entityId);
    const allocation = await prepayments.drawDownPrepayment(
      advance.id,
      invoiceVoucherId,
      drawn,
    );
    return { advanceVoucherId: advance.id, allocationVoucherId: allocation.id };
  }

  /** The AR (debit-positive) / AP (credit-positive) control-account balance. */
  async function controlBalance(code: 'AR' | 'AP'): Promise<number> {
    const net = await ledgerBalance.getLedgerNet(
      { codes: [code] },
      { creditPositive: code === 'AP' },
    );
    // Normalize the -0 a credit-positive negation of zero produces.
    return net + 0;
  }

  /** Σ of the still-active cash matches against one voucher. */
  async function activeCash(voucherId: number): Promise<number> {
    const row = await db
      .selectFrom('reconciliation_match')
      .select((eb) => eb.fn.sum<number>('amount_matched').as('total'))
      .where('voucher_id', '=', voucherId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    return Number(row?.total ?? 0);
  }

  // ── AR: credit notes ──────────────────────────────────────────────────

  it('a fully credited sales invoice has zero outstanding and is not offered', async () => {
    const customerId = await seedCustomer();
    const { invoiceId, voucherId } = await postInvoice(customerId, 12400, 2400);

    await creditNote('sales_invoice', invoiceId, 12400, 2400);

    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(0);
    expect(await controlBalance('AR')).toBe(0);

    const [candidate] =
      await outstanding.findArCandidatesByCounterparty(customerId);
    expect(candidate.remainingBalance).toBe(0);

    // The collectible offers a bank line actually sees.
    const { statementId, transactionId } = await bankLine(12400, 'INV-1');
    const offered = await reconciliation.getMatchCandidates(
      statementId,
      transactionId,
    );
    expect(offered.candidates.map((c) => c.voucherId)).not.toContain(voucherId);
    const proposals = await reconciliation.proposeMatches(statementId);
    expect(proposals.map((p) => p.voucherId)).not.toContain(voucherId);
  });

  it('a partial credit leaves exactly the uncredited remainder, cash-settleable', async () => {
    const customerId = await seedCustomer();
    const { invoiceId, voucherId } = await postInvoice(customerId, 12400, 2400);

    await creditNote('sales_invoice', invoiceId, 4400, 851);
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(8000);

    await settleWithCash(voucherId, 8000, true);
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(0);
  });

  it('cumulative partial credits net down to zero', async () => {
    const customerId = await seedCustomer();
    const { invoiceId, voucherId } = await postInvoice(customerId, 10000);

    await creditNote('sales_invoice', invoiceId, 3000);
    await creditNote('sales_invoice', invoiceId, 7000);

    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(0);
    expect(await controlBalance('AR')).toBe(0);
  });

  it('reversing a credit note releases its credit and restores the outstanding', async () => {
    const customerId = await seedCustomer();
    const { invoiceId, voucherId } = await postInvoice(customerId, 10000);

    const creditVoucherId = await creditNote('sales_invoice', invoiceId, 10000);
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(0);

    await reverseVoucher(creditVoucherId);

    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(10000);
    expect(await controlBalance('AR')).toBe(10000);
  });

  // ── AP: supplier symmetry ─────────────────────────────────────────────

  it('a fully credited expense has zero payable and is not offered', async () => {
    const supplierId = await seedSupplier();
    const { expenseId, voucherId } = await postExpense(supplierId, 12400, 2400);

    await creditNote('expense', expenseId, 12400, 2400);

    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(0);
    expect(await controlBalance('AP')).toBe(0);

    const [candidate] =
      await outstanding.findApCandidatesByCounterparty(supplierId);
    expect(candidate.remainingBalance).toBe(0);

    const { statementId, transactionId } = await bankLine(-12400, 'SUP-1');
    const offered = await reconciliation.getMatchCandidates(
      statementId,
      transactionId,
    );
    expect(offered.candidates.map((c) => c.voucherId)).not.toContain(voucherId);
  });

  it('a partial purchase credit leaves the uncredited payable', async () => {
    const supplierId = await seedSupplier();
    const { expenseId, voucherId } = await postExpense(supplierId, 10000);

    await creditNote('expense', expenseId, 2500);

    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(7500);

    await settleWithCash(voucherId, 7500, false);
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(0);
  });

  // ── Mixed sequences ───────────────────────────────────────────────────

  it('credit, advance and cash consume one receivable exactly once each', async () => {
    const customerId = await seedCustomer();
    const { invoiceId, voucherId } = await postInvoice(customerId, 10000);

    await creditNote('sales_invoice', invoiceId, 4000);
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(6000);

    await allocateAdvance(customerId, 'customer', 1000, voucherId);
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(5000);

    await settleWithCash(voucherId, 2000, true);
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(3000);
  });

  it('a draw-down cannot exceed what a credit note has already relieved', async () => {
    const customerId = await seedCustomer();
    const { invoiceId, voucherId } = await postInvoice(customerId, 10000);

    await creditNote('sales_invoice', invoiceId, 9000);

    // Advance of 5000, but only 1000 of the receivable is left to relieve.
    await allocateAdvance(customerId, 'customer', 5000, voucherId);

    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(0);
    const allocated = await db
      .selectFrom('prepayment_allocation')
      .select('base_amount')
      .where('invoice_voucher_id', '=', voucherId)
      .execute();
    expect(allocated.map((a) => a.base_amount)).toEqual([1000]);
  });

  it('the supplier side mixes a purchase credit with an advance the same way', async () => {
    const supplierId = await seedSupplier();
    const { expenseId, voucherId } = await postExpense(supplierId, 10000);

    await creditNote('expense', expenseId, 2000);
    await allocateAdvance(supplierId, 'supplier', 3000, voucherId);

    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(5000);
  });

  it('reversing the advance allocation restores only the advance part of a credited invoice', async () => {
    const customerId = await seedCustomer();
    const { invoiceId, voucherId } = await postInvoice(customerId, 10000);

    await creditNote('sales_invoice', invoiceId, 4000);
    const { allocationVoucherId } = await allocateAdvance(
      customerId,
      'customer',
      1000,
      voucherId,
    );
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(5000);

    await reverseVoucher(allocationVoucherId);

    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(6000);
  });

  it('unmatching cash restores only the cash part of a credited invoice', async () => {
    const customerId = await seedCustomer();
    const { invoiceId, voucherId } = await postInvoice(customerId, 10000);

    await creditNote('sales_invoice', invoiceId, 4000);
    const matchId = await settleWithCash(voucherId, 2000, true);
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(4000);

    await reconciliation.unmatch(matchId);

    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(6000);
  });

  // ── Isolation ─────────────────────────────────────────────────────────

  it('a credit note touches only the invoice it names', async () => {
    const customerA = await seedCustomer('A Ltd');
    const customerB = await seedCustomer('B Ltd');
    const credited = await postInvoice(customerA, 10000);
    const sibling = await postInvoice(customerA, 7000);
    const other = await postInvoice(customerB, 5000);
    const supplierId = await seedSupplier();
    const payable = await postExpense(supplierId, 6000);

    await creditNote('sales_invoice', credited.invoiceId, 10000);

    expect(
      await outstanding.getRemainingVoucherBalance(credited.voucherId),
    ).toBe(0);
    expect(
      await outstanding.getRemainingVoucherBalance(sibling.voucherId),
    ).toBe(7000);
    expect(await outstanding.getRemainingVoucherBalance(other.voucherId)).toBe(
      5000,
    );
    expect(
      await outstanding.getRemainingVoucherBalance(payable.voucherId),
    ).toBe(6000);
  });

  // ── The activation / write boundary ───────────────────────────────────

  it('a draft staged before the credit note cannot settle the invoice afterwards', async () => {
    const customerId = await seedCustomer();
    const { invoiceId, voucherId } = await postInvoice(customerId, 10000);

    const { transactionId } = await bankLine(10000, 'stale draft');
    const { records } = await reconciliation.executeMatch([
      {
        bankTransactionId: transactionId,
        voucherId,
        matchType: 'exact',
        amountMatched: 10000,
        confidence: 'high',
        signal: 'manual',
      },
    ]);

    // The credit note lands while the draft waits for approval.
    await creditNote('sales_invoice', invoiceId, 10000);

    await expect(reconciliation.activateMatch(records[0].id)).rejects.toThrow(
      /only 0 outstanding remains/,
    );
    expect(await activeCash(voucherId)).toBe(0);
  });

  it('a partial credit shrinks what a pending draft may still settle', async () => {
    const customerId = await seedCustomer();
    const { invoiceId, voucherId } = await postInvoice(customerId, 10000);

    const { transactionId } = await bankLine(10000, 'stale draft');
    const { records } = await reconciliation.executeMatch([
      {
        bankTransactionId: transactionId,
        voucherId,
        matchType: 'exact',
        amountMatched: 10000,
        confidence: 'high',
        signal: 'manual',
      },
    ]);

    await creditNote('sales_invoice', invoiceId, 3000);

    await expect(reconciliation.activateMatch(records[0].id)).rejects.toThrow(
      /only 7000 outstanding remains/,
    );
  });

  // ── Open items vs the control account ─────────────────────────────────

  it('open items reconcile to the AR/AP control accounts, net of the cash-settlement gap', async () => {
    const customerId = await seedCustomer();
    const supplierId = await seedSupplier();

    const fullyCredited = await postInvoice(customerId, 12400, 2400);
    await creditNote('sales_invoice', fullyCredited.invoiceId, 12400, 2400);

    const partlyCredited = await postInvoice(customerId, 10000);
    await creditNote('sales_invoice', partlyCredited.invoiceId, 2500);

    const withAdvance = await postInvoice(customerId, 8000);
    await allocateAdvance(customerId, 'customer', 3000, withAdvance.voucherId);

    const withCash = await postInvoice(customerId, 5000);
    await settleWithCash(withCash.voucherId, 2000, true);

    const arVouchers = [
      fullyCredited.voucherId,
      partlyCredited.voucherId,
      withAdvance.voucherId,
      withCash.voucherId,
    ];
    let arOpen = 0;
    let arCash = 0;
    for (const v of arVouchers) {
      arOpen += await outstanding.getRemainingVoucherBalance(v);
      arCash += await activeCash(v);
    }
    expect(arOpen).toBe(0 + 7500 + 5000 + 3000);

    // The credit note and the draw-down BOTH post their own vouchers, so they
    // relieve the control account as well as the open item. A cash match does
    // not post a settlement voucher at all (ADR-0008 foresees one; the current
    // engine only records the link), so the control account still carries what
    // cash has settled. That residual — and nothing else — is the difference.
    expect(await controlBalance('AR')).toBe(arOpen + arCash);
    expect((await controlBalance('AR')) - arOpen).toBe(arCash);

    const apCredited = await postExpense(supplierId, 10000);
    await creditNote('expense', apCredited.expenseId, 4000);
    const apWithAdvance = await postExpense(supplierId, 9000);
    await allocateAdvance(
      supplierId,
      'supplier',
      2000,
      apWithAdvance.voucherId,
    );

    let apOpen = 0;
    for (const v of [apCredited.voucherId, apWithAdvance.voucherId]) {
      apOpen += await outstanding.getRemainingVoucherBalance(v);
    }
    expect(apOpen).toBe(6000 + 7000);
    expect(await controlBalance('AP')).toBe(apOpen);
  });
});
