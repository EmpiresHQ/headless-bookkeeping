import { Injectable, Optional, BadRequestException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, sql } from 'kysely';
import { Database } from '../../database/types';
import { toBool } from '../../database/helpers';
import { AccountService } from '../account/account.service';
import { LedgerValidationService } from '../validation/ledger-validation.service';
import { PeriodLockService } from '../../reporting-periods/period-lock.service';
import { RulesService } from '../../rules/rules.service';
import {
  mustReject,
  isUnresolvedSemanticFailure,
} from '../../rules/rules.guards';
import {
  ResolvedLine,
  SemanticValidationContext,
  Override,
} from '../../rules/types';
import { ValidatableLine } from '../validation/types';
import { DraftVoucher, PostedVoucher, VoucherLine } from '../voucher/types';
import { ValidationError } from './types';
import { GENESIS_HASH, computeVoucherHash } from './voucher-hash';

/**
 * The semantic-validation decision for a post, made EXPLICITLY by the caller
 * (ADR-0019). There is exactly one write path; whether the country-plugin
 * semantic tier runs is a centralized, declared choice — never a silent side
 * effect of which method a caller happened to reach.
 *
 * - `intake-driven`: a document-backed Voucher (Expense, SalesInvoice). It
 *   ALWAYS carries semantic context (country, supplier facts, org context,
 *   category) and the semantic tier runs (an Override may relax a failure).
 * - `system-generated`: a Voucher with no source document and (often) no
 *   Category — FX-realized gain/loss, reversals, dividend settlement, VAT
 *   settlement (CONTEXT.md). It explicitly declares it has NO semantic context;
 *   the semantic tier is skipped. Structural + hard-process Rules still run.
 */
export type PostingSemantics =
  | {
      kind: 'intake-driven';
      context: SemanticValidationContext;
      override?: Override;
    }
  | { kind: 'system-generated' };

/**
 * The result of preparing a draft: resolved lines (account_code → account_id),
 * carried into the posting transaction so resolution happens exactly once.
 */
export interface PreparedVoucher {
  draft: DraftVoucher;
  resolved: ValidatableLine[];
}

const SYSTEM_GENERATED: PostingSemantics = { kind: 'system-generated' };

/**
 * PostingService — the single, deep write path for the ledger (ADR-0019).
 *
 * Everything that turns a draft into a posted Voucher (or rejects it) lives
 * here, exactly once:
 *  - account resolution (`account_code → {account_id, account_currency}`),
 *  - all three Rules tiers (structural + hard-process period-lock + semantic),
 *  - the period-lock invariant (ADR-0009), enforced by THROW (BadRequestException),
 *  - gapless voucher numbering + the hash chain (ADR-0013/0021).
 *
 * The business-object status transition + its atomic idempotency claim
 * (ADR-0021) lives in {@link StatusTransitionService} — callers claim the
 * object there, then post the voucher here, inside one transaction.
 *
 * Whether the country-plugin semantic tier runs is an EXPLICIT, centralized
 * decision carried in {@link PostingSemantics} — an intake-driven Voucher always
 * supplies semantic context; a system-generated Voucher declares it has none.
 * A direct low-level post therefore cannot silently skip semantic validation.
 */
