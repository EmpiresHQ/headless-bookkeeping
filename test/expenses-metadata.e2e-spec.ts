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
      .compile();

    app = module.createNestApplication();
    await app.init();

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
