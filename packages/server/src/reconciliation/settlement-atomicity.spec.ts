import { fxTestProviders } from '../../test/fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect, sql } from 'kysely';
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
import { ReconciliationService } from './reconciliation.service';
import { OutstandingVoucherService } from './outstanding-voucher.service';
import { PrepaymentAllocationRepository } from './prepayment-allocation.repository';
import { PrepaymentService } from './prepayment.service';
import { FXRealizedService } from './fx-realized.service';
import { SettlementVoucherService } from './settlement-voucher.service';

/**
 * Issue #202 — the settlement a match posts and the reversals an unmatch owes
 * must be ATOMIC with the link itself. Before this, activation flipped the
 * status and then posted FX in a second commit, and unmatch committed the FX
 * reversal, the settlement reversal and the deletion separately: a failure in
 * between left the ledger changed with the match still active, and a retry
 * reversed the same voucher twice.
 *
 * The faults here are injected at the SQLite level — real triggers that ABORT
 * a specific write — so what is proven is the database's own rollback, not a
 * mocked one: after a failure NOTHING was written, and the retry writes each
 * artifact exactly once.
 */
describe('settlement atomicity and legacy repair (#202)', () => {
  let db: Kysely<Database>;
  let reconciliation: ReconciliationService;
  let outstanding: OutstandingVoucherService;
  let salesInvoices: SalesInvoicesService;
  let posting: PostingService;
  let entities: EntitiesService;
  let banks: BankStatementService;
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
        ...fxTestProviders(),
        PluginLoader,
        CurrencyService,
        FXRealizedService,
        LedgerBalanceService,
        OutstandingVoucherService,
        PrepaymentAllocationRepository,
        PrepaymentService,
        OrgContextResolver,
        ReconciliationService,
        SettlementVoucherService,
        VoucherRepository,
        VoucherLineRepository,
        VoucherProjectionService,
        SalesInvoicesService,
      ],
    }).compile();

    reconciliation = module.get(ReconciliationService);
    outstanding = module.get(OutstandingVoucherService);
    salesInvoices = module.get(SalesInvoicesService);
    posting = module.get(PostingService);
    entities = module.get(EntitiesService);
    banks = module.get(BankStatementService);
    ledgerBalance = module.get(LedgerBalanceService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ── Helpers ───────────────────────────────────────────────────────────

  let counter = 0;

  async function seedCustomer(): Promise<number> {
    counter++;
    const c = await entities.onboard({
      role: 'customer',
      country: 'IE',
      name: `Cust ${counter}`,
      registrationKey: `IE${3000000 + counter}T`,
      // A goods customer: these suites are about settlement and FX, not about
      // the place of supply of services (issue #209 — a SERVICE sale to a
      // foreign customer needs a recorded tax status, and its stated tax must
      // match the derived rate; both are exercised in their own suites).
      goodsVsServices: 'goods',
    });
    return c.id;
  }

  async function postInvoice(
    customerId: number,
    gross: number,
    taxPointDate = '2026-05-15',
  ): Promise<number> {
    counter++;
    const invoice = await salesInvoices.createInvoice({
      customer_id: customerId,
      invoice_number: `INV-A-${counter}`,
      gross_amount: gross,
      vat_amount: 0,
      currency: 'EUR',
      tax_point_date: taxPointDate,
      due_date: null,
    });
    const draft = await salesInvoices.generateDraftVoucher(invoice.id);
    const posted = await posting.postVoucher(draft);
    await salesInvoices.updateInvoiceStatus(invoice.id, 'posted', posted.id);
    return posted.id;
  }

  async function bankLine(
    amount: number,
    transactionDate = '2026-05-18',
  ): Promise<number> {
    const stmt = await banks.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2026-05-01',
      end_date: '2026-05-31',
      transactions: [
        {
          transaction_date: transactionDate,
          description: 'payment',
          amount,
          currency: 'EUR',
          status: 'open',
        },
      ],
    });
    return stmt.transactions[0].id;
  }

  async function stageMatch(
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
    return records[0].id;
  }

  async function voucherCount(): Promise<number> {
    const row = await db
      .selectFrom('voucher')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** How many POSTED counter-vouchers reverse this voucher. */
  async function reversalCount(voucherId: number): Promise<number> {
    const row = await db
      .selectFrom('voucher')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('reverses_id', '=', voucherId)
      .where('posted_at', 'is not', null)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async function matchRow(matchId: number) {
    return db
      .selectFrom('reconciliation_match')
      .select(['status', 'settlement_voucher_id', 'fx_voucher_id'])
      .where('id', '=', matchId)
      .executeTakeFirst();
  }

  /** Inject a SQLite trigger that ABORTs a specific write. */
  async function injectFault(name: string, body: string): Promise<void> {
    await sql.raw(body).execute(db);
    faults.push(name);
  }

  const faults: string[] = [];
  async function clearFaults(): Promise<void> {
    for (const name of faults.splice(0)) {
      await sql.raw(`DROP TRIGGER IF EXISTS ${name}`).execute(db);
    }
  }

  // ── Activation ────────────────────────────────────────────────────────

  it('a failure while activating leaves no settlement behind, and the retry posts exactly one', async () => {
    const customerId = await seedCustomer();
    const voucherId = await postInvoice(customerId, 10000);
    const txnId = await bankLine(10000);
    const matchId = await stageMatch(txnId, voucherId, 10000);

    const before = await voucherCount();
    await injectFault(
      'fail_match_flip',
      `CREATE TRIGGER fail_match_flip BEFORE UPDATE ON reconciliation_match
       BEGIN SELECT RAISE(ABORT, 'injected activation failure'); END`,
    );

    await expect(reconciliation.activateMatch(matchId)).rejects.toThrow();

    // The settlement was posted inside the same transaction as the flip, so
    // the abort took it with it: no voucher, no ledger movement, still draft.
    expect(await voucherCount()).toBe(before);
    expect(await ledgerBalance.getLedgerNet({ codes: ['BANK_EUR'] })).toBe(0);
    expect(await matchRow(matchId)).toMatchObject({
      status: 'draft',
      settlement_voucher_id: null,
    });
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(10000);

    await clearFaults();
    const { settlementVoucherId } = await reconciliation.activateMatch(matchId);

    expect(settlementVoucherId).not.toBeNull();
    expect(await voucherCount()).toBe(before + 1);
    expect(await ledgerBalance.getLedgerNet({ codes: ['BANK_EUR'] })).toBe(
      10000,
    );
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(0);
  });

  it('activating twice settles once', async () => {
    const customerId = await seedCustomer();
    const voucherId = await postInvoice(customerId, 10000);
    const txnId = await bankLine(10000);
    const matchId = await stageMatch(txnId, voucherId, 10000);

    const first = await reconciliation.activateMatch(matchId);
    const before = await voucherCount();
    const second = await reconciliation.activateMatch(matchId);

    expect(second.settlementVoucherId).toBe(first.settlementVoucherId);
    expect(await voucherCount()).toBe(before);
    expect(await ledgerBalance.getLedgerNet({ codes: ['BANK_EUR'] })).toBe(
      10000,
    );
  });

  // ── Unmatch ───────────────────────────────────────────────────────────

  it('a failure while deleting the link rolls the reversal back, and the retry reverses once', async () => {
    const customerId = await seedCustomer();
    const voucherId = await postInvoice(customerId, 10000);
    const txnId = await bankLine(10000);
    const matchId = await stageMatch(txnId, voucherId, 10000);
    const { settlementVoucherId } = await reconciliation.activateMatch(matchId);

    const before = await voucherCount();
    await injectFault(
      'fail_match_delete',
      `CREATE TRIGGER fail_match_delete BEFORE DELETE ON reconciliation_match
       BEGIN SELECT RAISE(ABORT, 'injected unmatch failure'); END`,
    );

    await expect(reconciliation.unmatch(matchId)).rejects.toThrow();

    // Nothing reversed, link untouched: the ledger and the sub-ledger are
    // still the consistent pair the successful activation left.
    expect(await voucherCount()).toBe(before);
    expect(await reversalCount(settlementVoucherId!)).toBe(0);
    expect(await matchRow(matchId)).toMatchObject({ status: 'active' });
    expect(await ledgerBalance.getLedgerNet({ codes: ['BANK_EUR'] })).toBe(
      10000,
    );

    await clearFaults();
    await reconciliation.unmatch(matchId);

    expect(await reversalCount(settlementVoucherId!)).toBe(1);
    expect(await voucherCount()).toBe(before + 1);
    expect(await matchRow(matchId)).toBeUndefined();
    expect(await ledgerBalance.getLedgerNet({ codes: ['BANK_EUR'] })).toBe(0);
    expect(await outstanding.getRemainingVoucherBalance(voucherId)).toBe(10000);
  });

  it('a failure on the SECOND reversal rolls the first one back too', async () => {
    const customerId = await seedCustomer();
    const voucherId = await postInvoice(customerId, 10000);
    const txnId = await bankLine(10000);
    const matchId = await stageMatch(txnId, voucherId, 10000);
    const { settlementVoucherId } = await reconciliation.activateMatch(matchId);

    // A link carrying BOTH ledger artifacts — the shape a pre-#202 match that
    // posted its own FX voucher has once its settlement is re-booked. Unmatch
    // must reverse both, or neither.
    const fxVoucher = await posting.postVoucher({
      tax_point_date: '2026-05-18',
      lines: [
        {
          account_code: 'BANK_EUR',
          amount: 250,
          currency: 'EUR',
          base_amount: 250,
          fx_rate: 1,
          is_debit: true,
        },
        {
          account_code: 'FX_GAIN_LOSS',
          amount: 250,
          currency: 'EUR',
          base_amount: 250,
          fx_rate: 1,
          is_debit: false,
        },
      ],
      reason: 'legacy realized FX',
    });
    await db
      .updateTable('reconciliation_match')
      .set({ fx_voucher_id: fxVoucher.id })
      .where('id', '=', matchId)
      .execute();

    const before = await voucherCount();
    // The FX reversal is posted first and the settlement reversal second; the
    // fault hits the second one.
    await injectFault(
      'fail_second_reversal',
      `CREATE TRIGGER fail_second_reversal BEFORE INSERT ON voucher
       WHEN NEW.reason LIKE 'Reversal of settlement voucher%'
       BEGIN SELECT RAISE(ABORT, 'injected second-post failure'); END`,
    );

    await expect(reconciliation.unmatch(matchId)).rejects.toThrow();

    expect(await voucherCount()).toBe(before);
    expect(await reversalCount(fxVoucher.id)).toBe(0);
    expect(await reversalCount(settlementVoucherId!)).toBe(0);
    expect(await matchRow(matchId)).toMatchObject({ status: 'active' });

    await clearFaults();
    const result = await reconciliation.unmatch(matchId);

    expect(result.fxReversalVoucherId).not.toBeNull();
    expect(result.settlementReversalVoucherId).not.toBeNull();
    expect(await reversalCount(fxVoucher.id)).toBe(1);
    expect(await reversalCount(settlementVoucherId!)).toBe(1);
    expect(await voucherCount()).toBe(before + 2);
  });

  it('unmatching twice, or concurrently, reverses exactly once', async () => {
    const customerId = await seedCustomer();
    const voucherId = await postInvoice(customerId, 10000);
    const txnId = await bankLine(10000);
    const matchId = await stageMatch(txnId, voucherId, 10000);
    const { settlementVoucherId } = await reconciliation.activateMatch(matchId);

    const [first, second] = await Promise.allSettled([
      reconciliation.unmatch(matchId),
      reconciliation.unmatch(matchId),
    ]);
    const fulfilled = [first, second].filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(await reversalCount(settlementVoucherId!)).toBe(1);

    // And a later, sequential retry finds nothing left to undo.
    await expect(reconciliation.unmatch(matchId)).rejects.toThrow(/not found/i);
    expect(await reversalCount(settlementVoucherId!)).toBe(1);
  });

  it('a settlement already reversed elsewhere is not reversed again', async () => {
    const customerId = await seedCustomer();
    const voucherId = await postInvoice(customerId, 10000);
    const txnId = await bankLine(10000);
    const matchId = await stageMatch(txnId, voucherId, 10000);
    const { settlementVoucherId } = await reconciliation.activateMatch(matchId);

    // Someone reversed the settlement voucher through another path.
    const lines = await db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select([
        'account.code as code',
        'voucher_line.amount as amount',
        'voucher_line.base_amount as base_amount',
        'voucher_line.is_debit as is_debit',
      ])
      .where('voucher_line.voucher_id', '=', settlementVoucherId!)
      .execute();
    await posting.postVoucher({
      tax_point_date: '2026-05-18',
      lines: lines.map((l) => ({
        account_code: l.code,
        amount: l.amount,
        currency: 'EUR',
        base_amount: l.base_amount,
        fx_rate: 1,
        is_debit: l.is_debit === 0,
      })),
      reverses_id: settlementVoucherId!,
      reason: 'out-of-band reversal',
    });

    const result = await reconciliation.unmatch(matchId);

    expect(result.settlementReversalVoucherId).toBeNull();
    expect(await reversalCount(settlementVoucherId!)).toBe(1);
    expect(await ledgerBalance.getLedgerNet({ codes: ['BANK_EUR'] })).toBe(0);
  });

  // ── The documented legacy repair, end to end ──────────────────────────

  it('repairs a pre-#202 match through unmatch + re-approve, preserving history and the lock', async () => {
    const customerId = await seedCustomer();
    const voucherId = await postInvoice(customerId, 10000, '2026-05-15');
    const txnId = await bankLine(10000, '2026-05-18');

    // A match as it looked before migration 070: active, settling the
    // invoice, with its own realized-FX voucher and NO settlement voucher.
    const fxVoucher = await posting.postVoucher({
      tax_point_date: '2026-05-18',
      lines: [
        {
          account_code: 'BANK_EUR',
          amount: 300,
          currency: 'EUR',
          base_amount: 300,
          fx_rate: 1,
          is_debit: true,
        },
        {
          account_code: 'FX_GAIN_LOSS',
          amount: 300,
          currency: 'EUR',
          base_amount: 300,
          fx_rate: 1,
          is_debit: false,
        },
      ],
      reason: 'legacy realized FX',
    });
    const now = Math.floor(Date.now() / 1000);
    const legacy = await db
      .insertInto('reconciliation_match')
      .values({
        bank_transaction_id: txnId,
        voucher_id: voucherId,
        match_type: 'exact',
        amount_matched: 10000,
        status: 'active',
        fx_voucher_id: fxVoucher.id,
        created_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // The period the original vouchers sit in is now LOCKED; a later one is open.
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

    expect(await reconciliation.listUnpostedSettlements()).toEqual([
      {
        matchId: legacy.id,
        bankTransactionId: txnId,
        voucherId,
        amountMatched: 10000,
      },
    ]);
    // The open item reads as settled while the control account still carries
    // it — the difference the repair exists to remove.
    const before = await reconciliation.getOpenItemReconciliation();
    expect(before.totals.controlAr).toBe(10000);
    expect(before.totals.openItems).toBe(0);
    expect(before.totals.unpostedSettlements).toBe(10000);
    expect(before.totals.unexplained).toBe(0);

    const originalLines = await db
      .selectFrom('voucher_line')
      .selectAll()
      .where('voucher_id', 'in', [voucherId, fxVoucher.id])
      .orderBy('id')
      .execute();

    // ── Step 1: unmatch. The FX voucher is reversed, not edited, and the
    // reversal is redirected out of the locked period (ADR-0009).
    const undone = await reconciliation.unmatch(legacy.id);
    expect(undone.settlementReversalVoucherId).toBeNull();
    const fxReversal = await db
      .selectFrom('voucher')
      .select(['tax_point_date', 'reverses_id'])
      .where('id', '=', undone.fxReversalVoucherId!)
      .executeTakeFirstOrThrow();
    expect(fxReversal.reverses_id).toBe(fxVoucher.id);
    expect(fxReversal.tax_point_date).toBe('2026-06-01');

    // ── Step 2: re-match and approve. The settlement posts, redirected into
    // the open period the same way.
    const reMatched = await stageMatch(txnId, voucherId, 10000);
    const { settlementVoucherId } =
      await reconciliation.activateMatch(reMatched);
    const settlement = await db
      .selectFrom('voucher')
      .select('tax_point_date')
      .where('id', '=', settlementVoucherId!)
      .executeTakeFirstOrThrow();
    expect(settlement.tax_point_date).toBe('2026-06-01');

    // ── The result: nothing unposted, the subledger ties to the control
    // account, and no posted history was rewritten.
    expect(await reconciliation.listUnpostedSettlements()).toEqual([]);
    const after = await reconciliation.getOpenItemReconciliation();
    expect(after.totals.openItems).toBe(0);
    expect(after.totals.controlAr).toBe(0);
    expect(after.totals.unexplained).toBe(0);

    const linesAfter = await db
      .selectFrom('voucher_line')
      .selectAll()
      .where('voucher_id', 'in', [voucherId, fxVoucher.id])
      .orderBy('id')
      .execute();
    expect(linesAfter).toEqual(originalLines);
  });
});