@Injectable()
export class PostingService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly accountService: AccountService,
    private readonly validation: LedgerValidationService,
    private readonly periodLock: PeriodLockService,
    // Optional so the low-level posting tests (which post only
    // system-generated drafts) need not wire the whole Rules graph. An
    // intake-driven post without RulesService present is a misconfiguration
    // and throws below — it never silently skips semantic validation.
    @Optional() private readonly rules?: RulesService,
  ) {}

  /**
   * Post a draft voucher as a standalone operation (own transaction).
   * Resolves account codes, runs all Rules tiers, then posts.
   *
   * Defaults to a system-generated marker so the system-generated callers
   * (FX-realized, dividends, prepayment, personal disposition, reversals,
   * the raw voucher controller) keep working with no semantic context.
   */
  async postVoucher(
    draft: DraftVoucher,
    semantics: PostingSemantics = SYSTEM_GENERATED,
  ): Promise<PostedVoucher> {
    const prepared = await this.prepare(draft, semantics);

    return this.db.transaction().execute(async (trx) => {
      return this.postPreparedTx(trx, prepared);
    });
  }

  /**
   * Post several drafts in a single transaction — all or nothing. Resolves and
   * validates every draft up front (outside the transaction, per the
   * better-sqlite3 single-connection constraint), then posts each via
   * postVoucherTx in order so the voucher sequence and hash chain advance
   * atomically. Used by the corrections flow so a reversal can never be posted
   * without its paired correction (ADR-0006 / ADR-0009). Reversal/correction
   * vouchers are system-generated (no semantic context) by default.
   *
   * Optional `hooks` let the caller fold its own writes into the SAME
   * transaction: `beforePost` runs before any voucher is inserted, `afterPost`
   * runs once all vouchers are inserted (receiving them). The corrections flow
   * uses these to persist the business-object patch and the reversed/voucher_id
   * status update atomically with the two vouchers. Hooks MUST use the provided
   * `trx` (never `this.db`) — reads/writes through `this.db` inside the open
   * transaction would deadlock better-sqlite3's single connection.
   */
  async postVouchersAtomic(
    drafts: DraftVoucher[],
    hooks?: {
      beforePost?: (trx: Kysely<Database>) => Promise<void>;
      afterPost?: (
        trx: Kysely<Database>,
        posted: PostedVoucher[],
      ) => Promise<void>;
    },
    semantics: PostingSemantics = SYSTEM_GENERATED,
  ): Promise<PostedVoucher[]> {
    const prepared: PreparedVoucher[] = [];
    for (const draft of drafts) {
      prepared.push(await this.prepare(draft, semantics));
    }

    return this.db.transaction().execute(async (trx) => {
      if (hooks?.beforePost) {
        await hooks.beforePost(trx);
      }
      const posted: PostedVoucher[] = [];
      for (const p of prepared) {
        posted.push(await this.postPreparedTx(trx, p));
      }
      if (hooks?.afterPost) {
        await hooks.afterPost(trx, posted);
      }
      return posted;
    });
  }

  /**
   * Resolve + run all Rules tiers for a draft OUTSIDE any transaction (the
   * better-sqlite3 single connection forbids DB reads inside an open
   * transaction, and resolution/semantic both read).
   *
   * Runs, in order:
   *  1. account resolution + structural Rules (throws ValidationError on fail),
   *  2. semantic Rules — ONLY for an intake-driven marker (throws
   *     BadRequestException on an unresolved/un-overridden semantic failure),
   *  3. hard-process Rules (period lock) — re-asserted as the backstop inside
   *     postPreparedTx; this method does not pre-read it.
   *
   * Returns the resolved lines to carry into the posting transaction so account
   * resolution happens exactly once.
   */
  async prepare(
    draft: DraftVoucher,
    semantics: PostingSemantics = SYSTEM_GENERATED,
  ): Promise<PreparedVoucher> {
    const { resolved, accounts } = await this.resolveAndValidate(draft);

    if (semantics.kind === 'intake-driven') {
      await this.enforceSemantic(draft, resolved, accounts, semantics);
    }

    return { draft, resolved };
  }

  /**
   * Resolve a draft's account codes to {account_id, account_currency}. THE
   * single place account resolution lives (ADR-0019 / AC-4) — every caller
   * (this service, the pipeline, approvals) goes through it rather than
   * re-implementing the code→id lookup. An unknown code resolves to id -1,
   * which fails the structural existence check.
   */
  async resolveLines(draft: DraftVoucher): Promise<{
    resolved: ValidatableLine[];
    accounts: { id: number; code: string; currency: string | null }[];
  }> {
    const codes = [...new Set(draft.lines.map((l) => l.account_code))];
    const accounts = await this.accountService.getAccountsByCodes(codes);
    const byCode = new Map(accounts.map((a) => [a.code, a]));

    const resolved: ValidatableLine[] = draft.lines.map((l) => {
      const account = byCode.get(l.account_code);
      return {
        account_id: account?.id ?? -1, // -1 = unknown code; fails the existence check
        amount: l.amount,
        currency: l.currency,
        base_amount: l.base_amount,
        fx_rate: l.fx_rate,
        is_debit: l.is_debit,
        account_currency: account?.currency ?? null,
      };
    });

    return { resolved, accounts };
  }

  /**
   * Resolve + run the structural tier. Throws ValidationError on a structural
   * failure. Shared by the single- and multi-voucher posting paths.
   */
  private async resolveAndValidate(draft: DraftVoucher): Promise<{
    resolved: ValidatableLine[];
    accounts: { id: number; code: string; currency: string | null }[];
  }> {
    const { resolved, accounts } = await this.resolveLines(draft);
    const validIds = new Set(accounts.map((a) => a.id));

    const result = this.validation.validateVoucherLines(resolved, validIds);
    if (!result.isValid) {
      throw new ValidationError(result.errors);
    }

    return { resolved, accounts };
  }

  /**
   * Run the country-plugin semantic tier for an intake-driven Voucher. Only the
   * lines carrying a real VAT code are checked (a `NULL_STANDARD` placeholder is
   * not semantically meaningful). A failure that is not overridden throws
   * BadRequestException — matching the pipeline's prior behavior so callers see
   * the same error type.
   */
  private async enforceSemantic(
    draft: DraftVoucher,
    resolved: ValidatableLine[],
    accounts: { id: number }[],
    semantics: Extract<PostingSemantics, { kind: 'intake-driven' }>,
  ): Promise<void> {
    if (!this.rules) {
      throw new BadRequestException(
        'Semantic validation requested for an intake-driven voucher but ' +
          'RulesService is not available',
      );
    }

    const validAccountIds = new Set(accounts.map((a) => a.id));
    const semanticLines: ResolvedLine[] = draft.lines
      .map((l, i) => ({
        ...resolved[i],
        vat_code: l.vat_code ?? 'NULL_STANDARD',
        category: semantics.context.category,
      }))
      .filter((l) => l.vat_code !== 'NULL_STANDARD');

    if (semanticLines.length === 0) {
      return;
    }

    // Unified tier interface (ADR-0005): the semantic tier is reached through
    // the single async `validate(tier, input)` entry. A failure (invalid VAT
    // code, missing category mapping, or an UNRESOLVABLE cross-border treatment
    // — ADR-0002) that is not overridden throws BadRequestException, matching
    // the pipeline's behavior so callers see the same error type.
    const semanticResult = await this.rules.validate('semantic', {
      resolvedLines: semanticLines,
      validAccountIds,
      context: semantics.context,
      override: semantics.override,
    });

    if (
      isUnresolvedSemanticFailure(semanticResult) ||
      mustReject(semanticResult)
    ) {
      throw new BadRequestException({
        message: 'Semantic validation failed',
        errors: [semanticResult.message],
      });
    }
  }

  /**
   * Post a prepared voucher inside an existing transaction. The hard-process
   * period-lock invariant is enforced HERE (the single authoritative point),
   * by throw (BadRequestException), so a locked-period post fails for every
   * caller regardless of any earlier early-warning check.
   */
  private async postPreparedTx(
    trx: Kysely<Database>,
    prepared: PreparedVoucher,
  ): Promise<PostedVoucher> {
    return this.postVoucherTx(trx, prepared.draft, prepared.resolved);
  }

  /**
   * Post a draft voucher inside an existing transaction (trx).
   *
   * Lines must already be resolved + structurally validated (via {@link prepare}).
   * The period-lock hard rule is the one thing this method always re-checks —
   * it is the single enforcement point for the locked-period invariant.
   */
  async postVoucherTx(
    trx: Kysely<Database>,
    draft: DraftVoucher,
    resolved: ValidatableLine[],
  ): Promise<PostedVoucher> {
    // Hard process rule (ADR-0009): cannot post into a locked reporting period.
    // ONE enforcement point, throw mode (BadRequestException) — see ADR-0019.
    await this.periodLock.assertPeriodOpen(draft.tax_point_date, trx);

    const postedAt = Math.floor(Date.now() / 1000);

    // ── Gapless sequential voucher number (ADR-0021) ──────────────
    // Mint V-YYYY-NNNNNN inside the posting transaction so the
    // sequence and the hash chain advance atomically.
    const year = draft.tax_point_date.slice(0, 4);

    await trx
      .insertInto('voucher_sequence')
      .values({ year, last_number: 0 })
      .onConflict((oc) => oc.column('year').doNothing())
      .execute();

    const seqResult = await trx
      .updateTable('voucher_sequence')
      .set({ last_number: sql`last_number + 1` })
      .where('year', '=', year)
      .returning('last_number')
      .executeTakeFirstOrThrow();

    const voucherNumber = `V-${year}-${String(seqResult.last_number).padStart(6, '0')}`;

    const previousHash = await this.chainHead(trx);

    const voucher = await trx
      .insertInto('voucher')
      .values({
        voucher_number: voucherNumber,
        tax_point_date: draft.tax_point_date,
        posted_at: postedAt,
        previous_hash: previousHash,
        reverses_id: draft.reverses_id ?? null,
        corrects_object_type: draft.corrects_object_type ?? null,
        corrects_object_id: draft.corrects_object_id ?? null,
        reason: draft.reason ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const insertedLines = await trx
      .insertInto('voucher_line')
      .values(
        draft.lines.map((l, i) => ({
          voucher_id: voucher.id,
          account_id: resolved[i].account_id,
          amount: l.amount,
          currency: l.currency,
          base_amount: l.base_amount,
          fx_rate: l.fx_rate,
          vat_code: l.vat_code ?? null,
          is_debit: l.is_debit ? 1 : 0,
        })),
      )
      .returningAll()
      .execute();

    const lines: VoucherLine[] = insertedLines.map((r) => ({
      id: r.id,
      voucher_id: r.voucher_id,
      account_id: r.account_id,
      amount: r.amount,
      currency: r.currency,
      base_amount: r.base_amount,
      fx_rate: r.fx_rate,
      vat_code: r.vat_code,
      is_debit: toBool(r.is_debit),
    }));

    return { ...voucher, lines };
  }

  /**
   * The hash of the latest posted voucher, or GENESIS_HASH if the ledger is
   * empty. ADR-0013: the new voucher's previous_hash links to this.
   */
  private async chainHead(trx: Kysely<Database>): Promise<string> {
    const prev = await trx
      .selectFrom('voucher')
      .selectAll()
      .where('posted_at', 'is not', null)
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!prev) return GENESIS_HASH;

    const prevLines = await trx
      .selectFrom('voucher_line')
      .selectAll()
      .where('voucher_id', '=', prev.id)
      .orderBy('id')
      .execute();

    return computeVoucherHash(
      prev,
      prevLines.map((l) => ({
        account_id: l.account_id,
        amount: l.amount,
        currency: l.currency,
        base_amount: l.base_amount,
        fx_rate: l.fx_rate,
        is_debit: toBool(l.is_debit),
      })),
    );
  }
}
