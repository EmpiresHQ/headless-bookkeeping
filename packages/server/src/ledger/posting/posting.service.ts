import {
  Injectable,
  Optional,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
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
import { NULL_VAT_CODE } from './vat-constants';
import {
  ANNUAL_CLOSE_ACCOUNT_CODES,
  ANNUAL_CLOSE_ALLOWED_VAT_CODES,
} from '../../reporting-periods/annual-close';
import {
  OrganizationBasisRow,
  sameBasisRow,
} from '../../organization/ledger-basis';

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
  | { kind: 'system-generated' }
  | {
      /**
       * A YEAR-END ADJUSTMENT of a financial year (issue #207) — the annual
       * depreciation charge the close of `financialYearId` posts on the year's
       * last day. Like `system-generated` it declares no semantic context, and
       * it additionally CLAIMS the narrowly validated route that may post into
       * a VAT period already filed (see `reporting-periods/annual-close.ts`).
       *
       * The claim is not the authorization: {@link PostingService.postVoucherTx}
       * validates the year, the date, the accounts and the VAT metadata, and
       * {@link PeriodLockService.assertAnnualClosePostable} validates the lock
       * state, before anything is written. It is constructed by
       * `AnnualAccountsService.finalize` alone — no request payload can carry
       * it, since {@link DraftVoucher} has no field for it and every HTTP
       * write path posts `system-generated` or `intake-driven`.
       */
      kind: 'annual-close';
      financialYearId: number;
    };

/**
 * The result of preparing a draft: resolved lines (account_code → account_id),
 * carried into the posting transaction so resolution happens exactly once.
 */
export interface PreparedVoucher {
  draft: DraftVoucher;
  resolved: ValidatableLine[];
  /**
   * The caller's declared semantics, carried into the transaction so the
   * period-lock enforcement point sees the same declaration the preparation
   * did (issue #207 — an annual-close claim must not be lost on the way in).
   */
  semantics: PostingSemantics;
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
    executor?: Kysely<Database>,
  ): Promise<PreparedVoucher> {
    const { resolved, accounts } = await this.resolveAndValidate(
      draft,
      executor,
    );

    if (semantics.kind === 'intake-driven') {
      await this.enforceSemantic(draft, resolved, accounts, semantics);
    }

    return {
      // The measurement basis travels ON the draft, so every post path carries
      // it without a further parameter (issue #215). A generator's own stamp
      // WINS: it is taken before the FX conversion is awaited, so it covers the
      // whole window in which the amounts were measured.
      //
      // The fallback below stamps the basis as at prepare time. That is the
      // full window ONLY for a draft that did no conversion of its own; for a
      // generator that converts without stamping, the conversion happened
      // before this sample and an edit that landed during it is NOT detected
      // here. VoucherProjectionService (intake), PrepaymentService (a bank
      // advance) and PersonalDispositionService therefore stamp explicitly.
      //
      // This check is about a basis that MOVED under an in-flight measurement.
      // It is not the only way an amount can be measured in the wrong unit: a
      // draft built from a PERSISTED denomination carries no conversion at all,
      // and is guarded where that denomination lives — see
      // ApprovalsService.assertAllowanceInBaseCurrency (issue #215), which
      // refuses an allowance whose stored currency is not the books'.
      draft: draft.measured_basis
        ? draft
        : {
            ...draft,
            measured_basis: await this.readBasis(executor ?? this.db),
          },
      resolved,
      semantics,
    };
  }

  /**
   * Read the organisation's measurement basis (issue #215). Returns undefined
   * when the singleton is absent — the low-level posting tests run without one,
   * and an absent row is not a basis change.
   */
  private async readBasis(
    executor: Kysely<Database>,
  ): Promise<OrganizationBasisRow | undefined> {
    return executor
      .selectFrom('organization')
      .select(['country', 'base_currency'])
      .executeTakeFirst();
  }

  /**
   * Resolve a draft's account codes to {account_id, account_currency}. THE
   * single place account resolution lives (ADR-0019 / AC-4) — every caller
   * (this service, the pipeline, approvals) goes through it rather than
   * re-implementing the code→id lookup. An unknown code resolves to id -1,
   * which fails the structural existence check.
   */
  async resolveLines(
    draft: DraftVoucher,
    executor?: Kysely<Database>,
  ): Promise<{
    resolved: ValidatableLine[];
    accounts: { id: number; code: string; currency: string | null }[];
  }> {
    const codes = [...new Set(draft.lines.map((l) => l.account_code))];
    const accounts = await this.accountService.getAccountsByCodes(
      codes,
      executor,
    );
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
  private async resolveAndValidate(
    draft: DraftVoucher,
    executor?: Kysely<Database>,
  ): Promise<{
    resolved: ValidatableLine[];
    accounts: { id: number; code: string; currency: string | null }[];
  }> {
    const { resolved, accounts } = await this.resolveLines(draft, executor);
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
        vat_code: l.vat_code ?? NULL_VAT_CODE,
        category: semantics.context.category,
      }))
      .filter((l) => l.vat_code !== NULL_VAT_CODE);

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
    return this.postVoucherTx(
      trx,
      prepared.draft,
      prepared.resolved,
      prepared.semantics,
    );
  }

  /**
   * Refuse a post whose amounts were measured under a basis the organisation
   * has since left (issue #215).
   *
   * Compares the RAW row, not the effective basis: no plugin is available at
   * this seam, and raw equality implies effective equality, so a real basis
   * change never slips through. The converse does not hold — an effect-free
   * edit (`'EUR'` → `null` under an EUR-default plugin) remains permitted at
   * any time and reads here as a difference — so a post in flight across such
   * an edit is rejected although its measurement was fine. Deliberate: nothing
   * is written, the caller retries, and the alternative is resolving defaults
   * at a seam that has no plugin.
   *
   * A draft carrying no stamp is not checked; see {@link prepare} for which
   * drafts carry one and what the fallback does and does not cover.
   */
  private async assertBasisUnchanged(
    trx: Kysely<Database>,
    measuredBasis: OrganizationBasisRow | undefined,
  ): Promise<void> {
    if (!measuredBasis) {
      return;
    }
    const currentBasis = await this.readBasis(trx);
    if (!currentBasis || sameBasisRow(measuredBasis, currentBasis)) {
      return;
    }
    throw new ConflictException(
      `The organisation's ledger measurement basis changed while this voucher ` +
        `was being measured: its amounts were measured as ` +
        `base_currency=${measuredBasis.base_currency ?? 'default'} ` +
        `country=${measuredBasis.country}, and the organisation now records ` +
        `base_currency=${currentBasis.base_currency ?? 'default'} ` +
        `country=${currentBasis.country}. Nothing was posted; retry the ` +
        `operation so the amounts are measured under the current basis.`,
    );
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
    semantics: PostingSemantics = SYSTEM_GENERATED,
  ): Promise<PostedVoucher> {
    // Measurement basis (issue #215). The organisation's base currency and
    // jurisdiction may be changed while the ledger is still EMPTY, and a draft
    // prepared just before such a change already carries `base_amount`s
    // measured the old way — its conversion may even have been awaiting an FX
    // rate over the network while the settings moved. Posting it would make the
    // very first voucher say a basis it was not measured in, and every later
    // voucher would be summed against it. Compare inside the transaction, where
    // the row cannot move again, and refuse rather than mislabel.
    await this.assertBasisUnchanged(trx, draft.measured_basis);

    // Hard process rule (ADR-0009): cannot post into a locked reporting period.
    // ONE enforcement point, throw mode (BadRequestException) — see ADR-0019.
    //
    // The single exception is the year-end adjustment route (issue #207), and
    // it is validated here, at that same enforcement point, rather than trusted:
    // the accounts and the VAT metadata are checked below and the lock state in
    // `assertAnnualClosePostable`. A caller cannot skip the checks by calling
    // this method directly — the claim IS the thing being validated.
    const annualClose =
      semantics.kind === 'annual-close' ? semantics.financialYearId : null;
    if (annualClose !== null) {
      this.assertAnnualCloseShape(draft);
      await this.periodLock.assertAnnualClosePostable(
        draft.tax_point_date,
        annualClose,
        trx,
      );
    } else {
      await this.periodLock.assertPeriodOpen(draft.tax_point_date, trx);
    }

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
        // The trusted mark of a year-end adjustment (issue #207): written only
        // here, only after the checks above passed, and immutable afterwards
        // (posted vouchers are immutable by trigger, ADR-0019).
        annual_close_period_id: annualClose,
        // The input-VAT deduction entitlement this purchase was booked at
        // (issue #211). Written from the draft, never recomputed later: an
        // organisation's settings change, and a posted voucher must keep saying
        // what it was posted on.
        input_vat_entitlement_basis: draft.input_vat_entitlement?.basis ?? null,
        input_vat_deduction_numerator:
          draft.input_vat_entitlement?.numerator ?? null,
        input_vat_deduction_denominator:
          draft.input_vat_entitlement?.denominator ?? null,
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
          // Issue #203: WHICH publication the rate came from, and from whom.
          // A generator that did not supply it writes NULL — never a guessed
          // source, which would make an unattributed rate look authoritative.
          fx_rate_date: l.fx_rate_date ?? null,
          fx_rate_source: l.fx_rate_source ?? null,
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
      fx_rate_date: r.fx_rate_date,
      fx_rate_source: r.fx_rate_source,
      vat_code: r.vat_code,
      is_debit: toBool(r.is_debit),
    }));

    return { ...voucher, lines };
  }

  /**
   * What a year-end adjustment is allowed to BE (issue #207), checked before the
   * locked-period rule is relaxed for it:
   *  - every line on an {@link ANNUAL_CLOSE_ACCOUNT_CODES} account — the
   *    depreciation charge and its accumulated-depreciation contra accounts, a
   *    list that contains no VAT-control account and no cash, receivable or
   *    payable account, so the adjustment cannot move money or VAT;
   *  - no line carrying real VAT metadata, so nothing that belongs on a
   *    declaration can ride in on a whitelisted account.
   *
   * Both are structural facts about the voucher, not claims about it — which is
   * the point: the caller's declaration decides which checks run, never whether
   * they pass.
   */
  private assertAnnualCloseShape(draft: DraftVoucher): void {
    const badAccounts = draft.lines
      .map((l) => l.account_code)
      .filter((code) => !ANNUAL_CLOSE_ACCOUNT_CODES.includes(code));
    if (badAccounts.length > 0) {
      throw new BadRequestException(
        `A year-end adjustment may only touch ${ANNUAL_CLOSE_ACCOUNT_CODES.join(', ')} — ` +
          `rejected line(s) on ${[...new Set(badAccounts)].join(', ')}`,
      );
    }

    const vatCodes = draft.lines
      .map((l) => l.vat_code ?? null)
      .filter((code) => !ANNUAL_CLOSE_ALLOWED_VAT_CODES.includes(code));
    if (vatCodes.length > 0) {
      throw new BadRequestException(
        `A year-end adjustment may not carry VAT metadata — rejected VAT code(s) ` +
          `${[...new Set(vatCodes)].join(', ')}`,
      );
    }
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
