import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BankTransactionRepository } from '../bank/bank-transaction.repository';

/** One row of a previewed duplicate group, with its financial references. */
export interface DuplicatePreviewRow {
  id: number;
  statement_ids: number[];
  transaction_date: string;
  amount: number;
  currency: string;
  status: string;
  external_id: string | null;
  provider_code: string | null;
  source_account_ref: string | null;
  activeMatchCount: number;
  draftMatchCount: number;
  settlementClaimExpenseId: number | null;
  advanceFunded: boolean;
}

/**
 * The row's KNOWN strong identity, or null when any component is unknown
 * (issue #399). A KNOWN identity is authoritative: two rows with DISTINCT
 * known identities are DIFFERENT bank movements — never mergeable, however
 * same their date/amount/merchant are (transaction 137 is exactly this
 * control). A null (unknown) identity is a legacy row whose bank ids were
 * lost — mergeable only by an explicit, audited operator decision.
 */
export function identityKey(row: {
  external_id: string | null;
  provider_code: string | null;
  source_account_ref: string | null;
}): string | null {
  if (!row.external_id || !row.provider_code || !row.source_account_ref) {
    return null;
  }
  return `${row.provider_code}|${row.source_account_ref}|${row.external_id}`;
}

/** Can `dup` be merged into `survivor` by identity? Never across distinct
 *  KNOWN identities; always when either side's identity is unknown. */
function identityCompatible(
  survivor: {
    external_id: string | null;
    provider_code: string | null;
    source_account_ref: string | null;
  },
  dup: {
    external_id: string | null;
    provider_code: string | null;
    source_account_ref: string | null;
  },
): boolean {
  const a = identityKey(survivor);
  const b = identityKey(dup);
  return a === null || b === null || a === b;
}

/**
 * The PREVIEW's compatibility (issue #399): what the preview itself offers
 * as a mergeable pair. Stricter than `identityCompatible` (an operator MAY
 * still explicitly apply a null↔known pair): a previewed survivor with a
 * KNOWN identity pairs only with same-identity or unknown rows, and a
 * previewed survivor with an UNKNOWN identity pairs only with unknown rows —
 * a row carrying its own KNOWN identity is surfaced as a distinct movement
 * (the transaction-137 control), never offered as the survivor's duplicate.
 */
function previewPairable(
  survivor: {
    external_id: string | null;
    provider_code: string | null;
    source_account_ref: string | null;
  },
  dup: {
    external_id: string | null;
    provider_code: string | null;
    source_account_ref: string | null;
  },
): boolean {
  const a = identityKey(survivor);
  const b = identityKey(dup);
  if (a === null && b === null) return true;
  if (a !== null && b !== null) return a === b;
  return false;
}

/** One candidate duplicate group (same account/date/amount/currency). */
export interface DuplicatePreviewGroup {
  accountId: number | null;
  transactionDate: string;
  amount: number;
  currency: string;
  rows: DuplicatePreviewRow[];
  recommendedSurvivorId: number | null;
  /**
   * The |amount| that would leave the OPEN, unreconciled duplicate rows of
   * this group that are IDENTITY-COMPATIBLE with the recommended survivor —
   * the expected open-amount impact of merging them away. Rows with a
   * DISTINCT KNOWN identity (genuine same-day/same-amount purchases) never
   * contribute: they are different movements and are not mergeable.
   */
  expectedOpenAmountImpact: number;
  /** Both rows carry financial references — explicit resolution required. */
  requiresExplicitResolution: boolean;
  /**
   * Rows whose KNOWN identity differs from the recommended survivor's —
   * genuine distinct movements sharing date/amount (e.g. transaction 137 vs
   * the 128/136 pair). Never mergeable; surfaced so the operator does not
   * mistake them for duplicates.
   */
  distinctIdentityRowIds: number[];
}

/** The state a preview saw — revalidated atomically at apply time. */
export interface RepairExpectedState {
  survivorActiveMatchCount: number;
  survivorDraftMatchCount: number;
  survivorSettlementClaimExpenseId: number | null;
  survivorStatus: string;
  survivorAdvanceFunded: boolean;
  duplicateActiveMatchCount: number;
  duplicateDraftMatchCount: number;
  duplicateSettlementClaimExpenseId: number | null;
  duplicateAdvanceFunded: boolean;
  duplicateStatus: string;
}

