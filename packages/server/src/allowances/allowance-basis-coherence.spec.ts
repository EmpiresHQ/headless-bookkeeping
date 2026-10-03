import { fxTestProviders } from '../../test/fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { ConflictException } from '@nestjs/common';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { CurrencyService } from '../currency/currency.service';
import { AccountService } from '../ledger/account/account.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PostingService } from '../ledger/posting/posting.service';
import { StatusTransitionService } from '../ledger/status/status-transition.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { RulesService } from '../rules/rules.service';
import { PolicyService } from '../policy/policy.service';
import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
import { ExpensesService } from '../expenses/expenses.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { AllowanceLimitService } from './allowance-limit.service';
import { AllowanceProjectionService } from './allowance-projection.service';
import { BusinessTripService } from './business-trip.service';
import { AllowanceService } from './allowance.service';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { CategoryService } from '../categories/category.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { seedEntity } from '../../test/helpers/seed-entity';

/**
 * Issue #215, the allowance path: an approved allowance can be the ledger's
 * FIRST voucher, and its amounts are booked at an IDENTITY rate against the
 * currency stored on the allowance row.
 *
 * That stored currency is a default written at creation, never re-checked. So
 * an allowance raised while the books were kept in EUR can survive a
 * legitimate (ledger still empty) switch of the base currency to USD and then
 * be approved, booking EUR-measured cents as `base_amount` in a USD-basis
 * ledger at `fx_rate = 1` — the same mislabelling #215 is about, arriving
 * through a persisted value rather than through an in-flight conversion.
 *
 * Statutory per-diem and kilometre rates are written in the jurisdiction's own
 * currency; translating them into another is not supported (the health cap
 * already refuses exactly that). So the coherent answer is refusal at approval,
 * with nothing posted — not a silent conversion.
 */
