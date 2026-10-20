import { fxTestProviders } from '../../test/fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { CurrencyService } from '../currency/currency.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { ExpensesService } from './expenses.service';
import { EntitiesService } from '../entities/entities.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { CategoryService } from '../categories/category.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { FxRateUnavailableError } from '../fx/fx-rate.types';
import { UnresolvedVatTreatmentError } from '../plugins/vat-treatment.errors';

/**
 * Issue #403's full purchase-side regression: the deterministic receipt→bank
 * link, the narrow bank-settlement valuation fallback, the fee separation and
 * the valuation-policy distinction — against the REAL projection/plugin/DB
 * stack, with only the FX authority replaced by a deterministic fixture
 * (empty by default: the authority "does not quote DKK", exactly the case
 * where the reference rate is genuinely unavailable and not retryable).
 *
 * The figures are the ticket's own, synthetic: labelled as such, no
 * production-data claim.
 */
describe('ExpensesService bank-settlement FX (integration, issue #403)', () => {
  let db: Kysely<Database>;
  let service: ExpensesService;
  let entities: EntitiesService;
  let organization: OrganizationService;
  let rawDb: SqliteDb.Database;

  beforeEach(async () => {
    rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
    });
    const { error } = await new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    }).migrateToLatest();
    if (error) throw error instanceof Error ? error : new Error(String(error));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        ...fxTestProviders([]),
        PluginLoader,
        OrgContextResolver,
        CurrencyService,
        VoucherProjectionService,
        EntitiesService,
        PeriodLockService,
        {
          provide: CategoryService,
          useValue: { assertValid: async () => {} },
        },
        AuditLogService,
        ExpensesService,
      ],
    }).compile();

    service = module.get(ExpensesService);
    entities = module.get(EntitiesService);
    organization = module.get(OrganizationService);
    await organization.updateOrganization({ country: 'EE' });
  });

  afterEach(async () => {
    await db.destroy();
  });

  /** Import a synthetic settlement line straight into the bank tables. */
  const seedBankLine = async (line: {
    date: string;
    debit: number;
    sourceCurrency: string;
    sourceAmount: number;
    fxRate: number | null;
    fee: number | null;
    descriptor: string | null;
  }): Promise<number> => {
    const account = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'BANK_EUR')
      .executeTakeFirstOrThrow();
    const stmt = await db
      .insertInto('bank_statement')
      .values({
        account_id: account.id,
        start_date: line.date,
        end_date: line.date,
        uploaded_at: Math.floor(Date.now() / 1000),
        file_path: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const txn = await db
      .insertInto('bank_transaction')
      .values({
        statement_id: stmt.id,
        transaction_date: line.date,
        description: `Synthetic ${line.descriptor} settlement`,
        amount: -line.debit,
        currency: 'EUR',
        source_currency: line.sourceCurrency,
        source_amount: line.sourceAmount,
        fx_rate: line.fxRate,
        // The printed quote's precision, as a CSV-sourced import retains it
        // (issue #403); null when the line has no printed rate at all.
        fx_rate_decimals: line.fxRate === null ? null : 7,
        conversion_fee: line.fee,
        counterparty_iban: null,
        counterparty_descriptor: line.descriptor,
        reference: null,
        status: 'open',
        created_at: Math.floor(Date.now() / 1000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return txn.id;
  };

  const nextHouseSupplier = () =>
    entities.onboard({
      role: 'supplier',
      country: 'DK',
      name: 'Next House Copenhagen',
      registrationKey: 'DK403NEXTHOUSE',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });

  it('values an eligible local foreign purchase at the bank\u2019s same-day settlement rate (Next House fixture)', async () => {
    await seedBankLine({
      date: '2026-06-19',
      debit: 811,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.1338333,
      fee: 8,
      descriptor: 'NEXT HOUSE COPENHAGEN',
    });
    const supplier = await nextHouseSupplier();
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200, // printed DK VAT — foreign, folded into the cost
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
    });
    const draft = await service.generateDraftVoucher(expense.id);

    // The recorded facts are PRESERVED, never rewritten (issue #406).
    const row = await db
      .selectFrom('expense')
      .select(['gross_amount', 'vat_amount', 'currency', 'tax_point_date'])
      .where('id', '=', expense.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
    });

    // The whole gross (foreign VAT included) is the cost, at the bank's rate;
    // NO EE VAT leg exists — the printed DK VAT is not EE input VAT.
    expect(draft.lines).toHaveLength(2);
    for (const l of draft.lines) {
      expect(l.fx_rate).toBeCloseTo(0.1338333, 12);
      expect(l.fx_rate_source).toBe('bank_statement');
      expect(l.fx_rate_date).toBe('2026-06-19');
      expect(l.amount).toBe(6000);
      expect(l.base_amount).toBe(803);
      expect(l.currency).toBe('DKK');
    }
    const cost = draft.lines.find((l) => l.is_debit)!;
    expect(cost.account_code).toBe('EXPENSE_TRAVEL');
    expect(cost.vat_code).toBeNull(); // foreign VAT folds into the cost
    const payable = draft.lines.find((l) => !l.is_debit)!;
    expect(payable.account_code).toBe('AP');

    // The exclusivity claim + the human-readable audit (once, not twice).
    const claims = await db
      .selectFrom('bank_settlement_usage')
      .selectAll()
      .execute();
    expect(claims).toHaveLength(1);
    expect(claims[0].expense_id).toBe(expense.id);
    const again = await service.generateDraftVoucher(expense.id);
    expect(again.lines[0].fx_rate_source).toBe('bank_statement');
    expect(
      await db.selectFrom('bank_settlement_usage').selectAll().execute(),
    ).toHaveLength(1);
    const audits = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'expense.bank_settlement_fx')
      .execute();
    expect(audits).toHaveLength(1);
    const detail = JSON.parse(audits[0].detail!) as Record<string, unknown>;
    expect(detail.conversion_fee).toBe(8);
    expect(detail.rate_direction).toBe('EUR per 1 DKK');
    // The calculation precision, rounding rule and consistency tolerance
    // actually applied, persisted with the valuation (issue #403).
    expect(detail.rate_calculation_precision).toContain(
      'bank-printed to 7 decimals',
    );
    expect(detail.rounding_rule).toContain('Math.round');
    expect(String(detail.consistency_tolerance)).toContain('exact');
    expect(detail.transaction_date).toBe('2026-06-19');
    expect(detail.tax_point_date).toBe('2026-06-19');
    expect(String(detail.valuation_policy)).toContain('RTJ1');
  });

  it('derives the rate from the fee-separated principal when the bank printed none (Circle K fixture)', async () => {
    await seedBankLine({
      date: '2026-06-18',
      debit: 527,
      sourceCurrency: 'DKK',
      sourceAmount: 3900,
      fxRate: null,
      fee: 5,
      descriptor: 'CIRCLE K',
    });
    const supplier = await entities.onboard({
      role: 'supplier',
      country: 'DK',
      name: 'Circle K',
      registrationKey: 'DK403CIRCLEK',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'meals',
      gross_amount: 3900,
      vat_amount: 780,
      currency: 'DKK',
      tax_point_date: '2026-06-18',
      service_place_rule: 'restaurant_catering',
      place_of_supply_country: 'DK',
    });
    const draft = await service.generateDraftVoucher(expense.id);
    expect(draft.lines).toHaveLength(2);
    for (const l of draft.lines) {
      expect(l.fx_rate).toBeCloseTo(522 / 3900, 12);
      expect(l.base_amount).toBe(522);
      expect(l.fx_rate_source).toBe('bank_statement');
    }
  });

  it('prefers an AVAILABLE statutory reference rate over the bank evidence (valuation-policy distinction)', async () => {
    // Rebuild with a published DKK rate for the date: the reference rate
    // governs recognition, and the bank evidence must not silently replace it.
    rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    const db2 = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
    });
    const { error } = await new Migrator({
      db: db2,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    }).migrateToLatest();
    if (error) throw new Error('m');
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db2 },
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        ...fxTestProviders([
          { quoteCurrency: 'DKK', rateDate: '2026-06-18', rate: 0.1338 },
        ]),
        PluginLoader,
        OrgContextResolver,
        CurrencyService,
        VoucherProjectionService,
        EntitiesService,
        PeriodLockService,
        { provide: CategoryService, useValue: { assertValid: async () => {} } },
        AuditLogService,
        ExpensesService,
      ],
    }).compile();
    const svc = module.get(ExpensesService);
    const ents = module.get(EntitiesService);
    await module.get(OrganizationService).updateOrganization({ country: 'EE' });

    // Circle K line with explicit bank rate AND fee…
    const account = await db2
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'BANK_EUR')
      .executeTakeFirstOrThrow();
    const stmt = await db2
      .insertInto('bank_statement')
      .values({
        account_id: account.id,
        start_date: '2026-06-18',
        end_date: '2026-06-18',
        uploaded_at: 0,
        file_path: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db2.insertInto('bank_transaction').values({
      statement_id: stmt.id,
      transaction_date: '2026-06-18',
      description: 'Circle K',
      amount: -527,
      currency: 'EUR',
      source_currency: 'DKK',
      source_amount: 3900,
      fx_rate: 0.1338461,
      conversion_fee: 5,
      counterparty_iban: null,
      counterparty_descriptor: 'CIRCLE K',
      reference: null,
      status: 'open',
      created_at: 0,
    });
    const supplier = await ents.onboard({
      role: 'supplier',
      country: 'DK',
      name: 'Circle K',
      registrationKey: 'DK403CIRCLEK',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const expense = await svc.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'meals',
      gross_amount: 3900,
      vat_amount: 780,
      currency: 'DKK',
      tax_point_date: '2026-06-18',
      service_place_rule: 'restaurant_catering',
      place_of_supply_country: 'DK',
    });
    const draft = await svc.generateDraftVoucher(expense.id);
    for (const l of draft.lines) {
      expect(l.fx_rate_source).toBe('ECB');
      expect(l.fx_rate_date).toBe('2026-06-18');
    }
    // No bank valuation claim and no bank-settlement audit: nothing was
    // booked from the bank evidence.
    const usage = await db2
      .selectFrom('bank_settlement_usage')
      .selectAll()
      .execute();
    expect(usage).toHaveLength(0);
    await db2.destroy();
  });

  it('keeps the statutory hold for a zero-VAT general-rule foreign service even with matching bank evidence (the SaaS counterexample)', async () => {
    await seedBankLine({
      date: '2026-06-19',
      debit: 811,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.1338333,
      fee: 8,
      descriptor: 'SAAS VENDOR',
    });
    const supplier = await entities.onboard({
      role: 'supplier',
      country: 'DK',
      name: 'SaaS Vendor ApS',
      registrationKey: 'DK403SAAS',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'software',
      gross_amount: 6000,
      vat_amount: 0,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      // No place-of-supply declaration: the GENERAL rule governs.
    });
    await expect(service.generateDraftVoucher(expense.id)).rejects.toThrow(
      FxRateUnavailableError,
    );
    // Nothing claimed or audited: the fallback refused the reverse charge.
    expect(
      await db.selectFrom('bank_settlement_usage').selectAll().execute(),
    ).toHaveLength(0);
  });

  it('holds with the missing fact named when a local-consumption rule is declared without a country', async () => {
    const supplier = await nextHouseSupplier();
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      // place_of_supply_country deliberately not recorded
    });
    await expect(service.generateDraftVoucher(expense.id)).rejects.toThrow(
      UnresolvedVatTreatmentError,
    );
  });

  it('holds when the declared rule\u2019s location is THIS country but the document carries foreign VAT', async () => {
    const supplier = await nextHouseSupplier();
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'EE', // a Tallinn hotel printing DK VAT
    });
    await expect(service.generateDraftVoucher(expense.id)).rejects.toThrow(
      UnresolvedVatTreatmentError,
    );
  });

  it('holds with the missing fact named when a local-consumption rule is declared without printed VAT', async () => {
    const supplier = await nextHouseSupplier();
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 0,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
    });
    await expect(service.generateDraftVoucher(expense.id)).rejects.toThrow(
      UnresolvedVatTreatmentError,
    );
  });

  it('surfaces ambiguity when an overlapping statement import duplicates the settlement line', async () => {
    for (let i = 0; i < 2; i++) {
      await seedBankLine({
        date: '2026-06-19',
        debit: 811,
        sourceCurrency: 'DKK',
        sourceAmount: 6000,
        fxRate: 0.1338333,
        fee: 8,
        descriptor: 'NEXT HOUSE COPENHAGEN',
      });
    }
    const supplier = await nextHouseSupplier();
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
    });
    let thrown: unknown;
    try {
      await service.generateDraftVoucher(expense.id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FxRateUnavailableError);
    expect((thrown as FxRateUnavailableError).message).toMatch(/ambiguous/i);
    // No expense, claim, audit or voucher duplication: nothing was booked.
    expect(
      await db.selectFrom('bank_settlement_usage').selectAll().execute(),
    ).toHaveLength(0);
  });

  it('keeps the statutory hold when the bank line is not a same-day settlement of this purchase', async () => {
    await seedBankLine({
      date: '2026-06-21', // two days later: not the transaction-date rate
      debit: 811,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.1338333,
      fee: 8,
      descriptor: 'NEXT HOUSE COPENHAGEN',
    });
    const supplier = await nextHouseSupplier();
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
    });
    let thrown: unknown;
    try {
      await service.generateDraftVoucher(expense.id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FxRateUnavailableError);
    expect((thrown as FxRateUnavailableError).message).not.toMatch(
      /ambiguous/i,
    );
  });

  it('refuses a same-amount descriptor of a DIFFERENT merchant differing in one significant token (Circle K vs Circle X, issue #403)', async () => {
    await seedBankLine({
      date: '2026-06-19',
      debit: 811,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.1338333,
      fee: 8,
      descriptor: 'CIRCLE K', // one-letter tokens are significant: K ≠ X
    });
    const supplier = await entities.onboard({
      role: 'supplier',
      country: 'DK',
      name: 'Circle X',
      registrationKey: 'DK403CIRCLEX',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
    });
    const thrown = await service
      .generateDraftVoucher(expense.id)
      .catch((e: unknown) => e as FxRateUnavailableError);
    expect(thrown).toBeInstanceOf(FxRateUnavailableError);
    expect((thrown as FxRateUnavailableError).message).toMatch(
      /do not identify this supplier/i,
    );
    expect(
      await db.selectFrom('bank_settlement_usage').selectAll().execute(),
    ).toHaveLength(0);
  });

  it('refuses a descriptor whose repeated tokens are not the supplier’s (PIZZA PIZZA is not PIZZA EXPRESS, issue #403)', async () => {
    await seedBankLine({
      date: '2026-06-19',
      debit: 811,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.1338333,
      fee: 8,
      descriptor: 'PIZZA PIZZA', // token multiplicity is identity
    });
    const supplier = await entities.onboard({
      role: 'supplier',
      country: 'DK',
      name: 'Pizza Express',
      registrationKey: 'DK403PIZZAEXPRESS',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'restaurant_catering',
      place_of_supply_country: 'DK',
    });
    await expect(service.generateDraftVoucher(expense.id)).rejects.toThrow(
      FxRateUnavailableError,
    );
    expect(
      await db.selectFrom('bank_settlement_usage').selectAll().execute(),
    ).toHaveLength(0);
  });

  it('refuses a legal-form-suffix-only descriptor (an AS names no particular merchant)', async () => {
    await seedBankLine({
      date: '2026-06-19',
      debit: 811,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.1338333,
      fee: 8,
      descriptor: 'AS',
    });
    const supplier = await nextHouseSupplier(); // '... AS' style name would match a bare 'AS'
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
    });
    await expect(service.generateDraftVoucher(expense.id)).rejects.toThrow(
      FxRateUnavailableError,
    );
    expect(
      await db.selectFrom('bank_settlement_usage').selectAll().execute(),
    ).toHaveLength(0);
  });

  it('keeps the statutory hold when the counterparty descriptor does not identify the supplier', async () => {
    await seedBankLine({
      date: '2026-06-19',
      debit: 811,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.1338333,
      fee: 8,
      descriptor: 'SOME OTHER MERCHANT',
    });
    const supplier = await nextHouseSupplier();
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
    });
    await expect(service.generateDraftVoucher(expense.id)).rejects.toThrow(
      FxRateUnavailableError,
    );
  });

  it('releases the abandoned reservation and appends a NEW audit entry when an edit re-values the draft (issue #403)', async () => {
    const bank1 = await seedBankLine({
      date: '2026-06-19',
      debit: 811,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.1338333,
      fee: 8,
      descriptor: 'NEXT HOUSE COPENHAGEN',
    });
    // A second line for the EDITED facts (Circle K DKK 24.50, fee 0.03).
    const bank2 = await seedBankLine({
      date: '2026-06-19',
      debit: 331,
      sourceCurrency: 'DKK',
      sourceAmount: 2450,
      fxRate: 0.13387755102040816,
      fee: 3,
      descriptor: 'NEXT HOUSE COPENHAGEN',
    });
    const supplier = await entities.onboard({
      role: 'supplier',
      country: 'DK',
      name: 'Next House Copenhagen',
      registrationKey: 'DK403NHMINI',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
    });
    // First valuation: bank 1, claim + one audit entry.
    await service.generateDraftVoucher(expense.id);
    expect(
      (await db.selectFrom('bank_settlement_usage').selectAll().execute()).map(
        (c) => c.bank_transaction_id,
      ),
    ).toEqual([bank1]);

    // A legitimate operator edit of the ORIGINAL amount: the draft re-values
    // on bank 2, the abandoned bank-1 reservation is RELEASED (a distinct
    // DKK-6000 purchase can use it), and the NEW valuation appends its own
    // audit entry — the historical one stays untouched (append-only).
    await service.updateDraft(expense.id, { gross_amount: 2450 });
    await service.generateDraftVoucher(expense.id);
    const claims = await db
      .selectFrom('bank_settlement_usage')
      .selectAll()
      .execute();
    expect(claims).toHaveLength(1);
    expect(claims[0].bank_transaction_id).toBe(bank2);
    const audits = await db
      .selectFrom('audit_log')
      .select(['id', 'detail'])
      .where('action', '=', 'expense.bank_settlement_fx')
      .orderBy('id')
      .execute();
    expect(audits).toHaveLength(2);
    const first = JSON.parse(audits[0].detail!) as {
      bank_transaction_id: number;
    };
    const second = JSON.parse(audits[1].detail!) as {
      bank_transaction_id: number;
      source_amount: number;
    };
    expect(first.bank_transaction_id).toBe(bank1);
    expect(second.bank_transaction_id).toBe(bank2);
    expect(second.source_amount).toBe(2450);

    // A same-state retry writes NOTHING new (idempotent per valuation).
    await service.generateDraftVoucher(expense.id);
    expect(
      await db
        .selectFrom('audit_log')
        .select('id')
        .where('action', '=', 'expense.bank_settlement_fx')
        .execute(),
    ).toHaveLength(2);
    expect(
      await db.selectFrom('bank_settlement_usage').selectAll().execute(),
    ).toHaveLength(1);
  });

  it('recovers an AMBIGUOUS settlement link via the operator’s explicit selection (issue #403 ambiguity recovery)', async () => {
    // Two genuinely distinct same-day settlements of the SAME merchant,
    // original currency and original amount — different rates/debits.
    const rowA = await seedBankLine({
      date: '2026-06-19',
      debit: 811,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.1338333,
      fee: 8,
      descriptor: 'NEXT HOUSE COPENHAGEN',
    });
    const rowB = await seedBankLine({
      date: '2026-06-19',
      debit: 830,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.137,
      fee: 8,
      descriptor: 'NEXT HOUSE COPENHAGEN',
    });
    const supplier = await nextHouseSupplier();
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
    });

    // Before resolution: the typed, actionable hold naming the endpoint.
    let thrown: unknown;
    try {
      await service.generateDraftVoucher(expense.id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FxRateUnavailableError);
    const holdMessage = (thrown as FxRateUnavailableError).message;
    expect(holdMessage).toMatch(/ambiguous/i);
    expect(holdMessage).toMatch(/\/api\/expenses\/\d+\/settlement-fx/);
    expect(
      await db.selectFrom('bank_settlement_usage').selectAll().execute(),
    ).toHaveLength(0);

    // The operator selects row B: validated, claimed, audited.
    const selection = await service.selectSettlementFx(expense.id, rowB);
    expect(selection).toEqual({
      expense_id: expense.id,
      bank_transaction_id: rowB,
    });
    const claims = await db
      .selectFrom('bank_settlement_usage')
      .selectAll()
      .execute();
    expect(claims).toHaveLength(1);
    expect(claims[0].bank_transaction_id).toBe(rowB);
    const selectionAudits = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'expense.bank_settlement_fx_selection')
      .execute();
    expect(selectionAudits).toHaveLength(1);
    const selectionDetail = JSON.parse(selectionAudits[0].detail!) as Record<
      string,
      unknown
    >;
    expect(selectionDetail.bank_transaction_id).toBe(rowB);
    expect(selectionDetail.reason).toMatch(/operator disambiguation/i);

    // The normal draft generation now values the purchase on the SELECTED
    // line — row B's own rate (0.137 × 6000 = 822 principal + 8 fee = 830),
    // row A untouched and unclaimed.
    const draft = await service.generateDraftVoucher(expense.id);
    for (const l of draft.lines) {
      expect(l.fx_rate).toBeCloseTo(0.137, 12);
      expect(l.base_amount).toBe(822);
      expect(l.fx_rate_source).toBe('bank_statement');
    }
    // The original facts are preserved; nothing was posted by the selection.
    const row = await db
      .selectFrom('expense')
      .select(['gross_amount', 'currency', 'voucher_id', 'status'])
      .where('id', '=', expense.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      gross_amount: 6000,
      currency: 'DKK',
      voucher_id: null,
      status: 'draft',
    });

    // Idempotence in state: a re-selection of the SAME line keeps exactly one
    // claim (each explicit decision stays on the append-only record), and a
    // re-generation adds no second valuation audit.
    await service.selectSettlementFx(expense.id, rowB);
    expect(
      (await db.selectFrom('bank_settlement_usage').selectAll().execute()).map(
        (c) => c.bank_transaction_id,
      ),
    ).toEqual([rowB]);
    await service.generateDraftVoucher(expense.id);
    expect(
      await db
        .selectFrom('audit_log')
        .select('id')
        .where('action', '=', 'expense.bank_settlement_fx')
        .execute(),
    ).toHaveLength(1);
    expect(await db.selectFrom('voucher').selectAll().execute()).toHaveLength(
      0,
    );
    void rowA;
  });

  it('refuses invalid settlement selections with NO side effects (issue #403 ambiguity recovery)', async () => {
    const rowA = await seedBankLine({
      date: '2026-06-19',
      debit: 811,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.1338333,
      fee: 8,
      descriptor: 'NEXT HOUSE COPENHAGEN',
    });
    const otherRow = await seedBankLine({
      date: '2026-06-20', // not the purchase's day
      debit: 900,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.15,
      fee: 5,
      descriptor: 'SOME OTHER MERCHANT',
    });
    const supplier = await nextHouseSupplier();
    const otherSupplier = await entities.onboard({
      role: 'supplier',
      country: 'DK',
      name: 'Some Other Merchant',
      registrationKey: 'DK403OTHER',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
    });
    // A second expense that CLAIMS rowA first.
    const first = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
      allow_duplicate: true,
    });
    await service.generateDraftVoucher(first.id); // claims rowA
    const claimsBefore = await db
      .selectFrom('bank_settlement_usage')
      .selectAll()
      .execute();

    // Claimed by another expense.
    await expect(service.selectSettlementFx(expense.id, rowA)).rejects.toThrow(
      /already values expense/i,
    );
    // Neither the purchase's day nor its merchant (the first failing
    // validation fires: the day).
    await expect(
      service.selectSettlementFx(expense.id, otherRow),
    ).rejects.toThrow(/not a same-day settlement/i);
    // A same-day line of a DIFFERENT merchant.
    const otherMerchantRow = await seedBankLine({
      date: '2026-06-19',
      debit: 900,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.15,
      fee: 5,
      descriptor: 'SOME OTHER MERCHANT',
    });
    await expect(
      service.selectSettlementFx(expense.id, otherMerchantRow),
    ).rejects.toThrow(/counterparty does not identify/i);
    // A different supplier's merchant.
    const claimant = await entities.onboard({
      role: 'employee',
      country: 'EE',
      name: 'Tripper',
      email: 'tripper403@example.com',
    });
    const claimantExpense = await service.createExpense({
      document_id: null,
      supplier_id: otherSupplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      claimant_id: claimant.id,
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
      allow_duplicate: true,
    });
    await expect(
      service.selectSettlementFx(claimantExpense.id, otherRow),
    ).rejects.toThrow(/claimant-paid/i);
    // Nonexistent line.
    await expect(
      service.selectSettlementFx(expense.id, 999999),
    ).rejects.toThrow(/not found/i);

    // NOTHING changed: no new claim, no selection audit, no voucher.
    expect(
      await db.selectFrom('bank_settlement_usage').selectAll().execute(),
    ).toEqual(claimsBefore);
    expect(
      await db
        .selectFrom('audit_log')
        .select('id')
        .where('action', '=', 'expense.bank_settlement_fx_selection')
        .execute(),
    ).toHaveLength(0);
    expect(await db.selectFrom('voucher').selectAll().execute()).toHaveLength(
      0,
    );
  });

  it('links and retries on an IBAN-only bank line (the descriptor is absent; a recorded supplier IBAN is the reliable identity)', async () => {
    const account = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'BANK_EUR')
      .executeTakeFirstOrThrow();
    const stmt = await db
      .insertInto('bank_statement')
      .values({
        account_id: account.id,
        start_date: '2026-06-19',
        end_date: '2026-06-19',
        uploaded_at: 0,
        file_path: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('bank_transaction')
      .values({
        statement_id: stmt.id,
        transaction_date: '2026-06-19',
        description: 'IBAN-only settlement',
        amount: -811,
        currency: 'EUR',
        source_currency: 'DKK',
        source_amount: 6000,
        fx_rate: 0.1338333,
        fx_rate_decimals: 7,
        conversion_fee: 8,
        counterparty_iban: 'DK5000400440116243',
        counterparty_descriptor: null, // the identity is the IBAN alone
        reference: null,
        status: 'open',
        created_at: 0,
      })
      .execute();

    const supplier = await nextHouseSupplier();
    await entities.addIdentifierIfAbsent(
      supplier.id,
      'iban',
      'DK5000400440116243',
    );

    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
    });
    // First automatic generation links via the recorded IBAN and claims.
    const draft = await service.generateDraftVoucher(expense.id);
    expect(draft.lines[0].fx_rate_source).toBe('bank_statement');
    expect(
      (await db.selectFrom('bank_settlement_usage').selectAll().execute())
        .length,
    ).toBe(1);
    // The SAME-draft retry (the claimed-row precedence) re-validates through
    // the IBAN identity too — no descriptor required — and stays idempotent.
    const retry = await service.generateDraftVoucher(expense.id);
    expect(retry.lines[0].fx_rate_source).toBe('bank_statement');
    expect(
      (await db.selectFrom('bank_settlement_usage').selectAll().execute())
        .length,
    ).toBe(1);
    expect(
      (
        await db
          .selectFrom('audit_log')
          .select('id')
          .where('action', '=', 'expense.bank_settlement_fx')
          .execute()
      ).length,
    ).toBe(1);
  });

  it('refuses a stale post whose bank row was DELETED (the statement was removed) after the draft was valued (issue #403)', async () => {
    // Synthetic declared facts (not a production receipt claim): a
    // DK-accommodation-declared DKK purchase with same-day bank evidence.
    const txnId = await seedBankLine({
      date: '2026-06-19',
      debit: 811,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.1338333,
      fee: 8,
      descriptor: 'NEXT HOUSE COPENHAGEN',
    });
    const supplier = await nextHouseSupplier();
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
    });
    // The draft IS bank-valued: its own evidence identity travels on it.
    const draft = await service.generateDraftVoucher(expense.id);
    expect(draft.bank_settlement).toBeDefined();
    expect(draft.bank_settlement!.bankTransactionId).toBe(txnId);
    const fingerprint = await service.draftFactsFingerprint(expense.id);

    // The statement (and its row — and the claim with it) is deleted after
    // the draft was valued. The DRAFT carries which evidence THIS valuation
    // used; the guard revalidates exactly that.
    const txn = await db
      .selectFrom('bank_transaction')
      .select(['statement_id'])
      .where('id', '=', txnId)
      .executeTakeFirstOrThrow();
    await db
      .deleteFrom('bank_transaction')
      .where('statement_id', '=', txn.statement_id)
      .execute();
    await db
      .deleteFrom('bank_statement')
      .where('id', '=', txn.statement_id)
      .execute();

    // The guard runs inside the posting transaction; the transaction rolls
    // back (released) when the guard throws — no held handles needed.
    await expect(
      db
        .transaction()
        .execute(async (trx) =>
          service.assertDraftFactsUnchangedTx(
            trx,
            expense.id,
            fingerprint,
            draft,
          ),
        ),
    ).rejects.toThrow(/was deleted/i);
  });

  it('refuses a stale post whose bank row was recorded as a PERSONAL disposition after the draft was valued (issue #403)', async () => {
    const txnId = await seedBankLine({
      date: '2026-06-19',
      debit: 811,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.1338333,
      fee: 8,
      descriptor: 'NEXT HOUSE COPENHAGEN',
    });
    const supplier = await nextHouseSupplier();
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
    });
    const draft = await service.generateDraftVoucher(expense.id);
    const fingerprint = await service.draftFactsFingerprint(expense.id);

    // A whole-line personal disposition lands in the post-generation window:
    // the full cash is accounted for on the books and the row's status flips
    // — no reconciliation match, so only the row guard sees it. (Synthetic
    // equivalent of the real PersonalDispositionService path, which posts
    // the same status transition.)
    await db
      .updateTable('bank_transaction')
      .set({ status: 'personal' })
      .where('id', '=', txnId)
      .execute();

    await expect(
      db
        .transaction()
        .execute(async (trx) =>
          service.assertDraftFactsUnchangedTx(
            trx,
            expense.id,
            fingerprint,
            draft,
          ),
        ),
    ).rejects.toThrow(/'personal' disposition/i);
  });

  it('a draft valued on line A still passes when an ABANDONED line B was disposed after an A-to-B-to-A re-selection (the draft\u2019s own evidence decides, issue #403)', async () => {
    // A-to-B-to-A: the valuation audit history deduplicates per
    // (expense, line), so a "latest audit entry" carrier would check the
    // abandoned B. The DRAFT carries the concrete evidence of THIS
    // valuation: line A.
    const rowA = await seedBankLine({
      date: '2026-06-19',
      debit: 811,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.1338333,
      fee: 8,
      descriptor: 'NEXT HOUSE COPENHAGEN',
    });
    const rowB = await seedBankLine({
      date: '2026-06-19',
      debit: 830,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.137,
      fee: 8,
      descriptor: 'NEXT HOUSE COPENHAGEN',
    });
    const supplier = await nextHouseSupplier();
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
    });
    // A-to-B-to-A operator selections, each generating a valuation.
    await service.selectSettlementFx(expense.id, rowA);
    await service.generateDraftVoucher(expense.id);
    await service.selectSettlementFx(expense.id, rowB);
    await service.generateDraftVoucher(expense.id);
    await service.selectSettlementFx(expense.id, rowA);
    const draft = await service.generateDraftVoucher(expense.id);
    expect(draft.bank_settlement!.bankTransactionId).toBe(rowA);
    const fingerprint = await service.draftFactsFingerprint(expense.id);

    // The ABANDONED line B is disposed of (a personal spend) — it is not
    // this draft's evidence, so the guard must pass for the draft on A.
    await db
      .updateTable('bank_transaction')
      .set({ status: 'personal' })
      .where('id', '=', rowB)
      .execute();

    await expect(
      db
        .transaction()
        .execute(async (trx) =>
          service.assertDraftFactsUnchangedTx(
            trx,
            expense.id,
            fingerprint,
            draft,
          ),
        ),
    ).resolves.toBeUndefined();
    // The same draft's OWN line disposed, however, refuses.
    await db
      .updateTable('bank_transaction')
      .set({ status: 'personal' })
      .where('id', '=', rowA)
      .execute();
    await expect(
      db
        .transaction()
        .execute(async (trx) =>
          service.assertDraftFactsUnchangedTx(
            trx,
            expense.id,
            fingerprint,
            draft,
          ),
        ),
    ).rejects.toThrow(/'personal' disposition/i);
  });

  it('a REFERENCE-valued draft carries no bank evidence: a later personal disposition of the bank row must not block it (issue #403)', async () => {
    // Rebuild the module with a DKK reference rate available: the statutory
    // rate governs the valuation and the draft carries no bank evidence.
    const refDb = new SqliteDb(':memory:');
    refDb.pragma('foreign_keys = ON');
    const db2 = new Kysely<Database>({
      dialect: new SqliteDialect({ database: refDb }),
    });
    const { error } = await new Migrator({
      db: db2,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    }).migrateToLatest();
    if (error) throw new Error('m');
    const module2: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db2 },
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        ...fxTestProviders([
          { quoteCurrency: 'DKK', rateDate: '2026-06-19', rate: 0.142 },
        ]),
        PluginLoader,
        OrgContextResolver,
        CurrencyService,
        VoucherProjectionService,
        EntitiesService,
        PeriodLockService,
        {
          provide: CategoryService,
          useValue: { assertValid: async () => {} },
        },
        AuditLogService,
        ExpensesService,
      ],
    }).compile();
    const svc = module2.get(ExpensesService);
    await module2
      .get(OrganizationService)
      .updateOrganization({ country: 'EE' });

    const account = await db2
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'BANK_EUR')
      .executeTakeFirstOrThrow();
    const stmtId = await db2
      .insertInto('bank_statement')
      .values({
        account_id: account.id,
        start_date: '2026-06-19',
        end_date: '2026-06-19',
        uploaded_at: 0,
        file_path: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .then((r) => r.id);
    const txnId = await db2
      .insertInto('bank_transaction')
      .values({
        statement_id: stmtId,
        transaction_date: '2026-06-19',
        description: 'Next House Copenhagen DKK 60',
        amount: -811,
        currency: 'EUR',
        source_currency: 'DKK',
        source_amount: 6000,
        fx_rate: 0.1338333,
        fx_rate_decimals: 7,
        conversion_fee: 8,
        counterparty_iban: null,
        counterparty_descriptor: 'NEXT HOUSE COPENHAGEN',
        reference: null,
        status: 'open',
        created_at: 0,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .then((r) => r.id);
    const ents = module2.get(EntitiesService);
    const supplier = await ents.onboard({
      role: 'supplier',
      country: 'DK',
      name: 'Next House Copenhagen',
      registrationKey: 'DK403REFPOS',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const expense = await svc.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
    });
    const draft = await svc.generateDraftVoucher(expense.id);
    // The reference rate governed the valuation — no bank evidence on the
    // draft, and no bank-settlement valuation audit entry either.
    expect(draft.bank_settlement).toBeUndefined();
    expect(draft.lines[0].fx_rate_source).toBe('ECB');
    const fingerprint = await svc.draftFactsFingerprint(expense.id);

    // A later personal disposition of the (unused) bank row — neither is
    // this draft's evidence.
    await db2
      .updateTable('bank_transaction')
      .set({ status: 'personal' })
      .where('id', '=', txnId)
      .execute();

    await expect(
      db2
        .transaction()
        .execute(async (trx) =>
          svc.assertDraftFactsUnchangedTx(trx, expense.id, fingerprint, draft),
        ),
    ).resolves.toBeUndefined();
    await db2.destroy();
  });

  it('re-derives the historical bank valuation for a POSTED purchase’s own fee-reconciled line on a VAT-only correction (issue #403)', async () => {
    // Synthetic declared facts. The full normal flow: bank-valued purchase
    // posts at 803, its settlement match consumes the principal, the fee
    // disposition books the 8-cent fee and flips the row to 'bank_fee' —
    // the purchase's OWN line, fully reconciled (803 + 8 = 811).
    const txnId = await seedBankLine({
      date: '2026-06-19',
      debit: 811,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.1338333,
      fee: 8,
      descriptor: 'NEXT HOUSE COPENHAGEN',
    });
    const supplier = await nextHouseSupplier();
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
    });
    const originalDraft = await service.generateDraftVoucher(expense.id);
    // The original valuation is the bank rate at 803 — the correction below
    // must re-derive exactly this.
    expect(originalDraft.lines[0].base_amount).toBe(803);
    // Mark the expense posted with its own voucher, and settle the line:
    // the principal match to the expense's own voucher + the fee part as a
    // fee-disposition voucher (an EXPENSE_BANK_FEE leg of exactly 8).
    const ownVoucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V403OWN',
        tax_point_date: '2026-06-19',
        posted_at: 0,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .then((r) => r.id);
    await db
      .updateTable('expense')
      .set({ status: 'posted', voucher_id: ownVoucher })
      .where('id', '=', expense.id)
      .execute();
    await db
      .insertInto('reconciliation_match')
      .values({
        bank_transaction_id: txnId,
        voucher_id: ownVoucher,
        match_type: 'exact',
        amount_matched: 803,
        cash_base_amount: 803,
        status: 'active',
        signal: 'manual',
        created_at: 0,
      })
      .execute();
    // The fee disposition: a fee voucher with a single EXPENSE_BANK_FEE
    // leg of 8, matched for the fee part.
    const feeAccountId = (
      await db
        .selectFrom('account')
        .select('id')
        .where('code', '=', 'EXPENSE_BANK_FEE')
        .executeTakeFirstOrThrow()
    ).id;
    const bankAccountId = (
      await db
        .selectFrom('account')
        .select('id')
        .where('code', '=', 'BANK_EUR')
        .executeTakeFirstOrThrow()
    ).id;
    const feeVoucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V403OWNFEE',
        tax_point_date: '2026-06-19',
        posted_at: 0,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .then((r) => r.id);
    await db
      .insertInto('voucher_line')
      .values([
        {
          voucher_id: feeVoucher,
          account_id: feeAccountId,
          amount: 8,
          currency: 'EUR',
          base_amount: 8,
          fx_rate: 1,
          fx_rate_date: '2026-06-19',
          fx_rate_source: 'identity',
          is_debit: 1,
          vat_code: null,
        },
        {
          voucher_id: feeVoucher,
          account_id: bankAccountId,
          amount: 8,
          currency: 'EUR',
          base_amount: 8,
          fx_rate: 1,
          fx_rate_date: '2026-06-19',
          fx_rate_source: 'identity',
          is_debit: 0,
          vat_code: null,
        },
      ])
      .execute();
    await db
      .insertInto('reconciliation_match')
      .values({
        bank_transaction_id: txnId,
        voucher_id: feeVoucher,
        match_type: 'partial',
        amount_matched: 8,
        cash_base_amount: 8,
        status: 'active',
        signal: 'manual',
        created_at: 0,
      })
      .execute();
    // The fee disposition flips the row: fully reconciled own line.
    await db
      .updateTable('bank_transaction')
      .set({ status: 'bank_fee' })
      .where('id', '=', txnId)
      .execute();

    // A VAT-only correction preview (the corrections flow's seam): the
    // gross/currency/supplier/date/place are UNCHANGED, so the SAME
    // historical bank valuation must be re-derived — no new cash acquired,
    // no claim, the row's own-settlement pattern intact.
    const preview = await service.previewPatchedDraft(expense.id, {
      vat_amount: 1000,
    });
    expect(preview.lines[0].fx_rate_source).toBe('bank_statement');
    expect(preview.lines[0].fx_rate).toBeCloseTo(0.1338333, 12);
    expect(preview.lines[0].base_amount).toBe(803);
    // Nothing new was acquired: one claim (the original), one line status.
    const claims = await db
      .selectFrom('bank_settlement_usage')
      .selectAll()
      .execute();
    expect(claims).toHaveLength(1);
    expect(claims[0].bank_transaction_id).toBe(txnId);
    const txnRow = await db
      .selectFrom('bank_transaction')
      .select('status')
      .where('id', '=', txnId)
      .executeTakeFirstOrThrow();
    expect(txnRow.status).toBe('bank_fee');
  });

  it('refuses a bank line whose cash is already ALLOCATED on the books (a posted settlement keeps the line open — status open is not unallocated)', async () => {
    const txnId = await seedBankLine({
      date: '2026-06-19',
      debit: 811,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.1338333,
      fee: 8,
      descriptor: 'NEXT HOUSE COPENHAGEN',
    });
    // A posted purchase settled PART of the line: an active reconciliation
    // match consumes 795 of its cash; the line stays OPEN with a remainder.
    const voucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V403ALLOC',
        tax_point_date: '2026-06-19',
        posted_at: 0,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('reconciliation_match')
      .values({
        bank_transaction_id: txnId,
        voucher_id: voucher.id,
        match_type: 'exact',
        amount_matched: 803,
        cash_base_amount: 795,
        status: 'active',
        signal: 'manual',
        created_at: 0,
      })
      .execute();

    const supplier = await nextHouseSupplier();
    // A DISTINCT DKK 6000 draft: not free full-settlement evidence.
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
      allow_duplicate: true,
    });
    let thrown: unknown;
    try {
      await service.generateDraftVoucher(expense.id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FxRateUnavailableError);
    expect((thrown as FxRateUnavailableError).message).toMatch(
      /allocated on the books/i,
    );
    // The explicit selection refuses it too — with no side effects.
    await expect(service.selectSettlementFx(expense.id, txnId)).rejects.toThrow(
      /allocated on the books/i,
    );
    expect(
      await db.selectFrom('bank_settlement_usage').selectAll().execute(),
    ).toHaveLength(0);
    expect(
      await db
        .selectFrom('audit_log')
        .select('id')
        .where('action', '=', 'expense.bank_settlement_fx_selection')
        .execute(),
    ).toHaveLength(0);
    // DRAFT matches are not allocations (the reconciliation seam's own
    // semantics): a staged draft match allocates no cash and must not
    // block free evidence. Seed a draft match on a FREE line's twin and
    // confirm the automatic valuation still links.
    const draftMatchTxn = await seedBankLine({
      date: '2026-06-20',
      debit: 811,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.1338333,
      fee: 8,
      descriptor: 'NEXT HOUSE COPENHAGEN',
    });
    await db
      .insertInto('reconciliation_match')
      .values({
        bank_transaction_id: draftMatchTxn,
        voucher_id: voucher.id,
        match_type: 'exact',
        amount_matched: 803,
        cash_base_amount: 803,
        status: 'draft',
        signal: 'manual',
        created_at: 0,
      })
      .execute();
    const secondExpense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-20',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
    });
    const draft = await service.generateDraftVoucher(secondExpense.id);
    expect(draft.lines[0].fx_rate_source).toBe('bank_statement');
  });

  it('refuses a bank line already claimed by a DIFFERENT expense (no double-valuation)', async () => {
    await seedBankLine({
      date: '2026-06-19',
      debit: 811,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.1338333,
      fee: 8,
      descriptor: 'NEXT HOUSE COPENHAGEN',
    });
    const supplier = await nextHouseSupplier();
    const first = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
    });
    await service.generateDraftVoucher(first.id); // claims the line
    const second = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
      allow_duplicate: true,
    });
    let thrown: unknown;
    try {
      await service.generateDraftVoucher(second.id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FxRateUnavailableError);
    expect((thrown as FxRateUnavailableError).message).toMatch(
      /already evidence another expense/i,
    );
    // Only the first expense holds the claim.
    const claims = await db
      .selectFrom('bank_settlement_usage')
      .selectAll()
      .execute();
    expect(claims).toHaveLength(1);
    expect(claims[0].expense_id).toBe(first.id);
  });

  it('refuses org-bank evidence for a claimant-paid purchase (the approver confirmed out of pocket)', async () => {
    await seedBankLine({
      date: '2026-06-19',
      debit: 811,
      sourceCurrency: 'DKK',
      sourceAmount: 6000,
      fxRate: 0.1338333,
      fee: 8,
      descriptor: 'NEXT HOUSE COPENHAGEN',
    });
    const claimant = await entities.onboard({
      role: 'employee',
      country: 'EE',
      name: 'Copenhagen Tripper',
      email: 'tripper@example.com',
    });
    const supplier = await nextHouseSupplier();
    const expense = await service.createExpense({
      document_id: null,
      supplier_id: supplier.id,
      category: 'travel',
      gross_amount: 6000,
      vat_amount: 1200,
      currency: 'DKK',
      tax_point_date: '2026-06-19',
      claimant_id: claimant.id,
      service_place_rule: 'immovable_property',
      place_of_supply_country: 'DK',
    });
    // The statutory path is unavailable (empty authority) and the bank
    // evidence is refused for a claimant-paid purchase — a typed hold whose
    // reason names the contradiction, never a bank-valued posting.
    let thrown: unknown;
    try {
      await service.generateDraftVoucher(expense.id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FxRateUnavailableError);
    expect((thrown as FxRateUnavailableError).message).toMatch(
      /claimant-paid purchase|out-of-pocket/i,
    );
  });
});
