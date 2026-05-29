import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import request from 'supertest';
import { App } from 'supertest/types';
import { Database } from './../src/database/types';
import { migrations } from './../src/database/migrations';
import { AccountService } from './../src/ledger/account/account.service';
import { LedgerValidationService } from './../src/ledger/validation/ledger-validation.service';
import { PostingService } from './../src/ledger/posting/posting.service';
import { VoucherRepository } from './../src/ledger/voucher/voucher.repository';
import { VoucherLineRepository } from './../src/ledger/voucher/voucher-line.repository';
import { VoucherController } from './../src/ledger/voucher/voucher.controller';

describe('Voucher (e2e)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;

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

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [VoucherController],
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        AccountService,
        LedgerValidationService,
        PostingService,
        VoucherRepository,
        VoucherLineRepository,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  const balanced = {
    voucher_number: 'V-2026-E2E-1',
    tax_point_date: '2026-01-15',
    lines: [
      {
        account_code: 'EXPENSE_SOFTWARE',
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        is_debit: true,
      },
      {
        account_code: 'CASH',
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        is_debit: false,
      },
    ],
  };

  it('POST /api/vouchers posts a valid voucher (201) with posted_at', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/vouchers')
      .send(balanced)
      .expect(201);
    const body = res.body as { posted_at: number; lines: unknown[] };
    expect(body.posted_at).not.toBeNull();
    expect(body.lines).toHaveLength(2);
  });

  it('POST /api/vouchers rejects an unbalanced voucher (400) atomically', async () => {
    const unbalanced = {
      ...balanced,
      voucher_number: 'V-2026-E2E-2',
      lines: [
        { ...balanced.lines[0] },
        { ...balanced.lines[1], amount: 9900, base_amount: 9900 },
      ],
    };
    await request(app.getHttpServer())
      .post('/api/vouchers')
      .send(unbalanced)
      .expect(400);

    const list = await request(app.getHttpServer())
      .get('/api/vouchers')
      .expect(200);
    const listBody = list.body as {
      vouchers: { voucher_number: string }[];
    };
    expect(
      listBody.vouchers.find((v) => v.voucher_number === 'V-2026-E2E-2'),
    ).toBeUndefined();
  });

  it('GET /api/vouchers/:id returns the posted voucher with lines', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/vouchers')
      .send({ ...balanced, voucher_number: 'V-2026-E2E-3' })
      .expect(201);
    const createdBody = created.body as { id: number };
    const res = await request(app.getHttpServer())
      .get(`/api/vouchers/${createdBody.id}`)
      .expect(200);
    const body = res.body as { voucher_number: string; lines: unknown[] };
    expect(body.voucher_number).toBe('V-2026-E2E-3');
    expect(body.lines).toHaveLength(2);
  });
});
