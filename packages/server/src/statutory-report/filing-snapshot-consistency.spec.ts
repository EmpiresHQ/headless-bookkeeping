import { fxTestProviders } from '../../test/fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { ConflictException } from '@nestjs/common';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { StatutoryReportService } from './statutory-report.service';
import { VatReportService } from '../vat-report/vat-report.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { AccountService } from '../ledger/account/account.service';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { CurrencyService } from '../currency/currency.service';
import { VoucherRepository } from '../ledger/voucher/voucher.repository';
import { VoucherLineRepository } from '../ledger/voucher/voucher-line.repository';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PostingService } from '../ledger/posting/posting.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
import { ReportingPeriodsService } from '../reporting-periods/reporting-periods.service';
import { StatutorySubmissionService } from '../statutory-submission/statutory-submission.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { validateAgainstKmdXsd } from '../plugins/estonia-kmd/xsd-validate';
import { readFileSync } from 'fs';
import { join } from 'path';

const xsd = readFileSync(
  join(__dirname, '../../test/fixtures/vatdeclaration.xsd'),
  'utf8',
);

/**
 * Issue #200 — the filing state a period is closed against must be complete,
 * frozen at the close, and reproducible afterwards.
 *
 * Real-DI against in-memory SQLite with the real migrations, services and
 * country plugin. The migration seeds reporting_period 1 = 2024-Q1 (open); the
 * EE plugin is made active by setting org.country = 'EE'.
 */
