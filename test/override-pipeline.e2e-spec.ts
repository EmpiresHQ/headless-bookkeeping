import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../src/database/types';
import { migrations } from '../src/database/migrations';
import { AppModule } from '../src/app.module';
import { NullCountryPlugin } from '../src/plugins/null-country.plugin';
import {
  CategoryMappingResult,
  SupplierFacts,
  OrgContext,
} from '../src/plugins/country-plugin.interface';
import request from 'supertest';
import { App } from 'supertest/types';

/**
 * A strict test plugin that extends NullCountryPlugin but rejects
 * a specific VAT code so we can exercise the override path
 * end-to-end.  NullCountryPlugin is permissive by design; this
 * plugin exists ONLY for testing the override pipeline.
 */
class StrictTestPlugin extends NullCountryPlugin {
  private static readonly REJECTED_VAT = 'STRICT_REJECTED';

  override getName(): string {
    return 'strict-test';
  }

  override getVATCodes(): string[] {
    return [...super.getVATCodes(), StrictTestPlugin.REJECTED_VAT];
  }

  override resolveCategoryMapping(
    category: string,
    supplierFacts: SupplierFacts,
    orgContext: OrgContext,
  ): CategoryMappingResult {
    if (category === 'strict-test-category') {
      return {
        accountCode: 'EXPENSE_OTHER',
        vatCode: StrictTestPlugin.REJECTED_VAT,
      };
    }
    return super.resolveCategoryMapping(category, supplierFacts, orgContext);
  }

  override validateVATCode(
    vatCode: string,
    context: { supplier: SupplierFacts; org: OrgContext },
  ): boolean {
    if (vatCode === StrictTestPlugin.REJECTED_VAT) {
      return false;
    }
    return super.validateVATCode(vatCode, context);
  }
}

interface PostResponse {
  expense: { status: string; voucher_id: number; currency: string };
  voucher: { id: number; lines: unknown[] } | null;
  policy: { action: string };
}

describe('Override Pipeline E2E', () => {
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
    if (error) {
      throw error instanceof Error ? error : new Error('Migration failed');
    }

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
      .useValue(db)
      .overrideProvider(NullCountryPlugin)
      .useClass(StrictTestPlugin)
      .compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  it('without override: semantic failure holds for approval', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/expenses')
      .send({
        category: 'strict-test-category',
        gross_amount: 10000,
        vat_amount: 2000,
        currency: 'EUR',
        tax_point_date: '2025-06-01',
      })
      .expect(201)
      .then((r) => r.body as { id: number });
    const expenseId = created.id;

    const posted = await request(app.getHttpServer())
      .post(`/api/expenses/${expenseId}/post`)
      .send({})
      .expect(201)
      .then((r) => r.body as PostResponse);

    expect(posted.expense.status).toBe('pending');
    expect(posted.voucher).toBeNull();
    expect(posted.policy.action).toBe('hold-for-approval');
  });

  it('with override: posts voucher and persists exactly one override row atomically', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/expenses')
      .send({
        category: 'strict-test-category',
        gross_amount: 10000,
        vat_amount: 2000,
        currency: 'EUR',
        tax_point_date: '2025-06-01',
      })
      .expect(201)
      .then((r) => r.body as { id: number });
    const expenseId = created.id;

    const override = { ruleType: 'semantic', reason: 'e2e test override' };
    const posted = await request(app.getHttpServer())
      .post(`/api/expenses/${expenseId}/post`)
      .send(override)
      .expect(201)
      .then((r) => r.body as PostResponse);

    expect(posted.expense.status).toBe('posted');
    expect(posted.expense.voucher_id).toBeGreaterThan(0);
    expect(posted.voucher).toBeDefined();
    expect(posted.policy.action).toBe('auto-post');
    expect(posted.voucher!.id).toBe(posted.expense.voucher_id);
    expect(posted.voucher!.lines).toBeDefined();

    // Verify exactly one override row exists in the DB.
    const overrideRows = await db
      .selectFrom('override')
      .selectAll()
      .where('business_object_type', '=', 'expense')
      .where('business_object_id', '=', expenseId)
      .execute();
    expect(overrideRows).toHaveLength(1);

    const row = overrideRows[0];
    expect(row.rule_type).toBe('semantic');
    expect(row.rule_name).toBe('semantic');
    expect(row.reason).toBe('e2e test override');
    expect(row.created_by).toBe('system');
    expect(row.created_at).toBeGreaterThan(0);
  });

  it('with override: NullCountryPlugin still passes normal expenses (no regression)', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/expenses')
      .send({
        category: 'software',
        gross_amount: 10000,
        vat_amount: 2000,
        currency: 'EUR',
        tax_point_date: '2025-06-01',
      })
      .expect(201)
      .then((r) => r.body as { id: number });
    const expenseId = created.id;

    // Post without override — should auto-post since all rules pass.
    const posted = await request(app.getHttpServer())
      .post(`/api/expenses/${expenseId}/post`)
      .send({})
      .expect(201)
      .then((r) => r.body as PostResponse);

    expect(posted.expense.status).toBe('posted');
    expect(posted.voucher).toBeDefined();
    expect(posted.policy.action).toBe('auto-post');

    // No override row logged.
    const overrideRows = await db
      .selectFrom('override')
      .selectAll()
      .where('business_object_type', '=', 'expense')
      .where('business_object_id', '=', expenseId)
      .execute();
    expect(overrideRows).toHaveLength(0);
  });

  it('double post is idempotent even with override', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/expenses')
      .send({
        category: 'strict-test-category',
        gross_amount: 10000,
        vat_amount: 2000,
        currency: 'EUR',
        tax_point_date: '2025-06-01',
      })
      .expect(201)
      .then((r) => r.body as { id: number });
    const expenseId = created.id;

    const override = { ruleType: 'semantic', reason: 'e2e test override' };

    // First post succeeds.
    await request(app.getHttpServer())
      .post(`/api/expenses/${expenseId}/post`)
      .send(override)
      .expect(201);

    // Second post returns 409 (idempotency guard).
    await request(app.getHttpServer())
      .post(`/api/expenses/${expenseId}/post`)
      .send(override)
      .expect(409);

    // Still exactly one override row (not duplicated).
    const overrideRows = await db
      .selectFrom('override')
      .selectAll()
      .where('business_object_type', '=', 'expense')
      .where('business_object_id', '=', expenseId)
      .execute();
    expect(overrideRows).toHaveLength(1);
  });
});
