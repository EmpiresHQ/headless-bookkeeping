import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { fxTestProviders } from '../../test/fx-fixtures';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AccountService } from '../ledger/account/account.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PostingService } from '../ledger/posting/posting.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { BankTransactionRepository } from '../bank/bank-transaction.repository';
import { BankStatementService } from '../bank/bank-statement.service';
import { BankTransactionStatus } from '../bank/bank-statement.types';
import { AuditLogService } from '../audit-log/audit-log.service';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CurrencyService } from '../currency/currency.service';
import { EntitiesService } from '../entities/entities.service';
import { PersonalDispositionService } from '../reconciliation/personal-disposition.service';
import { BankFeeDispositionService } from '../reconciliation/bank-fee-disposition.service';
import { PrepaymentService } from '../reconciliation/prepayment.service';
import { PrepaymentAllocationRepository } from '../reconciliation/prepayment-allocation.repository';
import { OutstandingVoucherService } from '../reconciliation/outstanding-voucher.service';
import { DividendsService } from '../dividends/dividends.service';
import {
  BankDuplicateRepairService,
  DuplicatePreviewGroup,
} from './bank-duplicate-repair.service';

type Disposition = Exclude<BankTransactionStatus, 'open'>;
const dispositions: Disposition[] = [
  'personal',
  'bank_fee',
  'prepayment',
  'dividend',
];