describe('Filing-state consistency (issue #200)', () => {
  let db: Kysely<Database>;
  let statutory: StatutoryReportService;
  let vatReports: VatReportService;
  let periods: ReportingPeriodsService;
  let submissions: StatutorySubmissionService;
  let organization: OrganizationService;
  let salesInvoices: SalesInvoicesService;
  let posting: PostingService;

  const PERIOD_ID = 1;

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
        OrgContextResolver,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        ...fxTestProviders(),
        PluginLoader,
        LedgerBalanceService,
        AccountService,
        CurrencyService,
        VoucherRepository,
        VoucherLineRepository,
        LedgerValidationService,
        PostingService,
        PeriodLockService,
        VoucherProjectionService,
        SalesInvoicesService,
        AuditFindingsService,
        AuditLogService,
        VatReportService,
        StatutorySubmissionService,
        StatutoryReportService,
        ReportingPeriodsService,
      ],
    }).compile();

    statutory = module.get(StatutoryReportService);
    vatReports = module.get(VatReportService);
    periods = module.get(ReportingPeriodsService);
    submissions = module.get(StatutorySubmissionService);
    organization = module.get(OrganizationService);
    salesInvoices = module.get(SalesInvoicesService);
    posting = module.get(PostingService);

    await organization.updateOrganization({
      country: 'EE',
      vat_registered: true,
      vat_registration_number: 'EE100000001',
      registry_code: '17499653',
      name: 'Test OÜ',
    });
  });

  afterEach(async () => {
    await db.destroy();
  });

  /** A registered B2B customer, so the sale lands on the INF annex. */
  async function createCustomer(
    regNumber: string,
    name: string,
  ): Promise<number> {
    const entity = await db
      .insertInto('entity')
      .values({
        role: 'customer',
        country: 'EE',
        name,
        goods_vs_services: 'goods',
        created_at: 0,
        updated_at: 0,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('entity_identifier')
      .values({
        entity_id: entity.id,
        kind: 'registration_key',
        value: regNumber,
        confirmed: 1,
      })
      .execute();
    return entity.id;
  }

  /** Post a domestic 24% sale (Dr AR / Cr REVENUE / Cr VAT_PAYABLE). */
  async function postSale({
    customerId = null,
    invoiceNumber,
    net,
  }: {
    customerId?: number | null;
    invoiceNumber: string;
    net: number;
  }): Promise<void> {
    const vat = Math.round(net * 0.24);
    const inv = await salesInvoices.createInvoice({
      customer_id: customerId,
      invoice_number: invoiceNumber,
      gross_amount: net + vat,
      vat_amount: vat,
      currency: 'EUR',
      tax_point_date: '2024-02-15',
      due_date: null,
    });
    const draft = await salesInvoices.generateDraftVoucher(inv.id);
    const posted = await posting.postVoucher(draft);
    await salesInvoices.updateInvoiceStatus(inv.id, 'posted', posted.id);
  }

  const countRows = async (
    table: 'vat_report' | 'statutory_filing_snapshot',
  ): Promise<number> =>
    (await db.selectFrom(table).selectAll().execute()).length;

  // ── AC1: a draft download freezes nothing ────────────────────────────────

  it('a draft export leaves no permanent filing snapshot behind', async () => {
    await postSale({ invoiceNumber: 'A', net: 10000 });

    const draft = await statutory.generate(PERIOD_ID, { formats: ['xml'] });
    expect(draft.artifacts[0].content).toContain(
      '<transactions24>100.00</transactions24>',
    );

    expect(await countRows('vat_report')).toBe(0);
    expect(await countRows('statutory_filing_snapshot')).toBe(0);

    // Repeated downloads still freeze nothing, and follow the live ledger.
    await postSale({ invoiceNumber: 'B', net: 10000 });
    const second = await statutory.generate(PERIOD_ID, { formats: ['xml'] });
    expect(second.artifacts[0].content).toContain(
      '<transactions24>200.00</transactions24>',
    );
    expect(await countRows('vat_report')).toBe(0);

    const period = await periods.getById(PERIOD_ID);
    expect(period.status).toBe('open');
    expect(period.vat_report_snapshot_id).toBeNull();
  });

  // ── AC2: the issue's exact reproduction now closes on the full period ────

  it('export → another posting → lock freezes BOTH sales, EUR 48 VAT and the complete voucher commitment', async () => {
    await postSale({ invoiceNumber: 'A', net: 10000 });
    await statutory.generate(PERIOD_ID, { formats: ['xml'] }); // the draft download
    await postSale({ invoiceNumber: 'B', net: 10000 });

    const locked = await periods.lock(PERIOD_ID);

    const frozen = await vatReports.getById(
      locked.vat_report_snapshot_id as number,
    );
    const live = await vatReports.preview(PERIOD_ID);

    expect(frozen.total_output_vat).toBe(4800);
    expect(live.total_output_vat).toBe(4800);
    expect(frozen.voucher_ids).toHaveLength(2);
    expect(frozen.voucher_ids).toEqual(live.voucher_ids);
    expect(frozen.merkle_root).toBe(live.merkle_root);

    // The final XML agrees with the frozen snapshot — no 24-vs-48-vs-200 split.
    const final = await statutory.generate(PERIOD_ID, { formats: ['xml'] });
    expect(final.artifacts[0].content).toContain(
      '<transactions24>200.00</transactions24>',
    );

    // The prepared event pins the snapshot actually filed, and its payload.
    const state = await submissions.getState(PERIOD_ID);
    expect(state.currentSnapshotId).toBe(frozen.id);
    expect(state.currentPayloadId).not.toBeNull();
  });

  // ── Legacy: a prematurely frozen snapshot is superseded, never reused ────

  it('a snapshot frozen early is superseded at lock, retained unmodified, and flagged', async () => {
    await postSale({ invoiceNumber: 'A', net: 10000 });
    // Simulate the pre-fix world (and the still-supported explicit freeze API):
    // a permanent snapshot frozen while the period was incomplete.
    const stale = await vatReports.generate(PERIOD_ID);
    expect(stale.total_output_vat).toBe(2400);

    await postSale({ invoiceNumber: 'B', net: 10000 });
    const locked = await periods.lock(PERIOD_ID);

    expect(locked.vat_report_snapshot_id).not.toBe(stale.id);
    const bound = await vatReports.getById(
      locked.vat_report_snapshot_id as number,
    );
    expect(bound.total_output_vat).toBe(4800);

    // The stale row is untouched and still readable — never edited, never deleted.
    const retained = await vatReports.getById(stale.id);
    expect(retained.total_output_vat).toBe(2400);
    expect(retained.merkle_root).toBe(stale.merkle_root);
    expect(await countRows('vat_report')).toBe(2);

    // The supersession is recorded, not silent.
    const findings = await db
      .selectFrom('audit_finding')
      .selectAll()
      .where('finding_type', '=', 'statutory_report_incomplete')
      .execute();
    expect(
      findings.some((f) => f.description.includes(`superseded VAT snapshot`)),
    ).toBe(true);
  });

  // ── AC3: a final export reproduces the BOUND state ───────────────────────

  it('a repeated final export reproduces the bound filing state despite mutable org and counterparty changes', async () => {
    const customerId = await createCustomer('EE200000002', 'Acme Buyer OÜ');
    await postSale({ customerId, invoiceNumber: 'INV-1', net: 200000 });

    await periods.lock(PERIOD_ID);
    const first = await statutory.generate(PERIOD_ID, { formats: ['xml'] });
    expect(first.artifacts[0].content).toContain('Acme Buyer OÜ');
    expect(first.artifacts[0].content).toContain(
      '<taxPayerRegCode>17499653</taxPayerRegCode>',
    );

    // Everything mutable the old export read from moves underneath us.
    await organization.updateOrganization({
      name: 'Renamed OÜ',
      registry_code: '10000000',
    });
    await db
      .updateTable('entity')
      .set({ name: 'Renamed Buyer AS' })
      .where('id', '=', customerId)
      .execute();
    await db
      .updateTable('entity_identifier')
      .set({ value: 'EE999999999' })
      .where('entity_id', '=', customerId)
      .execute();

    const second = await statutory.generate(PERIOD_ID, { formats: ['xml'] });
    expect(second.artifacts[0].content).toBe(first.artifacts[0].content);
    expect(second.artifacts[0].content).not.toContain('Renamed');
  });

  it('a final export renders with the jurisdiction frozen at the close, not the current one', async () => {
    await postSale({ invoiceNumber: 'A', net: 10000 });
    await periods.lock(PERIOD_ID);
    const filed = await statutory.generate(PERIOD_ID, { formats: ['xml'] });
    expect(filed.artifacts).toHaveLength(1);

    // Moving the organization to a country with no dedicated plugin would fall
    // back to NullCountryPlugin, which produces NO artifacts at all.
    await organization.updateOrganization({ country: 'DK' });

    const again = await statutory.generate(PERIOD_ID, { formats: ['xml'] });
    expect(again.artifacts).toHaveLength(1);
    expect(again.artifacts[0].content).toBe(filed.artifacts[0].content);
  });

  // ── Payload versions stay addressable per submission event ───────────────

  it('a reconciliation appends a payload version without changing what an earlier submitted event identifies', async () => {
    await postSale({ invoiceNumber: 'A', net: 10000 });
    const stale = await vatReports.generate(PERIOD_ID);
    await postSale({ invoiceNumber: 'B', net: 10000 });

    // Bind the stale snapshot the way the pre-fix lock did, and file it.
    await db
      .updateTable('reporting_period')
      .set({ status: 'locked', filed_at: 1, vat_report_snapshot_id: stale.id })
      .where('id', '=', PERIOD_ID)
      .execute();
    const v1 = await statutory.freezeFilingSnapshot(
      PERIOD_ID,
      stale.id,
      'lock',
    );
    await submissions.recordEvent(PERIOD_ID, {
      event_kind: 'prepared',
      report_kind: 'EE_KMD',
      source_snapshot_type: 'vat_report',
      source_snapshot_id: stale.id,
      source_payload_id: v1.payloadId,
      actor: 'system',
    });
    await submissions.recordOperatorEvent(PERIOD_ID, {
      event_kind: 'submitted',
      external_ref: 'EMTA-1',
    });
    const filedXml = (await statutory.generate(PERIOD_ID, { formats: ['xml'] }))
      .artifacts[0].content;

    const outcome = await periods.reconcileFilingSnapshot(PERIOD_ID);
    expect(outcome.changed).toBe(true);
    expect(outcome.snapshot_superseded).toBe(true);
    expect(outcome.previous_payload_id).toBe(v1.payloadId);
    expect(outcome.current_payload_id).not.toBe(v1.payloadId);

    // The default export now renders the corrected version...
    const corrected = await statutory.generate(PERIOD_ID, { formats: ['xml'] });
    expect(corrected.artifacts[0].content).toContain(
      '<transactions24>200.00</transactions24>',
    );

    // ...while the version the `submitted` event names is still reproducible,
    // byte for byte, and the event still points at it.
    const submitted = (await submissions.getState(PERIOD_ID)).history.find(
      (e) => e.event_kind === 'submitted',
    );
    expect(submitted?.source_snapshot_id).toBe(stale.id);
    expect(submitted?.source_payload_id).toBe(v1.payloadId);

    const replayed = await statutory.generate(PERIOD_ID, {
      formats: ['xml'],
      filingVersionId: submitted?.source_payload_id as number,
    });
    expect(replayed.artifacts[0].content).toBe(filedXml);
    expect(
      replayed.warnings.some((w) => w.code === 'filing_payload_superseded'),
    ).toBe(true);
  });

  it('keeps the correction-declaration obligation open across repeated reconciliations until the corrected version is itself submitted', async () => {
    await postSale({ invoiceNumber: 'A', net: 10000 });
    const stale = await vatReports.generate(PERIOD_ID);
    await postSale({ invoiceNumber: 'B', net: 10000 });
    await db
      .updateTable('reporting_period')
      .set({ status: 'locked', filed_at: 1, vat_report_snapshot_id: stale.id })
      .where('id', '=', PERIOD_ID)
      .execute();
    const v1 = await statutory.freezeFilingSnapshot(
      PERIOD_ID,
      stale.id,
      'lock',
    );
    await submissions.recordEvent(PERIOD_ID, {
      event_kind: 'prepared',
      report_kind: 'EE_KMD',
      source_snapshot_type: 'vat_report',
      source_snapshot_id: stale.id,
      source_payload_id: v1.payloadId,
      actor: 'system',
    });
    await submissions.recordOperatorEvent(PERIOD_ID, {
      event_kind: 'submitted',
      external_ref: 'EMTA-1',
    });
    await submissions.recordOperatorEvent(PERIOD_ID, {
      event_kind: 'accepted',
    });

    const first = await periods.reconcileFilingSnapshot(PERIOD_ID);
    expect(first.changed).toBe(true);
    expect(first.correction_declaration_required).toBe(true);

    // A retry writes nothing, but the obligation does NOT quietly clear.
    const retry = await periods.reconcileFilingSnapshot(PERIOD_ID);
    expect(retry.changed).toBe(false);
    expect(retry.correction_declaration_required).toBe(true);
    expect(retry.current_snapshot_id).toBe(first.current_snapshot_id);
    expect(retry.current_payload_id).toBe(first.current_payload_id);
    expect(retry.notes.join(' ')).toContain('parandusdeklaratsioon');

    // A retry appends no new finding — the first one stays open instead.
    const findings = await db
      .selectFrom('audit_finding')
      .selectAll()
      .where('finding_type', '=', 'statutory_report_incomplete')
      .execute();
    expect(
      findings.filter((f) =>
        f.description.includes('Filing-state reconciliation'),
      ),
    ).toHaveLength(1);

    // Recording the correction against the corrected version clears it.
    await submissions.recordOperatorEvent(PERIOD_ID, {
      event_kind: 'correction_submitted',
      external_ref: 'EMTA-2',
    });
    const after = await periods.reconcileFilingSnapshot(PERIOD_ID);
    expect(after.correction_declaration_required).toBe(false);
  });

  // ── Legacy locked period with no frozen filing state ─────────────────────

  it('refuses a final export for a legacy locked period, and repairs it on reconcile', async () => {
    await postSale({ invoiceNumber: 'A', net: 10000 });
    const stale = await vatReports.generate(PERIOD_ID);
    await postSale({ invoiceNumber: 'B', net: 10000 });
    await db
      .updateTable('reporting_period')
      .set({ status: 'locked', filed_at: 1, vat_report_snapshot_id: stale.id })
      .where('id', '=', PERIOD_ID)
      .execute();

    // Refused outright — no artifact is produced that a caller could mistake
    // for the filed document.
    await expect(
      statutory.generate(PERIOD_ID, { formats: ['xml'] }),
    ).rejects.toThrow(/no frozen filing state/i);

    const outcome = await periods.reconcileFilingSnapshot(PERIOD_ID);
    expect(outcome.changed).toBe(true);
    expect(outcome.snapshot_superseded).toBe(true);
    expect(outcome.correction_declaration_required).toBe(false);

    const repaired = await statutory.generate(PERIOD_ID, { formats: ['xml'] });
    expect(repaired.artifacts[0].content).toContain(
      '<transactions24>200.00</transactions24>',
    );
    expect(repaired.warnings.map((w) => w.code)).not.toContain(
      'filing_snapshot_drift',
    );

    // Idempotent: a healthy period writes nothing on a second run.
    const payloadsBefore = await countRows('statutory_filing_snapshot');
    const again = await periods.reconcileFilingSnapshot(PERIOD_ID);
    expect(again.changed).toBe(false);
    expect(await countRows('statutory_filing_snapshot')).toBe(payloadsBefore);
  });

  it('restores a null binding on a legacy locked period whose existing snapshot is already current', async () => {
    await postSale({ invoiceNumber: 'A', net: 10000 });
    // The existing snapshot already describes the period exactly, so the freeze
    // REUSES it (created = false) — but the period is bound to nothing.
    const current = await vatReports.generate(PERIOD_ID);
    await db
      .updateTable('reporting_period')
      .set({ status: 'locked', filed_at: 1, vat_report_snapshot_id: null })
      .where('id', '=', PERIOD_ID)
      .execute();

    await expect(
      statutory.generate(PERIOD_ID, { formats: ['xml'] }),
    ).rejects.toThrow(/no frozen filing state/i);

    const outcome = await periods.reconcileFilingSnapshot(PERIOD_ID);
    expect(outcome.changed).toBe(true);
    expect(outcome.snapshot_superseded).toBe(false);
    expect(outcome.previous_snapshot_id).toBeNull();
    expect(outcome.current_snapshot_id).toBe(current.id);
    // No duplicate snapshot was written — the existing one was simply rebound.
    expect(await countRows('vat_report')).toBe(1);
    expect((await periods.getById(PERIOD_ID)).vat_report_snapshot_id).toBe(
      current.id,
    );

    const repaired = await statutory.generate(PERIOD_ID, { formats: ['xml'] });
    expect(repaired.artifacts[0].content).toContain(
      '<transactions24>100.00</transactions24>',
    );

    const again = await periods.reconcileFilingSnapshot(PERIOD_ID);
    expect(again.changed).toBe(false);
  });

  it('reconciliation refuses an open period', async () => {
    await expect(periods.reconcileFilingSnapshot(PERIOD_ID)).rejects.toThrow(
      ConflictException,
    );
  });

  // ── Filing is one atomic act ─────────────────────────────────────────────

  it('a failure while freezing the filing payload rolls the whole lock back', async () => {
    await postSale({ invoiceNumber: 'A', net: 10000 });

    jest
      .spyOn(statutory, 'freezeFilingSnapshot')
      .mockRejectedValueOnce(new Error('disk on fire'));

    await expect(periods.lock(PERIOD_ID)).rejects.toThrow('disk on fire');

    const period = await periods.getById(PERIOD_ID);
    expect(period.status).toBe('open');
    expect(period.filed_at).toBeNull();
    expect(period.vat_report_snapshot_id).toBeNull();
    expect(await countRows('vat_report')).toBe(0);
    expect(await countRows('statutory_filing_snapshot')).toBe(0);
    expect((await submissions.getState(PERIOD_ID)).history).toHaveLength(0);

    // A retry after the fault files cleanly — no half-written evidence left.
    jest.restoreAllMocks();
    const locked = await periods.lock(PERIOD_ID);
    expect(locked.status).toBe('locked');
    expect((await submissions.getState(PERIOD_ID)).history).toHaveLength(1);
  });

  it('a failure while recording the prepared event rolls the lock back too', async () => {
    await postSale({ invoiceNumber: 'A', net: 10000 });

    jest
      .spyOn(submissions, 'recordEvent')
      .mockRejectedValueOnce(new Error('event log unavailable'));

    await expect(periods.lock(PERIOD_ID)).rejects.toThrow(
      'event log unavailable',
    );

    const period = await periods.getById(PERIOD_ID);
    expect(period.status).toBe('open');
    expect(await countRows('vat_report')).toBe(0);
    expect(await countRows('statutory_filing_snapshot')).toBe(0);
  });

  it('a failure while recording the reconciliation event leaves the old binding intact', async () => {
    await postSale({ invoiceNumber: 'A', net: 10000 });
    const stale = await vatReports.generate(PERIOD_ID);
    await postSale({ invoiceNumber: 'B', net: 10000 });
    await db
      .updateTable('reporting_period')
      .set({ status: 'locked', filed_at: 1, vat_report_snapshot_id: stale.id })
      .where('id', '=', PERIOD_ID)
      .execute();
    await statutory.freezeFilingSnapshot(PERIOD_ID, stale.id, 'lock');

    const payloadsBefore = await countRows('statutory_filing_snapshot');
    jest
      .spyOn(submissions, 'recordEvent')
      .mockRejectedValueOnce(new Error('event log unavailable'));

    await expect(periods.reconcileFilingSnapshot(PERIOD_ID)).rejects.toThrow(
      'event log unavailable',
    );

    // Binding, snapshot and payload all rolled back together — the period is
    // NOT left bound to a new snapshot whose pinning event never landed.
    const period = await periods.getById(PERIOD_ID);
    expect(period.vat_report_snapshot_id).toBe(stale.id);
    expect(await countRows('vat_report')).toBe(1);
    expect(await countRows('statutory_filing_snapshot')).toBe(payloadsBefore);

    // Retrying after the fault completes the repair.
    jest.restoreAllMocks();
    const outcome = await periods.reconcileFilingSnapshot(PERIOD_ID);
    expect(outcome.changed).toBe(true);
    expect((await periods.getById(PERIOD_ID)).vat_report_snapshot_id).toBe(
      outcome.current_snapshot_id,
    );
  });

  // ── Immutability of the new table ────────────────────────────────────────

  // ── Issue #209: a payload frozen BEFORE KMD field 3.1 had its own row ─────

  /**
   * Freeze a payload the way the pre-#209 code did: identical in every respect
   * except that `declaration.row3_1_intra_eu_supply` does not exist, because
   * the field did not exist. The stored row is APPENDED, never edited — the
   * existing rows are immutable by trigger, and this test does not touch them.
   */
  async function freezeLegacyPayload(): Promise<{
    legacyVersionId: number;
    currentVersionId: number;
  }> {
    const current = await db
      .selectFrom('statutory_filing_snapshot')
      .selectAll()
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    const payload = JSON.parse(current.payload) as {
      declaration: Record<string, unknown>;
    };
    delete payload.declaration.row3_1_intra_eu_supply;
    const legacy = await db
      .insertInto('statutory_filing_snapshot')
      .values({
        reporting_period_id: current.reporting_period_id,
        vat_report_id: current.vat_report_id,
        report_kind: current.report_kind,
        country: current.country,
        payload: JSON.stringify(payload),
        reason: current.reason,
        created_at: current.created_at,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    return { legacyVersionId: legacy.id, currentVersionId: current.id };
  }

  it('renders a pre-3.1 frozen payload byte-identically and XSD-valid — non-zero intra-EU', async () => {
    // An intra-EU B2B service sale (0%, KMD rows 3 + 3.1, VD 3S) plus a
    // domestic sale, so both the 3.1 box and the 24% box carry figures.
    const fiCustomer = await db
      .insertInto('entity')
      .values({
        role: 'customer',
        country: 'FI',
        name: 'Suomi Oy',
        goods_vs_services: 'services',
        tax_status: 'taxable_business',
        created_at: 0,
        updated_at: 0,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    const euInvoice = await salesInvoices.createInvoice({
      customer_id: fiCustomer.id,
      invoice_number: 'EU-SERVICE',
      gross_amount: 10000,
      vat_amount: 0,
      currency: 'EUR',
      tax_point_date: '2024-02-15',
      supply_type: 'services',
    });
    const euDraft = await salesInvoices.generateDraftVoucher(euInvoice.id);
    const euPosted = await posting.postVoucher(euDraft);
    await salesInvoices.updateInvoiceStatus(
      euInvoice.id,
      'posted',
      euPosted.id,
    );
    await postSale({ invoiceNumber: 'DOMESTIC', net: 20000 });

    await periods.lock(PERIOD_ID);
    const { legacyVersionId, currentVersionId } = await freezeLegacyPayload();

    const renderOf = async (versionId: number) => {
      const res = await statutory.generate(PERIOD_ID, {
        formats: ['xml', 'csv'],
        filingVersionId: versionId,
      });
      return {
        xml: res.artifacts.find((a) => a.filename.endsWith('.xml'))!.content,
        csv: res.artifacts.find((a) => a.filename.endsWith('.csv'))!.content,
      };
    };

    const legacy = await renderOf(legacyVersionId);
    const currentRender = await renderOf(currentVersionId);

    // The figure the box was always rendered from is reproduced exactly…
    expect(legacy.xml).toContain(
      '<euSupplyInclGoodsAndServicesZeroVat>100.00</euSupplyInclGoodsAndServicesZeroVat>',
    );
    expect(legacy.xml).not.toContain('NaN');
    expect(legacy.csv).not.toContain('NaN');
    // …and the whole artifact is byte-identical to the current-format render.
    expect(legacy.xml).toBe(currentRender.xml);
    expect(legacy.csv).toBe(currentRender.csv);
    expect(validateAgainstKmdXsd(legacy.xml, xsd)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('renders a pre-3.1 frozen payload byte-identically — zero intra-EU', async () => {
    // Nothing intra-EU at all: the box must stay ABSENT, not become NaN.
    await postSale({ invoiceNumber: 'DOMESTIC-ONLY', net: 20000 });
    await periods.lock(PERIOD_ID);
    const { legacyVersionId, currentVersionId } = await freezeLegacyPayload();

    const render = async (versionId: number) =>
      (
        await statutory.generate(PERIOD_ID, {
          formats: ['xml', 'csv'],
          filingVersionId: versionId,
        })
      ).artifacts;

    const legacy = await render(legacyVersionId);
    const currentRender = await render(currentVersionId);
    const xml = legacy.find((a) => a.filename.endsWith('.xml'))!.content;
    const csv = legacy.find((a) => a.filename.endsWith('.csv'))!.content;

    expect(xml).not.toContain('euSupplyInclGoodsAndServicesZeroVat');
    expect(xml).not.toContain('NaN');
    expect(csv).not.toContain('NaN');
    expect(xml).toBe(
      currentRender.find((a) => a.filename.endsWith('.xml'))!.content,
    );
    expect(csv).toBe(
      currentRender.find((a) => a.filename.endsWith('.csv'))!.content,
    );
    expect(validateAgainstKmdXsd(xml, xsd)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('statutory_filing_snapshot rows reject UPDATE and DELETE', async () => {
    await postSale({ invoiceNumber: 'A', net: 10000 });
    await periods.lock(PERIOD_ID);

    const row = await db
      .selectFrom('statutory_filing_snapshot')
      .select('id')
      .executeTakeFirstOrThrow();

    await expect(
      db
        .updateTable('statutory_filing_snapshot')
        .set({ payload: '{}' })
        .where('id', '=', row.id)
        .execute(),
    ).rejects.toThrow('append-only');
    await expect(
      db
        .deleteFrom('statutory_filing_snapshot')
        .where('id', '=', row.id)
        .execute(),
    ).rejects.toThrow('append-only');
  });
});
