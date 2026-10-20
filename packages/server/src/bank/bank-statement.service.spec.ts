import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AccountService } from '../ledger/account/account.service';
import { BankStatementService } from './bank-statement.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BankTransactionRepository } from './bank-transaction.repository';

/**
 * Integration test for the bank statement module.
 * Exercises the REAL DI graph against an in-memory SQLite DB seeded by the
 * real migrations (including account seeding).
 */
describe('BankStatementService (integration)', () => {
  let db: Kysely<Database>;
  let service: BankStatementService;

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
        AccountService,
        BankTransactionRepository,
        AuditLogService,
        BankStatementService,
      ],
    }).compile();

    service = module.get(BankStatementService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('creates a statement with BANK_EUR account + 2 transactions → returns statement with id and 2 transactions', async () => {
    const result = await service.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2025-01-01',
      end_date: '2025-01-31',
      transactions: [
        {
          transaction_date: '2025-01-05',
          description: 'Salary deposit',
          amount: 500000,
          currency: 'EUR',
        },
        {
          transaction_date: '2025-01-10',
          description: 'Office rent',
          amount: -120000,
          currency: 'EUR',
        },
      ],
    });

    expect(result.statement.id).toBeDefined();
    expect(result.statement.account_id).toBeDefined();
    expect(result.transactions).toHaveLength(2);
  });

  it('listTransactions returns exactly those rows with correct amounts (including negative)', async () => {
    const { statement } = await service.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2025-02-01',
      end_date: '2025-02-28',
      transactions: [
        {
          transaction_date: '2025-02-01',
          description: 'Incoming',
          amount: 300000,
          currency: 'EUR',
        },
        {
          transaction_date: '2025-02-15',
          description: 'Outgoing',
          amount: -75000,
          currency: 'EUR',
        },
      ],
    });

    const txns = await service.listTransactions(statement.id);
    expect(txns).toHaveLength(2);

    const amounts = txns.map((t) => t.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([-75000, 300000]);
  });

  it('G6 constraint — inserting bank_transaction with status="bogus" is rejected by DB CHECK', async () => {
    const { statement } = await service.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2025-03-01',
      end_date: '2025-03-31',
      transactions: [
        {
          transaction_date: '2025-03-01',
          amount: 10000,
          currency: 'EUR',
        },
      ],
    });

    // Directly insert a row with an invalid status via raw SQL to prove the CHECK.
    await expect(
      db
        .insertInto('bank_transaction')
        .values({
          statement_id: statement.id,
          transaction_date: '2025-03-02',
          amount: 5000,
          currency: 'EUR',
          status: 'bogus',
          created_at: Math.floor(Date.now() / 1000),
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('G6 FK — inserting bank_statement with non-existent account_id is rejected', async () => {
    // SQLite requires PRAGMA foreign_keys = ON to enforce FKs.
    await db.executeQuery(sql`PRAGMA foreign_keys = ON`.compile(db));

    await expect(
      db
        .insertInto('bank_statement')
        .values({
          account_id: 99999,
          start_date: '2025-04-01',
          end_date: '2025-04-30',
          uploaded_at: Math.floor(Date.now() / 1000),
          file_path: null,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('rejects a non-existent account code', async () => {
    await expect(
      service.createStatement({
        account_code: 'BANK_GHOST',
        start_date: '2025-06-01',
        end_date: '2025-06-30',
        transactions: [],
      }),
    ).rejects.toThrow("Account 'BANK_GHOST' not found");
  });

  it('rejects an existing account that is not a bank account (wrong type)', async () => {
    await expect(
      service.createStatement({
        account_code: 'EXPENSE_SOFTWARE',
        start_date: '2025-06-01',
        end_date: '2025-06-30',
        transactions: [],
      }),
    ).rejects.toThrow("Account 'EXPENSE_SOFTWARE' is not a bank account");
  });

  it('G3 discriminating — negative amount round-trips as -1525, currency="USD" round-trips', async () => {
    const result = await service.createStatement({
      account_code: 'BANK_USD',
      start_date: '2025-05-01',
      end_date: '2025-05-31',
      transactions: [
        {
          transaction_date: '2025-05-10',
          description: 'Card purchase',
          amount: -1525,
          currency: 'USD',
          source_currency: 'EUR',
          source_amount: -1400,
          fx_rate: 1.089,
        },
      ],
    });

    const txns = await service.listTransactions(result.statement.id);
    expect(txns).toHaveLength(1);
    expect(txns[0].amount).toBe(-1525);
    expect(txns[0].currency).toBe('USD');
    expect(txns[0].source_currency).toBe('EUR');
    expect(txns[0].source_amount).toBe(-1400);
    expect(txns[0].fx_rate).toBeCloseTo(1.089, 3);
  });

  it('deleteStatement removes the statement and its transactions', async () => {
    const { statement } = await service.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2025-07-01',
      end_date: '2025-07-31',
      transactions: [
        { transaction_date: '2025-07-05', amount: 1000, currency: 'EUR' },
        { transaction_date: '2025-07-06', amount: -500, currency: 'EUR' },
      ],
    });

    await service.deleteStatement(statement.id);

    const statements = await service.listStatements();
    expect(statements.find((s) => s.id === statement.id)).toBeUndefined();
    expect(await service.listTransactions(statement.id)).toHaveLength(0);
  });

  it('deleteStatement throws NotFound for a missing statement', async () => {
    await expect(service.deleteStatement(99999)).rejects.toThrow(
      'Bank statement 99999 not found',
    );
  });

  // ── Issue #399: the canonical bank-transaction journal ────────────
  //
  // SYNTHETIC LHV-like fixtures throughout: the issue's reproduced amounts
  // (EUR 1726.59 across eight pairs; a genuine EUR 14.05 payment with a
  // different bank id) are reproduced with labelled synthetic data — no
  // production source CSV was inspected, imported or repaired.

  describe('canonical journal (issue #399)', () => {
    const PROVIDER = 'LHV-SYN';
    const ACCOUNT_REF = 'EE11SYNTHETIC';

    /** The issue's eight overlapping outgoing pairs, EUR 1726.59 total. */
    const eightPairs = [
      {
        external_id: 'SYN-TXN-121',
        archive_ref: 'SYN-ARCH-121',
        amount: -1391,
      },
      {
        external_id: 'SYN-TXN-122',
        archive_ref: 'SYN-ARCH-122',
        amount: -1391,
      },
      {
        external_id: 'SYN-TXN-123',
        archive_ref: 'SYN-ARCH-123',
        amount: -1391,
      },
      {
        external_id: 'SYN-TXN-124',
        archive_ref: 'SYN-ARCH-124',
        amount: -1391,
      },
      {
        external_id: 'SYN-TXN-125',
        archive_ref: 'SYN-ARCH-125',
        amount: -1391,
      },
      {
        external_id: 'SYN-TXN-126',
        archive_ref: 'SYN-ARCH-126',
        amount: -114300,
      },
      {
        external_id: 'SYN-TXN-127',
        archive_ref: 'SYN-ARCH-127',
        amount: -49999,
      },
      {
        external_id: 'SYN-TXN-128',
        archive_ref: 'SYN-ARCH-128',
        amount: -1405,
      },
    ];
    const totalEight = eightPairs.reduce((s, p) => s + Math.abs(p.amount), 0);
    expect(totalEight).toBe(172659); // EUR 1726.59 — the issue's observed sum

    const mayJuneRow = (p: {
      external_id: string;
      archive_ref: string;
      amount: number;
    }) => ({
      transaction_date: '2026-06-08',
      description: `Synthetic May–June statement row ${p.external_id}`,
      amount: p.amount,
      currency: 'EUR',
      external_id: p.external_id,
      archive_ref: p.archive_ref,
    });

    const mayJune = {
      account_code: 'BANK_EUR',
      provider_code: PROVIDER,
      source_account_ref: ACCOUNT_REF,
      start_date: '2026-05-08',
      end_date: '2026-06-09',
      transactions: eightPairs.map(mayJuneRow),
    };

    /** 15 unique June rows — including the genuine EUR 14.05 payment with a
     *  DISTINCT bank id (the transaction-137 negative control). */
    const juneUniques = [
      {
        external_id: 'SYN-TXN-137',
        archive_ref: 'SYN-ARCH-137',
        amount: -1405,
      },
      ...Array.from({ length: 14 }, (_, i) => ({
        external_id: `SYN-TXN-U${i + 1}`,
        archive_ref: `SYN-ARCH-U${i + 1}`,
        amount: -(1000 + i),
      })),
    ].map((p, i) => ({
      transaction_date: '2026-06-15',
      description: `Synthetic June unique row ${p.external_id}`,
      amount: p.amount,
      currency: 'EUR',
      external_id: p.external_id,
      archive_ref: p.archive_ref,
      ...(i === 0
        ? {
            // Same DAY, same AMOUNT as the SYN-TXN-128 pair — distinct bank id.
            transaction_date: '2026-06-08',
          }
        : {}),
    }));

    const june = {
      account_code: 'BANK_EUR',
      provider_code: PROVIDER,
      source_account_ref: ACCOUNT_REF,
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      transactions: [...eightPairs.map(mayJuneRow), ...juneUniques],
    };

    it('deduplicates overlapping imports into one canonical journal, in BOTH orders', async () => {
      const first = await service.createStatement(mayJune);
      expect(first.summary.newCount).toBe(8);
      expect(first.summary.knownCount).toBe(0);

      const second = await service.createStatement(june);
      expect(second.summary.newCount).toBe(15);
      expect(second.summary.knownCount).toBe(8);
      expect(second.summary.conflictCount).toBe(0);

      // Exactly one canonical operation per original bank id; the total
      // outgoing open amount includes each movement ONCE (no EUR 1726.59
      // overstatement from duplicated pairs).
      const canonical = await db
        .selectFrom('bank_transaction')
        .selectAll()
        .execute();
      expect(new Set(canonical.map((t) => t.external_id)).size).toBe(
        canonical.length,
      );
      expect(canonical).toHaveLength(23);
      expect(canonical.reduce((s, t) => s + Math.abs(t.amount), 0)).toBe(
        totalEight + juneUniques.reduce((s, u) => s + Math.abs(u.amount), 0),
      );
    });

    it('deduplicates in the REVERSE arrival order too (June first, May–June second)', async () => {
      await service.createStatement(june);
      const second = await service.createStatement(mayJune);
      expect(second.summary.newCount).toBe(0);
      expect(second.summary.knownCount).toBe(8);
      const canonical = await db
        .selectFrom('bank_transaction')
        .select('id')
        .execute();
      expect(canonical).toHaveLength(23);
    });

    it('preserves the genuine same-day/same-amount payment with a DISTINCT bank id (transaction-137 control)', async () => {
      await service.createStatement(mayJune);
      await service.createStatement(june);
      const txn128 = await db
        .selectFrom('bank_transaction')
        .selectAll()
        .where('external_id', '=', 'SYN-TXN-128')
        .executeTakeFirstOrThrow();
      const txn137 = await db
        .selectFrom('bank_transaction')
        .selectAll()
        .where('external_id', '=', 'SYN-TXN-137')
        .executeTakeFirstOrThrow();
      expect(txn137.id).not.toBe(txn128.id);
      expect(txn137.transaction_date).toBe(txn128.transaction_date);
      expect(txn137.amount).toBe(txn128.amount);
    });

    it('an exact structured repeat with no raw-source evidence is idempotent by its own identical content (issue #399)', async () => {
      await service.createStatement(june);
      const second = await service.createStatement(june);
      // A pure structured import (no raw archive) names no raw source, so
      // its identical projected content is its whole evidence: an exact
      // repeat inserts nothing (see the fingerprint tests for the boundary
      // that keeps genuinely different raw sources apart).
      expect(second.summary.newCount).toBe(0);
      expect(second.summary.knownCount).toBe(23);
      const canonical = await db
        .selectFrom('bank_transaction')
        .select('id')
        .execute();
      expect(canonical).toHaveLength(23);
      expect(await service.listStatements()).toHaveLength(1);
    });

    it('a raw archive WITHOUT a fingerprint is UNCERTAIN — no replay claim, identity-less twins flagged for review (issue #399)', async () => {
      const row = {
        transaction_date: '2026-06-21',
        description: 'Synthetic identical purchase across two raw exports',
        amount: -2500,
        currency: 'EUR',
      };
      // Two imports each linking their OWN archived raw source but not
      // characterising it (no fingerprint): the caller has raw evidence it
      // did not identify — nothing may claim they are the same source.
      const a = await service.createStatement({
        ...mayJune,
        file_path: 'bank-statements/1/first.csv',
        transactions: [row],
      });
      const b = await service.createStatement({
        ...mayJune,
        file_path: 'bank-statements/2/second.csv',
        transactions: [row],
      });
      expect(a.statement.id).not.toBe(b.statement.id);
      expect(b.summary.newCount).toBe(1);
      expect(b.summary.conflictCount).toBe(1);
      expect(b.summary.conflicts[0].kind).toBe('ambiguous_overlap');
      expect(await service.listStatements()).toHaveLength(2);
    });

    it('a renamed/reordered re-upload with the SAME authoritative raw fingerprint is the same source replay (issue #399)', async () => {
      await service.createStatement({
        ...june,
        source_fingerprint: 'raw-fingerprint-export-june',
      });
      const replay = await service.createStatement({
        ...june,
        source_fingerprint: 'raw-fingerprint-export-june',
        transactions: [...june.transactions].reverse(),
        file_path: 'bank-statements/other/renamed.csv',
      });
      expect(replay.summary.newCount).toBe(0);
      expect(replay.summary.knownCount).toBe(23);
      const canonical = await db
        .selectFrom('bank_transaction')
        .select('id')
        .execute();
      expect(canonical).toHaveLength(23);
      expect(await service.listStatements()).toHaveLength(1);
    });

    it('deduplicates WITHIN a single file when the same bank id repeats', async () => {
      const result = await service.createStatement({
        ...mayJune,
        transactions: [
          ...eightPairs.map(mayJuneRow),
          mayJuneRow(eightPairs[0]), // the same id, same facts, same file
        ],
      });
      expect(result.summary.newCount).toBe(8);
      expect(result.summary.knownCount).toBe(1);
      expect(result.summary.conflictCount).toBe(0);
      const canonical = await db
        .selectFrom('bank_transaction')
        .select('id')
        .execute();
      expect(canonical).toHaveLength(8);
    });

    it('does NOT merge the same bank id across a different provider or a different source account', async () => {
      await service.createStatement(mayJune);
      const otherProvider = await service.createStatement({
        ...mayJune,
        provider_code: 'SEB-SYN',
      });
      expect(otherProvider.summary.newCount).toBe(8);
      const otherAccount = await service.createStatement({
        ...mayJune,
        source_account_ref: 'EE22SYNTHETIC',
      });
      expect(otherAccount.summary.newCount).toBe(8);
      const canonical = await db
        .selectFrom('bank_transaction')
        .select('id')
        .execute();
      expect(canonical).toHaveLength(24);
    });

    it('keeps identity-less same-day/same-amount rows DISTINCT but surfaces the ambiguous overlap for review', async () => {
      const weak = (desc: string) => ({
        transaction_date: '2026-06-20',
        description: desc,
        amount: -2500,
        currency: 'EUR',
      });
      const a = await service.createStatement({
        ...mayJune,
        transactions: [weak('Synthetic identical purchase A')],
      });
      const b = await service.createStatement({
        ...mayJune,
        transactions: [weak('Synthetic identical purchase B')],
      });
      // Both movements stand (genuine identical purchases are never
      // collapsed by date+amount) — but the overlap is flagged for review.
      expect(a.summary.newCount).toBe(1);
      expect(b.summary.newCount).toBe(1);
      expect(b.summary.conflictCount).toBe(1);
      expect(b.summary.conflicts[0].kind).toBe('ambiguous_overlap');
      const open = await service.listConflicts('open');
      expect(open).toHaveLength(1);
    });

    it('raises a persisted conflict for a same-identity amount mismatch — never overwriting the canonical row', async () => {
      await service.createStatement({
        ...mayJune,
        transactions: [mayJuneRow(eightPairs[0])],
      });
      const conflicting = await service.createStatement({
        ...mayJune,
        transactions: [
          {
            ...mayJuneRow(eightPairs[0]),
            amount: -9999,
          },
        ],
      });
      expect(conflicting.summary.newCount).toBe(0);
      expect(conflicting.summary.knownCount).toBe(0);
      expect(conflicting.summary.conflictCount).toBe(1);
      expect(conflicting.summary.conflicts[0].kind).toBe('amount_mismatch');
      const canonical = await db
        .selectFrom('bank_transaction')
        .selectAll()
        .where('external_id', '=', 'SYN-TXN-121')
        .executeTakeFirstOrThrow();
      expect(canonical.amount).toBe(-1391); // unchanged
    });

    it('raises a fact_mismatch conflict for conflicting settlement FX facts (DKK 60.00 vs 24.50, same EUR debit)', async () => {
      await service.createStatement({
        ...mayJune,
        transactions: [
          {
            ...mayJuneRow(eightPairs[0]),
            amount: -811,
            source_currency: 'DKK',
            source_amount: 6000,
            fx_rate: 0.1338333,
            conversion_fee: 8,
          },
        ],
      });
      const conflicting = await service.createStatement({
        ...mayJune,
        transactions: [
          {
            ...mayJuneRow(eightPairs[0]),
            amount: -811,
            source_currency: 'DKK',
            source_amount: 2450, // a DIFFERENT purchase's valuation
            fx_rate: 0.1338333,
            conversion_fee: 8,
          },
        ],
      });
      expect(conflicting.summary.conflictCount).toBe(1);
      expect(conflicting.summary.conflicts[0].kind).toBe('fact_mismatch');
      const canonical = await db
        .selectFrom('bank_transaction')
        .selectAll()
        .where('external_id', '=', 'SYN-TXN-121')
        .executeTakeFirstOrThrow();
      expect(canonical.source_amount).toBe(6000); // the original valuation stands
    });

    it('raises a fact_mismatch conflict for a conflicting separately-evidenced conversion fee (8 vs 50)', async () => {
      await service.createStatement({
        ...mayJune,
        transactions: [
          {
            ...mayJuneRow(eightPairs[0]),
            amount: -811,
            source_currency: 'DKK',
            source_amount: 6000,
            fx_rate: 0.1338333,
            conversion_fee: 8,
          },
        ],
      });
      const conflicting = await service.createStatement({
        ...mayJune,
        transactions: [
          {
            ...mayJuneRow(eightPairs[0]),
            amount: -811,
            source_currency: 'DKK',
            source_amount: 6000,
            fx_rate: 0.1338333,
            conversion_fee: 50,
          },
        ],
      });
      expect(conflicting.summary.conflictCount).toBe(1);
      expect(conflicting.summary.conflicts[0].kind).toBe('fact_mismatch');
    });

    it('treats a pending/booked date shift EXPLICITLY: the explained alias is known with per-source facts retained; an unexplained date change is a conflict', async () => {
      await service.createStatement({
        ...mayJune,
        transactions: [
          {
            ...mayJuneRow(eightPairs[0]),
            transaction_date: '2026-06-08',
            booking_date: '2026-06-09',
          },
        ],
      });
      // Pending→booked alias: the second source's value date is the first
      // source's booking date — the SAME movement, known.
      const booked = await service.createStatement({
        ...mayJune,
        transactions: [
          {
            ...mayJuneRow(eightPairs[0]),
            transaction_date: '2026-06-09', // the first source's BOOKING date
            booking_date: '2026-06-09',
          },
        ],
      });
      expect(booked.summary.knownCount).toBe(1);
      expect(booked.summary.conflictCount).toBe(0);
      // The differing per-source date is retained verbatim on the provenance row.
      const sources = await db
        .selectFrom('bank_transaction_source')
        .select('facts')
        .execute();
      expect(sources).toHaveLength(2);
      const facts = sources.map((s) => JSON.parse(s.facts ?? '{}'));
      expect(new Set(facts.map((f) => f.transaction_date as string))).toEqual(
        new Set(['2026-06-08', '2026-06-09']),
      );

      // An UNEXPLAINED material date change — a conflict, never a silent merge.
      const moved = await service.createStatement({
        ...mayJune,
        transactions: [
          {
            ...mayJuneRow(eightPairs[0]),
            transaction_date: '2026-06-25',
            booking_date: '2026-06-25',
          },
        ],
      });
      expect(moved.summary.conflictCount).toBe(1);
      expect(moved.summary.conflicts[0].kind).toBe('fact_mismatch');
    });

    it('keeps an OPEN conflict OPEN when the conflicting source is re-uploaded (a retry is not a success)', async () => {
      const conflicting = {
        ...mayJune,
        // A true retried import names its raw source (as the ingestion path
        // does) — the retry below replays THIS source, not a guess.
        source_fingerprint: 'raw-fingerprint-conflicting-source',
        transactions: [
          {
            ...mayJuneRow(eightPairs[0]),
            amount: -811,
            source_currency: 'DKK',
            source_amount: 6000,
            fx_rate: 0.1338333,
            conversion_fee: 8,
          },
        ],
      };
      await service.createStatement({
        ...mayJune,
        transactions: [
          {
            ...mayJuneRow(eightPairs[0]),
            amount: -811,
            source_currency: 'DKK',
            source_amount: 6000,
            fx_rate: 0.1338333,
            conversion_fee: 50,
          },
        ],
      });
      const first = await service.createStatement(conflicting);
      expect(first.summary.conflictCount).toBe(1);
      expect(first.summary.knownCount).toBe(0);
      // A retried upload of the SAME conflicting source must not relabel its
      // rejected row as a successfully-known row.
      const retry = await service.createStatement(conflicting);
      expect(retry.summary.conflictCount).toBe(1);
      expect(retry.summary.knownCount).toBe(0);
      expect((await service.listConflicts('open')).length).toBe(1);
    });

    it('resolves a conflict idempotently through the review operation', async () => {
      await service.createStatement({
        ...mayJune,
        transactions: [mayJuneRow(eightPairs[0])],
      });
      await service.createStatement({
        ...mayJune,
        transactions: [
          {
            ...mayJuneRow(eightPairs[0]),
            amount: -9999,
          },
        ],
      });
      const open = await service.listConflicts('open');
      expect(open).toHaveLength(1);
      await service.resolveConflict(open[0].id);
      expect(await service.listConflicts('open')).toHaveLength(0);
      await service.resolveConflict(open[0].id); // idempotent re-resolution
      await expect(service.resolveConflict(99999)).rejects.toThrow('not found');
    });

    it('treats two exports that differ only in RAW source bytes as DIFFERENT sources — flagged ambiguous, never a silent replay (issue #399)', async () => {
      // An identity-less row: without a bank id the twin cannot be decided
      // by movement identity, so the distinct-source boundary is what
      // protects it.
      const row = {
        transaction_date: '2026-06-21',
        description: 'Synthetic identical purchase across two raw exports',
        amount: -2500,
        currency: 'EUR',
      };
      // Same mapped rows, but each import names its OWN authoritative raw
      // fingerprint (as the ingestion path computes from the raw buffer).
      const exportA = await service.createStatement({
        ...mayJune,
        source_fingerprint: 'raw-fingerprint-export-a',
        transactions: [row],
      });
      const exportB = await service.createStatement({
        ...mayJune,
        source_fingerprint: 'raw-fingerprint-export-b',
        transactions: [row],
      });
      // Two import artifacts, two archives — B was NOT collapsed into A.
      expect(exportA.statement.id).not.toBe(exportB.statement.id);
      expect(exportB.summary.newCount).toBe(1);
      // The identity-less twin overlap is flagged for review: surfaced
      // uncertainty, never a guessed merge and never a collapsed purchase.
      expect(exportB.summary.conflictCount).toBe(1);
      expect(exportB.summary.conflicts[0].kind).toBe('ambiguous_overlap');
      const statements = await service.listStatements();
      expect(statements).toHaveLength(2);
    });

    it('treats two imports naming the SAME raw fingerprint as an exact replay (issue #399)', async () => {
      const row = mayJuneRow(eightPairs[0]);
      await service.createStatement({
        ...mayJune,
        source_fingerprint: 'raw-fingerprint-export-a',
        transactions: [row],
      });
      const replay = await service.createStatement({
        ...mayJune,
        source_fingerprint: 'raw-fingerprint-export-a',
        transactions: [row],
      });
      expect(replay.summary.newCount).toBe(0);
      expect(replay.summary.knownCount).toBe(1);
      const canonical = await db
        .selectFrom('bank_transaction')
        .select('id')
        .execute();
      expect(canonical).toHaveLength(1);
      expect(await service.listStatements()).toHaveLength(1);
    });

    it('replays the same raw source even when a fresh mapping changes projected facts', async () => {
      const row = {
        transaction_date: '2026-06-21',
        amount: -2500,
        currency: 'EUR',
        description: 'First inferred description',
      };
      const original = await service.createStatement({
        ...mayJune,
        source_fingerprint: 'same-original-csv',
        transactions: [row, row],
      });
      const replay = await service.createStatement({
        ...mayJune,
        source_fingerprint: 'same-original-csv',
        provider_code: 'DIFFERENT-INFERENCE',
        source_account_ref: null,
        transactions: [row, row].map((t) => ({
          ...t,
          description: 'New inferred description',
        })),
      });
      expect(replay.statement.id).toBe(original.statement.id);
      expect(replay.summary.newCount).toBe(0);
      expect(replay.summary.knownCount).toBe(2);
      expect(replay.transactions).toHaveLength(2);
      expect(replay.transactions.map((t) => t.description)).toEqual([
        'First inferred description',
        'First inferred description',
      ]);
      expect(await service.listStatements()).toHaveLength(1);
    });

    it('is idempotent under CONCURRENT imports of the same movement (storage-level uniqueness)', async () => {
      const row = mayJuneRow(eightPairs[0]);
      const [a, b] = await Promise.all([
        service.createStatement({ ...mayJune, transactions: [row] }),
        service.createStatement({
          ...mayJune,
          transactions: [row],
        }),
      ]);
      const canonical = await db
        .selectFrom('bank_transaction')
        .select('id')
        .execute();
      expect(canonical).toHaveLength(1);
      // Both statements exist (two import requests), both resolve to the one
      // canonical movement; at most one inserted it.
      expect(a.summary.newCount + b.summary.newCount).toBe(1);
      expect(a.summary.knownCount + b.summary.knownCount).toBe(1);
    });

    it('exposes many-source provenance through a statement view: both statements see the shared canonical row', async () => {
      await service.createStatement(mayJune);
      const second = await service.createStatement(june);
      const sharedId = second.transactions.find(
        (t) => t.external_id === 'SYN-TXN-121',
      )?.id;
      expect(sharedId).toBeDefined();
      const fromFirst = await service.listTransactions(
        (await service.listStatements()).find(
          (s) => s.start_date === '2026-05-08',
        )!.id,
      );
      const shared = fromFirst.find((t) => t.id === sharedId);
      expect(shared).toBeDefined();
      // The shared movement visibly retains BOTH source statements.
      expect(shared!.sources.map((s) => s.statement_id).sort()).toHaveLength(2);
    });

    it('detaching one statement keeps a SHARED canonical movement and its financial history', async () => {
      await service.createStatement(mayJune);
      const second = await service.createStatement({
        ...june,
        transactions: [mayJuneRow(eightPairs[0])],
      });
      const sharedId = second.transactions[0].id;
      // Give the shared movement FINANCIAL history: an active match on a real voucher.
      const voucherId = (
        await db
          .insertInto('voucher')
          .values({
            voucher_number: 'V-SYN-2026-000001',
            tax_point_date: '2026-06-08',
            posted_at: 1790000000,
            previous_hash: null,
            reverses_id: null,
            corrects_object_type: null,
            corrects_object_id: null,
            reason: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await db
        .insertInto('reconciliation_match')
        .values({
          bank_transaction_id: sharedId,
          voucher_id: voucherId,
          match_type: 'exact',
          amount_matched: 1391,
          status: 'active',
          signal: 'manual',
          created_at: 1790000000,
        })
        .execute();

      const mayJuneStatement = (await service.listStatements()).find(
        (s) => s.start_date === '2026-05-08',
      )!;
      const result = await service.deleteStatement(mayJuneStatement.id);
      // The shared movement survives (it is evidenced by the June statement).
      expect(result.retainedTransactionIds).toContain(sharedId);
      const surviving = await db
        .selectFrom('bank_transaction')
        .selectAll()
        .where('id', '=', sharedId)
        .executeTakeFirstOrThrow();
      expect(surviving.amount).toBe(-1391);
      const matches = await db
        .selectFrom('reconciliation_match')
        .selectAll()
        .where('bank_transaction_id', '=', sharedId)
        .execute();
      expect(matches).toHaveLength(1); // its reconciliation history is intact
    });

    it('detaching a statement RETAINS an exclusively-referenced movement that carries financial history', async () => {
      const created = await service.createStatement({
        ...mayJune,
        transactions: [mayJuneRow(eightPairs[0])],
      });
      const txnId = created.transactions[0].id;
      const voucherId = (
        await db
          .insertInto('voucher')
          .values({
            voucher_number: 'V-SYN-2026-000002',
            tax_point_date: '2026-06-08',
            posted_at: 1790000000,
            previous_hash: null,
            reverses_id: null,
            corrects_object_type: null,
            corrects_object_id: null,
            reason: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await db
        .insertInto('reconciliation_match')
        .values({
          bank_transaction_id: txnId,
          voucher_id: voucherId,
          match_type: 'exact',
          amount_matched: 1391,
          status: 'active',
          signal: 'manual',
          created_at: 1790000000,
        })
        .execute();

      const result = await service.deleteStatement(created.statement.id);
      expect(result.retainedTransactionIds).toContain(txnId);
      // The movement survives with its origin detached (NULL), never deleted.
      const surviving = await db
        .selectFrom('bank_transaction')
        .selectAll()
        .where('id', '=', txnId)
        .executeTakeFirstOrThrow();
      expect(surviving.statement_id).toBeNull();
      expect(surviving.amount).toBe(-1391);
      const matches = await db
        .selectFrom('reconciliation_match')
        .selectAll()
        .where('bank_transaction_id', '=', txnId)
        .execute();
      expect(matches).toHaveLength(1);
    });

    it('detaches sources while retaining conflict history and referenced canonical movements', async () => {
      const original = await service.createStatement({
        ...mayJune,
        transactions: [mayJuneRow(eightPairs[0])],
      });
      const conflicting = await service.createStatement({
        ...mayJune,
        transactions: [{ ...mayJuneRow(eightPairs[0]), amount: -999 }],
      });
      const conflict = conflicting.summary.conflicts[0];
      // Another source's review still needs the original canonical row.
      const detached = await service.deleteStatement(original.statement.id);
      expect(detached.retainedTransactionIds).toEqual([
        original.transactions[0].id,
      ]);
      await service.resolveConflict(conflict.id);
      // Resolved review history also survives detaching its source artifact.
      await service.deleteStatement(conflicting.statement.id);
      const history = await service.listConflicts('resolved');
      expect(history).toHaveLength(1);
      expect(history[0].statement_id).toBe(conflicting.statement.id);
      expect(await service.listStatements()).toHaveLength(0);
      expect(
        await db.selectFrom('bank_transaction').select('id').execute(),
      ).toEqual([{ id: original.transactions[0].id }]);
    });

    it('detaching a statement removes a movement referenced ONLY by it with NO financial history', async () => {
      const created = await service.createStatement({
        ...mayJune,
        transactions: [mayJuneRow(eightPairs[0])],
      });
      const txnId = created.transactions[0].id;
      const result = await service.deleteStatement(created.statement.id);
      expect(result.retainedTransactionIds).not.toContain(txnId);
      const gone = await db
        .selectFrom('bank_transaction')
        .select('id')
        .where('id', '=', txnId)
        .execute();
      expect(gone).toHaveLength(0);
    });
  });
});