// Real posting and full migrations: a disposition may have immutable bank
// legs without any reconciliation_match (personal is the reported regression).
describe('Bank duplicate repair and disposition history (issue #399)', () => {
  let db: Kysely<Database>;
  let bank: BankStatementService;
  let repair: BankDuplicateRepairService;
  let repo: BankTransactionRepository;
  let personal: PersonalDispositionService;
  let fee: BankFeeDispositionService;
  let prepayment: PrepaymentService;
  let dividends: DividendsService;

  beforeEach(async () => {
    const native = new SqliteDb(':memory:');
    native.pragma('foreign_keys=ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: native }),
    });
    const { error } = await new Migrator({
      db,
      provider: {
        getMigrations: () => Promise.resolve(migrations),
      },
    }).migrateToLatest();
    if (error) throw error;
    const module = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        AccountService,
        LedgerBalanceService,
        LedgerValidationService,
        PostingService,
        PeriodLockService,
        BankTransactionRepository,
        BankStatementService,
        AuditLogService,
        OrganizationService,
        OrgContextResolver,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        ...fxTestProviders(),
        PluginLoader,
        CurrencyService,
        EntitiesService,
        PersonalDispositionService,
        BankFeeDispositionService,
        PrepaymentService,
        PrepaymentAllocationRepository,
        OutstandingVoucherService,
        DividendsService,
        BankDuplicateRepairService,
      ],
    }).compile();
    bank = module.get(BankStatementService);
    repair = module.get(BankDuplicateRepairService);
    repo = module.get(BankTransactionRepository);
    personal = module.get(PersonalDispositionService);
    fee = module.get(BankFeeDispositionService);
    prepayment = module.get(PrepaymentService);
    dividends = module.get(DividendsService);
    await module.get(OrganizationService).updateOrganization({ country: 'IE' });
  });
  afterEach(async () => db.destroy());

  async function source(fingerprint: string) {
    const input = {
      account_code: 'BANK_EUR',
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      transactions: [
        {
          transaction_date: '2026-06-19',
          amount: -1405,
          currency: 'EUR',
          description: 'Synthetic disposition overlap',
          conversion_fee: 1405,
        },
      ],
    };
    return bank.createStatement({ ...input, source_fingerprint: fingerprint });
  }

  async function pair() {
    const a = await source('first-source');
    const b = await source('second-source');
    return { a, b, aid: a.transactions[0].id, bid: b.transactions[0].id };
  }

  function expected(
    group: DuplicatePreviewGroup,
    survivorId: number,
    duplicateId: number,
  ) {
    const s = group.rows.find((r) => r.id === survivorId)!;
    const d = group.rows.find((r) => r.id === duplicateId)!;
    return {
      survivorActiveMatchCount: s.activeMatchCount,
      survivorDraftMatchCount: s.draftMatchCount,
      survivorSettlementClaimExpenseId: s.settlementClaimExpenseId,
      survivorStatus: s.status,
      survivorAdvanceFunded: s.advanceFunded,
      duplicateActiveMatchCount: d.activeMatchCount,
      duplicateDraftMatchCount: d.draftMatchCount,
      duplicateSettlementClaimExpenseId: d.settlementClaimExpenseId,
      duplicateAdvanceFunded: d.advanceFunded,
      duplicateStatus: d.status,
    };
  }

  async function post(status: Disposition, id: number) {
    if (status === 'personal') return personal.markAsPersonal(id);
    if (status === 'bank_fee') return fee.markAsBankFee(id);
    if (status === 'prepayment') return prepayment.createSupplierPrepayment(id);
    const declaration = await dividends.declare({
      gross_amount: 1405,
      tax_point_date: '2026-06-19',
    });
    await repo.updateStatus(id, 'dividend');
    return dividends.settle(id, declaration.voucher_id);
  }

  async function financialHistory() {
    return {
      vouchers: await db
        .selectFrom('voucher')
        .selectAll()
        .orderBy('id')
        .execute(),
      lines: await db
        .selectFrom('voucher_line')
        .selectAll()
        .orderBy('id')
        .execute(),
      matches: await db
        .selectFrom('reconciliation_match')
        .selectAll()
        .orderBy('id')
        .execute(),
      advances: await db
        .selectFrom('prepayment_advance')
        .selectAll()
        .orderBy('id')
        .execute(),
    };
  }

  it.each(dispositions)(
    'protects a posted %s duplicate; repair in the safe direction and detach preserve history',
    async (status) => {
      const { a, b, aid, bid } = await pair();
      await post(status, bid);
      const before = await financialHistory();
      expect(before.vouchers.length).toBeGreaterThan(0);
      const group = (await repair.preview())[0];
      expect(group.recommendedSurvivorId).toBe(bid);
      expect(group.expectedOpenAmountImpact).toBe(1405);
      await expect(
        repair.applyRepair({
          survivorId: aid,
          duplicateId: bid,
          expected: expected(group, aid, bid),
        }),
      ).rejects.toThrow(ConflictException);
      expect(await repo.findById(bid)).toMatchObject({ id: bid, status });
      expect(await financialHistory()).toEqual(before);
      expect(
        await db.selectFrom('bank_duplicate_repair').selectAll().execute(),
      ).toHaveLength(0);

      // Keep the disposed movement; only the financially free open copy goes.
      await repair.applyRepair({
        survivorId: bid,
        duplicateId: aid,
        expected: expected(group, bid, aid),
      });
      expect((await repo.findById(aid))?.id).toBe(bid);
      await expect(personal.markAsPersonal(bid)).rejects.toThrow('not open');
      await bank.deleteStatement(a.statement.id);
      const detached = await bank.deleteStatement(b.statement.id);
      expect(detached.retainedTransactionIds).toContain(bid);
      expect(await repo.findById(bid)).toMatchObject({
        id: bid,
        status,
        statement_id: null,
      });
      expect(await financialHistory()).toEqual(before);
    },
  );

  it.each(dispositions)(
    'retains a %s movement when its only source is detached, without repair aliases',
    async (status) => {
      const a = await source('only-source');
      const aid = a.transactions[0].id;
      await post(status, aid);
      const before = await financialHistory();
      const detached = await bank.deleteStatement(a.statement.id);
      expect(detached.retainedTransactionIds).toContain(aid);
      expect(await repo.findById(aid)).toMatchObject({
        id: aid,
        status,
        statement_id: null,
      });
      expect(await financialHistory()).toEqual(before);
    },
  );

  it.each(['survivor', 'duplicate'])(
    'rejects a preview when the %s was personally posted afterwards',
    async (side) => {
      const { aid, bid } = await pair();
      const group = (await repair.preview())[0];
      const state = expected(group, aid, bid);
      await personal.markAsPersonal(side === 'survivor' ? aid : bid);
      const before = await financialHistory();
      await expect(
        repair.applyRepair({
          survivorId: aid,
          duplicateId: bid,
          expected: state,
        }),
      ).rejects.toThrow(/stale preview/);
      expect(await financialHistory()).toEqual(before);
      expect(await repo.findById(aid)).toMatchObject({ id: aid });
      expect(await repo.findById(bid)).toMatchObject({ id: bid });
    },
  );

  it('revalidates the survivor advance funding independently of its status', async () => {
    const { aid, bid } = await pair();
    await post('prepayment', aid);
    const group = (await repair.preview())[0];
    const state = expected(group, aid, bid);
    expect(state.survivorAdvanceFunded).toBe(true);
    const before = await financialHistory();
    await expect(
      repair.applyRepair({
        survivorId: aid,
        duplicateId: bid,
        expected: { ...state, survivorAdvanceFunded: false },
      }),
    ).rejects.toThrow(/stale preview/);
    expect(await financialHistory()).toEqual(before);
  });

  it('requires explicit resolution when the two copies have different posted dispositions', async () => {
    const { aid, bid } = await pair();
    await post('personal', aid);
    await post('bank_fee', bid);
    const before = await financialHistory();
    const group = (await repair.preview())[0];
    expect(group.requiresExplicitResolution).toBe(true);
    expect(group.expectedOpenAmountImpact).toBe(0);
    for (const [survivorId, duplicateId] of [
      [aid, bid],
      [bid, aid],
    ]) {
      await expect(
        repair.applyRepair({
          survivorId,
          duplicateId,
          expected: expected(group, survivorId, duplicateId),
        }),
      ).rejects.toThrow(ConflictException);
    }
    expect(await financialHistory()).toEqual(before);
  });
});
