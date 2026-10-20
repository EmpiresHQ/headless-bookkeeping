import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { DraftVoucher } from '../ledger/voucher/types';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { CategoryService } from '../categories/category.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  Expense,
  CreateExpenseDto,
  ExpenseStatus,
  PatchExpenseDraftInput,
} from './types';
import {
  DuplicateCandidate,
  DuplicateDetection,
  findDuplicateExpense,
  normalizeInvoiceNumber,
} from './duplicate-detection';
import { DuplicateExpenseException } from './duplicate-expense.exception';
import {
  BANK_STATEMENT_RATE_SOURCE,
  FxRateUnavailableError,
} from '../fx/fx-rate.types';
import type { BankSettlementLink } from '../bank/settlement-fx';

/** The deterministic outcome of a bank-settlement link attempt (issue #403). */
type BankSettlementResolution =
  | { kind: 'link'; link: BankSettlementLink }
  | { kind: 'unresolved'; reason: string };

/**
 * Common legal-form suffixes across the jurisdictions we book for. A token
 * that is ONLY a legal-form suffix does not distinguish one merchant from
 * another ('AS', 'OÜ', 'LTD', …), so a descriptor consisting solely of such
 * tokens cannot establish identity (issue #403: 'UNRELATED AS' must not match
 * every '-AS' supplier).
 */
const LEGAL_FORM_SUFFIXES = new Set([
  'as',
  'asa',
  'aps',
  'oü',
  'ou',
  'oy',
  'ab',
  'a/s',
  'ag',
  'gmbh',
  'sa',
  'nv',
  'bv',
  'ltd',
  'llc',
  'plc',
  'inc',
  'spa',
  'srl',
  'kk',
  'kg',
]);

/**
 * Deterministic counterparty-identity rule (issue #403): every normalized
 * token of the bank's merchant descriptor/IBAN must appear among the tokens
 * of a supplier identity value (its name, a merchant_descriptor / name_alias /
 * IBAN identifier). Case- and punctuation-blind, order-blind, never fuzzy —
 * a descriptor naming a DIFFERENT merchant does not match.
 *
 * ONE-CHARACTER tokens are SIGNIFICANT and retained ('CIRCLE K' vs 'CIRCLE X'
 * turns on the K/X: dropping short tokens made those two the same merchant
 * and let an unrelated bank line value the wrong purchase). And a descriptor
 * whose every token is a legal-form suffix establishes nothing.
 */
function descriptorMatchesIdentity(
  descriptor: string,
  identity: string,
): boolean {
  const d = meaningfulNameTokens(descriptor);
  if (d.length === 0) return false;
  const id = meaningfulNameTokens(identity);
  // The FULL meaningful name, as a token set — a subset match would let a
  // descriptor naming one merchant ('CIRCLE K') claim a longer, different
  // one ('CIRCLE K OFFICE SERVICES AS'); only the same full merchant name
  // (or a RECORDED alias/IBAN identifier, matched the same way) links.
  // Multiset equality, not subset-includes: token MULTIPLICITY is identity
  // ('PIZZA PIZZA' is not 'PIZZA EXPRESS' — two pizzas vs a pizza and an
  // express), so the sorted token sequences must match element-wise.
  const ds = [...d].sort();
  const is = [...id].sort();
  return ds.length === is.length && ds.every((t, i) => t === is[i]);
}

/** The meaningful name tokens of a merchant identity value: Unicode-folded,
 *  punctuation-free, legal-form suffixes removed consistently from BOTH
 *  sides of any comparison ('CIRCLE K A/S' ≡ 'Circle K As' ≡ [circle, k]).
 *  One-character tokens ARE significant ('CIRCLE K' ≠ 'CIRCLE X'). */
function meaningfulNameTokens(s: string): string[] {
  const folded = s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Slashed legal forms, merged before tokenizing so they hit the suffix
    // set ('A/S' → 'as') instead of fragmenting into bare letters.
    .replace(/a\/p\/s/g, 'aps')
    .replace(/a\/s/g, 'as')
    .replace(/s\/a/g, 'sa')
    .replace(/n\/v/g, 'nv')
    .replace(/b\/v/g, 'bv');
  return folded
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .filter((t) => !LEGAL_FORM_SUFFIXES.has(t));
}

