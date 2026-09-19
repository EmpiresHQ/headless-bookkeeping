import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { VatReportService } from '../vat-report/vat-report.service';
import { OrganizationService } from '../organization/organization.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { StatutorySubmissionService } from '../statutory-submission/statutory-submission.service';
import { StatutoryReportService } from '../statutory-report/statutory-report.service';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import {
  computeNextPeriodDates,
  computeEndFromStart,
  computeNameFromStart,
} from './period-dates';
import {
  ReportingPeriod,
  CreateReportingPeriodDto,
  CreateNextPeriodDto,
  PeriodWarning,
  FilingReconciliation,
} from './types';

@Injectable()
export class ReportingPeriodsService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly vatReportService: VatReportService,
    private readonly organizationService: OrganizationService,
    private readonly pluginLoader: PluginLoader,
    private readonly statutorySubmissionService: StatutorySubmissionService,
    private readonly statutoryReportService: StatutoryReportService,
    private readonly auditFindings: AuditFindingsService,
  ) {}

  async list(): Promise<ReportingPeriod[]> {
    const rows = await this.db
      .selectFrom('reporting_period')
      .selectAll()
      .orderBy('start_date', 'asc')
      .execute();

    return rows.map((r) => this.mapRow(r));
  }

  async getById(id: number): Promise<ReportingPeriod> {
    const row = await this.db
      .selectFrom('reporting_period')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundException(`Reporting period ${id} not found`);
    }

    return this.mapRow(row);
  }

  /**
   * Delete a reporting period — ONLY if it is empty (open, never filed, with no
   * vouchers tax-point-dated inside it). Lets an operator undo a mistakenly
   * created period (there is no other removal path). A `locked` period or one
   * that already has vouchers is never deletable — those are corrected via the
   * normal reversal/correction flows.
   */
  async deleteEmptyPeriod(id: number): Promise<ReportingPeriod> {
    const period = await this.getById(id); // 404s if unknown

    if (period.status === 'locked') {
      throw new ConflictException(
        `Reporting period ${id} (${period.name}) is locked — cannot delete a filed period.`,
      );
    }

    const voucher = await this.db
      .selectFrom('voucher')
      .select('id')
      .where('tax_point_date', '>=', period.start_date)
      .where('tax_point_date', '<=', period.end_date)
      .limit(1)
      .executeTakeFirst();
    if (voucher) {
      throw new ConflictException(
        `Reporting period ${id} (${period.name}) has vouchers — only an empty period can be deleted.`,
      );
    }

    await this.db.deleteFrom('reporting_period').where('id', '=', id).execute();

    return period;
  }

  async getCurrent(): Promise<ReportingPeriod> {
    const row = await this.db
      .selectFrom('reporting_period')
      .selectAll()
      .where('status', '=', 'open')
      .orderBy('start_date', 'desc')
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundException('No open reporting period found');
    }

    return this.mapRow(row);
  }

  async create(dto: CreateReportingPeriodDto): Promise<ReportingPeriod> {
    const now = Math.floor(Date.now() / 1000);

    // Reject a period that overlaps any existing one (D3). Two periods overlap
    // when each starts on or before the other ends; ISO date strings compare
    // lexicographically. Overlapping periods make `getCurrent` ambiguous and
    // let a single tax_point_date fall into two periods (double-counted in VAT
    // reports), so a date must belong to at most one reporting period.
    const overlap = await this.db
      .selectFrom('reporting_period')
      .select(['id', 'name'])
      .where('start_date', '<=', dto.end_date)
      .where('end_date', '>=', dto.start_date)
      .executeTakeFirst();
    if (overlap) {
      throw new ConflictException(
        `Reporting period ${dto.start_date}..${dto.end_date} overlaps existing period "${overlap.name}" (${overlap.id})`,
      );
    }

    const row = await this.db
      .insertInto('reporting_period')
      .values({
        name: dto.name,
        start_date: dto.start_date,
        end_date: dto.end_date,
        status: 'open',
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.mapRow(row);
  }

  async createNext(override: CreateNextPeriodDto): Promise<ReportingPeriod> {
    const org = await this.organizationService.getOrganization();
    const plugin = this.pluginLoader.resolve(org.country);
    const frequency = plugin.getDefaultPeriodFrequency();

    const periods = await this.list();
    const lastEndDate =
      periods.length > 0 ? periods[periods.length - 1].end_date : null;

    const today = new Date().toISOString().slice(0, 10);
    const computed = computeNextPeriodDates(frequency, lastEndDate, today);

    const start_date = override.start_date ?? computed.start_date;
    const end_date =
      override.end_date ??
      (override.start_date
        ? computeEndFromStart(frequency, override.start_date)
        : computed.end_date);
    const name = override.name ?? computeNameFromStart(frequency, start_date);

    return this.create({ name, start_date, end_date });
  }

  /**
   * File (lock) a reporting period. Filing is ONE atomic act (ADR-0009): in a
   * single transaction it
   *   1. freezes a COMPLETE, CURRENT VAT snapshot over every voucher covered by
   *      the period (with its Merkle commitment),
   *   2. freezes the full filing payload bound to that snapshot — declarant
   *      identity, signed declaration bases and INF detail — so the final
   *      export never has to recompute them from mutable current data, and
   *   3. flips the period to `locked`, stamping `filed_at` +
   *      `vat_report_snapshot_id`.
   * All three or none: there is no "locked without snapshot" state, and no
   * "locked against an incomplete snapshot" state either.
   *
   * Issue #200: the freeze in step 1 no longer blindly reuses whatever
   * `vat_report` row happened to exist. A snapshot that still describes the
   * period exactly is reused (filing stays idempotent); one that has drifted —
   * classically because an early draft export froze it — is SUPERSEDED by a
   * fresh complete snapshot. The drifted row is never edited or deleted (it is
   * immutable by trigger) and any submission event that pinned it keeps naming
   * the exact artifact it filed; it simply stops being the current one. The
   * supersession is recorded as an audit finding, never silently.
   *
   * Idempotent: re-filing an already-locked period returns it unchanged and
   * never regenerates anything. Filing must proceed in order: an earlier
   * still-open period blocks filing a later one (409).
   */
  async lock(id: number): Promise<ReportingPeriod> {
    const existing = await this.getById(id);

    // Idempotent: already locked → return as-is (no regeneration).
    if (existing.status === 'locked') {
      return existing;
    }

    // Filing order: no filing a later period while an earlier one is still open.
    const earlierOpen = await this.db
      .selectFrom('reporting_period')
      .select(['id', 'name'])
      .where('status', '=', 'open')
      .where('start_date', '<', existing.start_date)
      .orderBy('start_date', 'asc')
      .executeTakeFirst();

    if (earlierOpen) {
      throw new ConflictException(
        `Cannot file period ${existing.name}: earlier period ${earlierOpen.name} is still open — file it first`,
      );
    }

    const filedAt = Math.floor(Date.now() / 1000);

    const outcome = await this.db.transaction().execute(async (trx) => {
      // 1. Freeze a complete, current VAT snapshot inside the filing transaction.
      const frozen = await this.vatReportService.freeze(id, trx);

      // 2. Freeze the full filing payload bound to it. If this throws, the
      //    snapshot and the status flip roll back with it — a period is never
      //    locked against a filing state we could not preserve.
      const payload = await this.statutoryReportService.freezeFilingSnapshot(
        id,
        frozen.report.id,
        'lock',
        trx,
      );

      // 3. Lock the period and bind it to the snapshot.
      const row = await trx
        .updateTable('reporting_period')
        .set({
          status: 'locked',
          filed_at: filedAt,
          vat_report_snapshot_id: frozen.report.id,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();

      // 4. Start the external statutory-filing lifecycle (ADR-0037): a
      //    `prepared` event pinned to the exact frozen snapshot AND the exact
      //    filing-payload version. In the SAME transaction (issue #200): the
      //    event is what tells a later export which payload the filing state
      //    identifies, so a period bound to artifacts whose event never landed
      //    would export the wrong version. All of it commits or none of it
      //    does, and a retry after a failure starts from a clean slate.
      //    filed_at keeps its meaning (the internal lock/close timestamp) and
      //    corresponds to this event; the early idempotent return above ensures
      //    re-locking never emits a duplicate.
      await this.statutorySubmissionService.recordEvent(
        id,
        {
          event_kind: 'prepared',
          report_kind: 'EE_KMD',
          source_snapshot_type: 'vat_report',
          source_snapshot_id: frozen.report.id,
          source_payload_id: payload.payloadId,
          actor: 'system',
        },
        trx,
      );

      return { row, frozen, payload };
    });

    if (outcome.frozen.superseded) {
      await this.auditFindings.create({
        finding_type: 'statutory_report_incomplete',
        severity: 'high',
        description:
          `Filing period "${existing.name}" superseded VAT snapshot ${outcome.frozen.superseded.id} ` +
          `(output VAT ${outcome.frozen.superseded.total_output_vat}, ${outcome.frozen.superseded.voucher_ids.length} voucher(s)) ` +
          `with snapshot ${outcome.frozen.report.id} (output VAT ${outcome.frozen.report.total_output_vat}, ` +
          `${outcome.frozen.report.voucher_ids.length} voucher(s)). The older snapshot had been frozen before the ` +
          `period was complete and is retained, unmodified, for audit — it was NOT filed.`,
      });
    }

    return this.mapRow(outcome.row);
  }

  /**
   * Repair a LOCKED period whose bound filing state is stale or incomplete —
   * the supported correction path for periods filed before issue #200 was
   * fixed (a draft export froze a partial snapshot, which the lock then bound).
   *
   * Never unlocks, never edits and never deletes anything (ADR-0012, ADR-0009).
   * It only APPENDS:
   *  - a fresh complete `vat_report` snapshot, if the bound one no longer
   *    describes the period's posted vouchers (the old row stays, immutable),
   *    and rebinds the period to the snapshot it should have been filed
   *    against — including the case of a locked period left bound to nothing;
   *  - a fresh `statutory_filing_snapshot` payload version, if none exists for
   *    the target snapshot or the frozen one no longer matches;
   *  - a `prepared` submission event pinning both, so the period's filing state
   *    moves to the corrected version while every earlier `submitted` /
   *    `accepted` event keeps naming the exact snapshot AND payload version it
   *    identified. Those earlier versions stay renderable via
   *    `GET /api/reporting-periods/:id/statutory-report?filing_version=<id>`.
   *
   * Fully idempotent: on a healthy period nothing is appended, nothing is
   * logged, and `changed` comes back false.
   *
   * It does NOT file anything with the tax authority. If the period had already
   * been submitted or accepted, the corrected figures must be filed as an
   * Estonian *parandusdeklaratsioon* — that is raised as a `critical` audit
   * finding, because only the operator can do it.
   */
  async reconcileFilingSnapshot(id: number): Promise<FilingReconciliation> {
    const period = await this.getById(id);

    if (period.status !== 'locked') {
      throw new ConflictException(
        `Reporting period ${id} (${period.name}) is open — lock it to bind a filing snapshot; ` +
          `reconciliation only repairs an already-filed period.`,
      );
    }

    const previousSnapshotId = period.vat_report_snapshot_id;
    const stateBefore = await this.statutorySubmissionService.getState(id);

    // Binding + payload + the `prepared` event that pins them are ONE act
    // (issue #200). Emitting the event after the commit would leave a window in
    // which the period is bound to the corrected snapshot while the filing
    // state still pins the old payload — exactly the disagreement this whole
    // change exists to remove. A failure rolls everything back, so a retry is
    // an ordinary fresh reconciliation.
    const outcome = await this.db.transaction().execute(async (trx) => {
      const frozen = await this.vatReportService.freeze(id, trx);
      const payload = await this.statutoryReportService.freezeFilingSnapshot(
        id,
        frozen.report.id,
        'reconcile',
        trx,
      );

      // Rebind whenever the period does not ALREADY point at the target — not
      // only when a new snapshot was inserted. A legacy period can be locked
      // with `vat_report_snapshot_id = null` while a perfectly current
      // `vat_report` row already exists: the freeze then reuses it
      // (`created = false`), and rebinding only on `created` would leave the
      // binding null forever, so the final export would keep failing even after
      // a "successful" reconciliation.
      const rebind = previousSnapshotId !== frozen.report.id;
      const pinnedChanged =
        stateBefore.currentSnapshotId !== frozen.report.id ||
        stateBefore.currentPayloadId !== payload.payloadId;
      const changed =
        frozen.created || payload.appended || rebind || pinnedChanged;

      if (rebind) {
        await trx
          .updateTable('reporting_period')
          .set({ vat_report_snapshot_id: frozen.report.id })
          .where('id', '=', id)
          .execute();
      }

      if (changed) {
        // Move the period's filing state onto the corrected artifacts. Earlier
        // events keep their own snapshot + payload ids, so what was submitted
        // stays exactly reproducible via ?filing_version=<id>.
        await this.statutorySubmissionService.recordEvent(
          id,
          {
            event_kind: 'prepared',
            report_kind: 'EE_KMD',
            source_snapshot_type: 'vat_report',
            source_snapshot_id: frozen.report.id,
            source_payload_id: payload.payloadId,
            actor: 'operator',
            note: `Filing-state reconciliation (issue #200): superseded VAT snapshot ${previousSnapshotId ?? 'none'}, filing payload ${stateBefore.currentPayloadId ?? 'none'}.`,
          },
          trx,
        );
      }

      return { frozen, payload, changed };
    });

    const currentSnapshotId = outcome.frozen.report.id;
    const currentPayloadId = outcome.payload.payloadId;

    // The obligation to file a parandusdeklaratsioon is derived from the
    // PERSISTED history, not from the status before this call: it survives any
    // number of idempotent retries and only clears once the corrected version
    // has actually been submitted (or accepted) in its own right.
    const stateAfter = await this.statutorySubmissionService.getState(id);
    const correctionRequired = this.correctionDeclarationPending(
      stateAfter.history,
      currentSnapshotId,
      currentPayloadId,
    );

    const notes: string[] = [];

    if (outcome.frozen.superseded && outcome.frozen.created) {
      notes.push(
        `VAT snapshot ${outcome.frozen.superseded.id} (output VAT ${outcome.frozen.superseded.total_output_vat}, ` +
          `${outcome.frozen.superseded.voucher_ids.length} voucher(s)) did not describe the period's posted vouchers. ` +
          `Superseded by snapshot ${currentSnapshotId} (output VAT ${outcome.frozen.report.total_output_vat}, ` +
          `${outcome.frozen.report.voucher_ids.length} voucher(s)); the old row is retained unmodified.`,
      );
    }
    if (outcome.payload.appended) {
      notes.push(
        `Froze filing payload version ${currentPayloadId} (declarant, jurisdiction, declaration bases and INF detail) ` +
          `for VAT snapshot ${currentSnapshotId}.`,
      );
    }
    if (!outcome.changed) {
      notes.push(
        `Reporting period "${period.name}" is already bound to a complete, current filing state ` +
          `(VAT snapshot ${currentSnapshotId}, filing payload ${currentPayloadId}). Nothing was written.`,
      );
    }
    if (correctionRequired) {
      notes.push(
        `This period was already reported to the tax authority against an older version. The corrected figures ` +
          `must be filed as a parandusdeklaratsioon and then recorded with ` +
          `POST /api/reporting-periods/${id}/submission-events; the system does not submit it. ` +
          `Until then this obligation stays open.`,
      );
    }

    // Only a change is worth a new finding — a retry must not spam the queue.
    // The finding raised by the first reconciliation stays open and keeps the
    // obligation visible until an operator resolves it.
    if (outcome.changed) {
      await this.auditFindings.create({
        finding_type: 'statutory_report_incomplete',
        severity: correctionRequired ? 'critical' : 'high',
        description:
          `Filing-state reconciliation for locked period "${period.name}" (#${id}): ` +
          notes.join(' '),
      });
    }

    return {
      reporting_period_id: id,
      changed: outcome.changed,
      snapshot_superseded: outcome.frozen.created,
      previous_snapshot_id: previousSnapshotId,
      current_snapshot_id: currentSnapshotId,
      previous_payload_id: stateBefore.currentPayloadId,
      current_payload_id: currentPayloadId,
      correction_declaration_required: correctionRequired,
      notes,
    };
  }

  /**
   * Does the tax authority still hold a version we have since corrected?
   *
   * True when the period was ever reported externally, but no `submitted` /
   * `correction_submitted` event names the snapshot AND payload version that is
   * current now. Derived purely from the persisted event log, so it is stable
   * across repeated reconciliations (a reconciliation only re-`prepared`s the
   * period; it files nothing) and clears exactly when the corrected version is
   * itself reported.
   */
  private correctionDeclarationPending(
    history: {
      event_kind: string;
      source_snapshot_id: number;
      source_payload_id: number | null;
    }[],
    currentSnapshotId: number,
    currentPayloadId: number,
  ): boolean {
    const everReported = history.some((e) =>
      [
        'submitted',
        'accepted',
        'correction_submitted',
        'correction_accepted',
      ].includes(e.event_kind),
    );
    if (!everReported) return false;

    return !history.some(
      (e) =>
        (e.event_kind === 'submitted' ||
          e.event_kind === 'correction_submitted') &&
        e.source_snapshot_id === currentSnapshotId &&
        e.source_payload_id === currentPayloadId,
    );
  }

  /**
   * List unresolved items that should be reviewed before locking a period:
   * - Pending approvals (expense/sales_invoice with status='pending' whose
   *   tax_point_date falls within the period)
   * - Unposted drafts (expense/sales_invoice with status='draft' whose
   *   tax_point_date falls within the period)
   *
   * Returns warnings but does NOT block locking — user decides.
   */
  async getWarnings(id: number): Promise<PeriodWarning[]> {
    const period = await this.getById(id);
    const warnings: PeriodWarning[] = [];

    // Pending approvals — expenses
    const pendingExpenses = await this.db
      .selectFrom('expense')
      .select(['id', 'category', 'gross_amount', 'currency'])
      .where('status', '=', 'pending')
      .where('tax_point_date', '>=', period.start_date)
      .where('tax_point_date', '<=', period.end_date)
      .execute();

    for (const e of pendingExpenses) {
      warnings.push({
        type: 'pending_approval',
        object_type: 'expense',
        object_id: e.id,
        description: `Expense #${e.id} (${e.category}, ${e.currency} ${e.gross_amount}) awaiting approval`,
      });
    }

    // Pending approvals — sales invoices
    const pendingInvoices = await this.db
      .selectFrom('sales_invoice')
      .select(['id', 'invoice_number', 'gross_amount', 'currency'])
      .where('status', '=', 'pending')
      .where('tax_point_date', '>=', period.start_date)
      .where('tax_point_date', '<=', period.end_date)
      .execute();

    for (const inv of pendingInvoices) {
      warnings.push({
        type: 'pending_approval',
        object_type: 'sales_invoice',
        object_id: inv.id,
        description: `SalesInvoice #${inv.invoice_number} (${inv.currency} ${inv.gross_amount}) awaiting approval`,
      });
    }

    // Unposted drafts — expenses
    const draftExpenses = await this.db
      .selectFrom('expense')
      .select(['id', 'category', 'gross_amount', 'currency'])
      .where('status', '=', 'draft')
      .where('tax_point_date', '>=', period.start_date)
      .where('tax_point_date', '<=', period.end_date)
      .execute();

    for (const e of draftExpenses) {
      warnings.push({
        type: 'unposted_draft',
        object_type: 'expense',
        object_id: e.id,
        description: `Expense #${e.id} (${e.category}, ${e.currency} ${e.gross_amount}) still in draft`,
      });
    }

    // Unposted drafts — sales invoices
    const draftInvoices = await this.db
      .selectFrom('sales_invoice')
      .select(['id', 'invoice_number', 'gross_amount', 'currency'])
      .where('status', '=', 'draft')
      .where('tax_point_date', '>=', period.start_date)
      .where('tax_point_date', '<=', period.end_date)
      .execute();

    for (const inv of draftInvoices) {
      warnings.push({
        type: 'unposted_draft',
        object_type: 'sales_invoice',
        object_id: inv.id,
        description: `SalesInvoice #${inv.invoice_number} (${inv.currency} ${inv.gross_amount}) still in draft`,
      });
    }

    return warnings;
  }

  private mapRow(row: {
    id: number;
    name: string;
    start_date: string;
    end_date: string;
    status: string;
    filed_at: number | null;
    vat_report_snapshot_id: number | null;
    created_at: number;
  }): ReportingPeriod {
    return {
      id: row.id,
      name: row.name,
      start_date: row.start_date,
      end_date: row.end_date,
      status: row.status as ReportingPeriod['status'],
      filed_at: row.filed_at,
      vat_report_snapshot_id: row.vat_report_snapshot_id,
      created_at: row.created_at,
    };
  }
}
