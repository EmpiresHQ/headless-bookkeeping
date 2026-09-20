import { expectDbRefusal } from '../../test/expect-db-refusal';
import {
  fxTestProviders,
  SETTLEMENT_SCENARIO_RATES,
} from '../../test/fx-fixtures';
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
import { CorrectionsService } from '../corrections/corrections.service';
import { StatusTransitionService } from '../ledger/status/status-transition.service';
import { DraftVoucherLine } from '../ledger/voucher/types';
import { ReconciliationService } from './reconciliation.service';
import { OutstandingVoucherService } from './outstanding-voucher.service';
import { PrepaymentAllocationRepository } from './prepayment-allocation.repository';
import { PrepaymentService } from './prepayment.service';
import { FXRealizedService } from './fx-realized.service';
import { SettlementVoucherService } from './settlement-voucher.service';

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
  let corrections: CorrectionsService;

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
        ...fxTestProviders(SETTLEMENT_SCENARIO_RATES),
        PluginLoader,
        CurrencyService,
        FXRealizedService,
        SettlementVoucherService,
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
        StatusTransitionService,
        CorrectionsService,
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
    corrections = module.get(CorrectionsService);
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
      // A goods customer: these suites are about settlement and FX, not about
      // the place of supply of services (issue #209 — a SERVICE sale to a
      // foreign customer needs a recorded tax status, and its stated tax must
      // match the derived rate; both are exercised in their own suites).
      goodsVsServices: 'goods',
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
    counterpartyIban?: string,
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
          counterparty_iban: counterpartyIban ?? null,
          status: 'open',
        },
      ],
    });
    return {
      statementId: stmt.statement.id,
      transactionId: stmt.transactions[0].id,
    };
  }

  /** A bank line carrying a foreign leg (source currency + rate). */
  async function foreignBankLine(args: {
    amount: number;
    sourceCurrency: string;
    sourceAmount: number;
    fxRate: number;
    accountCode?: string;
    currency?: string;
  }): Promise<{ statementId: number; transactionId: number }> {
    const stmt = await banks.createStatement({
      account_code: args.accountCode ?? 'BANK_EUR',
      start_date: '2026-05-01',
      end_date: '2026-05-31',
      transactions: [
        {
          transaction_date: '2026-05-18',
          description: 'foreign settlement',
          amount: args.amount,
          currency: args.currency ?? 'EUR',
          source_currency: args.sourceCurrency,
          source_amount: args.sourceAmount,
          fx_rate: args.fxRate,
          status: 'open',
        },
      ],
    });
    return {
      statementId: stmt.statement.id,
      transactionId: stmt.transactions[0].id,
    };
  }

  /** Stage + approve a match against an existing bank line. */
  async function settleLine(
    transactionId: number,
    voucherId: number,
    amount: number,
  ): Promise<number> {
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

  /** Σ of the remaining outstanding over a set of vouchers. */
  async function sumRemaining(voucherIds: number[]): Promise<number> {
    let total = 0;
    for (const id of voucherIds) {
      total += await outstanding.getRemainingVoucherBalance(id);
    }
    return total;
  }

  /** The settlement voucher a match posted, if any. */
  async function settlementVoucherOf(matchId: number): Promise<number | null> {
    const row = await db
      .selectFrom('reconciliation_match')
      .select('settlement_voucher_id')
      .where('id', '=', matchId)
      .executeTakeFirstOrThrow();
    return row.settlement_voucher_id;
  }

  /** A voucher's legs as {code, isDebit, base}, ordered by account code. */
  async function voucherLegs(
    voucherId: number,
  ): Promise<{ code: string; isDebit: number; base: number }[]> {
    const rows = await db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select([
        'account.code as code',
        'voucher_line.is_debit as is_debit',
        'voucher_line.base_amount as base_amount',
      ])
      .where('voucher_line.voucher_id', '=', voucherId)
      .orderBy('account.code')
      .execute();
    return rows.map((r) => ({
      code: r.code,
      isDebit: r.is_debit,
      base: r.base_amount,
    }));
  }

  /** A bank account's debit-positive base balance. */
  async function bankBalance(code: string): Promise<number> {
    return (await ledgerBalance.getLedgerNet({ codes: [code] })) + 0;
  }

  async function voucherCount(): Promise<number> {
    const row = await db
      .selectFrom('voucher')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /**
   * Switch the Organization to the EE plugin, whose reference rates are real
   * (USD→EUR 0.92) — the IE default resolves to the null plugin, which refuses
   * cross-currency conversion outright.
   */
  async function useEstoniaPlugin(): Promise<void> {
    await db
      .updateTable('organization')
      .set({ country: 'EE' })
      .where('id', '=', 1)
      .execute();
  }

  /** The invoice number a sales-invoice voucher belongs to. */
  async function invoiceNumberOf(voucherId: number): Promise<string> {
    const row = await db
      .selectFrom('sales_invoice')
      .select('invoice_number')
      .where('voucher_id', '=', voucherId)
      .executeTakeFirstOrThrow();
    return row.invoice_number;
  }

  /** A posted Expense denominated in a non-base currency. */
  async function postExpenseInCurrency(
    supplierId: number,
    gross: number,
    currency: string,
  ): Promise<{ expenseId: number; voucherId: number }> {
    invoiceCounter++;
    const expense = await expenses.createExpense({
      supplier_id: supplierId,
      category: 'software',
      gross_amount: gross,
      vat_amount: 0,
      currency,
      tax_point_date: '2026-05-15',
      supplier_invoice_number: `SUP-FX-${invoiceCounter}`,
    });
    const draft = await expenses.generateDraftVoucher(expense.id);
    const posted = await posting.postVoucher(draft);
    await expenses.updateExpenseStatus(expense.id, 'posted', posted.id);
    return { expenseId: expense.id, voucherId: posted.id };
  }

  /** A posted SalesInvoice denominated in a non-base currency. */
  async function postInvoiceInCurrency(
    customerId: number,
    gross: number,
    currency: string,
  ): Promise<{ invoiceId: number; voucherId: number }> {
    invoiceCounter++;
    const invoice = await salesInvoices.createInvoice({
      customer_id: customerId,
      invoice_number: `INV-FX-${invoiceCounter}`,
      gross_amount: gross,
      vat_amount: 0,
      currency,
      tax_point_date: '2026-05-15',
      due_date: null,
    });
    const draft = await salesInvoices.generateDraftVoucher(invoice.id);
    const posted = await posting.postVoucher(draft);
    await salesInvoices.updateInvoiceStatus(invoice.id, 'posted', posted.id);
    return { invoiceId: invoice.id, voucherId: posted.id };
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

  it('open items reconcile exactly to the AR and AP control accounts', async () => {
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

    const unmatched = await postInvoice(customerId, 4000);
    const undoneMatch = await settleWithCash(unmatched.voucherId, 4000, true);
    await reconciliation.unmatch(undoneMatch);

    const arVouchers = [
      fullyCredited.voucherId,
      partlyCredited.voucherId,
      withAdvance.voucherId,
      withCash.voucherId,
      unmatched.voucherId,
    ];
    const arOpen = await sumRemaining(arVouchers);
    expect(arOpen).toBe(0 + 7500 + 5000 + 3000 + 4000);

    // Every settlement type now posts its own voucher — credit note, advance
    // draw-down AND cash — so the control account and the open items are the
    // same number, with no residual to explain away. The unmatched line's
    // settlement was reversed, so it is back in both.
    expect(await controlBalance('AR')).toBe(arOpen);
    expect(await reconciliation.listUnpostedSettlements()).toEqual([]);

    const apCredited = await postExpense(supplierId, 10000);
    await creditNote('expense', apCredited.expenseId, 4000);
    const apWithAdvance = await postExpense(supplierId, 9000);
    await allocateAdvance(
      supplierId,
      'supplier',
      2000,
      apWithAdvance.voucherId,
    );
    const apWithCash = await postExpense(supplierId, 7000);
    await settleWithCash(apWithCash.voucherId, 3000, false);

    const apOpen = await sumRemaining([
      apCredited.voucherId,
      apWithAdvance.voucherId,
      apWithCash.voucherId,
    ]);
    expect(apOpen).toBe(6000 + 7000 + 4000);
    expect(await controlBalance('AP')).toBe(apOpen);
  });

  // ── The settlement voucher itself ─────────────────────────────────────

  it('activating a cash match posts the settlement voucher that clears AR', async () => {
    const customerId = await seedCustomer();
    const { voucherId } = await postInvoice(customerId, 10000);

    const matchId = await settleWithCash(voucherId, 4000, true);

    const settlementVoucherId = await settlementVoucherOf(matchId);
    expect(settlementVoucherId).not.toBeNull();
    expect(await voucherLegs(settlementVoucherId!)).toEqual([
      { code: 'AR', isDebit: 0, base: 4000 },
      { code: 'BANK_EUR', isDebit: 1, base: 4000 },
    ]);
    expect(await controlBalance('AR')).toBe(6000);
    expect(await bankBalance('BANK_EUR')).toBe(4000);
  });

  it('activating an AP cash match posts the mirrored settlement', async () => {
    const supplierId = await seedSupplier();
    const { voucherId } = await postExpense(supplierId, 10000);

    const matchId = await settleWithCash(voucherId, 10000, false);

    const settlementVoucherId = await settlementVoucherOf(matchId);
    expect(await voucherLegs(settlementVoucherId!)).toEqual([
      { code: 'AP', isDebit: 1, base: 10000 },
      { code: 'BANK_EUR', isDebit: 0, base: 10000 },
    ]);
    expect(await controlBalance('AP')).toBe(0);
    expect(await bankBalance('BANK_EUR')).toBe(-10000);
  });

  it('unmatching reverses the settlement voucher instead of editing it', async () => {
    const customerId = await seedCustomer();
    const { voucherId } = await postInvoice(customerId, 10000);
    const matchId = await settleWithCash(voucherId, 10000, true);
    const settlementVoucherId = await settlementVoucherOf(matchId);

    const result = await reconciliation.unmatch(matchId);

    expect(result.settlementReversalVoucherId).not.toBeNull();
    const reversal = await db
      .selectFrom('voucher')
      .select(['reverses_id', 'posted_at'])
      .where('id', '=', result.settlementReversalVoucherId!)
      .executeTakeFirstOrThrow();
    expect(reversal.reverses_id).toBe(settlementVoucherId);
    // The original settlement voucher is untouched — it still stands, reversed.
    expect(await voucherLegs(settlementVoucherId!)).toHaveLength(2);
    expect(await controlBalance('AR')).toBe(10000);
    expect(await bankBalance('BANK_EUR')).toBe(0);
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(10000);
  });

  it('activation is atomic: a refused over-match posts no settlement', async () => {
    const customerId = await seedCustomer();
    const { invoiceId, voucherId } = await postInvoice(customerId, 10000);

    const { transactionId } = await bankLine(10000, 'stale');
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
    await creditNote('sales_invoice', invoiceId, 10000);

    await expect(reconciliation.activateMatch(records[0].id)).rejects.toThrow(
      /outstanding remains/,
    );

    expect(await settlementVoucherOf(records[0].id)).toBeNull();
    expect(await bankBalance('BANK_EUR')).toBe(0);
    expect(await controlBalance('AR')).toBe(0);
  });

  it('re-activating an already active match posts nothing further', async () => {
    const customerId = await seedCustomer();
    const { voucherId } = await postInvoice(customerId, 10000);
    const matchId = await settleWithCash(voucherId, 10000, true);

    const before = await voucherCount();
    await reconciliation.activateMatch(matchId);

    expect(await voucherCount()).toBe(before);
    expect(await controlBalance('AR')).toBe(0);
    expect(await bankBalance('BANK_EUR')).toBe(10000);
  });

  it('a prepayment match books no second settlement: the advance already holds the cash', async () => {
    const customerId = await seedCustomer();
    await entities.addAlias(customerId, {
      kind: 'iban',
      value: 'IE29AIBK93115212345678',
      confirmed: true,
    });
    const { transactionId } = await bankLine(
      5000,
      'advance',
      'IE29AIBK93115212345678',
    );
    const advance = await prepayments.createCustomerPrepayment(
      transactionId,
      customerId,
    );

    // The same bank line is then linked to its advance voucher as a match.
    const { records } = await reconciliation.executeMatch([
      {
        bankTransactionId: transactionId,
        voucherId: advance.id,
        matchType: 'prepayment',
        amountMatched: 5000,
        confidence: 'high',
        signal: 'manual',
      },
    ]);
    await reconciliation.activateMatch(records[0].id);

    expect(await settlementVoucherOf(records[0].id)).toBeNull();
    // Only the advance voucher's own Dr BANK — not doubled.
    expect(await bankBalance('BANK_EUR')).toBe(5000);
    expect(await reconciliation.listUnpostedSettlements()).toEqual([]);
  });

  it('a settlement dated into a locked period is redirected into the open one', async () => {
    const customerId = await seedCustomer();
    const { voucherId } = await postInvoice(customerId, 10000);

    await db
      .insertInto('reporting_period')
      .values({
        name: '2026-05',
        start_date: '2026-05-01',
        end_date: '2026-05-31',
        status: 'locked',
        filed_at: 0,
        created_at: 0,
      })
      .execute();
    await db
      .insertInto('reporting_period')
      .values({
        name: '2026-06',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        status: 'open',
        filed_at: null,
        created_at: 0,
      })
      .execute();

    // The bank line sits inside the locked period (2026-05-18).
    const matchId = await settleWithCash(voucherId, 10000, true);

    const settlementVoucherId = await settlementVoucherOf(matchId);
    const settlement = await db
      .selectFrom('voucher')
      .select('tax_point_date')
      .where('id', '=', settlementVoucherId!)
      .executeTakeFirstOrThrow();
    expect(settlement.tax_point_date).toBe('2026-06-01');
  });

  it('a match activated before the settlement voucher existed is reported, not guessed', async () => {
    const customerId = await seedCustomer();
    const { voucherId } = await postInvoice(customerId, 10000);
    const { transactionId } = await bankLine(10000, 'historical');

    // A pre-migration-070 row: active, settling the invoice, no ledger entry.
    const now = Math.floor(Date.now() / 1000);
    const legacy = await db
      .insertInto('reconciliation_match')
      .values({
        bank_transaction_id: transactionId,
        voucher_id: voucherId,
        match_type: 'exact',
        amount_matched: 10000,
        status: 'active',
        created_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // The open item is settled, the control account is not — and the
    // difference is attributable to exactly this link, with nothing invented.
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(0);
    expect(await controlBalance('AR')).toBe(10000);
    expect(await reconciliation.listUnpostedSettlements()).toEqual([
      {
        matchId: legacy.id,
        bankTransactionId: transactionId,
        voucherId,
        amountMatched: 10000,
      },
    ]);

    // Re-booking it is the documented repair: unmatch, then match again.
    await reconciliation.unmatch(legacy.id);
    await settleWithCash(voucherId, 10000, true);
    expect(await controlBalance('AR')).toBe(0);
    expect(await reconciliation.listUnpostedSettlements()).toEqual([]);
  });

  // ── Corrections (ADR-0009) ────────────────────────────────────────────

  it('a corrected invoice carries its settlements onto the replacement', async () => {
    const customerId = await seedCustomer();
    const { invoiceId, voucherId } = await postInvoice(customerId, 10000);

    await creditNote('sales_invoice', invoiceId, 1000);
    await allocateAdvance(customerId, 'customer', 2000, voucherId);
    await settleWithCash(voucherId, 3000, true);
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(4000);

    const correction = await corrections.correctSalesInvoice(invoiceId, {
      kind: 'financial',
      reason: 'agreed price increase',
      patch: { gross_amount: 15000 },
    });
    expect(correction.outcome).toBe('posted_reversal_and_correction');
    const correctedVoucherId = correction.correctedVoucherId!;

    // The superseded voucher no longer stands: nothing is collectible on it.
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(0);
    // The replacement carries the restated gross minus every settlement that
    // was already taken against the object: 15000 − 1000 − 2000 − 3000.
    expect(
      await outstanding.getRemainingVoucherBalance(correctedVoucherId),
    ).toBe(9000);

    const [candidate] =
      await outstanding.findArCandidatesByCounterparty(customerId);
    expect(candidate.voucherId).toBe(correctedVoucherId);
    expect(candidate.remainingBalance).toBe(9000);

    expect(await controlBalance('AR')).toBe(9000);
  });

  it('a stale draft against the superseded voucher can no longer be activated', async () => {
    const customerId = await seedCustomer();
    const { invoiceId, voucherId } = await postInvoice(customerId, 10000);

    const { transactionId } = await bankLine(10000, 'stale');
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

    await corrections.correctSalesInvoice(invoiceId, {
      kind: 'financial',
      reason: 'wrong amount',
      patch: { gross_amount: 12000 },
    });

    await expect(reconciliation.activateMatch(records[0].id)).rejects.toThrow(
      /only 0 outstanding remains/,
    );
    expect(await bankBalance('BANK_EUR')).toBe(0);
  });

  it('a cancelled invoice has no outstanding and is never offered again', async () => {
    const customerId = await seedCustomer();
    const { invoiceId, voucherId } = await postInvoice(customerId, 10000);

    const result = await corrections.correctSalesInvoice(invoiceId, {
      kind: 'reversal',
      reason: 'issued in error',
    });
    expect(result.outcome).toBe('posted_reversal');

    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(0);
    expect(
      await outstanding.findArCandidatesByCounterparty(customerId),
    ).toEqual([]);
    expect(await controlBalance('AR')).toBe(0);

    const { statementId, transactionId } = await bankLine(
      10000,
      'late payment',
    );
    const offered = await reconciliation.getMatchCandidates(
      statementId,
      transactionId,
    );
    expect(offered.candidates.map((c) => c.voucherId)).not.toContain(voucherId);
  });

  it('a corrected expense stays payable to its supplier at the restated amount', async () => {
    const supplierId = await seedSupplier();
    const { expenseId, voucherId } = await postExpense(supplierId, 10000);
    await settleWithCash(voucherId, 2500, false);

    const correction = await corrections.correctExpense(expenseId, {
      kind: 'financial',
      reason: 'supplier re-issued the bill',
      patch: { gross_amount: 8000 },
    });
    const correctedVoucherId = correction.correctedVoucherId!;

    expect(
      await outstanding.getRemainingVoucherBalance(correctedVoucherId),
    ).toBe(5500);
    const [candidate] =
      await outstanding.findApCandidatesByCounterparty(supplierId);
    expect(candidate.voucherId).toBe(correctedVoucherId);
    expect(await controlBalance('AP')).toBe(5500);
  });

  // ── Foreign currency + over-settlement ────────────────────────────────

  it('a credit note reduces by its POSTED base amount, not by its document gross', async () => {
    await useEstoniaPlugin();
    const customerId = await seedCustomer();

    // USD 1000.00 invoiced; booked at the EE plugin's USD→EUR 0.92 ⇒ EUR 920.00.
    const { invoiceId, voucherId } = await postInvoiceInCurrency(
      customerId,
      100000,
      'USD',
    );
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(92000);

    // A USD 250.00 credit note: 25000 in document currency, 23000 in base.
    const creditVoucherId = await creditNote('sales_invoice', invoiceId, 25000);
    const creditBase = await ledgerBalance.getVoucherNetBase(creditVoucherId, [
      'AR',
    ]);
    expect(creditBase).toBe(23000);

    // The outstanding drops by the BASE effect (23000), not by the gross
    // (25000) — the document-currency number would understate the receivable.
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(69000);
    expect(await controlBalance('AR')).toBe(69000);
  });

  it('a credit note issued after payment reports a surplus instead of a silent tie', async () => {
    const customerId = await seedCustomer();
    const { invoiceId, voucherId } = await postInvoice(customerId, 10000);

    await settleWithCash(voucherId, 10000, true);
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(0);

    // The customer is credited AFTER paying in full: nothing is left to
    // collect, but 4000 is now owed BACK to them. The outstanding clips to
    // zero; the surplus is where that 4000 is stated.
    await creditNote('sales_invoice', invoiceId, 4000);

    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(0);
    expect(await outstanding.getSettlementSurplus(voucherId)).toBe(4000);
    expect(await controlBalance('AR')).toBe(-4000);
    // control = Σ open items − Σ surplus, exactly.
    expect(await controlBalance('AR')).toBe(
      (await outstanding.getRemainingVoucherBalance(voucherId)) -
        (await outstanding.getSettlementSurplus(voucherId)),
    );
    // And it is still not offered for collection.
    const [candidate] =
      await outstanding.findArCandidatesByCounterparty(customerId);
    expect(candidate.remainingBalance).toBe(0);
  });

  // ── Settlement slice arithmetic against real banking values ───────────

  it('a partial receipt at an unchanged rate books the whole cash, with no FX', async () => {
    const customerId = await seedCustomer();
    // Invoice booked base 10 000. The customer pays 4 000 of it; the line
    // carries a foreign leg whose rate moves nothing (4 000 @ 1.0).
    const { voucherId } = await postInvoice(customerId, 10000);
    const { transactionId } = await foreignBankLine({
      amount: 4000,
      sourceCurrency: 'USD',
      sourceAmount: 4000,
      fxRate: 1,
    });

    const matchId = await settleLine(transactionId, voucherId, 4000);

    // Scaling the cash by the match's share of the INVOICE (4 000/10 000)
    // valued this receipt at 1 600 and invented a 2 400 loss. The slice is a
    // share of the LINE, so the bank gets all 4 000 and there is no FX leg.
    expect(await voucherLegs((await settlementVoucherOf(matchId))!)).toEqual([
      { code: 'AR', isDebit: 0, base: 4000 },
      { code: 'BANK_EUR', isDebit: 1, base: 4000 },
    ]);
    expect(await bankBalance('BANK_EUR')).toBe(4000);
    expect(await bankBalance('FX_GAIN_LOSS')).toBe(0);
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(6000);
    expect(await controlBalance('AR')).toBe(6000);
  });

  it('one foreign line split across two invoices splits its gain in proportion', async () => {
    await useEstoniaPlugin();
    const customerId = await seedCustomer();
    // Two USD invoices booked at 0.92: 6 000 USD → 5 520 and 4 000 USD → 3 680.
    const big = await postInvoiceInCurrency(customerId, 6000, 'USD');
    const small = await postInvoiceInCurrency(customerId, 4000, 'USD');
    expect(await outstanding.getRemainingVoucherBalance(big.voucherId)).toBe(
      5520,
    );

    // The bank converts the whole 10 000 USD at 0.95 → 9 500 EUR of cash.
    const { transactionId } = await foreignBankLine({
      amount: 9500,
      sourceCurrency: 'USD',
      sourceAmount: 10000,
      fxRate: 0.95,
    });

    const bigMatch = await settleLine(transactionId, big.voucherId, 5520);
    const smallMatch = await settleLine(transactionId, small.voucherId, 3680);

    // Each slice is valued in USD at the rate the cash really arrived at:
    // 6 000 USD × 0.95 = 5 700 and 4 000 USD × 0.95 = 3 800.
    expect(await voucherLegs((await settlementVoucherOf(bigMatch))!)).toEqual([
      { code: 'AR', isDebit: 0, base: 5520 },
      { code: 'BANK_EUR', isDebit: 1, base: 5700 },
      { code: 'FX_GAIN_LOSS', isDebit: 0, base: 180 },
    ]);
    expect(await voucherLegs((await settlementVoucherOf(smallMatch))!)).toEqual(
      [
        { code: 'AR', isDebit: 0, base: 3680 },
        { code: 'BANK_EUR', isDebit: 1, base: 3800 },
        { code: 'FX_GAIN_LOSS', isDebit: 0, base: 120 },
      ],
    );

    // The two slices together are exactly the line's cash and its gain.
    expect(await bankBalance('BANK_EUR')).toBe(9500);
    expect(await bankBalance('FX_GAIN_LOSS')).toBe(-300);
    expect(await controlBalance('AR')).toBe(0);
  });

  it('paying a foreign payable at a worse rate books a loss, not a gain', async () => {
    await useEstoniaPlugin();
    const supplierId = await seedSupplier();
    // 1 000 USD payable booked at 0.92 → 920 base.
    const { voucherId } = await postExpenseInCurrency(supplierId, 1000, 'USD');
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(920);

    // We pay 1 000 USD but the bank charges 0.95 → 950 EUR leaves the account.
    const { transactionId } = await foreignBankLine({
      amount: -950,
      sourceCurrency: 'USD',
      sourceAmount: -1000,
      fxRate: 0.95,
    });
    const matchId = await settleLine(transactionId, voucherId, 920);

    expect(await voucherLegs((await settlementVoucherOf(matchId))!)).toEqual([
      { code: 'AP', isDebit: 1, base: 920 },
      { code: 'BANK_EUR', isDebit: 0, base: 950 },
      { code: 'FX_GAIN_LOSS', isDebit: 1, base: 30 },
    ]);
    // Paying MORE base than booked is a loss (a debit to FX_GAIN_LOSS).
    expect(await bankBalance('FX_GAIN_LOSS')).toBe(30);
    expect(await bankBalance('BANK_EUR')).toBe(-950);
    expect(await controlBalance('AP')).toBe(0);
  });

  it('a non-base statement account keeps the cash on its own bank', async () => {
    await useEstoniaPlugin();
    const customerId = await seedCustomer();
    const { voucherId } = await postInvoiceInCurrency(customerId, 10000, 'USD');

    // A USD statement: the money arrives in the USD account, in USD.
    const stmt = await banks.createStatement({
      account_code: 'BANK_USD',
      start_date: '2026-05-01',
      end_date: '2026-05-31',
      transactions: [
        {
          transaction_date: '2026-05-18',
          description: 'USD receipt',
          amount: 10000,
          currency: 'USD',
          status: 'open',
        },
      ],
    });
    const matchId = await settleLine(stmt.transactions[0].id, voucherId, 9200);

    const legs = await db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select([
        'account.code as code',
        'voucher_line.amount as amount',
        'voucher_line.currency as currency',
        'voucher_line.base_amount as base_amount',
      ])
      .where(
        'voucher_line.voucher_id',
        '=',
        (await settlementVoucherOf(matchId))!,
      )
      .orderBy('account.code')
      .execute();
    expect(legs).toEqual([
      { code: 'AR', amount: 9200, currency: 'EUR', base_amount: 9200 },
      { code: 'BANK_USD', amount: 10000, currency: 'USD', base_amount: 9200 },
    ]);
    // Nothing is fabricated on the base bank account.
    expect(await bankBalance('BANK_EUR')).toBe(0);
    expect(await controlBalance('AR')).toBe(0);
  });

  // ── Cancelled documents: nothing collectible, money still owed back ───

  it('cancelling a paid invoice leaves the payment visible as owed back', async () => {
    const customerId = await seedCustomer();
    const { invoiceId, voucherId } = await postInvoice(customerId, 10000);
    await settleWithCash(voucherId, 6000, true);
    await creditNote('sales_invoice', invoiceId, 1000);
    await allocateAdvance(customerId, 'customer', 1000, voucherId);

    await corrections.correctSalesInvoice(invoiceId, {
      kind: 'reversal',
      reason: 'issued in error',
    });

    // Nothing is collectible on a cancelled invoice …
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(0);
    expect(
      await outstanding.findArCandidatesByCounterparty(customerId),
    ).toEqual([]);
    // … but the 6 000 paid, the 1 000 credited and the 1 000 drawn from the
    // advance did not disappear with it: they are owed back, and the AR
    // control balance says so.
    expect(await outstanding.getSettlementSurplus(voucherId)).toBe(8000);
    expect(await controlBalance('AR')).toBe(-8000);

    const reconciliationView = await reconciliation.getOpenItemReconciliation();
    const item = reconciliationView.items.find(
      (i) => i.voucherId === voucherId,
    );
    expect(item).toMatchObject({
      objectType: 'sales_invoice',
      remaining: 0,
      surplus: 8000,
      cancelled: true,
    });
    expect(reconciliationView.totals.unexplained).toBe(0);
  });

  it('cancelling a part-paid expense reports the supplier refund the same way', async () => {
    const supplierId = await seedSupplier();
    const { expenseId, voucherId } = await postExpense(supplierId, 10000);
    await settleWithCash(voucherId, 2500, false);

    await corrections.correctExpense(expenseId, {
      kind: 'reversal',
      reason: 'never received the goods',
    });

    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(0);
    expect(await outstanding.getSettlementSurplus(voucherId)).toBe(2500);
    expect(await controlBalance('AP')).toBe(-2500);

    const view = await reconciliation.getOpenItemReconciliation();
    expect(view.items.find((i) => i.voucherId === voucherId)).toMatchObject({
      objectType: 'expense',
      surplus: 2500,
      cancelled: true,
    });
    expect(view.totals.unexplained).toBe(0);
  });

  it('the open-item read ties the whole subledger to both control accounts', async () => {
    const customerId = await seedCustomer();
    const supplierId = await seedSupplier();

    const open = await postInvoice(customerId, 10000);
    await settleWithCash(open.voucherId, 4000, true);

    const overCredited = await postInvoice(customerId, 5000);
    await settleWithCash(overCredited.voucherId, 5000, true);
    await creditNote('sales_invoice', overCredited.invoiceId, 2000);

    const payable = await postExpense(supplierId, 7000);
    await settleWithCash(payable.voucherId, 1000, false);

    const view = await reconciliation.getOpenItemReconciliation();
    expect(view.totals.openItems).toBe(6000 + 0 + 6000);
    expect(view.totals.surplus).toBe(2000);
    expect(view.totals.unpostedSettlements).toBe(0);
    expect(view.totals.controlAr).toBe(6000 - 2000);
    expect(view.totals.controlAp).toBe(6000);
    expect(view.totals.unexplained).toBe(0);
  });

  // ── Bank-line capacity is CASH, not booked base ───────────────────────

  it('a full settlement whose cash is cheaper than its booked amount is allowed', async () => {
    await useEstoniaPlugin();
    const customerId = await seedCustomer();
    // 10 000 USD invoiced, booked at 0.92 → 9 200 receivable.
    const { voucherId } = await postInvoiceInCurrency(customerId, 10000, 'USD');
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(9200);

    // The customer pays the whole 10 000 USD, but the bank converts at 0.90,
    // so only 9 000 of cash arrives. Clearing the 9 200 receivable costs
    // 9 000 of cash plus a 200 FX loss — the old guard compared the 9 200
    // BOOKED match against the 9 000 line and refused a full settlement.
    const { transactionId } = await foreignBankLine({
      amount: 9000,
      sourceCurrency: 'USD',
      sourceAmount: 10000,
      fxRate: 0.9,
    });

    const matchId = await settleLine(transactionId, voucherId, 9200);

    expect(await voucherLegs((await settlementVoucherOf(matchId))!)).toEqual([
      { code: 'AR', isDebit: 0, base: 9200 },
      { code: 'BANK_EUR', isDebit: 1, base: 9000 },
      { code: 'FX_GAIN_LOSS', isDebit: 1, base: 200 },
    ]);
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(0);
    expect(await controlBalance('AR')).toBe(0);
    expect(await bankBalance('BANK_EUR')).toBe(9000);
    expect(await bankBalance('FX_GAIN_LOSS')).toBe(200);
  });

  it('the proposal itself is sized in the invoice currency, not the line cash', async () => {
    await useEstoniaPlugin();
    const customerId = await seedCustomer();
    const { voucherId } = await postInvoiceInCurrency(customerId, 10000, 'USD');
    const invoiceNumber = await invoiceNumberOf(voucherId);

    const stmt = await banks.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2026-05-01',
      end_date: '2026-05-31',
      transactions: [
        {
          transaction_date: '2026-05-18',
          description: `payment ${invoiceNumber}`,
          reference: invoiceNumber,
          amount: 9000,
          currency: 'EUR',
          source_currency: 'USD',
          source_amount: 10000,
          fx_rate: 0.9,
          status: 'open',
        },
      ],
    });

    const [proposal] = await reconciliation.proposeMatches(stmt.statement.id);

    // 9 200 — the whole receivable — not the 9 000 of cash that settles it.
    expect(proposal.voucherId).toBe(voucherId);
    expect(proposal.amountMatched).toBe(9200);
    expect(proposal.matchType).toBe('exact');
  });

  it('paying a foreign payable with cheaper cash clears it and books the gain', async () => {
    await useEstoniaPlugin();
    const supplierId = await seedSupplier();
    // 10 000 USD payable booked at 0.92 → 9 200.
    const { voucherId } = await postExpenseInCurrency(supplierId, 10000, 'USD');

    // We pay the 10 000 USD but it only costs 9 000 EUR.
    const { transactionId } = await foreignBankLine({
      amount: -9000,
      sourceCurrency: 'USD',
      sourceAmount: -10000,
      fxRate: 0.9,
    });

    const matchId = await settleLine(transactionId, voucherId, 9200);

    expect(await voucherLegs((await settlementVoucherOf(matchId))!)).toEqual([
      { code: 'AP', isDebit: 1, base: 9200 },
      { code: 'BANK_EUR', isDebit: 0, base: 9000 },
      { code: 'FX_GAIN_LOSS', isDebit: 0, base: 200 },
    ]);
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(0);
    expect(await controlBalance('AP')).toBe(0);
    expect(await bankBalance('BANK_EUR')).toBe(-9000);
    expect(await bankBalance('FX_GAIN_LOSS')).toBe(-200);
  });

  it('a line whose cash is spent settles nothing further, however much booked headroom is left', async () => {
    await useEstoniaPlugin();
    const customerId = await seedCustomer();
    const big = await postInvoiceInCurrency(customerId, 6000, 'USD'); // 5 520
    const small = await postInvoiceInCurrency(customerId, 4000, 'USD'); // 3 680
    const third = await postInvoiceInCurrency(customerId, 400, 'USD'); // 368

    // One line of 10 000 USD converted at 0.95 → 9 500 of cash.
    const { statementId, transactionId } = await foreignBankLine({
      amount: 9500,
      sourceCurrency: 'USD',
      sourceAmount: 10000,
      fxRate: 0.95,
    });

    // A draft staged against the third invoice BEFORE the cash is spent —
    // the stale-draft path, which never re-consults the candidate list.
    const { records } = await reconciliation.executeMatch([
      {
        bankTransactionId: transactionId,
        voucherId: third.voucherId,
        matchType: 'partial',
        amountMatched: 300,
        confidence: 'high',
        signal: 'manual',
      },
    ]);

    // The two real settlements consume 5 700 + 3 800 = the line's whole 9 500.
    await settleLine(transactionId, big.voucherId, 5520);
    await settleLine(transactionId, small.voucherId, 3680);
    expect(await bankBalance('BANK_EUR')).toBe(9500);

    // The booked sum so far is only 9 200, so the old booked-vs-cash cap saw
    // 300 of headroom and would have posted cash the line never carried.
    await expect(reconciliation.activateMatch(records[0].id)).rejects.toThrow(
      /over-allocate bank line/,
    );
    // A fresh direct match against another open invoice is refused on the
    // same ground — the guard is at the write boundary, not in discovery.
    const fourth = await postInvoiceInCurrency(customerId, 400, 'USD');
    const direct = await reconciliation.executeMatch([
      {
        bankTransactionId: transactionId,
        voucherId: fourth.voucherId,
        matchType: 'partial',
        amountMatched: 300,
        confidence: 'high',
        signal: 'manual',
      },
    ]);
    await expect(
      reconciliation.activateMatch(direct.records[0].id),
    ).rejects.toThrow(/over-allocate bank line/);
    // … and the candidate read stops offering the line at all.
    const offered = await reconciliation.getMatchCandidates(
      statementId,
      transactionId,
    );
    expect(offered.lineRemaining).toBe(0);
    expect(offered.candidates).toEqual([]);

    // The bank holds exactly the cash that arrived — no duplication.
    expect(await bankBalance('BANK_EUR')).toBe(9500);
    expect(await outstanding.getRemainingVoucherBalance(third.voucherId)).toBe(
      368,
    );
  });

  it('unmatching gives the line its cash back, and only that much', async () => {
    await useEstoniaPlugin();
    const customerId = await seedCustomer();
    const big = await postInvoiceInCurrency(customerId, 6000, 'USD'); // 5 520
    const small = await postInvoiceInCurrency(customerId, 4000, 'USD'); // 3 680
    const other = await postInvoiceInCurrency(customerId, 4000, 'USD'); // 3 680

    const { transactionId } = await foreignBankLine({
      amount: 9500,
      sourceCurrency: 'USD',
      sourceAmount: 10000,
      fxRate: 0.95,
    });
    await settleLine(transactionId, big.voucherId, 5520);
    const smallMatch = await settleLine(transactionId, small.voucherId, 3680);
    expect(await bankBalance('BANK_EUR')).toBe(9500);

    await reconciliation.unmatch(smallMatch);
    expect(await bankBalance('BANK_EUR')).toBe(5700);

    // Exactly the released 3 800 of cash is available again — enough for one
    // more 3 680 invoice, and nothing beyond it.
    await settleLine(transactionId, other.voucherId, 3680);
    expect(await bankBalance('BANK_EUR')).toBe(9500);
    expect(await outstanding.getRemainingVoucherBalance(small.voucherId)).toBe(
      3680,
    );

    const leftover = await postInvoiceInCurrency(customerId, 100, 'USD');
    const staged = await reconciliation.executeMatch([
      {
        bankTransactionId: transactionId,
        voucherId: leftover.voucherId,
        matchType: 'partial',
        amountMatched: 92,
        confidence: 'high',
        signal: 'manual',
      },
    ]);
    await expect(
      reconciliation.activateMatch(staged.records[0].id),
    ).rejects.toThrow(/over-allocate bank line/);
    expect(await bankBalance('BANK_EUR')).toBe(9500);
  });

  it('splitting a line three ways never banks more cash than it carried', async () => {
    await useEstoniaPlugin();
    const customerId = await seedCustomer();
    // Three USD invoices whose slices do not divide the line's cash evenly.
    const a = await postInvoiceInCurrency(customerId, 3333, 'USD');
    const b = await postInvoiceInCurrency(customerId, 3333, 'USD');
    const c = await postInvoiceInCurrency(customerId, 3334, 'USD');

    const { statementId, transactionId } = await foreignBankLine({
      amount: 9333,
      sourceCurrency: 'USD',
      sourceAmount: 10000,
      fxRate: 0.9333,
    });
    const lineCash = 9333;

    for (const invoice of [a, b, c]) {
      const remaining = await outstanding.getRemainingVoucherBalance(
        invoice.voucherId,
      );
      await settleLine(transactionId, invoice.voucherId, remaining);
      expect(
        await outstanding.getRemainingVoucherBalance(invoice.voucherId),
      ).toBe(0);
    }

    // Every invoice is settled, and the bank holds 9 331 of the 9 333 that
    // arrived: the three rounded slices leave 2 cents of the line unclaimed.
    // Those cents stay ON the line as unallocated cash — the split never
    // banks more than the line carried, and the shortfall is not invented
    // away either.
    const banked = await bankBalance('BANK_EUR');
    expect(banked).toBe(9331);
    expect(banked).toBeLessThanOrEqual(lineCash);
    expect(await controlBalance('AR')).toBe(0);

    const { lineRemaining } = await reconciliation.getMatchCandidates(
      statementId,
      transactionId,
    );
    expect(lineRemaining).toBe(lineCash - banked);
  });

  it('an oversized match is refused, not clipped to the cash the line has', async () => {
    await useEstoniaPlugin();
    const customerId = await seedCustomer();
    // 20 000 USD invoiced, booked at 0.92 → 18 400 receivable.
    const { voucherId } = await postInvoiceInCurrency(customerId, 20000, 'USD');
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(18400);

    // The customer pays HALF: 10 000 USD, converted at 0.95 → 9 500 of cash.
    const { statementId, transactionId } = await foreignBankLine({
      amount: 9500,
      sourceCurrency: 'USD',
      sourceAmount: 10000,
      fxRate: 0.95,
    });

    // A direct write (no candidate list consulted) asks to settle the WHOLE
    // 18 400 from this half payment. The slice would clip itself to the
    // 9 500 the line carries, so a guard reading the clipped figure sees
    // nothing wrong — and the invoice would clear with 8 900 written off as
    // realized FX that never happened. The guard reads the UNCLIPPED demand
    // (20 000 USD × 0.95 = 19 000) and refuses.
    const staged = await reconciliation.executeMatch([
      {
        bankTransactionId: transactionId,
        voucherId,
        matchType: 'exact',
        amountMatched: 18400,
        confidence: 'high',
        signal: 'manual',
      },
    ]);
    await expect(
      reconciliation.activateMatch(staged.records[0].id),
    ).rejects.toThrow(/needs 19000 of cash but only 9500/);

    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(18400);
    expect(await bankBalance('BANK_EUR')).toBe(0);
    expect(await bankBalance('FX_GAIN_LOSS')).toBe(0);
    expect(await controlBalance('AR')).toBe(18400);

    // What the line CAN settle still goes through, once the refused draft is
    // discarded: 10 000 USD of the invoice is 9 200 of booked receivable,
    // paid with 9 500 of cash — a 300 gain.
    await reconciliation.discardDraftMatch(staged.records[0].id);
    const matchId = await settleLine(transactionId, voucherId, 9200);
    expect(await voucherLegs((await settlementVoucherOf(matchId))!)).toEqual([
      { code: 'AR', isDebit: 0, base: 9200 },
      { code: 'BANK_EUR', isDebit: 1, base: 9500 },
      { code: 'FX_GAIN_LOSS', isDebit: 0, base: 300 },
    ]);
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(9200);
    const { lineRemaining } = await reconciliation.getMatchCandidates(
      statementId,
      transactionId,
    );
    expect(lineRemaining).toBe(0);
  });

  it('the rounding tolerance never squeezes an extra match onto a spent line', async () => {
    await useEstoniaPlugin();
    const customerId = await seedCustomer();
    const paid = await postInvoiceInCurrency(customerId, 10000, 'USD'); // 9 200
    const leftover = await postInvoiceInCurrency(customerId, 100, 'USD'); // 92

    const { transactionId } = await foreignBankLine({
      amount: 9200,
      sourceCurrency: 'USD',
      sourceAmount: 10000,
      fxRate: 0.92,
    });
    await settleLine(transactionId, paid.voucherId, 9200);
    expect(await bankBalance('BANK_EUR')).toBe(9200);

    // Nothing is left on the line, so even a one-cent match is refused —
    // the tolerance that absorbs a split's rounding must not become headroom.
    for (const amount of [1, 92]) {
      const staged = await reconciliation.executeMatch([
        {
          bankTransactionId: transactionId,
          voucherId: leftover.voucherId,
          matchType: 'partial',
          amountMatched: amount,
          confidence: 'high',
          signal: 'manual',
        },
      ]);
      await expect(
        reconciliation.activateMatch(staged.records[0].id),
      ).rejects.toThrow(/over-allocate bank line/);
      await reconciliation.discardDraftMatch(staged.records[0].id);
    }
    expect(await bankBalance('BANK_EUR')).toBe(9200);
    expect(
      await outstanding.getRemainingVoucherBalance(leftover.voucherId),
    ).toBe(92);
  });

  // ── FX provenance on the settlement's own legs (issue #203) ──────────

  /**
   * A settlement's cash leg must record HOW its base value was actually
   * reached. The two ways are genuinely different, and labelling both as "the
   * bank's rate on the transaction date" was false for one of them and threw
   * away the publication date for the other.
   */
  describe('settlement leg provenance', () => {
    const legsOf = async (matchId: number) =>
      db
        .selectFrom('voucher_line')
        .innerJoin('account', 'account.id', 'voucher_line.account_id')
        .select([
          'account.code as code',
          'voucher_line.fx_rate as fx_rate',
          'voucher_line.fx_rate_date as fx_rate_date',
          'voucher_line.fx_rate_source as fx_rate_source',
        ])
        .where(
          'voucher_line.voucher_id',
          '=',
          (await settlementVoucherOf(matchId))!,
        )
        .orderBy('account.code')
        .execute();

    /** A USD statement line dated `date`, settling `voucherId` for `booked`. */
    const settleUsdStatement = async (
      voucherId: number,
      date: string,
      booked: number,
    ) => {
      const stmt = await banks.createStatement({
        account_code: 'BANK_USD',
        start_date: '2026-05-01',
        end_date: '2026-05-31',
        transactions: [
          {
            transaction_date: date,
            description: 'USD receipt',
            amount: 10000,
            currency: 'USD',
            status: 'open',
          },
        ],
      });
      return settleLine(stmt.transactions[0].id, voucherId, booked);
    };

    it('a SATURDAY settlement on a USD account records the Friday publication that valued it', async () => {
      await useEstoniaPlugin();
      const customerId = await seedCustomer();
      const { voucherId } = await postInvoiceInCurrency(
        customerId,
        10000,
        'USD',
      );

      // 2026-05-16 is a Saturday. The ECB published nothing; the rate in force
      // is Friday 2026-05-15's, and the cash on a USD account has no base
      // figure of its own, so that reference rate is what valued it.
      const matchId = await settleUsdStatement(voucherId, '2026-05-16', 9200);

      expect(await legsOf(matchId)).toEqual([
        {
          code: 'AR',
          fx_rate: 1,
          fx_rate_date: '2026-05-16',
          fx_rate_source: 'identity',
        },
        {
          code: 'BANK_USD',
          fx_rate: 0.92,
          // Not the transaction date, and not the bank's rate: the ECB
          // publication actually applied.
          fx_rate_date: '2026-05-15',
          fx_rate_source: 'ECB',
        },
      ]);
    });

    it('the stored provenance survives the source changing afterwards', async () => {
      await useEstoniaPlugin();
      const customerId = await seedCustomer();
      const { voucherId } = await postInvoiceInCurrency(
        customerId,
        10000,
        'USD',
      );
      const matchId = await settleUsdStatement(voucherId, '2026-05-16', 9200);
      const before = await legsOf(matchId);

      // Upstream revises the very publication this settlement was booked
      // against. The cache is append-only and the posted line is immutable, so
      // history stays reproducible — the settlement still explains itself by
      // the 2026-05-15 observation it actually used.
      const cached = await db
        .selectFrom('fx_reference_rate')
        .selectAll()
        .execute();
      await expectDbRefusal(
        () =>
          db
            .updateTable('fx_reference_rate')
            .set({ rate: 9.9 })
            .where('rate_date', '=', '2026-05-15')
            .execute(),
        /immutable/,
      );
      expect(
        await db.selectFrom('fx_reference_rate').selectAll().execute(),
      ).toEqual(cached);

      expect(await legsOf(matchId)).toEqual(before);
    });

    it('a base-currency statement keeps the BANK as the source of its valuation', async () => {
      await useEstoniaPlugin();
      const supplierId = await seedSupplier();
      const { voucherId } = await postExpenseInCurrency(
        supplierId,
        1000,
        'USD',
      );

      // A EUR statement line that carries the USD payment's own conversion:
      // the base figure is on the statement, so the bank valued it, not a
      // reference rate. That distinction is ADR-0004's Wave-5 rule and must
      // survive.
      const stmt = await banks.createStatement({
        account_code: 'BANK_EUR',
        start_date: '2026-05-01',
        end_date: '2026-05-31',
        transactions: [
          {
            transaction_date: '2026-05-16',
            description: 'Paid 1000 USD',
            amount: -950,
            currency: 'EUR',
            source_currency: 'USD',
            source_amount: 1000,
            fx_rate: 0.95,
            status: 'open',
          },
        ],
      });
      const matchId = await settleLine(stmt.transactions[0].id, voucherId, 920);

      const bank = (await legsOf(matchId)).find((l) => l.code === 'BANK_EUR');
      expect(bank).toMatchObject({
        fx_rate_source: 'bank_statement',
        fx_rate_date: '2026-05-16',
      });
    });

    it('a reversal mirrors the provenance of the leg it reverses', async () => {
      await useEstoniaPlugin();
      const customerId = await seedCustomer();
      const { voucherId } = await postInvoiceInCurrency(
        customerId,
        10000,
        'USD',
      );
      const matchId = await settleUsdStatement(voucherId, '2026-05-16', 9200);
      const settlementId = (await settlementVoucherOf(matchId))!;

      await reconciliation.unmatch(matchId);

      const reversal = await db
        .selectFrom('voucher_line')
        .innerJoin('voucher', 'voucher.id', 'voucher_line.voucher_id')
        .innerJoin('account', 'account.id', 'voucher_line.account_id')
        .select([
          'account.code as code',
          'voucher_line.fx_rate_date as fx_rate_date',
          'voucher_line.fx_rate_source as fx_rate_source',
        ])
        .where('voucher.reverses_id', '=', settlementId)
        .execute();

      const bank = reversal.find((l) => l.code === 'BANK_USD');
      // The reversal must be explicable by the SAME rate evidence as the
      // original, not re-resolved against whatever the source says now.
      expect(bank).toMatchObject({
        fx_rate_date: '2026-05-15',
        fx_rate_source: 'ECB',
      });
    });
  });
});
