import { FX_RATE_SOURCE } from '../src/fx/fx-rate.types';
import { ECB_FIXTURE_RATES, FixtureFxRateSource } from './fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../src/database/types';
import { migrations } from '../src/database/migrations';
import { DOCUMENT_STORAGE_ROOT } from '../src/documents/document-storage.service';
import { AppModule } from '../src/app.module';
import { MastraService } from '../src/ai/mastra.service';
import { fauxMastraService } from './faux-mastra.service';
import { ExpensesService } from '../src/expenses/expenses.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { ReportingPeriodsService } from '../src/reporting-periods/reporting-periods.service';
import { CategoryService } from '../src/categories/category.service';
import { CorrectionsService } from '../src/corrections/corrections.service';
import { AuditLogService } from '../src/audit-log/audit-log.service';
import { ZodValidationPipe } from '../src/common/pipes/zod-validation.pipe';
import { Expense } from '../src/expenses/types';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

describe('Expenses document-metadata PATCH E2E', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let root: string;
  let token: string;

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

    root = mkdtempSync(join(tmpdir(), 'expenses-metadata-e2e-'));

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
      .useValue(db)
      .overrideProvider(DOCUMENT_STORAGE_ROOT)
      .useValue(root)
      .overrideProvider(MastraService)
      .useValue(fauxMastraService)
      .overrideProvider(CategoryService)
      .useValue({
        list: () => Promise.resolve([]),
        isValid: () => Promise.resolve(true),
        assertValid: async () => {},
      })
      // Issue #203: the FX rate source is the ONE boundary at which
      // authoritative rates enter the system. An e2e test binds it to a
      // deterministic fixture, so booting the app never reaches the ECB.
      .overrideProvider(FX_RATE_SOURCE)
      .useValue(new FixtureFxRateSource(ECB_FIXTURE_RATES))
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
    await app.listen(0, '127.0.0.1');

    token = 'test-token-expenses-metadata-12345';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await db
      .insertInto('api_token')
      .values({ token_hash: tokenHash, label: 'e2e-test' })
      .execute();
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  describe('Expense create operation keys (#420)', () => {
    const facts = {
      category: 'software',
      gross_amount: 4303,
      vat_amount: 0,
      currency: 'EUR',
      tax_point_date: '2026-09-10',
    };
    const create = (key?: string, body: object = facts) => {
      const r = request(app.getHttpServer())
        .post('/api/expenses')
        .set('Authorization', `Bearer ${token}`);
      return (key === undefined ? r : r.set('Idempotency-Key', key)).send(body);
    };
    const count = async (
      table: 'expense' | 'expense_create_operation' | 'audit_log',
    ) =>
      (
        await db
          .selectFrom(table)
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .executeTakeFirstOrThrow()
      ).n;

    it('replays the original response for explicit and concurrent retries with one persisted Expense', async () => {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => create('same-create').expect(201)),
      );
      for (const r of responses) expect(r.body).toEqual(responses[0].body);
      expect(await count('expense')).toBe(1);
      expect(await count('expense_create_operation')).toBe(1);
      expect((await create('same-create').expect(201)).body).toEqual(
        responses[0].body,
      );
    });

    it('conflicts on changed facts, including concurrent changed-payload claims', async () => {
      const outcomes = await Promise.all([
        create('racing-facts', facts),
        create('racing-facts', { ...facts, gross_amount: 9900 }),
      ]);
      expect(outcomes.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await count('expense')).toBe(1);
      expect(await count('expense_create_operation')).toBe(1);
      expect(outcomes.find((r) => r.status === 409)?.body.message).toContain(
        'different expense facts',
      );
    });

    it('normalizes optional insert defaults and request object order', async () => {
      const first = await create('normalized').expect(201);
      const replay = await create('normalized', {
        ...facts,
        supplier_id: null,
        document_id: null,
        service_place_rule: 'general',
        allow_duplicate: false,
      }).expect(201);
      expect(replay.body).toEqual(first.body);
      expect(await count('expense')).toBe(1);
    });

    it('allows separate keys and legacy no-key calls for identical supplier-less facts', async () => {
      const rows = await Promise.all([
        create('separate-one'),
        create('separate-two'),
        create(),
        create(),
      ]);
      expect(rows.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      expect(new Set(rows.map((r) => r.body.id)).size).toBe(4);
      expect(await count('expense')).toBe(4);
      expect(await count('expense_create_operation')).toBe(2);
    });

    it('replays draft creation after real posting without posting another voucher', async () => {
      const original = await create('posted-create').expect(201);
      const expenses = app.get(ExpensesService);
      const draft = await expenses.generateDraftVoucher(original.body.id);
      const posted = await app.get(PostingService).postVoucher(draft);
      await expenses.updateExpenseStatus(original.body.id, 'posted', posted.id);
      expect((await create('posted-create').expect(201)).body).toEqual(
        original.body,
      );
      expect((await expenses.getExpenseById(original.body.id)).status).toBe(
        'posted',
      );
      expect(
        await db.selectFrom('voucher').select('id').execute(),
      ).toHaveLength(1);
    });

    it('keeps the original create snapshot after edits and deletion, without resurrection', async () => {
      const original = await create('historic-create').expect(201);
      const expenses = app.get(ExpensesService);
      await expenses.updateDraft(original.body.id, { gross_amount: 9000 });
      expect((await create('historic-create').expect(201)).body).toEqual(
        original.body,
      );
      expect(
        (await expenses.getExpenseById(original.body.id)).gross_amount,
      ).toBe(9000);
      await expenses.deleteDraft(original.body.id);
      expect((await create('historic-create').expect(201)).body).toEqual(
        original.body,
      );
      expect(await count('expense')).toBe(0);
      expect(await count('expense_create_operation')).toBe(1);
    });

    it('retains the purchase duplicate guard and rolls back failed create/key/override audit together', async () => {
      const now = Math.floor(Date.now() / 1000);
      const supplier = await db
        .insertInto('entity')
        .values({
          role: 'supplier',
          country: 'IE',
          name: 'Synthetic #420 supplier',
          created_at: now,
          updated_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const input = {
        ...facts,
        supplier_id: supplier.id,
        supplier_invoice_number: 'QA420-1',
      };
      await create(undefined, input).expect(201);
      await create('refused-duplicate', input).expect(409);
      expect(await count('expense_create_operation')).toBe(0);
      const audit = app.get(AuditLogService);
      const fail = jest
        .spyOn(audit, 'record')
        .mockRejectedValueOnce(new Error('synthetic audit failure'));
      await create('override-create', {
        ...input,
        allow_duplicate: true,
      }).expect(500);
      fail.mockRestore();
      expect(await count('expense')).toBe(1);
      expect(await count('expense_create_operation')).toBe(0);
      const override = { ...input, allow_duplicate: true };
      const accepted = await create('override-create', override).expect(201);
      const auditCount = await count('audit_log');
      expect(
        (await create('override-create', override).expect(201)).body,
      ).toEqual(accepted.body);
      expect(await count('audit_log')).toBe(auditCount);
      expect(await count('expense')).toBe(2);
      expect(await count('expense_create_operation')).toBe(1);
    });

    it('rejects invalid key syntax and invalid create bodies without storing a claim', async () => {
      await create('bad key').expect(400);
      await create('x'.repeat(129)).expect(400);
      await create('valid-key', { ...facts, gross_amount: -1 }).expect(400);
      expect(await count('expense')).toBe(0);
      expect(await count('expense_create_operation')).toBe(0);
    });
  });

  async function seedPostedExpense(
    app: INestApplication<App>,
    { gross, vat, date }: { gross: number; vat: number; date: string },
  ): Promise<Expense> {
    const expensesService = app.get(ExpensesService);
    const postingService = app.get(PostingService);

    const expense = await expensesService.createExpense({
      category: 'office',
      gross_amount: gross,
      vat_amount: vat,
      currency: 'EUR',
      tax_point_date: date,
    });

    const draft = await expensesService.generateDraftVoucher(expense.id);
    const posted = await postingService.postVoucher(draft);
    await expensesService.updateExpenseStatus(expense.id, 'posted', posted.id);
    return expensesService.getExpenseById(expense.id);
  }

  it('GET list excludes cancelled rows before aggregation and exposes explicit history and detail', async () => {
    const cancelled = await seedPostedExpense(app, {
      gross: 10000,
      vat: 0,
      date: '2026-03-15',
    });
    const replacement = await seedPostedExpense(app, {
      gross: 8000,
      vat: 0,
      date: '2026-04-15',
    });
    const corrections = app.get(CorrectionsService);
    await corrections.correctExpense(cancelled.id, {
      kind: 'reversal',
      reason: 'Cancelled',
    });
    await corrections.correctExpense(replacement.id, {
      kind: 'financial',
      reason: 'Restated',
      patch: { gross_amount: 5000 },
    });
    const get = (path: string) =>
      request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token}`);
    const active = await get('/api/expenses').expect(200);
    expect(active.body.expenses).toEqual([
      expect.objectContaining({
        id: replacement.id,
        effective_gross_amount: 5000,
        cancelled: false,
      }),
    ]);
    const history = await get('/api/expenses?include_cancelled=1').expect(200);
    expect(history.body.expenses).toHaveLength(2);
    expect(history.body.expenses[0]).toMatchObject({
      id: cancelled.id,
      effective_gross_amount: 0,
      cancelled: true,
    });
    await get(`/api/expenses/${cancelled.id}`).expect(200);
    expect(
      (await get('/api/expenses?include_cancelled=0').expect(200)).body
        .expenses,
    ).toHaveLength(1);
  });

  async function lockPeriodCovering(
    app: INestApplication<App>,
    date: string,
  ): Promise<void> {
    const periodsService = app.get(ReportingPeriodsService);
    // Parse the date to derive a month-wide period
    const d = new Date(date);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const startDate = `${year}-${month}-01`;
    const lastDay = new Date(Date.UTC(year, d.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10);

    // Force-lock any earlier open periods directly in DB so the filing-order
    // guard in ReportingPeriodsService.lock() doesn't block us.
    const filedAt = Math.floor(Date.now() / 1000);
    await db
      .updateTable('reporting_period')
      .set({ status: 'locked', filed_at: filedAt })
      .where('status', '=', 'open')
      .where('start_date', '<', startDate)
      .execute();

    const period = await periodsService.create({
      name: `${year}-${month}`,
      start_date: startDate,
      end_date: lastDay,
    });
    await periodsService.lock(period.id);
  }

  it('sets supplier_invoice_number on a posted expense while the period is open', async () => {
    const e = await seedPostedExpense(app, {
      gross: 12000,
      vat: 2000,
      date: '2026-05-10',
    });
    const res = await request(app.getHttpServer())
      .patch(`/api/expenses/${e.id}/document-metadata`)
      .set('Authorization', `Bearer ${token}`)
      .send({ supplier_invoice_number: 'SUP-9' })
      .expect(200);
    expect(
      (res.body as { supplier_invoice_number: string }).supplier_invoice_number,
    ).toBe('SUP-9');
  });

  it('rejects the patch when the expense period is locked', async () => {
    const e = await seedPostedExpense(app, {
      gross: 12000,
      vat: 2000,
      date: '2026-05-10',
    });
    await lockPeriodCovering(app, '2026-05-10');
    await request(app.getHttpServer())
      .patch(`/api/expenses/${e.id}/document-metadata`)
      .set('Authorization', `Bearer ${token}`)
      .send({ supplier_invoice_number: 'SUP-9' })
      .expect(400);
  });
});