export interface RepairResult {
  repairId: number;
  survivorId: number;
  aliasId: number;
  repointedSourceRowCount: number;
  /** |amount| removed from open amounts by this repair (0 when the duplicate
   *  was not an open, unreconciled row). */
  openAmountImpact: number;
  alreadyApplied: boolean;
}

/**
 * The audited, previewable repair of ALREADY-IMPORTED duplicate bank rows
 * (issue #399 — pre-canonical-journal imports duplicated overlapping
 * movements; this is the supported migration path for that history).
 *
 * A repair is METADATA-ONLY: it repoints source provenance, records the
 * removed id as an alias of the survivor, and deletes the duplicate ROW. It
 * never writes a voucher, expense, payment, FX entry or VAT fact, never sums
 * allocations, and never silently deletes financial history — a duplicate
 * carrying financial references is refused until the operator resolves it
 * through the normal flows (or picks the financially-referenced row as the
 * survivor).
 */
@Injectable()
export class BankDuplicateRepairService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly transactionRepo: BankTransactionRepository,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Preview candidate duplicate groups: canonical rows sharing
   * (account, date, amount, currency) — the shape legacy duplicates have,
   * since their bank-provided ids were lost before issue #399's identity
   * columns existed. Read-only; nothing is executed.
   */
  async preview(): Promise<DuplicatePreviewGroup[]> {
    const groups = await this.db
      .selectFrom('bank_transaction')
      .select([
        'account_id',
        'transaction_date',
        'amount',
        'currency',
        (eb) => eb.fn.countAll<number>().as('n'),
      ])
      .groupBy(['account_id', 'transaction_date', 'amount', 'currency'])
      .having((eb) => eb.fn.countAll<number>(), '>', 1)
      .execute();

    const result: DuplicatePreviewGroup[] = [];
    for (const g of groups) {
      const rows = await this.previewRows(
        g.account_id,
        g.transaction_date,
        g.amount,
        g.currency,
      );
      if (rows.length < 2) continue;

      // Prefer the reconciled survivor: a row with ACTIVE matches (or any
      // financial reference) is the canonical record the duplicates should
      // resolve to. Ties fall back to the oldest row (lowest id).
      const financial = rows.filter(
        (r) =>
          r.status !== 'open' ||
          r.activeMatchCount > 0 ||
          r.draftMatchCount > 0 ||
          r.settlementClaimExpenseId !== null ||
          r.advanceFunded,
      );
      const recommended =
        financial.find((r) => r.activeMatchCount > 0) ??
        financial[0] ??
        rows.find((r) => r.id === Math.min(...rows.map((x) => x.id))) ??
        null;

      const duplicates = rows.filter((r) => r.id !== recommended?.id);
      // Preview pairing (issue #399): only PREVIEW-PAIRABLE rows are offered
      // as the survivor's duplicates; rows carrying a distinct KNOWN identity
      // (the transaction-137 control) are surfaced as distinct movements.
      const compatible = duplicates.filter((r) =>
        recommended ? previewPairable(recommended, r) : true,
      );
      const incompatible = duplicates.filter(
        (r) => recommended && !previewPairable(recommended, r),
      );
      // Expected open-amount impact (never overstated, issue #399): every
      // preview-pairable duplicate that is itself financially FREE and —
      // when its identity is UNKNOWN — comes from ANOTHER statement than the
      // survivor (a same-statement identical row may be a genuine repeated
      // purchase; the operator decides pairwise). Same-KNOWN-identity rows
      // are unambiguous duplicates wherever they came from.
      const retainStatements = new Set(recommended?.statement_ids ?? []);
      const financialFree = (r: DuplicatePreviewRow) =>
        r.status === 'open' &&
        r.activeMatchCount === 0 &&
        r.draftMatchCount === 0 &&
        r.settlementClaimExpenseId === null &&
        !r.advanceFunded;
      const removableCount = compatible.filter(
        (r) =>
          financialFree(r) &&
          (identityKey(r) !== null ||
            r.statement_ids.some((sid) => !retainStatements.has(sid))),
      ).length;
      const openImpact = removableCount * Math.abs(g.amount);

      result.push({
        accountId: g.account_id,
        transactionDate: g.transaction_date,
        amount: g.amount,
        currency: g.currency,
        rows,
        recommendedSurvivorId: recommended ? recommended.id : null,
        expectedOpenAmountImpact: openImpact,
        requiresExplicitResolution:
          financial.length >= 2 ||
          compatible.some(
            (r) =>
              r.status !== 'open' ||
              r.activeMatchCount > 0 ||
              r.draftMatchCount > 0 ||
              r.settlementClaimExpenseId !== null ||
              r.advanceFunded,
          ),
        distinctIdentityRowIds: incompatible.map((r) => r.id),
      });
    }
    return result;
  }

  /**
   * Apply one duplicate merge. Atomic, revalidated against the previewed
   * state, idempotent on retry. Refuses (409) when the chosen duplicate
   * carries financial references — those need explicit resolution through
   * the normal flows; a merge never sums allocations and never deletes
   * financial history.
   */
  async applyRepair(args: {
    survivorId: number;
    duplicateId: number;
    expected: RepairExpectedState;
    performedBy?: string;
  }): Promise<RepairResult> {
    const { survivorId, duplicateId } = args;
    if (survivorId === duplicateId) {
      throw new BadRequestException('survivor and duplicate are the same id');
    }
    const performedBy = args.performedBy ?? 'operator';

    return this.db.transaction().execute(async (trx) => {
      const survivor = await trx
        .selectFrom('bank_transaction')
        .selectAll()
        .where('id', '=', survivorId)
        .executeTakeFirst();
      const duplicate = await trx
        .selectFrom('bank_transaction')
        .selectAll()
        .where('id', '=', duplicateId)
        .executeTakeFirst();
      if (!survivor) {
        throw new NotFoundException(
          `Bank transaction ${survivorId} (survivor) not found`,
        );
      }

      // Idempotent retry: the duplicate row no longer exists BECAUSE this
      // very repair already removed it — its alias is the durable record.
      // The alias must point at the requested survivor; otherwise the
      // caller is replaying a DIFFERENT decision.
      if (!duplicate) {
        const priorAlias = await trx
          .selectFrom('bank_transaction_alias')
          .selectAll()
          .where('alias_transaction_id', '=', duplicateId)
          .executeTakeFirst();
        if (!priorAlias) {
          throw new NotFoundException(
            `Bank transaction ${duplicateId} (duplicate) not found`,
          );
        }
        if (priorAlias.canonical_transaction_id !== survivorId) {
          throw new ConflictException(
            `Transaction ${duplicateId} was already merged into ` +
              `${priorAlias.canonical_transaction_id}, not ${survivorId}`,
          );
        }
        const priorRepair = await trx
          .selectFrom('bank_duplicate_repair')
          .selectAll()
          .where('id', '=', priorAlias.repair_id)
          .executeTakeFirstOrThrow();
        return {
          repairId: priorRepair.id,
          survivorId,
          aliasId: priorAlias.id,
          repointedSourceRowCount: 0,
          openAmountImpact: 0,
          alreadyApplied: true,
        };
      }

      // Idempotent retry: the duplicate was already merged — return the
      // original repair's result, applied to nothing new.
      const existingAlias = await trx
        .selectFrom('bank_transaction_alias')
        .selectAll()
        .where('alias_transaction_id', '=', duplicateId)
        .executeTakeFirst();
      if (existingAlias) {
        if (existingAlias.canonical_transaction_id !== survivorId) {
          throw new ConflictException(
            `Transaction ${duplicateId} was already merged into ` +
              `${existingAlias.canonical_transaction_id}, not ${survivorId}`,
          );
        }
        const repair = await trx
          .selectFrom('bank_duplicate_repair')
          .selectAll()
          .where('id', '=', existingAlias.repair_id)
          .executeTakeFirstOrThrow();
        return {
          repairId: repair.id,
          survivorId,
          aliasId: existingAlias.id,
          repointedSourceRowCount: 0,
          openAmountImpact: 0,
          alreadyApplied: true,
        };
      }

      // Money facts must agree — a conflicting merge is refused, never summed.
      if (
        survivor.amount !== duplicate.amount ||
        survivor.currency !== duplicate.currency ||
        survivor.account_id !== duplicate.account_id
      ) {
        throw new ConflictException(
          'survivor and duplicate have conflicting money facts ' +
            '(amount/currency/account) — a merge cannot resolve them; use the normal correction flows',
        );
      }

      // DISTINCT KNOWN identities are different bank movements — never
      // mergeable, however same the date/amount/merchant are (issue #399's
      // transaction-137 control). A merge across them is refused outright.
      if (!identityCompatible(survivor, duplicate)) {
        throw new ConflictException(
          `survivor ${survivorId} and duplicate ${duplicateId} carry distinct known bank identities ` +
            `(provider/source-account/external id) — they are different movements and are never merged`,
        );
      }
      // A legacy null-identity merge is an EXPLICIT operator decision: the
      // operator chose this pair from the preview; the audit entry records it.

      // Revalidate the previewed state atomically (stale preview → 409).
      const dupFacts = await this.financialFacts(
        trx,
        duplicateId,
        duplicate.status,
      );
      const surFacts = await this.financialFacts(
        trx,
        survivorId,
        survivor.status,
      );
      const e = args.expected;
      const stale =
        survivor.status !== e.survivorStatus ||
        surFacts.advanceFunded !== e.survivorAdvanceFunded ||
        surFacts.activeMatchCount !== e.survivorActiveMatchCount ||
        surFacts.draftMatchCount !== e.survivorDraftMatchCount ||
        surFacts.settlementClaimExpenseId !==
          e.survivorSettlementClaimExpenseId ||
        dupFacts.activeMatchCount !== e.duplicateActiveMatchCount ||
        dupFacts.draftMatchCount !== e.duplicateDraftMatchCount ||
        dupFacts.settlementClaimExpenseId !==
          e.duplicateSettlementClaimExpenseId ||
        dupFacts.advanceFunded !== e.duplicateAdvanceFunded ||
        duplicate.status !== e.duplicateStatus;
      if (stale) {
        throw new ConflictException(
          'stale preview — the rows changed since the preview; re-preview and retry',
        );
      }

      // Financial references on the DUPLICATE require explicit resolution:
      // never summed, never silently deleted. Both financial → the operator
      // must resolve through the normal flows (unmatch/reversal).
      if (dupFacts.hasFinancial) {
        const bothFinancial = surFacts.hasFinancial;
        throw new ConflictException(
          bothFinancial
            ? 'both rows carry financial references (dispositions/matches/settlement claims/advance funding) — resolve through the normal reversal/unmatch flows; a merge never sums or deletes financial history'
            : 'the duplicate carries financial references — pick the financially-referenced row as the survivor, or resolve the duplicate through the normal flows first',
        );
      }

      // The duplicate's OPEN status is what its removal contributes to open
      // amounts (an unreconciled open row leaving the journal).
      const openAmountImpact =
        duplicate.status === 'open' ? Math.abs(duplicate.amount) : 0;

      // Apply: repair row, alias, provenance repoint, duplicate removal,
      // conflict repoint — all atomic with the audit entry.
      const repairKey = `${survivorId}:${duplicateId}`;
      let repairId: number;
      try {
        const repairRow = await trx
          .insertInto('bank_duplicate_repair')
          .values({
            repair_key: repairKey,
            survivor_id: survivorId,
            duplicate_id: duplicateId,
            performed_by: performedBy,
            created_at: Math.floor(Date.now() / 1000),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        repairId = repairRow.id;
      } catch (err) {
        // The same pair was already repaired by a concurrent/retried call.
        const existing = await trx
          .selectFrom('bank_duplicate_repair')
          .selectAll()
          .where('repair_key', '=', repairKey)
          .executeTakeFirst();
        if (!existing) throw err;
        return {
          repairId: existing.id,
          survivorId,
          aliasId: -1,
          repointedSourceRowCount: 0,
          openAmountImpact: 0,
          alreadyApplied: true,
        };
      }

      const aliasRow = await trx
        .insertInto('bank_transaction_alias')
        .values({
          alias_transaction_id: duplicateId,
          canonical_transaction_id: survivorId,
          repair_id: repairId,
          created_at: Math.floor(Date.now() / 1000),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const repointed = await trx
        .updateTable('bank_transaction_source')
        .set({ bank_transaction_id: survivorId })
        .where('bank_transaction_id', '=', duplicateId)
        .executeTakeFirst();

      // Conflicts that referenced the duplicate as the canonical row are
      // review items about this same movement — repointed, not deleted.
      await trx
        .updateTable('bank_import_conflict')
        .set({ canonical_transaction_id: survivorId })
        .where('canonical_transaction_id', '=', duplicateId)
        .execute();

      await trx
        .deleteFrom('bank_transaction')
        .where('id', '=', duplicateId)
        .execute();

      await this.auditLog.record(
        {
          actor: performedBy,
          action: 'bank.duplicate_repair.apply',
          outcome: 'accepted',
          target_type: 'bank_transaction',
          target_id: survivorId,
          detail: {
            repair_id: repairId,
            survivor_id: survivorId,
            duplicate_id: duplicateId,
            alias_id: aliasRow.id,
            repointed_source_rows: Number(repointed.numUpdatedRows ?? 0),
            open_amount_impact: openAmountImpact,
          },
        },
        trx,
      );

      return {
        repairId,
        survivorId,
        aliasId: aliasRow.id,
        repointedSourceRowCount: Number(repointed.numUpdatedRows ?? 0),
        openAmountImpact,
        alreadyApplied: false,
      };
    });
  }

  private async financialFacts(
    trx: Kysely<Database>,
    txnId: number,
    status: string,
  ) {
    const matchRows = await trx
      .selectFrom('reconciliation_match')
      .select(['status'])
      .where('bank_transaction_id', '=', txnId)
      .where('status', 'in', ['draft', 'active'])
      .execute();
    const activeMatchCount = matchRows.filter(
      (m) => m.status === 'active',
    ).length;
    const draftMatchCount = matchRows.filter(
      (m) => m.status === 'draft',
    ).length;
    const usage = await trx
      .selectFrom('bank_settlement_usage')
      .select('expense_id')
      .where('bank_transaction_id', '=', txnId)
      .executeTakeFirst();
    const advance = await trx
      .selectFrom('prepayment_advance')
      .select('id')
      .where('bank_transaction_id', '=', txnId)
      .executeTakeFirst();
    return {
      activeMatchCount,
      draftMatchCount,
      settlementClaimExpenseId: usage ? usage.expense_id : null,
      advanceFunded: advance !== undefined,
      hasFinancial:
        status !== 'open' ||
        matchRows.length > 0 ||
        usage !== undefined ||
        advance !== undefined,
    };
  }

  private async previewRows(
    accountId: number | null,
    transactionDate: string,
    amount: number,
    currency: string,
  ): Promise<DuplicatePreviewRow[]> {
    const rows = await this.db
      .selectFrom('bank_transaction')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('transaction_date', '=', transactionDate)
      .where('amount', '=', amount)
      .where('currency', '=', currency)
      .orderBy('id')
      .execute();
    const result: DuplicatePreviewRow[] = [];
    for (const r of rows) {
      const facts = await this.financialFacts(this.db, r.id, r.status);
      const sources = await this.db
        .selectFrom('bank_transaction_source')
        .select('statement_id')
        .where('bank_transaction_id', '=', r.id)
        .orderBy('statement_id')
        .execute();
      result.push({
        id: r.id,
        statement_ids: sources.map((s) => s.statement_id),
        transaction_date: r.transaction_date,
        amount: r.amount,
        currency: r.currency,
        status: r.status,
        external_id: r.external_id,
        provider_code: r.provider_code,
        source_account_ref: r.source_account_ref,
        activeMatchCount: facts.activeMatchCount,
        draftMatchCount: facts.draftMatchCount,
        settlementClaimExpenseId: facts.settlementClaimExpenseId,
        advanceFunded: facts.advanceFunded,
      });
    }
    return result;
  }
}
