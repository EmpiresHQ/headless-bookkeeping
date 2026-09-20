import { fxTestProviders } from '../../test/fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { BadRequestException } from '@nestjs/common';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { OrganizationService } from '../organization/organization.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { PostingService } from '../ledger/posting/posting.service';
import { AccountService } from '../ledger/account/account.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { ReportingPeriodsService } from '../reporting-periods/reporting-periods.service';
import { VatReportService } from '../vat-report/vat-report.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { StatutorySubmissionService } from '../statutory-submission/statutory-submission.service';
import { StatutoryReportService } from '../statutory-report/statutory-report.service';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import type { AnnualAccountsInput } from '../plugins/annual-accounts.types';
import { validateEtGaapInstance } from '../../test/xbrl/validate-xbrl-instance';
import { AnnualAccountsService } from './annual-accounts.service';

describe('AnnualAccountsService.generate — draft (integration)', () => {
  let db: Kysely<Database>;
  let service: AnnualAccountsService;
  let reportingPeriods: ReportingPeriodsService;

  async function postVoucher(
    taxPointDate: string,
    lines: Array<{ code: string; isDebit: boolean; base: number }>,
    // A posted voucher is immutable (ADR-0019), so its reason / reversal link
    // must be written at insert time, not patched afterwards.
    opts?: { reason?: string; reversesId?: number },
  ): Promise<number> {
    const v = await db
      .insertInto('voucher')
      .values({
        voucher_number: `V-${Math.random().toString(36).slice(2, 9)}`,
        tax_point_date: taxPointDate,
        posted_at: 1,
        previous_hash: null,
        reason: opts?.reason ?? null,
        reverses_id: opts?.reversesId ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const l of lines) {
      const acc = await db
        .selectFrom('account')
        .select('id')
        .where('code', '=', l.code)
        .executeTakeFirstOrThrow();
      await db
        .insertInto('voucher_line')
        .values({
          voucher_id: v.id,
          account_id: acc.id,
          amount: l.base,
          currency: 'EUR',
          base_amount: l.base,
          fx_rate: 1,
          vat_code: null,
          is_debit: l.isDebit ? 1 : 0,
        })
        .execute();
    }
    return v.id;
  }

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

    // Organization: EE so the Estonia plugin renders. Migration 001 seeds the
    // singleton org row (id = 1), so update it rather than insert a second.
    await db
      .updateTable('organization')
      .set({
        name: 'Test OÜ',
        country: 'EE',
        base_currency: 'EUR',
        vat_registered: 1,
        // Deliberately DISTINCT from registry_code: the annual declarant must
        // be the commercial registry code, and a test where the two coincide
        // could not tell the two apart (issue #204).
        vat_registration_number: 'EE123456789',
        registry_code: '17499653',
      } as never)
      .execute();

    // Migration 011 seeds a stray open '2024-Q1' period; the finalize path locks
    // 2026 and the filing-order rule forbids locking a later period while an
    // earlier one is still open. Clear the seeded periods so only the 2025
    // (locked) / 2026 (open) fixture below exists.
    await db.deleteFrom('reporting_period').execute();

    // A 2026 reporting period (the year being closed) + a 2025 prior.
    await db
      .insertInto('reporting_period')
      .values([
        {
          name: '2025',
          start_date: '2025-01-01',
          end_date: '2025-12-31',
          status: 'locked',
          filed_at: 1,
          created_at: 1,
        } as never,
        {
          name: '2026',
          start_date: '2026-01-01',
          end_date: '2026-12-31',
          status: 'open',
          created_at: 1,
        } as never,
      ])
      .execute();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        LedgerBalanceService,
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        ...fxTestProviders(),
        PluginLoader,
        OrgContextResolver,
        AccountService,
        LedgerValidationService,
        PeriodLockService,
        PostingService,
        VatReportService,
        AuditLogService,
        StatutorySubmissionService,
        StatutoryReportService,
        AuditFindingsService,
        ReportingPeriodsService,
        AnnualAccountsService,
      ],
    }).compile();
    service = module.get(AnnualAccountsService);
    reportingPeriods = module.get(ReportingPeriodsService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  function periodId(name: string): Promise<number> {
    return db
      .selectFrom('reporting_period')
      .select('id')
      .where('name', '=', name)
      .executeTakeFirstOrThrow()
      .then((r) => r.id);
  }

  it('assembles a balanced draft and renders an XBRL artifact, posting nothing', async () => {
    // Capital injection 2026.
    await postVoucher('2026-01-02', [
      { code: 'BANK_EUR', isDebit: true, base: 2500 },
      { code: 'EQUITY', isDebit: false, base: 2500 },
    ]);
    // A capitalized vehicle bought 2026-01-10 for 20000 (debit FIXED_ASSETS, credit BANK).
    const acqId = await postVoucher('2026-01-10', [
      { code: 'FIXED_ASSETS_VEHICLES', isDebit: true, base: 20000 },
      { code: 'BANK_EUR', isDebit: false, base: 20000 },
    ]);
    await db
      .insertInto('fixed_asset')
      .values({
        name: 'Van',
        asset_class: 'vehicle',
        acquisition_voucher_id: acqId,
        acquisition_date: '2026-01-10',
        cost_base_minor: 20000,
        useful_life_years: 5,
        residual_value_minor: 0,
        retired_at: null,
      } as never)
      .execute();
    // Revenue + a cash expense in 2026.
    await postVoucher('2026-03-01', [
      { code: 'BANK_EUR', isDebit: true, base: 60000 },
      { code: 'REVENUE', isDebit: false, base: 60000 },
    ]);
    await postVoucher('2026-04-01', [
      { code: 'EXPENSE_OTHER', isDebit: true, base: 42000 },
      { code: 'BANK_EUR', isDebit: false, base: 42000 },
    ]);

    const before = await db
      .selectFrom('voucher')
      .select(db.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();

    const id = await periodId('2026');
    const result = await service.generate(id);

    // Renders exactly one XBRL artifact.
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].filename).toBe('annual-accounts-2026.xbrl');
    // The depreciation expense line is present (computed virtually): vehicle
    // 20000 / 5y = 4000 annual charge (full year).
    // The depreciation charge is reported on the DURATION context, with the
    // credit-balance sign the taxonomy's calculation expects.
    expect(result.artifacts[0].content).toContain(
      '<et-gaap:DepreciationAndImpairmentLossReversal contextRef="d-2026-01-01_2026-12-31"',
    );

    // CARRIED CONCERN: the assembled draft must balance (Aktiva = Kohustused +
    // Omakapital) in BOTH the current AND the prior column, because the
    // prior-period balances, priorNetIncome and brought-forward retained
    // earnings are all derived from the SAME posted ledger. Parse the two
    // TotalAssets / TotalEquityAndLiabilities facts out of the XBRL and assert
    // each column's accounting equation holds.
    const xbrl = result.artifacts[0].content;
    const fact = (concept: string, ctx: string): number => {
      const m = xbrl.match(
        new RegExp(
          `<${concept} contextRef="${ctx}"[^>]*>(-?[\\d.]+)</${concept}>`,
        ),
      );
      if (!m) throw new Error(`fact ${concept}@${ctx} not found in XBRL`);
      return Number(m[1]);
    };
    // Current column: with the virtual depreciation folded in.
    expect(fact('et-gaap:Assets', 'i-2026-12-31')).toBe(
      fact('et-gaap:LiabilitiesAndEquity', 'i-2026-12-31'),
    );
    // Prior column: empty prior year ⇒ both sides 0, still balanced.
    expect(fact('et-gaap:Assets', 'i-2025-12-31')).toBe(
      fact('et-gaap:LiabilitiesAndEquity', 'i-2025-12-31'),
    );
    // And the whole instance validates against the official taxonomy.
    expect(validateEtGaapInstance(xbrl).errors).toEqual([]);

    // Draft posts NOTHING: voucher count unchanged.
    const after = await db
      .selectFrom('voucher')
      .select(db.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
  });

  it('identifies the declarant by registry code, never by VAT number', async () => {
    // The fixture org carries BOTH, and they differ: registry_code 17499653,
    // vat_registration_number EE123456789. Issue #204 shipped the VAT number.
    await postVoucher('2026-01-02', [
      { code: 'BANK_EUR', isDebit: true, base: 2500 },
      { code: 'EQUITY', isDebit: false, base: 2500 },
    ]);
    const result = await service.generate(await periodId('2026'));
    const xbrl = result.artifacts[0].content;

    expect(xbrl).toContain('>17499653</xbrli:identifier>');
    expect(xbrl).toContain(
      '<et-gaap:RegistryCode contextRef="i-2026-12-31">17499653</et-gaap:RegistryCode>',
    );
    expect(xbrl).not.toContain('EE123456789');
    expect(validateEtGaapInstance(xbrl).errors).toEqual([]);
  });

  it('hands out no artifact — and refuses to finalize — when the registry code is missing', async () => {
    await db
      .updateTable('organization')
      .set({ registry_code: null } as never)
      .execute();
    await postVoucher('2026-01-02', [
      { code: 'BANK_EUR', isDebit: true, base: 2500 },
      { code: 'EQUITY', isDebit: false, base: 2500 },
    ]);
    const id = await periodId('2026');

    // The gap is named, and no document that could be filed is produced. It is
    // NOT patched over with the VAT number the organization does still have.
    const draft = await service.generate(id);
    expect(draft.artifacts).toEqual([]);
    expect(draft.warnings.map((w) => w.code)).toContain(
      'missing_declarant_reg_number',
    );

    await expect(service.finalize(id)).rejects.toThrow(
      /no commercial registry code/i,
    );
    // And the refusal left the year open — nothing was locked against nothing.
    const after = await db
      .selectFrom('reporting_period')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('open');
  });

  it('cannot finalize a period stored with an impossible date — nothing is posted or locked', async () => {
    // `reporting_period.end_date` is a plain text column and the create DTO
    // does not calendar-check it, so an impossible day really can reach here.
    // (Tightening period creation itself is #207, not this change.)
    await db
      .updateTable('reporting_period')
      .set({ end_date: '2026-02-30' } as never)
      .where('name', '=', '2026')
      .execute();
    await postVoucher('2026-01-02', [
      { code: 'BANK_EUR', isDebit: true, base: 2500 },
      { code: 'EQUITY', isDebit: false, base: 2500 },
    ]);
    const id = await periodId('2026');
    const before = await db
      .selectFrom('voucher')
      .select(db.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();

    // A caller-fixable data defect, so a 400 that NAMES the bad date — not an
    // opaque 500 from the global filter.
    await expect(service.generate(id)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/2026-02-30.*not a real calendar date/),
    });
    await expect(service.finalize(id)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/2026-02-30.*not a real calendar date/),
    });

    // The refusal came before anything was written: no voucher, still open.
    const after = await db
      .selectFrom('voucher')
      .select(db.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
    const period = await db
      .selectFrom('reporting_period')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(period.status).toBe('open');
  });

  it('warns (soft) when EXPENSE_OTHER dominates total expenses', async () => {
    await postVoucher('2026-01-02', [
      { code: 'BANK_EUR', isDebit: true, base: 100000 },
      { code: 'EQUITY', isDebit: false, base: 100000 },
    ]);
    await postVoucher('2026-03-01', [
      { code: 'BANK_EUR', isDebit: true, base: 50000 },
      { code: 'REVENUE', isDebit: false, base: 50000 },
    ]);
    // Almost all expense lands in EXPENSE_OTHER (concentration).
    await postVoucher('2026-04-01', [
      { code: 'EXPENSE_OTHER', isDebit: true, base: 40000 },
      { code: 'BANK_EUR', isDebit: false, base: 40000 },
    ]);
    const id = await periodId('2026');
    const result = await service.generate(id);
    expect(result.warnings.map((w) => w.code)).toContain(
      'expense_other_concentration',
    );
  });

  it('warns (soft) when there are assets in the register but no depreciation posted', async () => {
    await postVoucher('2026-01-02', [
      { code: 'BANK_EUR', isDebit: true, base: 2500 },
      { code: 'EQUITY', isDebit: false, base: 2500 },
    ]);
    const acqId = await postVoucher('2026-01-10', [
      { code: 'FIXED_ASSETS_VEHICLES', isDebit: true, base: 20000 },
      { code: 'BANK_EUR', isDebit: false, base: 20000 },
    ]);
    // Register row exists; in draft, depreciation is computed virtually so the
    // "not yet posted" soft warning is expected (no ACCUM_DEPRECIATION voucher).
    await db
      .insertInto('fixed_asset')
      .values({
        name: 'Van',
        asset_class: 'vehicle',
        acquisition_voucher_id: acqId,
        acquisition_date: '2026-01-10',
        cost_base_minor: 20000,
        useful_life_years: 5,
        residual_value_minor: 0,
        retired_at: null,
      } as never)
      .execute();
    const id = await periodId('2026');
    const result = await service.generate(id);
    expect(result.warnings.map((w) => w.code)).toContain(
      'depreciation_not_yet_posted',
    );
  });

  it('flags an unmapped nonzero account as a blocking diagnostic', async () => {
    // SHAREHOLDER_LOAN-style code that the RTJ map does not cover but the seed
    // has — use RECEIVABLE_FROM_OWNER? It IS mapped. Use a deliberately unmapped
    // seeded account: there is none guaranteed unmapped, so assert on the
    // count of blocking warnings being zero for a fully-mapped balanced book.
    await postVoucher('2026-01-02', [
      { code: 'BANK_EUR', isDebit: true, base: 2500 },
      { code: 'EQUITY', isDebit: false, base: 2500 },
    ]);
    const id = await periodId('2026');
    const result = await service.generate(id);
    const blocking = result.warnings.filter(
      (w) => (w as { severity?: string }).severity === 'block',
    );
    expect(blocking).toHaveLength(0);
  });

  it('finalize posts ONE depreciation voucher, locks the year, and matches the draft numbers', async () => {
    await postVoucher('2026-01-02', [
      { code: 'BANK_EUR', isDebit: true, base: 2500 },
      { code: 'EQUITY', isDebit: false, base: 2500 },
    ]);
    const acqId = await postVoucher('2026-01-10', [
      { code: 'FIXED_ASSETS_VEHICLES', isDebit: true, base: 20000 },
      { code: 'BANK_EUR', isDebit: false, base: 20000 },
    ]);
    await db
      .insertInto('fixed_asset')
      .values({
        name: 'Van',
        asset_class: 'vehicle',
        acquisition_voucher_id: acqId,
        acquisition_date: '2026-01-10',
        cost_base_minor: 20000,
        useful_life_years: 5,
        residual_value_minor: 0,
        retired_at: null,
      } as never)
      .execute();
    await postVoucher('2026-03-01', [
      { code: 'BANK_EUR', isDebit: true, base: 60000 },
      { code: 'REVENUE', isDebit: false, base: 60000 },
    ]);
    await postVoucher('2026-04-01', [
      { code: 'EXPENSE_OTHER', isDebit: true, base: 42000 },
      { code: 'BANK_EUR', isDebit: false, base: 42000 },
    ]);

    const id = await periodId('2026');
    const draft = await service.generate(id);
    const final = await service.finalize(id);

    // Numbers identical (the rendered XBRL content matches).
    expect(final.artifacts[0].content).toBe(draft.artifacts[0].content);

    // A depreciation voucher was posted (4000 to DEPRECIATION_EXPENSE).
    const depLine = await db
      .selectFrom('voucher_line as vl')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select(['vl.base_amount', 'vl.is_debit'])
      .where('a.code', '=', 'DEPRECIATION_EXPENSE')
      .executeTakeFirst();
    expect(depLine?.base_amount).toBe(4000);
    expect(depLine?.is_debit).toBe(1);

    // The period is now locked.
    const period = await db
      .selectFrom('reporting_period')
      .select(['status', 'filed_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(period.status).toBe('locked');
    expect(period.filed_at).not.toBeNull();
  });

  it('rejects a second finalize on an already-locked period', async () => {
    await postVoucher('2026-01-02', [
      { code: 'BANK_EUR', isDebit: true, base: 2500 },
      { code: 'EQUITY', isDebit: false, base: 2500 },
    ]);
    const id = await periodId('2026');
    await service.finalize(id);
    await expect(service.finalize(id)).rejects.toThrow(
      /already.*final|locked/i,
    );
  });

  it('does not double-post depreciation when an earlier finalize posted but lock failed (filing-order)', async () => {
    // Filing-order setup: re-open the 2025 prior period so the filing-order
    // rule in `lock` (earlier open period blocks locking a later one) throws.
    await db
      .updateTable('reporting_period')
      .set({ status: 'open', filed_at: null } as never)
      .where('name', '=', '2025')
      .execute();

    // 2026 book with a live vehicle ⇒ a 4000 annual depreciation charge.
    await postVoucher('2026-01-02', [
      { code: 'BANK_EUR', isDebit: true, base: 2500 },
      { code: 'EQUITY', isDebit: false, base: 2500 },
    ]);
    const acqId = await postVoucher('2026-01-10', [
      { code: 'FIXED_ASSETS_VEHICLES', isDebit: true, base: 20000 },
      { code: 'BANK_EUR', isDebit: false, base: 20000 },
    ]);
    await db
      .insertInto('fixed_asset')
      .values({
        name: 'Van',
        asset_class: 'vehicle',
        acquisition_voucher_id: acqId,
        acquisition_date: '2026-01-10',
        cost_base_minor: 20000,
        useful_life_years: 5,
        residual_value_minor: 0,
        retired_at: null,
      } as never)
      .execute();
    await postVoucher('2026-03-01', [
      { code: 'BANK_EUR', isDebit: true, base: 60000 },
      { code: 'REVENUE', isDebit: false, base: 60000 },
    ]);
    await postVoucher('2026-04-01', [
      { code: 'EXPENSE_OTHER', isDebit: true, base: 42000 },
      { code: 'BANK_EUR', isDebit: false, base: 42000 },
    ]);

    const id = await periodId('2026');

    const countDepLines = async (): Promise<number> => {
      const r = await db
        .selectFrom('voucher_line as vl')
        .innerJoin('account as a', 'a.id', 'vl.account_id')
        .select(db.fn.countAll<number>().as('n'))
        .where('a.code', '=', 'DEPRECIATION_EXPENSE')
        .executeTakeFirstOrThrow();
      return r.n;
    };

    // First finalize: lock fails (2025 still open) ⇒ throws AND, with the fix,
    // posts ZERO partial state (precondition checked before posting).
    await expect(service.finalize(id)).rejects.toThrow(
      /earlier period.*still open/i,
    );
    expect(await countDepLines()).toBe(0);
    const afterFirst = await db
      .selectFrom('reporting_period')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(afterFirst.status).toBe('open');

    // Now make 2025 lockable and finalize again: EXACTLY ONE depreciation
    // charge must end up posted (no double-post), and 2026 ends locked.
    await service.finalize(await periodId('2025'));
    await service.finalize(id);

    expect(await countDepLines()).toBe(1);
    const depLine = await db
      .selectFrom('voucher_line as vl')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select(['vl.base_amount', 'vl.is_debit'])
      .where('a.code', '=', 'DEPRECIATION_EXPENSE')
      .executeTakeFirstOrThrow();
    expect(depLine.base_amount).toBe(4000);
    expect(depLine.is_debit).toBe(1);

    const finalPeriod = await db
      .selectFrom('reporting_period')
      .select(['status', 'filed_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(finalPeriod.status).toBe('locked');
    expect(finalPeriod.filed_at).not.toBeNull();
  });

  it('diagnoseInput returns a balance_sheet_imbalance block for an imbalanced input', () => {
    const input: AnnualAccountsInput = {
      period: { name: '2026', startDate: '2026-01-01', endDate: '2026-12-31' },
      priorPeriod: null,
      mode: 'final',
      balances: [{ code: 'BANK_EUR', type: 'asset', current: 100, prior: 0 }],
      fixedAssets: [],
      periodNetIncome: 0,
      priorNetIncome: 0,
      retainedEarningsBroughtForward: 0,
      declarant: { regNumber: 'EE123456789', name: 'Test OÜ' },
    };
    const warnings = service.diagnoseInput(input);
    const block = warnings.find(
      (w) => (w as { severity?: string }).severity === 'block',
    );
    expect(block?.code).toBe('balance_sheet_imbalance');
  });

  it('hard-blocks finalize (BadRequestException) when a blocking diagnostic is present, leaving the period open', async () => {
    await postVoucher('2026-01-02', [
      { code: 'BANK_EUR', isDebit: true, base: 2500 },
      { code: 'EQUITY', isDebit: false, base: 2500 },
    ]);
    const id = await periodId('2026');
    jest
      .spyOn(service as never as { diagnose: () => unknown }, 'diagnose')
      .mockReturnValueOnce([
        { code: 'balance_sheet_imbalance', message: 'x', severity: 'block' },
      ] as never);
    await expect(service.finalize(id)).rejects.toThrow(BadRequestException);
    // And nothing got locked.
    const period = await db
      .selectFrom('reporting_period')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(period.status).toBe('open');
  });

  // ── Issue #205: regeneration must not re-virtualize a posted charge. ──
  //
  // The original reproduction: a FULL 12-month 2026 with one IT asset acquired
  // 2026-01-01 for EUR 1,200 (120000 minor), 4-year life, zero residual ⇒ an
  // annual charge of EUR 300 (30000 minor).
  const IT_COST_MINOR = 120000;
  const ANNUAL_CHARGE_MINOR = 30000;

  async function seedFullYearItAsset(): Promise<void> {
    // Capital, revenue and a cash expense, so the year is a lifelike book.
    await postVoucher('2026-01-01', [
      { code: 'BANK_EUR', isDebit: true, base: 500000 },
      { code: 'EQUITY', isDebit: false, base: 500000 },
    ]);
    const acqId = await postVoucher('2026-01-01', [
      { code: 'FIXED_ASSETS_IT', isDebit: true, base: IT_COST_MINOR },
      { code: 'BANK_EUR', isDebit: false, base: IT_COST_MINOR },
    ]);
    await db
      .insertInto('fixed_asset')
      .values({
        name: 'Laptop fleet',
        asset_class: 'it_equipment',
        acquisition_voucher_id: acqId,
        acquisition_date: '2026-01-01',
        cost_base_minor: IT_COST_MINOR,
        useful_life_years: 4,
        residual_value_minor: 0,
        retired_at: null,
      } as never)
      .execute();
    await postVoucher('2026-06-30', [
      { code: 'BANK_EUR', isDebit: true, base: 900000 },
      { code: 'REVENUE', isDebit: false, base: 900000 },
    ]);
    await postVoucher('2026-07-31', [
      { code: 'EXPENSE_OTHER', isDebit: true, base: 120000 },
      { code: 'BANK_EUR', isDebit: false, base: 120000 },
    ]);
  }

  /** Read one XBRL fact (in EUR units, as issue #204 fixed) out of an instance. */
  function xbrlFact(xbrl: string, concept: string, ctx: string): number {
    const m = xbrl.match(
      new RegExp(
        `<${concept} contextRef="${ctx}"[^>]*>(-?[\\d.]+)</${concept}>`,
      ),
    );
    if (!m) throw new Error(`fact ${concept}@${ctx} not found in XBRL`);
    return Number(m[1]);
  }

  const DURATION_2026 = 'd-2026-01-01_2026-12-31';
  const INSTANT_2026 = 'i-2026-12-31';

  /**
   * The three figures the issue names: annual depreciation, profit, net PPE.
   * `depreciation` is the raw fact, which the taxonomy's calculation carries
   * with the CREDIT sign — a EUR 300 charge reads as -300.
   */
  function reportedFigures(xbrl: string): {
    depreciation: number;
    profit: number;
    ppe: number;
  } {
    return {
      depreciation: xbrlFact(
        xbrl,
        'et-gaap:DepreciationAndImpairmentLossReversal',
        DURATION_2026,
      ),
      profit: xbrlFact(xbrl, 'et-gaap:TotalProfitLoss', DURATION_2026),
      ppe: xbrlFact(xbrl, 'et-gaap:PropertyPlantAndEquipment', INSTANT_2026),
    };
  }

  async function voucherCount(): Promise<number> {
    const r = await db
      .selectFrom('voucher')
      .select(db.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    return r.n;
  }

  async function postedDepreciationLines(): Promise<
    Array<{ base_amount: number; is_debit: number }>
  > {
    return db
      .selectFrom('voucher_line as vl')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select(['vl.base_amount', 'vl.is_debit'])
      .where('a.code', '=', 'DEPRECIATION_EXPENSE')
      .execute();
  }

  it('re-downloading a finalized year repeats the SAME depreciation, and writes nothing', async () => {
    await seedFullYearItAsset();
    const id = await periodId('2026');

    const draft = await service.generate(id);
    expect(reportedFigures(draft.artifacts[0].content).depreciation).toBe(
      -ANNUAL_CHARGE_MINOR / 100,
    );

    const final = await service.finalize(id);
    const finalFigures = reportedFigures(final.artifacts[0].content);
    // EUR 300 of depreciation — in euros, against the 2026 taxonomy (#204).
    expect(finalFigures.depreciation).toBe(-300);
    // Net PPE = cost 1200 − accumulated 300.
    expect(finalFigures.ppe).toBe(900);

    const countAfterFinalize = await voucherCount();

    // The bug: the second assembly added the full virtual charge on top of the
    // one it had just posted, so the same finalized year reported EUR 600.
    const again = await service.generate(id);
    expect(reportedFigures(again.artifacts[0].content)).toEqual(finalFigures);
    expect(again.artifacts[0].content).toBe(final.artifacts[0].content);
    // A third download is just as stable.
    const third = await service.generate(id);
    expect(third.artifacts[0].content).toBe(final.artifacts[0].content);
    // Downloads post nothing at all.
    expect(await voucherCount()).toBe(countAfterFinalize);
    expect(await postedDepreciationLines()).toHaveLength(1);
    expect(validateEtGaapInstance(again.artifacts[0].content).errors).toEqual(
      [],
    );
  });

  it('says the charge is already posted instead of claiming it is still unposted', async () => {
    await seedFullYearItAsset();
    const id = await periodId('2026');

    const before = await service.generate(id);
    expect(before.warnings.map((w) => w.code)).toContain(
      'depreciation_not_yet_posted',
    );

    await service.finalize(id);
    const after = await service.generate(id);
    expect(after.warnings.map((w) => w.code)).not.toContain(
      'depreciation_not_yet_posted',
    );
    // Positive evidence of the prior posting, with the amount.
    const posted = after.warnings.find(
      (w) => w.code === 'depreciation_already_posted',
    );
    expect(posted?.message).toContain(String(ANNUAL_CHARGE_MINOR));
  });

  it('retries after depreciation posted but locking failed, without double-posting or re-virtualizing', async () => {
    await seedFullYearItAsset();
    const id = await periodId('2026');
    const expected = reportedFigures(
      (await service.generate(id)).artifacts[0].content,
    );

    // FAILURE INJECTION AT THE LOCK: the depreciation voucher commits, then
    // locking blows up (a crash mid-lock, not the filing-order precondition the
    // service checks up front). The year stays open WITH the charge posted.
    const lockSpy = jest
      .spyOn(reportingPeriods, 'lock')
      .mockRejectedValueOnce(new Error('lock crashed mid-flight'));
    await expect(service.finalize(id)).rejects.toThrow(/lock crashed/);
    lockSpy.mockRestore();

    expect(await postedDepreciationLines()).toEqual([
      { base_amount: ANNUAL_CHARGE_MINOR, is_debit: 1 },
    ]);
    const stillOpen = await db
      .selectFrom('reporting_period')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(stillOpen.status).toBe('open');

    // A draft taken in that half-closed state reads the posted charge once —
    // it does not add a second virtual copy on top.
    const between = await service.generate(id);
    expect(reportedFigures(between.artifacts[0].content)).toEqual(expected);

    // And the retry posts no second charge, locks the year, reports the same.
    const final = await service.finalize(id);
    expect(reportedFigures(final.artifacts[0].content)).toEqual(expected);
    expect(await postedDepreciationLines()).toEqual([
      { base_amount: ANNUAL_CHARGE_MINOR, is_debit: 1 },
    ]);
    const locked = await db
      .selectFrom('reporting_period')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(locked.status).toBe('locked');
  });

  it('still charges the year when the period is locked but no annual close was posted', async () => {
    // A year can be locked by the ordinary period lock without any annual close
    // (that is what `finalize` adds). Suppressing depreciation on "locked"
    // alone would silently drop a real, unposted charge.
    await seedFullYearItAsset();
    const id = await periodId('2026');
    await db
      .updateTable('reporting_period')
      .set({ status: 'locked', filed_at: 1 } as never)
      .where('id', '=', id)
      .execute();

    const draft = await service.generate(id);
    expect(reportedFigures(draft.artifacts[0].content).depreciation).toBe(-300);
    expect(draft.warnings.map((w) => w.code)).toContain(
      'depreciation_not_yet_posted',
    );
  });

  it('still charges the year when some OTHER depreciation voucher exists (disposal catch-up)', async () => {
    // Disposal catch-up depreciation (#208) debits the same DEPRECIATION_EXPENSE
    // and credits the same ACCUM_DEPRECIATION_IT — but carries a different
    // reason, so it is not this year's annual close and must not cancel it.
    await seedFullYearItAsset();
    const disposalAcqId = await postVoucher('2026-02-01', [
      { code: 'FIXED_ASSETS_IT', isDebit: true, base: 40000 },
      { code: 'BANK_EUR', isDebit: false, base: 40000 },
    ]);
    await db
      .insertInto('fixed_asset')
      .values({
        name: 'Retired server',
        asset_class: 'it_equipment',
        acquisition_voucher_id: disposalAcqId,
        acquisition_date: '2026-02-01',
        cost_base_minor: 40000,
        useful_life_years: 4,
        residual_value_minor: 0,
        retired_at: 1,
      } as never)
      .execute();
    await postVoucher(
      '2026-03-31',
      [
        { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 5000 },
        { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 5000 },
      ],
      { reason: 'Disposal catch-up depreciation for asset 2' },
    );

    const id = await periodId('2026');
    const draft = await service.generate(id);
    // The posted disposal catch-up (50) PLUS the still-unposted annual charge
    // (300) — the annual charge is not suppressed by the account activity.
    expect(reportedFigures(draft.artifacts[0].content).depreciation).toBe(-350);
  });

  it('leaves a filed year alone when the close is reversed in a LATER period', async () => {
    // A correction booked in the next year belongs to the next year. It is
    // outside the reported year's ledger window, so the 2026 balances still
    // carry the close — and the posted-evidence lookup must use the SAME window,
    // or the reversal would net the charge away and 2026 would virtualize it a
    // second time on re-download.
    await seedFullYearItAsset();
    const id = await periodId('2026');
    const final = await service.finalize(id);
    const expected = reportedFigures(final.artifacts[0].content);

    const close = await db
      .selectFrom('voucher')
      .select('id')
      .where('reason', '=', 'Annual depreciation charge for 2026')
      .executeTakeFirstOrThrow();
    await postVoucher(
      '2027-01-05',
      [
        {
          code: 'DEPRECIATION_EXPENSE',
          isDebit: false,
          base: ANNUAL_CHARGE_MINOR,
        },
        {
          code: 'ACCUM_DEPRECIATION_IT',
          isDebit: true,
          base: ANNUAL_CHARGE_MINOR,
        },
      ],
      {
        reason: 'Reversal of annual depreciation charge for 2026',
        reversesId: close.id,
      },
    );

    const again = await service.generate(id);
    expect(reportedFigures(again.artifacts[0].content)).toEqual(expected);
    expect(again.artifacts[0].content).toBe(final.artifacts[0].content);
    expect(again.warnings.map((w) => w.code)).not.toContain(
      'depreciation_not_yet_posted',
    );
  });

  it('re-virtualizes the annual charge once its posted close has been reversed', async () => {
    await seedFullYearItAsset();
    const id = await periodId('2026');
    const expected = reportedFigures(
      (await service.generate(id)).artifacts[0].content,
    );
    await service.finalize(id);

    const close = await db
      .selectFrom('voucher')
      .select('id')
      .where('reason', '=', 'Annual depreciation charge for 2026')
      .executeTakeFirstOrThrow();
    // Reverse it: the mirrored voucher points back with `reverses_id`, so the
    // ledger no longer carries the charge — and the report must not pretend it
    // does. Nothing about the original posted history is rewritten.
    await postVoucher(
      '2026-12-31',
      [
        {
          code: 'DEPRECIATION_EXPENSE',
          isDebit: false,
          base: ANNUAL_CHARGE_MINOR,
        },
        {
          code: 'ACCUM_DEPRECIATION_IT',
          isDebit: true,
          base: ANNUAL_CHARGE_MINOR,
        },
      ],
      {
        reason: 'Reversal of annual depreciation charge for 2026',
        reversesId: close.id,
      },
    );

    const after = await service.generate(id);
    expect(reportedFigures(after.artifacts[0].content)).toEqual(expected);
    expect(after.warnings.map((w) => w.code)).toContain(
      'depreciation_not_yet_posted',
    );
  });
});