@Injectable()
export class ExpensesService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly projection: VoucherProjectionService,
    private readonly periodLock: PeriodLockService,
    private readonly categoryService: CategoryService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * The deterministic duplicate key of issue #195, applied at the single choke
   * point every creation path goes through. Returns the expense this candidate
   * appears to duplicate, or null.
   *
   * Scoped to the supplier's own non-reversed expenses — `supplier_id` is the
   * first component of both rules, so nothing outside it can match, and a
   * candidate with no supplier is not comparable at all.
   */
  private async detectDuplicate(
    candidate: DuplicateCandidate,
    executor: Kysely<Database> = this.db,
    excludeExpenseId?: number,
    excludeDocumentId?: number | null,
  ): Promise<DuplicateDetection | null> {
    const supplierId = candidate.supplier_id;
    if (supplierId == null) return null;

    let peersQuery = executor
      .selectFrom('expense')
      .select([
        'id',
        'supplier_id',
        'supplier_invoice_number',
        'currency',
        'gross_amount',
        'tax_point_date',
        'status',
        'claimant_id',
        'ai_document_type',
      ])
      .where('supplier_id', '=', supplierId)
      .where('status', '!=', 'reversed');
    // A draft being edited is never its own duplicate (issue #247) — and no
    // expense is ever a duplicate of another expense minted from the SAME
    // document (issue #404): `expense.document_id` is single-valued, so every
    // row carrying it belongs to one purchase chain (the retries of one
    // intake), never to two purchases. A genuine vendor re-send arrives as a
    // NEW document and keeps its full duplicate protection.
    if (excludeExpenseId !== undefined) {
      peersQuery = peersQuery.where('id', '!=', excludeExpenseId);
    }
    if (excludeDocumentId !== undefined && excludeDocumentId !== null) {
      peersQuery = peersQuery.where((eb) =>
        eb.or([
          eb('document_id', 'is', null),
          eb('document_id', '!=', excludeDocumentId),
        ]),
      );
    }
    const peers = await peersQuery.execute();

    return findDuplicateExpense(
      {
        supplier_id: supplierId,
        supplier_invoice_number: candidate.supplier_invoice_number,
        currency: candidate.currency,
        gross_amount: candidate.gross_amount,
        tax_point_date: candidate.tax_point_date,
        claimant_id: candidate.claimant_id ?? null,
      },
      peers,
    );
  }

  async createExpense(dto: CreateExpenseDto): Promise<Expense> {
    await this.categoryService.assertValid(dto.category);

    // Duplicate guard (issue #195 / ADR-0010). It refuses CREATION and nothing
    // else: it runs before the insert, so no voucher, posting or period lock is
    // ever involved and there is nothing to reverse afterwards.
    const duplicate = await this.detectDuplicate(dto);
    if (duplicate && dto.allow_duplicate !== true) {
      throw new DuplicateExpenseException(duplicate);
    }

    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .insertInto('expense')
      .values({
        document_id: dto.document_id ?? null,
        supplier_id: dto.supplier_id ?? null,
        category: dto.category,
        gross_amount: dto.gross_amount,
        vat_amount: dto.vat_amount,
        currency: dto.currency,
        tax_point_date: dto.tax_point_date,
        document_vat_marking: dto.document_vat_marking ?? null,
        supplier_invoice_number: dto.supplier_invoice_number ?? null,
        asset_name: dto.asset_name ?? null,
        asset_useful_life_years: dto.asset_useful_life_years ?? null,
        asset_residual_value_minor: dto.asset_residual_value_minor ?? null,
        claimant_id: dto.claimant_id ?? null,
        company_addressed_receipt:
          dto.company_addressed_receipt === true
            ? 1
            : dto.company_addressed_receipt === false
              ? 0
              : null,
        service_place_rule:
          dto.service_place_rule === 'general'
            ? null
            : (dto.service_place_rule ?? null),
        place_of_supply_country: dto.place_of_supply_country ?? null,
        ai_confidence: dto.ai_confidence ?? null,
        ai_document_type: dto.ai_document_type ?? null,
        ai_kind: dto.ai_kind ?? null,
        status: 'draft',
        voucher_id: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Only an override that actually overrode something is worth a trace, and
    // only once the expense really exists (audit_log is append-only, ADR-0026,
    // so a speculative entry could not be taken back).
    if (duplicate) {
      await this.auditLog.record({
        actor: 'operator',
        action: 'expense.duplicate_guard.override',
        outcome: 'allowed',
        target_type: 'expense',
        target_id: result.id,
        detail: {
          duplicate_of_expense_id: duplicate.existingExpenseId,
          matched_on: duplicate.matchedOn,
          supplier_id: dto.supplier_id ?? null,
          supplier_invoice_number: dto.supplier_invoice_number ?? null,
          reason: duplicate.reason,
        },
      });
    }

    return this.mapRow(result);
  }

  /** Only accepted, non-reversed purchases inform classification history. */
  async getPostedCategoryHistory(
    supplierId: number,
  ): Promise<{ category: string; count: number }[]> {
    const rows = await this.db
      .selectFrom('expense')
      .select(['category', (eb) => eb.fn.count<number>('id').as('count')])
      .where('supplier_id', '=', supplierId)
      .where('status', '=', 'posted')
      .groupBy('category')
      .orderBy('category')
      .execute();
    return rows.map((row) => ({
      category: row.category,
      count: Number(row.count),
    }));
  }

  async getExpenses(): Promise<(Expense & { reconciled: boolean })[]> {
    const rows = await this.db
      .selectFrom('expense')
      .selectAll()
      .orderBy('id')
      .execute();
    const reconciled = await this.reconciledVoucherIds(
      rows.map((r) => r.voucher_id),
    );
    return rows.map((r) => ({
      ...this.mapRow(r),
      reconciled: r.voucher_id != null && reconciled.has(r.voucher_id),
    }));
  }

  /**
   * The subset of the given voucher ids that carry at least one
   * reconciliation_match — i.e. the expense's posted voucher is matched to a
   * bank transaction. Surfaced as a business-level `reconciled` flag; the
   * voucher itself stays hidden (ADR-0001). One query, no cross-module dep.
   */
  private async reconciledVoucherIds(
    voucherIds: (number | null)[],
  ): Promise<Set<number>> {
    const ids = voucherIds.filter((v): v is number => v != null);
    if (ids.length === 0) return new Set();
    const rows = await this.db
      .selectFrom('reconciliation_match')
      .select('voucher_id')
      .distinct()
      .where('voucher_id', 'in', ids)
      .execute();
    return new Set(rows.map((r) => r.voucher_id));
  }

  async getExpenseById(id: number): Promise<Expense> {
    const row = await this.db
      .selectFrom('expense')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundException(`Expense ${id} not found`);
    }

    return this.mapRow(row);
  }

  /**
   * Delete an expense — ONLY while it is a `draft` (no approval, no posted
   * voucher). A `pending`/`posted`/`reversed` expense is never deleted: a
   * posted voucher is immutable (correct via reversal), and a pending one must
   * have its approval rejected first. Lets an operator clear probe/junk drafts.
   */
  async deleteDraft(id: number): Promise<Expense> {
    const expense = await this.getExpenseById(id);
    if (expense.status !== 'draft') {
      throw new ConflictException(
        `Expense ${id} is ${expense.status}; only a draft expense can be deleted ` +
          `(a posted voucher is immutable — correct via reversal; reject a pending approval first).`,
      );
    }
    await this.db.deleteFrom('expense').where('id', '=', id).execute();
    return expense;
  }

  async generateDraftVoucher(expenseId: number): Promise<DraftVoucher> {
    const expense = await this.getExpenseById(expenseId);
    const { draft, settlementLink } = await this.buildDraftVoucher(expense);
    if (
      settlementLink &&
      draft.lines.some((l) => l.fx_rate_source === BANK_STATEMENT_RATE_SOURCE)
    ) {
      // The draft actually BOOKED the bank rate (the projection may still have
      // preferred an available statutory rate). CLAIM the bank line for this
      // expense — atomically, so a concurrent draft generation for a different
      // expense cannot also post against it — and write the human-readable
      // audit entry once.
      await this.claimBankSettlementUsage(expense, settlementLink);
      await this.auditBankSettlementFxOnce(expense, settlementLink, draft);
    }
    return draft;
  }

  /**
   * Atomically claim the bank settlement line for THIS expense (issue #403).
   *
   * The claim table's UNIQUE index on `bank_transaction_id` is the guard: one
   * bank line values one purchase, whatever the interleaving of concurrent
   * draft generations. An insert conflict for the SAME expense is the
   * idempotent retry case (its own claim, kept); a conflict for a DIFFERENT
   * expense is a typed refusal — this expense cannot be valued from a bank
   * line that already values another one, so the statutory path (and its
   * hold) stands, and nothing is posted against a double-used settlement.
   */
  private async claimBankSettlementUsage(
    expense: Expense,
    link: BankSettlementLink,
  ): Promise<void> {
    // The claim is ATOMIC at the database level and backend-agnostic: the
    // UNIQUE index on bank_transaction_id does the guarding, an ON CONFLICT
    // DO NOTHING turns a racing claim into "read who won", and the
    // authoritative owner read decides the outcome. No error-code sniffing —
    // a UNIQUE violation and any other fault keep distinct shapes.
    //
    // The claim is also FACTS-VALIDATED atomically (issue #403): the expense
    // row is re-read INSIDE the claim transaction and must still carry the
    // facts the link values — an edit can legitimately land between the draft
    // generation's FX wait and this claim, and an unvalidated claim would
    // reserve the OLD bank line for the EDITED purchase (a stale draft
    // posting against evidence that no longer describes it). A mismatch is a
    // typed refusal: nothing is claimed, the stale draft is not posted, and
    // the next generation claims against the current facts.
    const now = Math.floor(Date.now() / 1000);
    await this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('expense')
        .select([
          'supplier_id',
          'claimant_id',
          'currency',
          'gross_amount',
          'tax_point_date',
        ])
        .where('id', '=', expense.id)
        .executeTakeFirst();
      // The COMPLETE identity/link facts, compared against the link: the
      // supplier whose identity the bank line matched (not merely "some
      // supplier exists"), no claimant contradiction, and the same original
      // currency/amount/date the link values.
      if (
        !current ||
        current.supplier_id !== link.supplierId ||
        current.claimant_id != null ||
        current.currency !== link.sourceCurrency ||
        current.gross_amount !== link.sourceAmount ||
        current.tax_point_date !== link.transactionDate
      ) {
        throw new FxRateUnavailableError(
          link.sourceCurrency,
          link.settledCurrency,
          link.transactionDate,
          `the purchase was edited or removed while its draft was being ` +
            `valued, so the bank settlement evidence no longer describes it; ` +
            `nothing was claimed or posted — post it again and the entry is ` +
            `recomputed from the current facts`,
          'no_rate_for_date',
        );
      }
      await trx
        .insertInto('bank_settlement_usage')
        .values({
          bank_transaction_id: link.bankTransactionId,
          expense_id: expense.id,
          created_at: now,
        })
        .onConflict((oc) => oc.column('bank_transaction_id').doNothing())
        .execute();
    });
    const owner = await this.db
      .selectFrom('bank_settlement_usage')
      .select(['expense_id'])
      .where('bank_transaction_id', '=', link.bankTransactionId)
      .executeTakeFirst();
    if (owner && owner.expense_id !== expense.id) {
      // The race was lost to a DIFFERENT expense: a typed refusal, so this
      // expense's valuation falls back to the statutory path (and its hold)
      // instead of posting against a double-used settlement.
      throw new FxRateUnavailableError(
        link.sourceCurrency,
        link.settledCurrency,
        link.transactionDate,
        `bank settlement line ${link.bankTransactionId} already values ` +
          `expense ${owner.expense_id}`,
        'no_rate_for_date',
      );
    }
    // Our own claim from an earlier generation (or the one just inserted) —
    // idempotent, kept.
  }

  /**
   * Build the draft voucher for an expense as if `patch` were applied, WITHOUT
   * persisting the patch. Used by the corrections flow so the corrected draft
   * can be computed before the posting transaction (reads happen up front; the
   * patch itself is persisted inside the transaction via {@link patchAmountsTx}).
   */
  async previewPatchedDraft(
    expenseId: number,
    patch: { gross_amount?: number; vat_amount?: number; category?: string },
  ): Promise<DraftVoucher> {
    if (patch.category !== undefined) {
      await this.categoryService.assertValid(patch.category);
    }
    const expense = await this.getExpenseById(expenseId);
    const patched: Expense = {
      ...expense,
      ...(patch.gross_amount !== undefined && {
        gross_amount: patch.gross_amount,
      }),
      ...(patch.vat_amount !== undefined && { vat_amount: patch.vat_amount }),
      ...(patch.category !== undefined && { category: patch.category }),
    };
    // Preview only: no audit entry is written for a draft nobody has booked.
    const { draft } = await this.buildDraftVoucher(patched);
    return draft;
  }

  /**
   * Thin adapter over the deep projection module (ADR-0006): an Expense supplies
   * its economic facts and the `purchase` direction; the projection produces the
   * balanced draft Voucher (Dr category / Dr VAT_RECEIVABLE / Cr AP).
   *
   * When the expense names a supplier we also hand the projection the supplier's
   * country, goods/services nature AND tax status so the plugin can resolve
   * cross-border treatment — including WHERE a reverse-charged acquisition came
   * from, which decides KMD row 6 vs row 7 (issue #210). Without a supplier the
   * facts are omitted and the projection assumes a domestic counterparty.
   */
  private async buildDraftVoucher(expense: Expense): Promise<{
    draft: DraftVoucher;
    settlementLink: BankSettlementLink | null;
    settlementUnresolved: string | null;
  }> {
    const supplier =
      expense.supplier_id !== null
        ? await this.db
            .selectFrom('entity')
            .select(['country', 'name', 'goods_vs_services', 'tax_status'])
            .where('id', '=', expense.supplier_id)
            .executeTakeFirst()
        : undefined;

    // ── Bank-settlement FX link (issue #403) ─────────────────────
    // A purchase may be valuably evidenced by the bank line that settled it
    // the SAME DAY (RTJ1 §93's transaction-date rate). Resolved
    // deterministically HERE — the adapter that owns the purchase row — and
    // validated/used ONLY as the projection's narrow fallback (see
    // settlementFxFallback and the ADR-0004 amendment). It is attempted for
    // every purchase with a recorded supplier: WHICH treatments may use it
    // (a `foreign_cost` local purchase whose foreign VAT folds into the cost,
    // or a VAT-free one) is decided by the projection from the RESOLVED
    // treatment, never from the stated vat_amount alone — a local foreign
    // receipt may carry positive foreign VAT.
    const settlement = await this.resolveBankSettlementLink(
      expense,
      supplier?.name ?? null,
    );

    const draft = await this.projection.project(
      {
        category: expense.category,
        grossAmount: expense.gross_amount,
        vatAmount: expense.vat_amount,
        currency: expense.currency,
        taxPointDate: expense.tax_point_date,
        ...(supplier && {
          supplierCountry: supplier.country,
          goodsVsServices: this.normalizeGoodsVsServices(
            supplier.goods_vs_services,
          ),
          taxStatus: this.normalizeTaxStatus(supplier.tax_status),
        }),
        claimantId: expense.claimant_id ?? null,
        companyAddressedReceipt:
          expense.claimant_id !== null
            ? expense.company_addressed_receipt === null
              ? null
              : Boolean(expense.company_addressed_receipt)
            : undefined,
        ...(settlement?.kind === 'link' && {
          settlementFx: settlement.link,
        }),
        ...(settlement?.kind === 'unresolved' && {
          settlementFxUnresolved: settlement.reason,
        }),
        ...(expense.service_place_rule != null && {
          servicePlaceRule: expense.service_place_rule,
        }),
        ...(expense.place_of_supply_country != null && {
          placeOfSupplyCountry: expense.place_of_supply_country,
        }),
      },
      'purchase',
    );
    return {
      draft,
      settlementLink: settlement?.kind === 'link' ? settlement.link : null,
      settlementUnresolved:
        settlement?.kind === 'unresolved' ? settlement.reason : null,
    };
  }

  /**
   * Resolve the bank settlement line that paid a VAT-free purchase —
   * deterministically, or not at all (issue #403).
   *
   * The link is NEVER amount alone. Every candidate must satisfy ALL of:
   *   - the SAME DAY as the purchase (the transaction-date rate, RTJ1 §93);
   *   - the SAME original currency AND original amount (the purchase's own
   *     foreign figure, exactly);
   *   - a COUNTERPARTY identity link to the supplier — the bank's merchant
   *     descriptor/IBAN matches the supplier's name or a recorded identifier
   *     (deterministic normalized-token rule, never fuzzy); and
   *   - exclusivity: the bank line is not already another expense's evidence.
   *
   * Ambiguity (two lines surviving every check), a line already used by a
   * different expense, or a claimant-paid purchase matched against the
   * ORGANISATION's bank line (the approver confirmed the claimant paid out of
   * pocket — an org-account settlement contradicts that) are EXPLICIT
   * unresolved outcomes, surfaced by the projection's fallback as the reason
   * the statutory hold stands. Nothing is guessed and nothing matches on
   * amount alone.
   */
  private async resolveBankSettlementLink(
    expense: Pick<
      Expense,
      | 'id'
      | 'supplier_id'
      | 'claimant_id'
      | 'currency'
      | 'gross_amount'
      | 'tax_point_date'
    >,
    supplierName: string | null,
  ): Promise<BankSettlementResolution> {
    if (expense.supplier_id == null) {
      return {
        kind: 'unresolved',
        reason: 'no supplier recorded to link a bank line against',
      };
    }
    if (expense.claimant_id != null) {
      // The approver confirmed this purchase was paid by the CLAIMANT out of
      // pocket; an organisation-account settlement would contradict that, so
      // no org bank line is used as its valuation evidence.
      return {
        kind: 'unresolved',
        reason:
          'claimant-paid purchase: an organisation bank settlement would ' +
          'contradict the confirmed out-of-pocket payment',
      };
    }

    const candidates = await this.db
      .selectFrom('bank_transaction')
      .selectAll()
      .where('source_currency', '=', expense.currency)
      .where('transaction_date', '=', expense.tax_point_date)
      .where('source_amount', '=', expense.gross_amount)
      .where('amount', '<', 0)
      .where('status', '=', 'open')
      .execute();

    if (candidates.length === 0) {
      return {
        kind: 'unresolved',
        reason:
          `no same-day bank settlement line carries this purchase's ` +
          `original ${expense.currency} ${expense.gross_amount} amount`,
      };
    }

    // Counterparty identity: the descriptor's normalized tokens must all
    // appear in the supplier's name or a recorded merchant_descriptor /
    // name_alias / IBAN identifier — deterministic, case/punctuation-blind.
    const identifiers = await this.db
      .selectFrom('entity_identifier')
      .select(['kind', 'value'])
      .where('entity_id', '=', expense.supplier_id)
      .execute();
    const identityValues = [
      ...(supplierName ? [supplierName] : []),
      ...identifiers
        .filter((i) =>
          ['merchant_descriptor', 'name_alias', 'iban'].includes(i.kind),
        )
        .map((i) => i.value),
    ];
    const linked = candidates.filter((c) => {
      const descriptor = c.counterparty_descriptor ?? c.counterparty_iban;
      if (descriptor == null) return false;
      return identityValues.some((v) =>
        descriptorMatchesIdentity(descriptor, v),
      );
    });

    // Exclusivity, fast path: a bank line already CLAIMED by another expense
    // is not evidence for this one (a retry of the same expense keeps its own
    // claim). The atomic guarantee is the UNIQUE claim insert at draft time
    // (claimBankSettlementUsage); this pre-read only avoids building a draft
    // that the claim would immediately refuse.
    const usage = await this.bankSettlementUsage();
    const free = linked.filter(
      (c) => !(c.id in usage) || usage[c.id] === expense.id,
    );

    if (free.length === 0) {
      return {
        kind: 'unresolved',
        reason:
          linked.length > 0
            ? 'the matching bank settlement line(s) already evidence another expense'
            : 'the same-day bank lines with this amount do not identify this supplier as counterparty',
      };
    }
    if (free.length > 1) {
      return {
        kind: 'unresolved',
        reason:
          `multiple bank settlement lines (${free
            .map((c) => c.id)
            .join(', ')}) match this purchase on currency, original amount, ` +
          `date and counterparty; the link is ambiguous`,
      };
    }
    const txn = free[0];
    return {
      kind: 'link',
      link: {
        bankTransactionId: txn.id,
        statementId: txn.statement_id,
        supplierId: expense.supplier_id,
        bookingDate: txn.booking_date,
        transactionDate: txn.transaction_date,
        sourceCurrency: txn.source_currency ?? '',
        sourceAmount: txn.source_amount ?? 0,
        settledCurrency: txn.currency,
        settledAmount: txn.amount,
        fxRate: txn.fx_rate,
        fxRateDecimals: txn.fx_rate_decimals,
        conversionFee: txn.conversion_fee,
        bankReferenceRate: txn.bank_reference_rate,
      },
    };
  }

  /**
   * Which expense has CLAIMED each bank settlement line (issue #403): the
   * `bank_settlement_usage` claim table, keyed by bank transaction id →
   * expense id. The UNIQUE index on the claim makes one bank line unable to
   * value two purchases; this read is only the fast path — the insert itself
   * is the atomic guard.
   */
  private async bankSettlementUsage(): Promise<Record<number, number>> {
    const rows = await this.db
      .selectFrom('bank_settlement_usage')
      .select(['bank_transaction_id', 'expense_id'])
      .execute();
    const usage: Record<number, number> = {};
    for (const row of rows) {
      usage[row.bank_transaction_id] = row.expense_id;
    }
    return usage;
  }

  /**
   * Audit the valuation of a draft actually booked from bank-settlement
   * evidence (issue #403 acceptance): the source statement and transaction,
   * the rate (its direction and origin), the fee, the dates, and the valuation
   * policy — written ONCE per expense (append-only log, ADR-0026, deduped by
   * the action + expense target).
   */
  private async auditBankSettlementFxOnce(
    expense: Expense,
    link: BankSettlementLink,
    draft: DraftVoucher,
  ): Promise<void> {
    if (
      !draft.lines.some((l) => l.fx_rate_source === BANK_STATEMENT_RATE_SOURCE)
    ) {
      return;
    }
    // Append-only, deduped per VALUATION (issue #403): an entry exists for
    // THIS (expense, bank line) pair — a retry of the same state is the same
    // valuation and writes nothing. A draft EDIT that re-valued the purchase
    // on a DIFFERENT bank line is a NEW valuation: a NEW entry, appended —
    // the original entry stays untouched, so the audit trail shows every
    // valuation the purchase actually went through.
    const priorRows = await this.db
      .selectFrom('audit_log')
      .select(['detail'])
      .where('action', '=', 'expense.bank_settlement_fx')
      .where('target_type', '=', 'expense')
      .where('target_id', '=', expense.id)
      .execute();
    const priorTxns = new Set(
      priorRows
        .map((r) => {
          try {
            const detail = JSON.parse(r.detail ?? '{}') as {
              bank_transaction_id?: number;
            };
            return typeof detail.bank_transaction_id === 'number'
              ? detail.bank_transaction_id
              : null;
          } catch {
            return null;
          }
        })
        .filter((v): v is number => v !== null),
    );
    if (priorTxns.has(link.bankTransactionId)) return;

    await this.auditLog.record({
      actor: 'system',
      action: 'expense.bank_settlement_fx',
      outcome: 'valued',
      target_type: 'expense',
      target_id: expense.id,
      detail: {
        bank_transaction_id: link.bankTransactionId,
        bank_statement_id: link.statementId,
        booking_date: link.bookingDate,
        transaction_date: link.transactionDate,
        tax_point_date: expense.tax_point_date,
        source_currency: link.sourceCurrency,
        source_amount: link.sourceAmount,
        settled_currency: link.settledCurrency,
        debit_amount: Math.abs(link.settledAmount),
        // The bank's OWN printed reference-rate observation, retained
        // UNVERIFIED — evidence of what the bank REPORTS, never verified
        // statutory provenance and never a valuation input (ADR-0004).
        ...(link.bankReferenceRate !== null && {
          bank_reference_rate_observation: link.bankReferenceRate,
        }),
        principal_amount: Math.round(
          link.fxRate !== null
            ? link.fxRate * link.sourceAmount
            : Math.abs(link.settledAmount) - (link.conversionFee ?? 0),
        ),
        conversion_fee: link.conversionFee,
        full_debit_reconciliation:
          'the fee is evidenced separately on the bank line; the purchase ' +
          'voucher books the fee-separated principal, and the fee remains on ' +
          'the statement line (and its reconciliation remainder) to be ' +
          'booked separately — never folded into the purchase and never ' +
          'duplicated',
        booked_fx_rate: draft.lines[0]?.fx_rate ?? null,
        booked_fx_rate_date: draft.lines[0]?.fx_rate_date ?? null,
        rate_direction: `${link.settledCurrency} per 1 ${link.sourceCurrency}`,
        rate_origin:
          link.fxRate !== null
            ? 'bank_statement (the bank printed its rate)'
            : 'derived from the fee-separated principal (|debit| - evidenced fee) / original amount',
        // The calculation precision, rounding rule and consistency
        // tolerance actually applied (issue #403): the bank's PRINTED
        // decimal places when it printed a rate (null = unknown or derived),
        // half-up rounding to base minor units, and the exact-consistency
        // check the figures had to satisfy before anything posted.
        rate_calculation_precision:
          link.fxRate !== null
            ? link.fxRateDecimals !== null
              ? `bank-printed to ${link.fxRateDecimals} decimals`
              : 'bank rate, printed precision unknown (numeric-only input)'
            : 'derived full-precision division ((debit - evidenced fee) / original amount)',
        rounding_rule: 'Math.round (half-up) to base-currency minor units',
        consistency_tolerance:
          'exact — the charged (fee-separated) principal must equal the ' +
          "bank's own rounded rate × original amount (0 tolerance)",
        valuation_policy:
          'same-day bank settlement rate as the transaction-date rate ' +
          '(RTJ1 §93, SME IFRS 30.6/30.7), used only because no statutory ' +
          'reference rate is available for the pair/date; no VAT legs exist on ' +
          'this purchase, so no statutory VAT-base conversion was substituted',
      },
    });
  }

  /** Map the entity's free-form goods/services column onto the projection enum. */
  private normalizeGoodsVsServices(
    value: string | null,
  ): 'goods' | 'services' | 'unknown' {
    return value === 'goods' || value === 'services' ? value : 'unknown';
  }

  /**
   * Map the supplier's stored tax status onto the plugin enum. A NULL column
   * (never recorded) and a literal 'unknown' mean the same thing, and neither
   * is 'non_taxable': the plugin refuses on unknown rather than deciding the
   * acquisition's origin — or whether a reverse charge is due at all — for us.
   */
  private normalizeTaxStatus(
    value: string | null,
  ): 'taxable_business' | 'non_taxable' | 'unknown' {
    return value === 'taxable_business' || value === 'non_taxable'
      ? value
      : 'unknown';
  }

  /**
   * A fingerprint of every fact the draft voucher for this expense is derived
   * from — the expense's own amounts/currency/tax point/category, the supplier
   * facts that decide its VAT treatment and its KMD acquisition row (issue
   * #210), and the organisation's VAT facts that decide how much of its input
   * VAT is deductible (issue #211).
   *
   * Taken before the draft is generated and re-checked inside the posting
   * transaction, it closes the reverse-order race: generate a draft → edit the
   * expense or the supplier → post. Mirrors the sales side (issue #209);
   * `status` is deliberately NOT part of it, because the transition claims that
   * separately.
   */
  async draftFactsFingerprint(
    id: number,
    executor: Kysely<Database> = this.db,
  ): Promise<string> {
    const expense = await executor
      .selectFrom('expense')
      .select([
        'id',
        'supplier_id',
        'category',
        'gross_amount',
        'vat_amount',
        'currency',
        'tax_point_date',
        'claimant_id',
        'company_addressed_receipt',
        // The place-of-supply facts (issue #403) are VALUATION facts: they
        // decide the cross-border treatment, so an edit between generating a
        // draft and posting it must refuse the stale draft (409) — the same
        // guard the supplier facts already get.
        'service_place_rule',
        'place_of_supply_country',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!expense) {
      throw new NotFoundException(`Expense ${id} not found`);
    }
    const supplier =
      expense.supplier_id !== null
        ? await executor
            .selectFrom('entity')
            .select(['id', 'country', 'goods_vs_services', 'tax_status'])
            .where('id', '=', expense.supplier_id)
            .executeTakeFirst()
        : undefined;
    // The organisation's OWN VAT facts now decide how much of the expense's
    // input VAT is deductible, and therefore what the legs are (issue #211).
    // A settings change between generating a draft and posting it moves the
    // entry, so it belongs in the fingerprint alongside the supplier's facts.
    const org = await executor
      .selectFrom('organization')
      .select([
        'vat_registered',
        'vat_registration_kind',
        'input_vat_entitlement',
        'input_vat_deduction_permille',
      ])
      .executeTakeFirst();
    return JSON.stringify([expense, supplier ?? null, org ?? null]);
  }

  /**
   * Refuse the write when the facts moved under an already-generated draft.
   * Runs on the posting transaction's executor, so the comparison and the write
   * see one consistent state.
   */
  async assertDraftFactsUnchangedTx(
    trx: Kysely<Database>,
    id: number,
    expected: string,
  ): Promise<void> {
    const actual = await this.draftFactsFingerprint(id, trx);
    if (actual !== expected) {
      throw new ConflictException(
        `Expense ${id} was changed while it was being posted (its own amounts, ` +
          `the supplier facts that decide its VAT treatment and KMD ` +
          `acquisition row, or the organisation's VAT facts that decide its ` +
          `input-VAT deduction), so the prepared entry no longer matches it. ` +
          `Nothing was posted or held — post it again and the entry is ` +
          `recomputed from the current facts.`,
      );
    }
  }

  /**
   * Set opaque document metadata (supplier_invoice_number) on a posted expense.
   * No ledger impact — pure administrative annotation. The period must be open
   * (not locked) so audit trails remain consistent with the filed snapshot.
   */
  async setDocumentMetadata(
    id: number,
    patch: { supplier_invoice_number?: string | null },
  ): Promise<Expense> {
    const expense = await this.getExpenseById(id);
    await this.periodLock.assertPeriodOpen(expense.tax_point_date);
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .updateTable('expense')
      .set({
        supplier_invoice_number: patch.supplier_invoice_number ?? null,
        updated_at: now,
      })
      .where('id', '=', id)
      .execute();
    return this.getExpenseById(id);
  }

  async updateExpenseStatus(
    id: number,
    status: 'draft' | 'pending' | 'posted' | 'reversed',
    voucherId: number | null,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .updateTable('expense')
      .set({
        status,
        voucher_id: voucherId,
        updated_at: now,
      })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Edit a draft (or pending) expense's economic facts in place (issue #247).
   *
   * The same SAME-object remedy the sales side has (issue #209): a rejected or
   * mistyped draft is fixed here and submitted again, keeping its source
   * document, its AI facts and its approval history. Also the draft/pending
   * branch of the corrections flow, which sends amounts/category only.
   *
   * Everything that decides whether the write is allowed — the state check,
   * the merged-amount check, the entity checks, the duplicate key — runs inside
   * ONE transaction, and the UPDATE claims the row conditionally
   * (`status IN (draft, pending) AND voucher_id IS NULL`). A status read taken
   * before the transaction would be a TOCTOU window in which a post landing in
   * between leaves this UPDATE rewriting an already-POSTED expense's facts
   * underneath its immutable voucher (same shape as the sales-invoice patch).
   * Saving never posts: submitting stays a separate, deliberate act.
   */
  async updateDraft(
    id: number,
    patch: PatchExpenseDraftInput,
  ): Promise<Expense> {
    // Category validity is a plugin rule read through OrganizationService on
    // the root connection, so it is checked BEFORE the transaction opens (the
    // single SQLite connection is held by the transaction once it does).
    if (patch.category !== undefined) {
      await this.categoryService.assertValid(patch.category);
    }

    const now = Math.floor(Date.now() / 1000);
    const row = await this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('expense')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!current) {
        throw new NotFoundException(`Expense ${id} not found`);
      }
      this.assertEditable(id, current.status);

      const next = {
        category: patch.category ?? current.category,
        supplier_id:
          patch.supplier_id !== undefined
            ? patch.supplier_id
            : current.supplier_id,
        gross_amount: patch.gross_amount ?? current.gross_amount,
        vat_amount: patch.vat_amount ?? current.vat_amount,
        currency: patch.currency ?? current.currency,
        tax_point_date: patch.tax_point_date ?? current.tax_point_date,
        supplier_invoice_number:
          patch.supplier_invoice_number !== undefined
            ? patch.supplier_invoice_number
            : current.supplier_invoice_number,
        claimant_id:
          patch.claimant_id !== undefined
            ? patch.claimant_id
            : current.claimant_id,
        company_addressed_receipt:
          patch.company_addressed_receipt !== undefined
            ? patch.company_addressed_receipt === null
              ? null
              : patch.company_addressed_receipt
                ? 1
                : 0
            : current.company_addressed_receipt,
        // The place-of-supply facts (issue #403) — operator-editable on a
        // draft, NULL ≡ the residual general rule / no declared location.
        service_place_rule:
          patch.service_place_rule !== undefined
            ? patch.service_place_rule === 'general'
              ? null
              : patch.service_place_rule
            : current.service_place_rule,
        place_of_supply_country:
          patch.place_of_supply_country !== undefined
            ? patch.place_of_supply_country
            : current.place_of_supply_country,
      };

      // ── Abandoned bank-settlement reservations (issue #403) ────────────
      // A draft edit that changes a fact the receipt→bank link is made of
      // (supplier, currency, original amount, date, or the claimant
      // contradiction) ABANDONS whatever bank line the unposted draft had
      // claimed: the reservation is released here, inside the same guarded
      // transaction, so a genuinely distinct purchase can use that line
      // instead of being told it "already evidences another expense". The
      // next valuation claims its own line. Unposted-only by the update's
      // own WHERE guard (draft/pending, voucher-less), so a posted or
      // voucher-bearing valuation keeps its claim for good.
      const linkKeyChanged =
        next.supplier_id !== current.supplier_id ||
        next.currency !== current.currency ||
        next.gross_amount !== current.gross_amount ||
        next.tax_point_date !== current.tax_point_date ||
        (next.claimant_id ?? null) !== (current.claimant_id ?? null);
      const abandonedClaim =
        linkKeyChanged &&
        (await trx
          .selectFrom('bank_settlement_usage')
          .select('bank_transaction_id')
          .where('expense_id', '=', id)
          .executeTakeFirst()) != null;
      if (abandonedClaim) {
        await trx
          .deleteFrom('bank_settlement_usage')
          .where('expense_id', '=', id)
          .execute();
      }

      this.assertMergedAmounts(id, next.gross_amount, next.vat_amount);
      // An entity is checked only when the edit CHANGES it: an unchanged
      // reference was accepted when the draft was made and must not block a
      // category or VAT fix.
      if (
        next.supplier_id !== current.supplier_id &&
        next.supplier_id !== null
      ) {
        await this.assertEntityRole(trx, 'supplier_id', next.supplier_id, [
          'supplier',
        ]);
      }
      if (
        next.claimant_id !== current.claimant_id &&
        next.claimant_id !== null
      ) {
        await this.assertEntityRole(trx, 'claimant_id', next.claimant_id, [
          'employee',
          'director',
        ]);
      }

      // Duplicate guard (issue #195) — re-run only when the edit changes a
      // VALUE the key is made of, so an already-accepted (possibly
      // operator-allowed) duplicate can still have its category or VAT fixed.
      const keyChanged =
        next.supplier_id !== current.supplier_id ||
        normalizeInvoiceNumber(next.supplier_invoice_number) !==
          normalizeInvoiceNumber(current.supplier_invoice_number) ||
        next.currency !== current.currency ||
        next.gross_amount !== current.gross_amount ||
        next.tax_point_date !== current.tax_point_date ||
        (next.claimant_id ?? null) !== (current.claimant_id ?? null);
      const duplicate = keyChanged
        ? await this.detectDuplicate(next, trx, id, current.document_id ?? null)
        : null;
      if (duplicate && patch.allow_duplicate !== true) {
        throw new DuplicateExpenseException(duplicate);
      }

      const updated = await trx
        .updateTable('expense')
        .set({
          ...next,
          ...(current.status === 'pending' && {
            status: 'draft',
            voucher_id: null,
          }),
          updated_at: now,
        })
        .where('id', '=', id)
        // The claim: only an editable, voucher-less row is touched. Zero rows
        // means the state changed under us — nothing is written.
        .where('status', 'in', ['draft', 'pending'])
        .where('voucher_id', 'is', null)
        .returningAll()
        .executeTakeFirst();

      if (!updated) {
        const actual = await trx
          .selectFrom('expense')
          .select(['status', 'voucher_id'])
          .where('id', '=', id)
          .executeTakeFirst();
        throw new ConflictException(
          `Cannot update draft: expense ${id} is ` +
            `${actual?.status ?? 'gone'} (voucher ${String(actual?.voucher_id)}) ` +
            `— it changed while this edit was being applied, so nothing was changed.`,
        );
      }

      // The override trace commits with the edit it allowed, or not at all
      // (audit_log is append-only, ADR-0026).
      if (duplicate) {
        await this.auditLog.record(
          {
            actor: 'operator',
            action: 'expense.duplicate_guard.override',
            outcome: 'allowed',
            target_type: 'expense',
            target_id: id,
            detail: {
              duplicate_of_expense_id: duplicate.existingExpenseId,
              matched_on: duplicate.matchedOn,
              supplier_id: next.supplier_id,
              supplier_invoice_number: next.supplier_invoice_number,
              reason: duplicate.reason,
              via: 'draft_edit',
            },
          },
          trx,
        );
      }

      // Only once the editable row is actually claimed does the pending
      // approval it was holding get superseded — never on a row we did not win.
      if (current.status === 'pending') {
        const approval = await trx
          .updateTable('approval')
          .set({
            status: 'superseded',
            resolved_at: now,
          })
          .where('object_type', '=', 'expense')
          .where('object_id', '=', id)
          .where('status', '=', 'pending')
          .returning('id')
          .executeTakeFirst();

        if (approval) {
          await trx
            .updateTable('audit_finding')
            .set({
              status: 'resolved',
              resolved_at: now,
              transitioned_by: null,
              transition_reason: 'Draft updated; approval superseded',
            })
            .where('finding_type', '=', 'pending_approval')
            .where('referenced_object_type', '=', 'approval')
            .where('referenced_object_id', '=', approval.id)
            .where('status', '=', 'open')
            .execute();
        }
      }

      return updated;
    });

    return this.mapRow(row);
  }

  /** Only a draft (or a pending expense, whose approval is then superseded) is editable. */
  private assertEditable(id: number, status: string): void {
    if (status !== 'draft' && status !== 'pending') {
      throw new ConflictException(
        `Cannot update draft: expense ${id} is ${status} ` +
          `(a posted voucher is immutable — correct it via POST ` +
          `/api/expenses/${id}/correct)`,
      );
    }
  }

  /** Validate the amounts the expense will HAVE after a partial patch merges. */
  private assertMergedAmounts(id: number, gross: number, vat: number): void {
    if (!Number.isInteger(gross) || !Number.isInteger(vat)) {
      throw new BadRequestException(
        `Expense ${id}: amounts must be integer minor units (cents)`,
      );
    }
    if (gross <= 0) {
      throw new BadRequestException(
        `Expense ${id}: gross_amount must be positive (would be ${gross})`,
      );
    }
    if (vat < 0) {
      throw new BadRequestException(
        `Expense ${id}: vat_amount cannot be negative (would be ${vat})`,
      );
    }
    if (vat > gross) {
      throw new BadRequestException(
        `Expense ${id}: vat_amount ${vat} would exceed gross_amount ` +
          `${gross} — the net would be negative.`,
      );
    }
  }

  private async assertEntityRole(
    trx: Kysely<Database>,
    field: string,
    entityId: number,
    roles: string[],
  ): Promise<void> {
    const entity = await trx
      .selectFrom('entity')
      .select(['id', 'role'])
      .where('id', '=', entityId)
      .executeTakeFirst();
    if (!entity) {
      throw new UnprocessableEntityException(
        `${field}: entity ${entityId} does not exist`,
      );
    }
    if (!roles.includes(entity.role)) {
      throw new UnprocessableEntityException(
        `${field}: entity ${entityId} is a ${entity.role}, expected ${roles.join(' or ')}`,
      );
    }
  }

  async patchAmounts(
    id: number,
    patch: {
      gross_amount?: number;
      vat_amount?: number;
      category?: string;
    },
  ): Promise<Expense> {
    const now = Math.floor(Date.now() / 1000);
    const row = await this.db
      .updateTable('expense')
      .set({
        ...(patch.gross_amount !== undefined && {
          gross_amount: patch.gross_amount,
        }),
        ...(patch.vat_amount !== undefined && {
          vat_amount: patch.vat_amount,
        }),
        ...(patch.category !== undefined && { category: patch.category }),
        updated_at: now,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.mapRow(row);
  }

  /**
   * Apply an amount/category patch inside an existing transaction (trx) — the
   * transactional twin of {@link patchAmounts}, used by the atomic correction
   * flow so the patch commits together with the reversal + correction vouchers.
   */
  async patchAmountsTx(
    trx: Kysely<Database>,
    id: number,
    patch: { gross_amount?: number; vat_amount?: number; category?: string },
  ): Promise<void> {
    // INVARIANT: patch.category is validated by the caller
    // (previewPatchedDraft -> CategoryService.assertValid) BEFORE this
    // transaction opens. Do not add an await here -- this runs inside the
    // synchronous transaction callback, where the patch is applied to the
    // 'expense' row below.
    const now = Math.floor(Date.now() / 1000);
    await trx
      .updateTable('expense')
      .set({
        ...(patch.gross_amount !== undefined && {
          gross_amount: patch.gross_amount,
        }),
        ...(patch.vat_amount !== undefined && {
          vat_amount: patch.vat_amount,
        }),
        ...(patch.category !== undefined && { category: patch.category }),
        updated_at: now,
      })
      .where('id', '=', id)
      .execute();
  }

  private validateStatus(status: string): ExpenseStatus {
    if (
      status === 'draft' ||
      status === 'pending' ||
      status === 'posted' ||
      status === 'reversed'
    ) {
      return status;
    }
    throw new Error(`Invalid expense status: ${status}`);
  }

  private mapRow(row: {
    id: number;
    document_id: number | null;
    supplier_id: number | null;
    category: string;
    gross_amount: number;
    vat_amount: number;
    currency: string;
    tax_point_date: string;
    status: string;
    voucher_id: number | null;
    document_vat_marking: string | null;
    supplier_invoice_number: string | null;
    asset_name: string | null;
    asset_useful_life_years: number | null;
    asset_residual_value_minor: number | null;
    claimant_id?: number | null;
    company_addressed_receipt?: number | null;
    service_place_rule?: string | null;
    place_of_supply_country?: string | null;
    ai_confidence?: number | null;
    ai_document_type?: string | null;
    ai_kind?: string | null;
    created_at: number;
    updated_at: number;
  }): Expense {
    return {
      id: row.id,
      document_id: row.document_id,
      supplier_id: row.supplier_id,
      category: row.category,
      gross_amount: row.gross_amount,
      vat_amount: row.vat_amount,
      currency: row.currency,
      tax_point_date: row.tax_point_date,
      status: this.validateStatus(row.status),
      voucher_id: row.voucher_id,
      document_vat_marking: row.document_vat_marking,
      supplier_invoice_number: row.supplier_invoice_number,
      asset_name: row.asset_name,
      asset_useful_life_years: row.asset_useful_life_years,
      asset_residual_value_minor: row.asset_residual_value_minor,
      claimant_id: row.claimant_id ?? null,
      company_addressed_receipt:
        row.company_addressed_receipt === null ||
        row.company_addressed_receipt === undefined
          ? null
          : Boolean(row.company_addressed_receipt),
      service_place_rule:
        row.service_place_rule === 'general' || row.service_place_rule == null
          ? null
          : (row.service_place_rule as Expense['service_place_rule']),
      place_of_supply_country: row.place_of_supply_country ?? null,
      ai_confidence: row.ai_confidence ?? null,
      ai_document_type: row.ai_document_type ?? null,
      ai_kind: row.ai_kind ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
