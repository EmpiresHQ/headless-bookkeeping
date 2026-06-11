import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { ApiTokenService } from '../auth/api-token.service';
import { OrganizationService } from '../organization/organization.service';
import { ReportingPeriodsService } from '../reporting-periods/reporting-periods.service';
import { VatReportService } from '../vat-report/vat-report.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { ExpensesService } from '../expenses/expenses.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
import { EntitiesService } from '../entities/entities.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { buildCli, CliDeps } from './cli';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { CategoryService } from '../categories/category.service';

// deleteDraft / delete only touch the DB (never the projection), so a null
// projection is safe for these unit tests.
const noProjection = null as unknown as VoucherProjectionService;
const noPeriodLock = null as unknown as PeriodLockService;
const noCategoryService = {
  list: () => Promise.resolve([]),
  isValid: () => Promise.resolve(true),
  assertValid: () => Promise.resolve(),
} as unknown as CategoryService;

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

// yargs surfaces validation errors synchronously via .fail; accept throw OR reject.
async function expectFailure(run: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await run();
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
}

describe('admin CLI (yargs)', () => {
  let db: Kysely<Database>;
  let deps: CliDeps;

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
    deps = {
      tokens: new ApiTokenService(db),
      organization: new OrganizationService(db),
      periods: new ReportingPeriodsService(
        db,
        new VatReportService(
          db,
          new LedgerBalanceService(db),
          new PluginLoader(new NullCountryPlugin(), new EstoniaCountryPlugin()),
          new OrganizationService(db),
        ),
      ),
      expenses: new ExpensesService(
        db,
        noProjection,
        noPeriodLock,
        noCategoryService,
      ),
      salesInvoices: new SalesInvoicesService(db, noProjection),
      entities: new EntitiesService(db),
    };
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('token', () => {
    it('create prints a plaintext token (stdout) that verifies', async () => {
      const { io, out, err } = makeIo();
      await buildCli(deps, io).parseAsync([
        'token',
        'create',
        '--label',
        'agent',
      ]);
      const token = out().trim();
      expect(token).toHaveLength(64);
      expect(err()).toContain('label=agent');
      expect(await deps.tokens.verify(token)).not.toBeNull();
    });

    it('list returns JSON without secrets; revoke invalidates', async () => {
      const c = makeIo();
      await buildCli(deps, c.io).parseAsync(['token', 'create']);
      const token = c.out().trim();
      const id = Number(/id=(\d+)/.exec(c.err())?.[1]);

      const l = makeIo();
      await buildCli(deps, l.io).parseAsync(['token', 'list']);
      expect(l.out()).not.toContain('token_hash');

      await buildCli(deps, makeIo().io).parseAsync([
        'token',
        'revoke',
        String(id),
      ]);
      expect(await deps.tokens.verify(token)).toBeNull();
    });

    it('revoke with a non-numeric id fails clearly', async () => {
      const { io, err } = makeIo();
      await expectFailure(() =>
        buildCli(deps, io).parseAsync(['token', 'revoke', 'nope']),
      );
      expect(err()).toMatch(/numeric <id>/);
    });
  });

  describe('org', () => {
    it('show prints the seeded organization (IE)', async () => {
      const { io, out } = makeIo();
      await buildCli(deps, io).parseAsync(['org', 'show']);
      expect((JSON.parse(out()) as { country: string }).country).toBe('IE');
    });

    it('set updates only the passed fields', async () => {
      const { io, out } = makeIo();
      await buildCli(deps, io).parseAsync([
        'org',
        'set',
        '--country',
        'DK',
        '--org-type',
        'company',
        '--vat-registered',
      ]);
      const org = JSON.parse(out()) as {
        country: string;
        org_type: string;
        vat_registered: boolean;
      };
      expect(org.country).toBe('DK');
      expect(org.org_type).toBe('company');
      expect(org.vat_registered).toBe(true);
    });
  });

  describe('period', () => {
    it('open creates a non-overlapping period and list shows it', async () => {
      const { io, out } = makeIo();
      await buildCli(deps, io).parseAsync([
        'period',
        'open',
        '--name',
        'FY2026',
        '--start',
        '2026-01-01',
        '--end',
        '2026-12-31',
      ]);
      expect((JSON.parse(out()) as { name: string }).name).toBe('FY2026');

      const l = makeIo();
      await buildCli(deps, l.io).parseAsync(['period', 'list']);
      const names = (JSON.parse(l.out()) as Array<{ name: string }>).map(
        (p) => p.name,
      );
      expect(names).toContain('FY2026');
    });

    it('open requires name/start/end', async () => {
      const { io } = makeIo();
      await expectFailure(() =>
        buildCli(deps, io).parseAsync(['period', 'open', '--name', 'X']),
      );
    });

    it('delete removes an empty period', async () => {
      const o = makeIo();
      await buildCli(deps, o.io).parseAsync([
        'period',
        'open',
        '--name',
        'FY2026',
        '--start',
        '2026-01-01',
        '--end',
        '2026-12-31',
      ]);
      const id = (JSON.parse(o.out()) as { id: number }).id;

      await buildCli(deps, makeIo().io).parseAsync([
        'period',
        'delete',
        String(id),
      ]);

      const l = makeIo();
      await buildCli(deps, l.io).parseAsync(['period', 'list']);
      const names = (JSON.parse(l.out()) as Array<{ name: string }>).map(
        (p) => p.name,
      );
      expect(names).not.toContain('FY2026');
    });
  });

  describe('cleanup deletes', () => {
    it('expense delete removes a draft expense', async () => {
      const e = await deps.expenses.createExpense({
        category: 'software',
        gross_amount: 1391,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-05-31',
      });
      await buildCli(deps, makeIo().io).parseAsync([
        'expense',
        'delete',
        String(e.id),
      ]);
      expect(await deps.expenses.getExpenses()).toHaveLength(0);
    });

    it('entity delete removes an unreferenced entity', async () => {
      const ent = await deps.entities.onboard({
        role: 'supplier',
        country: 'US',
        name: 'OpenRouter',
        registrationKey: 'US-OR-1',
      });
      await buildCli(deps, makeIo().io).parseAsync([
        'entity',
        'delete',
        String(ent.id),
      ]);
      expect(await deps.entities.list()).toHaveLength(0);
    });

    it('delete with a non-numeric id fails', async () => {
      const { io } = makeIo();
      await expectFailure(() =>
        buildCli(deps, io).parseAsync(['expense', 'delete', 'nope']),
      );
    });
  });

  it('unknown command fails and prints usage', async () => {
    const { io, err } = makeIo();
    await expectFailure(() => buildCli(deps, io).parseAsync(['bogus']));
    expect(err().length).toBeGreaterThan(0);
  });
});
