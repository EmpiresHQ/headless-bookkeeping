import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AccountService } from '../ledger/account/account.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BankStatementService } from '../bank/bank-statement.service';
import { BankTransactionRepository } from '../bank/bank-transaction.repository';
import { BankDuplicateRepairService } from './bank-duplicate-repair.service';
import type { DuplicatePreviewRow } from './bank-duplicate-repair.service';

/**
 * Issue #399: the audited, previewable repair of ALREADY-IMPORTED duplicates.
 *
 * The fixture is a SYNTHETIC reproduction of the issue's observed state —
 * eight overlapping outgoing pairs totalling EUR 1726.59 imported TWICE by
 * the PRE-canonical-journal importer (no bank-provided ids survived that
 * import path), statement8 rows 121–128, statement9 duplicate copies
 * 129–136, an active match each on 126/127, a third active match on a unique
 * statement9 row 138, and the genuine same-day/same-amount payment 137 with
 * a DISTINCT bank id. No production data was inspected, imported or repaired;
 * this is labelled synthetic fixture data reproducing the issue's amounts
 * and relationships.
 */
describe('BankDuplicateRepairService (integration, issue #399)', () => {
  let db: Kysely<Database>;
  let service: BankDuplicateRepairService;
  let bank: BankStatementService;
  let repo: BankTransactionRepository;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        AccountService,
        AuditLogService,
        BankTransactionRepository,
        BankStatementService,
        BankDuplicateRepairService,
      ],
    }).compile();
    service = module.get(BankDuplicateRepairService);
    bank = module.get(BankStatementService);
    repo = module.get(BankTransactionRepository);
  });

  afterEach(async () => db.destroy());

  function now(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** A synthetic posted voucher — the repair must never add or remove one. */
  async function insertVoucher(n: number): Promise<number> {
    return (
      await db
        .insertInto('voucher')
        .values({
          voucher_number: `V-SYN-2026-${String(n).padStart(6, '0')}`,
          tax_point_date: '2026-06-08',
          posted_at: now(),
          previous_hash: null,
          reverses_id: null,
          corrects_object_type: null,
          corrects_object_id: null,
          reason: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  }

  /** A synthetic ACTIVE match — the "match 17/18/23" of the issue. */
  async function insertActiveMatch(
    n: number,
    txnId: number,
    amount: number,
  ): Promise<number> {
    const voucherId = await insertVoucher(n);
    return (
      await db
        .insertInto('reconciliation_match')
        .values({
          bank_transaction_id: txnId,
          voucher_id: voucherId,
          match_type: 'exact',
          amount_matched: amount,
          status: 'active',
          signal: 'manual',
          created_at: now(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  }

  const pairAmounts = [
    -1391, -1391, -1391, -1391, -1391, -114300, -49999, -1405,
  ];
  const totalEight = pairAmounts.reduce((s, a) => s + Math.abs(a), 0);
  expect(totalEight).toBe(172659); // EUR 1726.59 — the issue's observed sum

  /** Import a statement through the PRE-canonical path: raw rows, NO bank
   *  ids — exactly how the already-imported duplicates arrived. */
  async function importLegacyStatement(
    startDate: string,
    rows: {
      transaction_date: string;
      amount: number;
      description: string;
      external_id?: string;
    }[],
  ): Promise<{ statementId: number; txnIds: number[] }> {
    const result = await bank.createStatement({
      account_code: 'BANK_EUR',
      provider_code: 'LHV-SYN',
      source_account_ref: 'EE11SYNTHETIC',
      start_date: startDate,
      end_date: '2026-06-30',
      transactions: rows.map((r) => ({
        transaction_date: r.transaction_date,
        description: r.description,
        amount: r.amount,
        currency: 'EUR',
        ...(r.external_id ? { external_id: r.external_id } : {}),
      })),
    });
    return {
      statementId: result.statement.id,
      txnIds: result.transactions.map((t) => t.id),
    };
  }

  async function seedIssueFixture(): Promise<{
    statement8: { statementId: number; txnIds: number[] };
    statement9: { statementId: number; txnIds: number[] };
    match126: number;
    match127: number;
    match138: number;
    txn137Id: number;
  }> {
    // Statement8 (2026-05-08 – 2026-06-09, source spans May 1 – June 9):
    // the eight pairs' originals, imported pre-canonical (no ids).
    const statement8 = await importLegacyStatement(
      '2026-05-08',
      pairAmounts.map((amount, i) => ({
        transaction_date: '2026-06-08',
        amount,
        description: `Synthetic statement8 pair row ${121 + i}`,
      })),
    );

    // Statement9 (June 1–30): the SAME eight movements imported again (the
    // pre-canonical importer duplicated them), plus 15 unique rows — one of
    // which (137) is a GENUINE EUR 14.05 payment with a distinct bank id,
    // same day and amount as the 128/136 pair.
    const juneRows = [
      ...pairAmounts.map((amount, i) => ({
        transaction_date: '2026-06-08',
        amount,
        description: `Synthetic statement9 duplicate row ${129 + i}`,
      })),
      {
        transaction_date: '2026-06-08',
        amount: -1405,
        description: 'Synthetic genuine payment 137 — distinct bank id',
        external_id: 'SYN-TXN-137',
      },
      ...Array.from({ length: 14 }, (_, i) => ({
        transaction_date: '2026-06-20',
        amount: -(2000 + i * 10),
        description: `Synthetic statement9 unique row ${139 + i}`,
      })),
    ];
    const statement9 = await importLegacyStatement('2026-06-01', juneRows);

    // matches 17/18 on statement8 rows 126/127; match 23 on a UNIQUE
    // statement9 row (138-analog) — NOT on the genuine 137 payment.
    const match126 = await insertActiveMatch(1, statement8.txnIds[5], 114300);
    const match127 = await insertActiveMatch(2, statement8.txnIds[6], 49999);
    const match138 = await insertActiveMatch(3, statement9.txnIds[9], 1405);

    return {
      statement8,
      statement9,
      match126,
      match127,
      match138,
      txn137Id: statement9.txnIds[8],
    };
  }

  it('previews the eight duplicate pairs with the reconciled survivor recommended and the 137 control excluded', async () => {
    const { statement8, statement9, txn137Id } = await seedIssueFixture();

    const groups = await service.preview();
    // Four groups by (date, amount): 13.91×5, 1143.00, 499.99, 14.05.
    expect(groups.map((g) => g.amount).sort((a, b) => a - b)).toEqual([
      -114300, -49999, -1405, -1391,
    ]);
    // The 14.05 group contains the 128/136 PAIR and the genuine 137.
    const group1405 = groups.find((g) => g.amount === -1405);
    expect(group1405).toBeDefined();
    expect(group1405!.rows.map((r) => r.id).sort((a, b) => a - b)).toEqual(
      [statement8.txnIds[7], statement9.txnIds[7], txn137Id].sort(
        (a, b) => a - b,
      ),
    );
    // The reconciled survivor (an ACTIVE match, issue's match 17/18 analog)
    // is recommended; the distinct-identity genuine 137 never is.
    const reconciledGroup = groups.find((g) => g.amount === -114300);
    expect(reconciledGroup!.recommendedSurvivorId).toBe(statement8.txnIds[5]);

    // The 137 control is surfaced as a distinct-identity row, never a
    // preview-pairable duplicate: its EUR 14.05 never counts toward the
    // expected impact (exactly one 14.05 duplicate is mergeable).
    expect(group1405!.distinctIdentityRowIds).toContain(txn137Id);
    expect(group1405!.expectedOpenAmountImpact).toBe(1405);
  });

  it('repairs the eight pairs: EUR 1726.59 leaves the open amounts, matches 17/18/23 survive, all 15 unique operations and 137 remain', async () => {
    const { statement8, statement9, match126, match127, match138, txn137Id } =
      await seedIssueFixture();

    const vouchersBefore = await db.selectFrom('voucher').selectAll().execute();

    const groups = await service.preview();
    const rowFactsById = new Map<number, DuplicatePreviewRow>();
    for (const g of groups) {
      for (const r of g.rows) rowFactsById.set(r.id, r);
    }

    // The operator's EXPLICIT pairwise decisions (issue #399): each
    // statement8 original survives its statement9 duplicate copy — never a
    // many-to-one date+amount equivalence, never the genuine 137.
    const survivorIds = [...statement8.txnIds];
    const duplicateIds = [...statement9.txnIds.slice(0, 8)]; // rows 129–136 only
    const pairs = survivorIds.map((survivorId, i) => ({
      survivorId,
      duplicateId: duplicateIds[i],
    }));
    // The genuine 137 (distinct bank id) is never paired.
    expect(pairs.some((p) => p.duplicateId === txn137Id)).toBe(false);

    let repairedImpact = 0;
    for (const { survivorId, duplicateId } of pairs) {
      const s = rowFactsById.get(survivorId)!;
      const d = rowFactsById.get(duplicateId)!;
      const result = await service.applyRepair({
        survivorId,
        duplicateId,
        expected: {
          survivorActiveMatchCount: s.activeMatchCount,
          survivorDraftMatchCount: s.draftMatchCount,
          survivorSettlementClaimExpenseId: s.settlementClaimExpenseId,
          duplicateActiveMatchCount: d.activeMatchCount,
          duplicateDraftMatchCount: d.draftMatchCount,
          duplicateSettlementClaimExpenseId: d.settlementClaimExpenseId,
          duplicateAdvanceFunded: d.advanceFunded,
          duplicateStatus: d.status,
        },
        performedBy: 'synthetic operator',
      });
      expect(result.alreadyApplied).toBe(false);
      repairedImpact += result.openAmountImpact;
    }
    expect(repairedImpact).toBe(172659); // EUR 1726.59 — once, not twice

    // No financial posting was created or removed by the metadata repair.
    const vouchersAfter = await db.selectFrom('voucher').selectAll().execute();
    expect(vouchersAfter).toEqual(vouchersBefore);

    // matches 17/18/23 survive on the canonical rows.
    const matches = await db
      .selectFrom('reconciliation_match')
      .selectAll()
      .execute();
    expect(matches.map((m) => m.id).sort((a, b) => a - b)).toEqual(
      [match126, match127, match138].sort((a, b) => a - b),
    );

    // All 15 unique statement9 operations remain, 137 distinct from 128/136.
    const remaining = await bank.listTransactions(statement9.statementId);
    expect(remaining).toHaveLength(8 + 15); // pairs now co-evidenced + uniques
    const remaining137 = remaining.find((t) => t.id === txn137Id);
    expect(remaining137).toBeDefined();
    expect(remaining137!.external_id).toBe('SYN-TXN-137');
    // The survivor (statement8's 14.05 original) is now co-evidenced by
    // statement9's view too.
    expect(remaining.find((t) => t.id === statement8.txnIds[7])).toBeDefined();
    // Statement8's view still shows its own eight movements.
    const remaining8 = await bank.listTransactions(statement8.statementId);
    expect(remaining8).toHaveLength(8);
  });

  it('replays idempotently: a retried repair of the same pair changes nothing and reports alreadyApplied', async () => {
    const { statement8, statement9 } = await seedIssueFixture();
    const survivorId = statement8.txnIds[0];
    const duplicateId = statement9.txnIds[0];
    const base = {
      survivorActiveMatchCount: 0,
      survivorDraftMatchCount: 0,
      survivorSettlementClaimExpenseId: null,
      duplicateActiveMatchCount: 0,
      duplicateDraftMatchCount: 0,
      duplicateSettlementClaimExpenseId: null,
      duplicateAdvanceFunded: false,
      duplicateStatus: 'open',
    };
    const first = await service.applyRepair({
      survivorId,
      duplicateId,
      expected: base,
      performedBy: 'synthetic operator',
    });
    expect(first.alreadyApplied).toBe(false);
    expect(first.openAmountImpact).toBe(1391);

    const retry = await service.applyRepair({
      survivorId,
      duplicateId,
      expected: base,
      performedBy: 'synthetic operator',
    });
    expect(retry.alreadyApplied).toBe(true);
    expect(retry.repairId).toBe(first.repairId);

    // The old id resolves to the survivor (alias preserved).
    const resolved = await repo.findById(duplicateId);
    expect(resolved?.id).toBe(survivorId);

    // Both sources may be detached without invalidating historical aliases
    // or the idempotency record, even without a financial allocation.
    await bank.deleteStatement(statement8.statementId);
    await bank.deleteStatement(statement9.statementId);
    expect((await repo.findById(duplicateId))?.id).toBe(survivorId);
    expect(
      (await service.applyRepair({ survivorId, duplicateId, expected: base }))
        .alreadyApplied,
    ).toBe(true);
  });

  it('refuses a stale preview (revalidated atomically at apply time)', async () => {
    const { statement8, statement9 } = await seedIssueFixture();
    const survivorId = statement8.txnIds[0];
    const duplicateId = statement9.txnIds[0];
    await expect(
      service.applyRepair({
        survivorId,
        duplicateId,
        expected: {
          // A LIE: the duplicate actually has no matches — the preview is stale.
          survivorActiveMatchCount: 0,
          survivorDraftMatchCount: 0,
          survivorSettlementClaimExpenseId: null,
          duplicateActiveMatchCount: 1,
          duplicateDraftMatchCount: 0,
          duplicateSettlementClaimExpenseId: null,
          duplicateAdvanceFunded: false,
          duplicateStatus: 'open',
        },
        performedBy: 'synthetic operator',
      }),
    ).rejects.toThrow(/stale preview/i);
  });

  it('refuses merging DISTINCT known bank identities (the 137 control) even with same date/amount', async () => {
    const { statement8, txn137Id } = await seedIssueFixture();
    // txn137 vs statement8's row 128: same day, same EUR 14.05 — distinct
    // KNOWN identity on 137 (row 128 is identity-less, so identity-compatible
    // would allow it; give 128 a DIFFERENT known identity to make both KNOWN
    // and DISTINCT).
    await db
      .updateTable('bank_transaction')
      .set({
        external_id: 'SYN-TXN-128',
      })
      .where('id', '=', statement8.txnIds[7])
      .execute();
    const base = {
      survivorActiveMatchCount: 0,
      survivorDraftMatchCount: 0,
      survivorSettlementClaimExpenseId: null,
      duplicateActiveMatchCount: 0,
      duplicateDraftMatchCount: 0,
      duplicateSettlementClaimExpenseId: null,
      duplicateAdvanceFunded: false,
      duplicateStatus: 'open',
    };
    await expect(
      service.applyRepair({
        survivorId: statement8.txnIds[7],
        duplicateId: txn137Id,
        expected: base,
        performedBy: 'synthetic operator',
      }),
    ).rejects.toThrow(/distinct known bank identities/i);
    // Both movements remain.
    const still = await db
      .selectFrom('bank_transaction')
      .select('id')
      .where('id', 'in', [statement8.txnIds[7], txn137Id])
      .execute();
    expect(still).toHaveLength(2);
  });

  it('refuses a merge across conflicting money facts', async () => {
    const { statement8, statement9 } = await seedIssueFixture();
    await db
      .updateTable('bank_transaction')
      .set({ amount: -9999 })
      .where('id', '=', statement9.txnIds[0])
      .execute();
    await expect(
      service.applyRepair({
        survivorId: statement8.txnIds[0],
        duplicateId: statement9.txnIds[0],
        expected: {
          survivorActiveMatchCount: 0,
          survivorDraftMatchCount: 0,
          survivorSettlementClaimExpenseId: null,
          duplicateActiveMatchCount: 0,
          duplicateDraftMatchCount: 0,
          duplicateSettlementClaimExpenseId: null,
          duplicateAdvanceFunded: false,
          duplicateStatus: 'open',
        },
        performedBy: 'synthetic operator',
      }),
    ).rejects.toThrow(/conflicting money facts/i);
  });

  it('refuses a duplicate carrying financial references — never sums, never silently deletes financial history', async () => {
    const { statement8, statement9 } = await seedIssueFixture();
    // Give the DUPLICATE an active match (an "allocated copy").
    await insertActiveMatch(9, statement9.txnIds[0], 1391);
    await expect(
      service.applyRepair({
        survivorId: statement8.txnIds[0],
        duplicateId: statement9.txnIds[0],
        expected: {
          survivorActiveMatchCount: 0,
          survivorDraftMatchCount: 0,
          survivorSettlementClaimExpenseId: null,
          duplicateActiveMatchCount: 1,
          duplicateDraftMatchCount: 0,
          duplicateSettlementClaimExpenseId: null,
          duplicateAdvanceFunded: false,
          duplicateStatus: 'open',
        },
        performedBy: 'synthetic operator',
      }),
    ).rejects.toThrow(/duplicate carries financial references/i);
    // The financially-referenced duplicate is intact, not deleted.
    const still = await db
      .selectFrom('bank_transaction')
      .select('id')
      .where('id', '=', statement9.txnIds[0])
      .execute();
    expect(still).toHaveLength(1);
  });

  it('refuses a merge when BOTH rows carry financial references — explicit resolution through the normal flows', async () => {
    const { statement8, statement9 } = await seedIssueFixture();
    // Both rows of the 1143.00 pair now carry active matches (17-analog and
    // a second one on the duplicate).
    await insertActiveMatch(9, statement9.txnIds[5], 114300);
    const groups = await service.preview();
    const group = groups.find((g) => g.amount === -114300);
    expect(group!.requiresExplicitResolution).toBe(true);
    await expect(
      service.applyRepair({
        survivorId: statement8.txnIds[5],
        duplicateId: statement9.txnIds[5],
        expected: {
          survivorActiveMatchCount: 1,
          survivorDraftMatchCount: 0,
          survivorSettlementClaimExpenseId: null,
          duplicateActiveMatchCount: 1,
          duplicateDraftMatchCount: 0,
          duplicateSettlementClaimExpenseId: null,
          duplicateAdvanceFunded: false,
          duplicateStatus: 'open',
        },
        performedBy: 'synthetic operator',
      }),
    ).rejects.toThrow(/both rows carry financial references/i);
  });

  it('refuses a duplicate carrying a settlement-evidence claim', async () => {
    const { statement8, statement9 } = await seedIssueFixture();
    const expenseId = (
      await db
        .insertInto('expense')
        .values({
          category: 'travel',
          gross_amount: 1391,
          vat_amount: 0,
          currency: 'EUR',
          tax_point_date: '2026-06-08',
          status: 'draft',
          created_at: now(),
          updated_at: now(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('bank_settlement_usage')
      .values({
        bank_transaction_id: statement9.txnIds[0],
        expense_id: expenseId,
        origin: 'operator',
        created_at: now(),
      })
      .execute();
    await expect(
      service.applyRepair({
        survivorId: statement8.txnIds[0],
        duplicateId: statement9.txnIds[0],
        expected: {
          survivorActiveMatchCount: 0,
          survivorDraftMatchCount: 0,
          survivorSettlementClaimExpenseId: null,
          duplicateActiveMatchCount: 0,
          duplicateDraftMatchCount: 0,
          duplicateSettlementClaimExpenseId: expenseId,
          duplicateAdvanceFunded: false,
          duplicateStatus: 'open',
        },
        performedBy: 'synthetic operator',
      }),
    ).rejects.toThrow(/duplicate carries financial references/i);
  });

  it('records the repair in the append-only audit log', async () => {
    const { statement8, statement9 } = await seedIssueFixture();
    const before = await db.selectFrom('audit_log').select('id').execute();
    await service.applyRepair({
      survivorId: statement8.txnIds[0],
      duplicateId: statement9.txnIds[0],
      expected: {
        survivorActiveMatchCount: 0,
        survivorDraftMatchCount: 0,
        survivorSettlementClaimExpenseId: null,
        duplicateActiveMatchCount: 0,
        duplicateDraftMatchCount: 0,
        duplicateSettlementClaimExpenseId: null,
        duplicateAdvanceFunded: false,
        duplicateStatus: 'open',
      },
      performedBy: 'synthetic operator',
    });
    const entries = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'bank.duplicate_repair.apply')
      .execute();
    expect(entries).toHaveLength(1);
    expect(entries[0].actor).toBe('synthetic operator');
    expect(JSON.parse(entries[0].detail!)).toMatchObject({
      duplicate_id: statement9.txnIds[0],
      survivor_id: statement8.txnIds[0],
      open_amount_impact: 1391,
    });
    expect(before.length).toBeLessThan(
      (await db.selectFrom('audit_log').select('id').execute()).length,
    );
  });
});
