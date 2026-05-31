import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import request from 'supertest';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { ReportingPeriodsService } from '../reporting-periods/reporting-periods.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminKeyGuard } from './admin-key.guard';

describe('AdminController (integration)', () => {
  let app: INestApplication;
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

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        ReportingPeriodsService,
        AdminService,
        AdminKeyGuard,
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  // ── Auth ────────────────────────────────────────────────────────────

  it('GET /admin/* returns 401 without x-admin-key header', async () => {
    await request(app.getHttpServer())
      .get('/admin/accounts')
      .expect(401)
      .expect((res) => {
        expect(res.body.message).toBe('Invalid or missing admin key');
      });
  });

  it('GET /admin/* returns 401 with wrong x-admin-key header', async () => {
    await request(app.getHttpServer())
      .get('/admin/accounts')
      .set('x-admin-key', 'wrong')
      .expect(401)
      .expect((res) => {
        expect(res.body.message).toBe('Invalid or missing admin key');
      });
  });

  it('GET /admin/* returns 200 with correct x-admin-key header', async () => {
    await request(app.getHttpServer())
      .get('/admin/accounts')
      .set('x-admin-key', 'dev')
      .expect(200);
  });

  // ── GET /admin/health (public) ──────────────────────────────────────

  it('GET /admin/health returns 200 without auth', async () => {
    await request(app.getHttpServer())
      .get('/admin/health')
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('ok');
        expect(res.body.timestamp).toBeDefined();
        expect(res.body.db).toBe(true);
      });
  });

  // ── GET /admin/accounts ─────────────────────────────────────────────

  it('GET /admin/accounts returns accounts with zero balance by default', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/accounts')
      .set('x-admin-key', 'dev')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    // Each account should have a balance field
    for (const account of res.body) {
      expect(account).toHaveProperty('id');
      expect(account).toHaveProperty('code');
      expect(account).toHaveProperty('name');
      expect(account).toHaveProperty('type');
      expect(account).toHaveProperty('is_system');
      expect(account).toHaveProperty('balance');
      expect(typeof account.balance).toBe('number');
    }
  });

  it('GET /admin/accounts reflects posted voucher lines in balances', async () => {
    // Insert a voucher
    const now = Math.floor(Date.now() / 1000);
    await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-000001',
        tax_point_date: '2026-01-15',
        posted_at: now,
      })
      .execute();

    // Get the CASH account to post against
    const account = await db
      .selectFrom('account')
      .selectAll()
      .where('code', '=', 'CASH')
      .executeTakeFirst();

    expect(account).toBeDefined();

    await db
      .insertInto('voucher_line')
      .values({
        voucher_id: 1,
        account_id: account!.id,
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        vat_code: null,
        is_debit: 1,
      })
      .execute();

    const res = await request(app.getHttpServer())
      .get('/admin/accounts')
      .set('x-admin-key', 'dev')
      .expect(200);

    const target = res.body.find(
      (a: { code: string }) => a.code === 'CASH',
    );
    expect(target).toBeDefined();
    expect(target.balance).toBe(10000);
  });

  // ── GET /admin/vouchers ─────────────────────────────────────────────

  it('GET /admin/vouchers returns vouchers', async () => {
    const now = Math.floor(Date.now() / 1000);
    await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-000001',
        tax_point_date: '2026-01-15',
        posted_at: now,
      })
      .execute();

    await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-000002',
        tax_point_date: '2026-02-20',
        posted_at: now,
      })
      .execute();

    const res = await request(app.getHttpServer())
      .get('/admin/vouchers')
      .set('x-admin-key', 'dev')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
  });

  it('GET /admin/vouchers supports from/to date range filter', async () => {
    const now = Math.floor(Date.now() / 1000);
    await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-000001',
        tax_point_date: '2026-01-15',
        posted_at: now,
      })
      .execute();

    await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-000002',
        tax_point_date: '2026-02-20',
        posted_at: now,
      })
      .execute();

    await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-000003',
        tax_point_date: '2026-03-10',
        posted_at: now,
      })
      .execute();

    // Filter to February only
    const res = await request(app.getHttpServer())
      .get('/admin/vouchers')
      .query({ from: '2026-02-01', to: '2026-02-28' })
      .set('x-admin-key', 'dev')
      .expect(200);

    expect(res.body.length).toBe(1);
    expect(res.body[0].voucher_number).toBe('V-000002');
  });

  // ── GET /admin/vouchers/:id ────────────────────────────────────────

  it('GET /admin/vouchers/:id returns voucher with lines', async () => {
    const now = Math.floor(Date.now() / 1000);
    await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-000001',
        tax_point_date: '2026-01-15',
        posted_at: now,
      })
      .execute();

    const account = await db
      .selectFrom('account')
      .selectAll()
      .where('code', '=', 'CASH')
      .executeTakeFirst();

    expect(account).toBeDefined();

    await db
      .insertInto('voucher_line')
      .values({
        voucher_id: 1,
        account_id: account!.id,
        amount: 5000,
        currency: 'EUR',
        base_amount: 5000,
        fx_rate: 1,
        vat_code: null,
        is_debit: 1,
      })
      .execute();

    const res = await request(app.getHttpServer())
      .get('/admin/vouchers/1')
      .set('x-admin-key', 'dev')
      .expect(200);

    expect(res.body.id).toBe(1);
    expect(res.body.voucher_number).toBe('V-000001');
    expect(Array.isArray(res.body.lines)).toBe(true);
    expect(res.body.lines.length).toBe(1);
    expect(res.body.lines[0].base_amount).toBe(5000);
  });

  it('GET /admin/vouchers/:id returns 404 for unknown voucher', async () => {
    await request(app.getHttpServer())
      .get('/admin/vouchers/999')
      .set('x-admin-key', 'dev')
      .expect(404);
  });

  // ── GET /admin/periods ──────────────────────────────────────────────

  it('GET /admin/periods returns reporting periods', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/periods')
      .set('x-admin-key', 'dev')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
  });

  // ── POST /admin/periods/:id/lock ───────────────────────────────────

  it('POST /admin/periods/:id/lock locks a period', async () => {
    const now = Math.floor(Date.now() / 1000);
    await db
      .insertInto('reporting_period')
      .values({
        name: 'Q1 2026',
        start_date: '2026-01-01',
        end_date: '2026-03-31',
        status: 'open',
        created_at: now,
      })
      .execute();

    const res = await request(app.getHttpServer())
      .post('/admin/periods/1/lock')
      .set('x-admin-key', 'dev')
      .expect(201);

    expect(res.body.status).toBe('locked');
  });

  // ── GET /admin/approvals ───────────────────────────────────────────

  it('GET /admin/approvals returns approvals', async () => {
    const now = Math.floor(Date.now() / 1000);
    await db
      .insertInto('approval')
      .values({
        object_type: 'expense',
        object_id: 1,
        status: 'pending',
        requested_by: 'test',
        created_at: now,
      })
      .execute();

    const res = await request(app.getHttpServer())
      .get('/admin/approvals')
      .set('x-admin-key', 'dev')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
  });

  // ── GET /admin/approvals/pending ───────────────────────────────────

  it('GET /admin/approvals/pending returns only pending', async () => {
    const now = Math.floor(Date.now() / 1000);
    await db
      .insertInto('approval')
      .values({
        object_type: 'expense',
        object_id: 1,
        status: 'pending',
        requested_by: 'test',
        created_at: now,
      })
      .execute();

    await db
      .insertInto('approval')
      .values({
        object_type: 'sales_invoice',
        object_id: 2,
        status: 'approved',
        requested_by: 'test',
        approved_by: 'admin',
        resolved_at: now,
        created_at: now,
      })
      .execute();

    const res = await request(app.getHttpServer())
      .get('/admin/approvals/pending')
      .set('x-admin-key', 'dev')
      .expect(200);

    expect(res.body.length).toBe(1);
    expect(res.body[0].status).toBe('pending');
  });

  // ── GET /admin/findings ────────────────────────────────────────────

  it('GET /admin/findings returns audit findings', async () => {
    const now = Math.floor(Date.now() / 1000);
    await db
      .insertInto('audit_finding')
      .values({
        finding_type: 'missing_receipt',
        severity: 'high',
        description: 'Receipt missing for expense #1',
        status: 'open',
        created_at: now,
      })
      .execute();

    const res = await request(app.getHttpServer())
      .get('/admin/findings')
      .set('x-admin-key', 'dev')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
  });

  // ── GET /admin/findings/open ───────────────────────────────────────

  it('GET /admin/findings/open returns only open', async () => {
    const now = Math.floor(Date.now() / 1000);
    await db
      .insertInto('audit_finding')
      .values({
        finding_type: 'missing_receipt',
        severity: 'high',
        description: 'Open finding',
        status: 'open',
        created_at: now,
      })
      .execute();

    await db
      .insertInto('audit_finding')
      .values({
        finding_type: 'resolved_item',
        severity: 'low',
        description: 'Resolved finding',
        status: 'resolved',
        resolved_at: now,
        created_at: now,
      })
      .execute();

    const res = await request(app.getHttpServer())
      .get('/admin/findings/open')
      .set('x-admin-key', 'dev')
      .expect(200);

    expect(res.body.length).toBe(1);
    expect(res.body[0].status).toBe('open');
  });
});