describe('Allowance measurement-basis coherence (issue #215)', () => {
  let db: Kysely<Database>;
  let approvals: ApprovalsService;
  let allowances: AllowanceService;
  let trips: BusinessTripService;
  let organization: OrganizationService;

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
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        ...fxTestProviders(),
        PluginLoader,
        OrgContextResolver,
        CurrencyService,
        AccountService,
        LedgerValidationService,
        PostingService,
        StatusTransitionService,
        PeriodLockService,
        RulesService,
        PolicyService,
        PostingPipelineService,
        VoucherProjectionService,
        AuditLogService,
        ExpensesService,
        SalesInvoicesService,
        {
          provide: ReconciliationService,
          useValue: {
            activateMatch: jest.fn(),
            discardDraftMatch: jest.fn(),
          },
        },
        AllowanceLimitService,
        AllowanceProjectionService,
        BusinessTripService,
        AuditFindingsService,
        AllowanceService,
        ApprovalsService,
        {
          provide: CategoryService,
          useValue: {
            list: () => Promise.resolve([]),
            isValid: () => Promise.resolve(true),
            assertValid: () => Promise.resolve(),
          },
        },
      ],
    }).compile();

    approvals = module.get(ApprovalsService);
    allowances = module.get(AllowanceService);
    trips = module.get(BusinessTripService);
    organization = module.get(OrganizationService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  /** A submitted daily allowance, awaiting approval. Returns the approval id. */
  async function submittedAllowance(): Promise<{
    allowanceId: number;
    approvalId: number;
  }> {
    const claimant = await seedEntity(db, { role: 'employee' });
    const trip = await trips.createBusinessTrip({
      claimantId: claimant.id,
      departureDate: '2026-06-13',
      returnDate: '2026-06-18',
      destinationCountry: 'DE',
    });
    const allowance = await allowances.createAllowance({
      claimantId: claimant.id,
      tripId: trip.id,
      type: 'daily_allowance',
    });
    await allowances.submitAllowance(allowance.id);
    const approval = await db
      .selectFrom('approval')
      .selectAll()
      .where('object_type', '=', 'allowance')
      .where('object_id', '=', allowance.id)
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();
    return { allowanceId: allowance.id, approvalId: approval.id };
  }

  const voucherCount = async () =>
    Number(
      (
        await db
          .selectFrom('voucher')
          .select((eb) => eb.fn.countAll().as('c'))
          .executeTakeFirstOrThrow()
      ).c,
    );

  const allowanceRow = (id: number) =>
    db
      .selectFrom('allowance')
      .select([
        'status',
        'currency',
        'voucher_id',
        'gross_amount',
        'tax_free_amount',
        'taxable_amount',
        'exemption_basis',
        'limit_window',
      ])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  const approvalRow = (id: number) =>
    db
      .selectFrom('approval')
      .select(['status', 'approved_by', 'resolved_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  // ── the defect ───────────────────────────────────────────────────────────

  it('refuses to post an allowance denominated in anything but the books’ base currency, and rolls everything back', async () => {
    const { allowanceId, approvalId } = await submittedAllowance();

    // The whole approval transaction is the unit of work: the split is
    // recomputed and WRITTEN before the voucher is projected, so the refusal
    // has to take those writes back with it, not just skip the posting.
    const allowanceBefore = await allowanceRow(allowanceId);
    const approvalBefore = await approvalRow(approvalId);

    // Legitimate: the ledger is still empty, so the basis may still be set up.
    await organization.updateOrganization({ base_currency: 'USD' });

    // The allowance still says EUR, and its lines would be booked at an
    // identity rate — EUR cents entering a USD-basis ledger as if they were
    // USD. Refused, with nothing written.
    await expect(
      approvals.approveApproval(approvalId, 'approver@test.com'),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(await voucherCount()).toBe(0);
    // The claim is still awaiting approval, with its split untouched, and the
    // approval is still pending — not approved-but-unposted.
    expect(await allowanceRow(allowanceId)).toEqual(allowanceBefore);
    expect(allowanceBefore.status).toBe('needs_triage');
    expect(await approvalRow(approvalId)).toEqual(approvalBefore);
    expect(approvalBefore.status).toBe('pending');
  });

  it('names both currencies so the refusal is actionable', async () => {
    const { approvalId } = await submittedAllowance();
    await organization.updateOrganization({ base_currency: 'USD' });
    await expect(
      approvals.approveApproval(approvalId, 'approver@test.com'),
    ).rejects.toThrow(/EUR.*USD|USD.*EUR/s);
  });

  it('offers only the resolutions that actually exist', async () => {
    const { approvalId } = await submittedAllowance();
    await organization.updateOrganization({ base_currency: 'USD' });

    // The claim workflow takes no currency, so "re-raise it in USD" is not a
    // thing a caller can do, and the message must not imply it. What it may
    // offer: setting the base currency back while the ledger is still empty,
    // and otherwise handling the claim outside this workflow.
    const err = await approvals
      .approveApproval(approvalId, 'approver@test.com')
      .catch((e: Error) => e);
    const message = (err as Error).message;
    expect(message).toMatch(/no supported way to restate/i);
    expect(message).toMatch(/set back to EUR/i);
    expect(message).toMatch(/accountant/i);
    expect(message).not.toMatch(/convert|exchange rate/i);
  });

  it('posts normally when the allowance and the books agree', async () => {
    const { allowanceId, approvalId } = await submittedAllowance();

    await approvals.approveApproval(approvalId, 'approver@test.com');

    expect(await voucherCount()).toBe(1);
    expect((await allowanceRow(allowanceId)).status).toBe('posted');

    const lines = await db
      .selectFrom('voucher_line')
      .select(['currency', 'base_amount', 'amount', 'fx_rate'])
      .execute();
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.currency).toBe('EUR');
      expect(l.fx_rate).toBe(1);
      expect(l.base_amount).toBe(l.amount);
    }
  });

  it('still allows an effect-free basis edit before the allowance is approved', async () => {
    const { approvalId } = await submittedAllowance();

    // Writing the plugin's own default into the override changes the column,
    // not the measurement — the allowance is still denominated in the books'
    // currency and posts.
    await organization.updateOrganization({ base_currency: 'EUR' });
    await approvals.approveApproval(approvalId, 'approver@test.com');
    expect(await voucherCount()).toBe(1);
  });
});
