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
import { PeriodLockService } from './../src/reporting-periods/period-lock.service';
import { VoucherRepository } from './../src/ledger/voucher/voucher.repository';
import { VoucherLineRepository } from './../src/ledger/voucher/voucher-line.repository';
import { VoucherController } from './../src/ledger/voucher/voucher.controller';
import { ZodValidationPipe } from './../src/common/pipes/zod-validation.pipe';

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
        PeriodLockService,
        VoucherRepository,
        VoucherLineRepository,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ZodValidationPipe());
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
    expect(res.body).toHaveProperty('posted_at');
    expect(typeof Reflect.get(res.body, 'posted_at')).toBe('number');
    expect(res.body).toHaveProperty('lines');
    expect(Array.isArray(Reflect.get(res.body, 'lines'))).toBe(true);
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
    expect(list.body).toHaveProperty('vouchers');
    expect(Array.isArray(Reflect.get(list.body, 'vouchers'))).toBe(true);
    expect(JSON.stringify(Reflect.get(list.body, 'vouchers'))).not.toContain(
      'V-2026-E2E-2',
    );
  });

  it('POST /api/vouchers rejects a malformed body with 400', async () => {
    const malformed = {
      voucher_number: '',
      tax_point_date: 'not-a-date',
      lines: [
        {
          account_code: 'EXPENSE_SOFTWARE',
          amount: -100,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          is_debit: true,
        },
      ],
    };
    const res = await request(app.getHttpServer())
      .post('/api/vouchers')
      .send(malformed)
      .expect(400);
    expect(res.body).toHaveProperty('voucher_number');
    expect(res.body).toHaveProperty('tax_point_date');
    expect(res.body).toHaveProperty('lines');
  });

  it('POST /api/vouchers mints a fresh gapless number each time (no duplicate)', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/vouchers')
      .send({ ...balanced, voucher_number: 'V-2026-E2E-DUP' })
      .expect(201);
    // Second post with same body mints a new V-YYYY-NNNNNN number
    const second = await request(app.getHttpServer())
      .post('/api/vouchers')
      .send({ ...balanced, voucher_number: 'V-2026-E2E-DUP' })
      .expect(201);
    // Both posted, but with different gapless numbers
    expect(Reflect.get(first.body, 'voucher_number')).not.toBe(
      Reflect.get(second.body, 'voucher_number'),
    );
    expect(Reflect.get(first.body, 'voucher_number')).toMatch(/^V-2026-\d{6}$/);
    expect(Reflect.get(second.body, 'voucher_number')).toMatch(
      /^V-2026-\d{6}$/,
    );
  });

  it('GET /api/vouchers/:id returns the posted voucher with lines', async () => {
    const postRes = await request(app.getHttpServer())
      .post('/api/vouchers')
      .send({ ...balanced, voucher_number: 'V-2026-E2E-3' })
      .expect(201);
    const res = await request(app.getHttpServer())
      .get('/api/vouchers/1')
      .expect(200);
    expect(res.body).toHaveProperty('voucher_number');
    // Gapless sequential format: V-YYYY-NNNNNN
    expect(Reflect.get(res.body, 'voucher_number')).toMatch(/^V-2026-\d{6}$/);
    expect(Reflect.get(res.body, 'voucher_number')).toBe(
      Reflect.get(postRes.body, 'voucher_number'),
    );
    expect(res.body).toHaveProperty('lines');
    expect(Array.isArray(Reflect.get(res.body, 'lines'))).toBe(true);
  });

  it('PUT /api/vouchers/:id is rejected with 405', async () => {
    await request(app.getHttpServer())
      .post('/api/vouchers')
      .send({ ...balanced, voucher_number: 'V-2026-E2E-PUT' })
      .expect(201);
    await request(app.getHttpServer())
      .put('/api/vouchers/1')
      .send({ reason: 'tampering' })
      .expect(405);
  });

  it('DELETE /api/vouchers/:id is rejected with 405', async () => {
    await request(app.getHttpServer())
      .post('/api/vouchers')
      .send({ ...balanced, voucher_number: 'V-2026-E2E-DEL' })
      .expect(201);
    await request(app.getHttpServer()).delete('/api/vouchers/1').expect(405);
  });

  it('PATCH /api/vouchers/:id is rejected with 405', async () => {
    await request(app.getHttpServer())
      .post('/api/vouchers')
      .send({ ...balanced, voucher_number: 'V-2026-E2E-PATCH' })
      .expect(201);
    await request(app.getHttpServer())
      .patch('/api/vouchers/1')
      .send({ reason: 'tampering' })
      .expect(405);
  });

  it('GET /api/vouchers/:id remains 200 for a posted voucher', async () => {
    await request(app.getHttpServer())
      .post('/api/vouchers')
      .send({ ...balanced, voucher_number: 'V-2026-E2E-GET' })
      .expect(201);
    await request(app.getHttpServer()).get('/api/vouchers/1').expect(200);
  });
});
