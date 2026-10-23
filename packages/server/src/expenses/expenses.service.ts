import type { FinancialPatch } from '../corrections/types';
import { euVatFactsSchema } from '../plugins/eu-vat';
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
  patchExpenseDraftSchema,
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

/** Normalize only facts that the create path actually stores. Object order in
 * nested VAT evidence is irrelevant; absent optional values use insert defaults.
 */
function createExpenseFacts(dto: CreateExpenseDto) {
  return {
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
    eu_vat_facts:
      dto.eu_vat_facts == null ? null : JSON.stringify(dto.eu_vat_facts),
    ai_confidence: dto.ai_confidence ?? null,
    ai_document_type: dto.ai_document_type ?? null,
    ai_kind: dto.ai_kind ?? null,
  };
}

function canonicalCreateJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

@Injectable()
export class ExpensesService {
  /**
   * The bank line's source statement for audit/provenance references
   * (issues #399/#403): its ORIGIN statement when that still exists, else
   * the earliest remaining statement that co-evidences the canonical row
   * (an origin may have been detached while the movement survives). Never
   * an invented 0 and never a rewrite of the historical audit entries.
   */
  private async resolveSourceStatementId(txn: {
    id: number;
    statement_id: number | null;
  }): Promise<number | null> {
    if (txn.statement_id !== null) return txn.statement_id;
    const row = await this.db
      .selectFrom('bank_transaction_source')
      .select('statement_id')
      .where('bank_transaction_id', '=', txn.id)
      .orderBy('statement_id')
      .executeTakeFirst();
    return row ? row.statement_id : null;
  }

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

  async createExpense(
    dto: CreateExpenseDto,
    operationKey?: string,
  ): Promise<Expense> {
    if (operationKey === undefined) {
      await this.categoryService.assertValid(dto.category);
      return this.insertExpense(dto, this.db);
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(operationKey)) {
      throw new BadRequestException(
        'Idempotency-Key must be 1–128 ASCII letters, digits, dots, underscores, colons or hyphens',
      );
    }
    const requestJson = canonicalCreateJson({
      ...createExpenseFacts(dto),
      eu_vat_facts: dto.eu_vat_facts ?? null,
      allow_duplicate: dto.allow_duplicate === true,
    });
    const replay = (stored: {
      request_json: string;
      response_json: string | null;
    }): Expense => {
      if (stored.request_json !== requestJson) {
        throw new ConflictException(
          'Idempotency-Key was already used with different expense facts',
        );
      }
      if (stored.response_json === null) {
        throw new ConflictException(
          'Expense creation is not yet confirmed; retry the same operation',
        );
      }
      return JSON.parse(stored.response_json) as Expense;
    };
    // Fast replay also survives subsequent category/configuration changes.
    // Safety does not depend on this read: the transaction claims the key first.
    const existing = await this.db
      .selectFrom('expense_create_operation')
      .selectAll()
      .where('operation_key', '=', operationKey)
      .executeTakeFirst();
    if (existing) return replay(existing);
    // CategoryService reads the root connection: validate before opening a transaction.
    await this.categoryService.assertValid(dto.category);
    return this.db.transaction().execute(async (trx) => {
      // First statement is a WRITE: serialize concurrent claims at SQLite's
      // unique key/write lock before reading or inserting an Expense.
      const claimed = await trx
        .insertInto('expense_create_operation')
        .values({
          operation_key: operationKey,
          request_json: requestJson,
          expense_id: null,
          response_json: null,
          created_at: Math.floor(Date.now() / 1000),
        })
        .onConflict((oc) => oc.column('operation_key').doNothing())
        .returning('operation_key')
        .executeTakeFirst();
      if (!claimed) {
        const stored = await trx
          .selectFrom('expense_create_operation')
          .selectAll()
          .where('operation_key', '=', operationKey)
          .executeTakeFirstOrThrow();
        return replay(stored);
      }
      const expense = await this.insertExpense(dto, trx);
      await trx
        .updateTable('expense_create_operation')
        .set({
          expense_id: expense.id,
          response_json: JSON.stringify(expense),
        })
        .where('operation_key', '=', operationKey)
        .execute();
      return expense;
    });
  }

  private async insertExpense(
    dto: CreateExpenseDto,
    executor: Kysely<Database>,
  ): Promise<Expense> {
    // Duplicate guard (issue #195 / ADR-0010). It refuses CREATION and nothing
    // else: it runs before the insert, so no voucher, posting or period lock is
    // ever involved and there is nothing to reverse afterwards.
    const duplicate = await this.detectDuplicate(dto, executor);
    if (duplicate && dto.allow_duplicate !== true) {
      throw new DuplicateExpenseException(duplicate);
    }

    const now = Math.floor(Date.now() / 1000);
    const result = await executor
      .insertInto('expense')
      .values({
        ...createExpenseFacts(dto),
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
      await this.auditLog.record(
        {
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
        },
        executor,
      );
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

  /** List projection only: follow actual reversal links from the live posting.
   * A financial correction already points at its replacement; its preceding
   * original/reversal pair cancels exactly. Settlement vouchers are never part
   * of this graph. Compare signed account/currency vectors, not double-entry
   * totals (which are zero for EVERY balanced voucher).
   */
  async listExpenses(includeCancelled = false) {
    const expenses = await this.getExpenses();
    const vouchers = await this.db
      .selectFrom('voucher')
      .select(['id', 'reverses_id'])
      .where('posted_at', 'is not', null)
      .execute();
    const children = new Map<number, number[]>();
    for (const v of vouchers) {
      if (v.reverses_id !== null) {
        children.set(v.reverses_id, [
          ...(children.get(v.reverses_id) ?? []),
          v.id,
        ]);
      }
    }
    const chains = new Map<number, Set<number>>();
    for (const e of expenses) {
      if (e.voucher_id === null || !children.has(e.voucher_id)) continue;
      const ids = new Set<number>();
      const visit = (id: number) => {
        if (ids.has(id)) return;
        ids.add(id);
        for (const child of children.get(id) ?? []) visit(child);
      };
      visit(e.voucher_id);
      chains.set(e.id, ids);
    }
    const ids = [...new Set([...chains.values()].flatMap((c) => [...c]))];
    const lines =
      ids.length === 0
        ? []
        : await this.db
            .selectFrom('voucher_line')
            .innerJoin('account', 'account.id', 'voucher_line.account_id')
            .select([
              'voucher_line.voucher_id',
              'voucher_line.account_id',
              'voucher_line.currency',
              'voucher_line.amount',
              'voucher_line.base_amount',
              'voucher_line.is_debit',
              'account.code',
            ])
            .where('voucher_line.voucher_id', 'in', ids)
            .execute();
    const linesByVoucher = new Map<number, typeof lines>();
    for (const line of lines) {
      const group = linesByVoucher.get(line.voucher_id) ?? [];
      group.push(line);
      linesByVoucher.set(line.voucher_id, group);
    }
    return expenses
      .map((e) => {
        const chain = chains.get(e.id);
        if (!chain)
          return {
            ...e,
            cancelled: false,
            effective_gross_amount: e.gross_amount,
          };
        const net = new Map<string, number>();
        let originalCredit = 0;
        let remainingCredit = 0;
        const relatedLines = [...chain].flatMap(
          (id) => linesByVoucher.get(id) ?? [],
        );
        for (const l of relatedLines) {
          const sign = l.is_debit ? -1 : 1;
          for (const [basis, amount] of [
            ['original', l.amount],
            ['base', l.base_amount],
          ] as const) {
            const key = `${l.account_id}:${l.currency}:${basis}`;
            net.set(key, (net.get(key) ?? 0) + sign * amount);
          }
          // Gross counter-leg, excluding self-assessed VAT. Bank-valued
          // purchases can have a different credit currency: the proportion is
          // applied to the purchase's own original-currency gross.
          if (
            l.code === 'AP' ||
            l.code === 'CLAIMANT_PAYABLE' ||
            l.code === 'CASH' ||
            l.code === 'BANK' ||
            l.code.startsWith('BANK_')
          ) {
            remainingCredit += sign * l.amount;
            if (l.voucher_id === e.voucher_id)
              originalCredit += sign * l.amount;
          }
        }
        const cancelled =
          net.size > 0 && [...net.values()].every((amount) => amount === 0);
        const effective = cancelled
          ? 0
          : originalCredit !== 0
            ? Math.round((e.gross_amount * remainingCredit) / originalCredit)
            : e.gross_amount;
        return { ...e, cancelled, effective_gross_amount: effective };
      })
      .filter((e) => includeCancelled || !e.cancelled);
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
   * The operator's EXPLICIT settlement-line selection (issue #403's
   * ambiguity recovery): when several same-day bank lines share the exact
   * merchant, original currency and original amount — genuinely distinct
   * settlements the deterministic resolver cannot tell apart — the held
   * draft stays held until a human says WHICH line settled THIS purchase.
   *
   * This is a RESOLUTION, not a bypass. The selected line runs through the
   * SAME validation the automatic link runs — counterparty identity, same
   * day, the same original currency and amount, the organisation's own bank
   * account, fee/rate sanity, exclusivity (a line claimed by another expense
   * is refused), and the claimant contradiction — and the valuation itself
   * happens later, in the normal draft generation, where the resolved
   * treatment, eligibility and statutory checks all run as always. Nothing
   * about the selection rewrites the expense: the original amount, currency
   * and attachments stand, and the posting goes through the normal
   * Rules → Policy → approval flow.
   *
   * Idempotent: re-selecting the same line keeps one claim and one selection
   * audit entry; selecting a DIFFERENT line for the same unposted draft
   * atomically REPLACES the reservation (the abandoned line is released for
   * a genuinely distinct purchase). Refused selections change nothing.
   */
  async selectSettlementFx(
    expenseId: number,
    bankTransactionId: number,
  ): Promise<{ expense_id: number; bank_transaction_id: number }> {
    const expense = await this.getExpenseById(expenseId);
    if (!expense) {
      throw new NotFoundException(`Expense ${expenseId} not found`);
    }
    // Unposted-only (the same guard an edit gets): a posted or
    // voucher-bearing valuation keeps its settlement for good.
    if (expense.status !== 'draft' && expense.status !== 'pending') {
      throw new ConflictException(
        `Expense ${expenseId} is ${expense.status} — its settlement ` +
          `stands; correct it via POST /api/expenses/${expenseId}/correct`,
      );
    }
    if (expense.voucher_id !== null) {
      throw new ConflictException(
        `Expense ${expenseId} already carries a voucher — its settlement ` +
          `stands`,
      );
    }
    if (expense.claimant_id !== null) {
      throw new BadRequestException(
        `Expense ${expenseId} is claimant-paid: an organisation bank ` +
          `settlement would contradict the confirmed out-of-pocket payment`,
      );
    }
    if (expense.supplier_id === null) {
      throw new BadRequestException(
        `Expense ${expenseId} has no supplier recorded to link a settlement ` +
          `line against`,
      );
    }

    const txn = await this.db
      .selectFrom('bank_transaction')
      .selectAll()
      .where('id', '=', bankTransactionId)
      .executeTakeFirst();
    if (!txn) {
      throw new NotFoundException(
        `Bank transaction ${bankTransactionId} not found`,
      );
    }

    // Exclusivity, fast path (the atomic guard is the claim transaction).
    const usage = await this.bankSettlementUsage();
    if (bankTransactionId in usage && usage[bankTransactionId] !== expenseId) {
      throw new ConflictException(
        `Bank transaction ${bankTransactionId} already values expense ` +
          `${usage[bankTransactionId]}`,
      );
    }

    // The organisation's OWN bank account: the line's statement must belong
    // to a real BANK_* asset account.
    const account = await this.db
      .selectFrom('bank_transaction')
      .innerJoin('account', 'account.id', 'bank_transaction.account_id')
      .select(['account.code as code', 'account.type as type'])
      .where('bank_transaction.id', '=', bankTransactionId)
      .executeTakeFirstOrThrow();

    // ── The same link validations the automatic resolution runs ────────
    if (txn.amount >= 0) {
      throw new BadRequestException(
        `Bank transaction ${bankTransactionId} is not a debit settlement`,
      );
    }
    if (account.type !== 'asset' || !account.code.startsWith('BANK_')) {
      throw new BadRequestException(
        `Bank transaction ${bankTransactionId} does not belong to a ` +
          `organisation bank account (${account.code})`,
      );
    }
    if (txn.status !== 'open') {
      throw new ConflictException(
        `Bank transaction ${bankTransactionId} is ${txn.status}, not open`,
      );
    }
    // Existing allocations (issue #403's reliable-link fidelity): a line whose
    // cash the books have already drawn on (an ACTIVE reconciliation match)
    // is not free FULL-settlement evidence for a DIFFERENT purchase — status
    // 'open' does not mean unallocated. A partial/combined settlement keeps
    // the line open with a remainder, and offering it here would claim cash
    // the books already own. Refused with the allocation named.
    {
      const allocated = await this.activeAllocation(bankTransactionId);
      const claimedByThis =
        bankTransactionId in usage && usage[bankTransactionId] === expenseId;
      if (allocated > 0 && !claimedByThis) {
        throw new ConflictException(
          `Bank transaction ${bankTransactionId} already has ` +
            `${allocated} of its cash allocated on the books — a line with ` +
            `an existing settlement is not free full-settlement evidence ` +
            `for this purchase; if this purchase really settled on it, ` +
            `book it manually with your accountant`,
        );
      }
    }
    if (txn.source_currency === null || txn.source_currency === '') {
      throw new BadRequestException(
        `Bank transaction ${bankTransactionId} carries no original ` +
          `currency evidence`,
      );
    }
    if (txn.source_currency !== expense.currency) {
      throw new BadRequestException(
        `Bank transaction ${bankTransactionId}'s original currency ` +
          `(${txn.source_currency}) is not the purchase's ` +
          `(${expense.currency})`,
      );
    }
    if (txn.source_amount === null || txn.source_amount <= 0) {
      throw new BadRequestException(
        `Bank transaction ${bankTransactionId} carries no positive ` +
          `original amount`,
      );
    }
    if (txn.source_amount !== expense.gross_amount) {
      throw new BadRequestException(
        `Bank transaction ${bankTransactionId}'s original amount ` +
          `(${txn.source_amount} ${txn.source_currency}) is not the ` +
          `purchase's (${expense.gross_amount} ${expense.currency})`,
      );
    }
    if (txn.currency === txn.source_currency) {
      throw new BadRequestException(
        `Bank transaction ${bankTransactionId} is settled in the original ` +
          `currency itself — no conversion evidence`,
      );
    }
    if (txn.transaction_date !== expense.tax_point_date) {
      throw new BadRequestException(
        `Bank transaction ${bankTransactionId} settled ` +
          `${txn.transaction_date}, not the purchase's transaction date ` +
          `(${expense.tax_point_date}) — not a same-day settlement`,
      );
    }

    // Counterparty identity: the full-merchant-name rule, never amount alone.
    const supplier = await this.loadSupplierIdentityValues(expense.supplier_id);
    const descriptor = txn.counterparty_descriptor ?? txn.counterparty_iban;
    if (
      descriptor === null ||
      !supplier.values.some((v) => descriptorMatchesIdentity(descriptor, v))
    ) {
      throw new BadRequestException(
        `Bank transaction ${bankTransactionId}'s counterparty does not ` +
          `identify the purchase's supplier (${supplier.name})`,
      );
    }

    // Fee/rate sanity (the full fee-separated arithmetic runs, as always, at
    // draft generation, where the effective base currency is known).
    if (
      txn.fx_rate !== null &&
      (!Number.isFinite(txn.fx_rate) || txn.fx_rate <= 0)
    ) {
      throw new BadRequestException(
        `Bank transaction ${bankTransactionId}'s conversion rate ` +
          `(${txn.fx_rate}) is not usable`,
      );
    }
    if (
      txn.conversion_fee !== null &&
      (!Number.isSafeInteger(txn.conversion_fee) ||
        txn.conversion_fee < 0 ||
        txn.conversion_fee >= Math.abs(txn.amount))
    ) {
      throw new ConflictException(
        `Bank transaction ${bankTransactionId}'s conversion fee ` +
          `(${txn.conversion_fee}) does not fit its debit ` +
          `(${Math.abs(txn.amount)}); the figures conflict`,
      );
    }

    // Atomic reservation replacement + audit: an abandoned selection is
    // released, the chosen line claimed, and the SELECTION ITSELF recorded —
    // all inside one transaction, so a failure leaves no un-audited
    // reservation and a racing edit/claim by another expense cannot
    // interleave. Every LINK-RELEVANT fact is re-compared inside the
    // transaction (not merely status/voucher): an edit that landed between
    // the validation above and this claim refuses the selection — the stale
    // evidence is never reserved.
    const now = Math.floor(Date.now() / 1000);
    await this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('expense')
        .select([
          'status',
          'voucher_id',
          'supplier_id',
          'claimant_id',
          'currency',
          'gross_amount',
          'tax_point_date',
        ])
        .where('id', '=', expenseId)
        .executeTakeFirstOrThrow();
      if (
        (current.status !== 'draft' && current.status !== 'pending') ||
        current.voucher_id !== null ||
        current.supplier_id !== expense.supplier_id ||
        (current.claimant_id ?? null) !== (expense.claimant_id ?? null) ||
        current.currency !== expense.currency ||
        current.gross_amount !== expense.gross_amount ||
        current.tax_point_date !== expense.tax_point_date
      ) {
        throw new ConflictException(
          `Expense ${expenseId} changed while its settlement was being ` +
            `selected; nothing was claimed or audited — retry and the ` +
            `validation runs on the current facts`,
        );
      }
      const owner = await trx
        .selectFrom('bank_settlement_usage')
        .select(['expense_id'])
        .where('bank_transaction_id', '=', bankTransactionId)
        .executeTakeFirst();
      if (owner && owner.expense_id !== expenseId) {
        throw new ConflictException(
          `Bank transaction ${bankTransactionId} was claimed by expense ` +
            `${owner.expense_id} while this selection was being made; ` +
            `nothing was changed — retry`,
        );
      }
      // SAME-STATE IDEMPOTENCE: re-selecting the row this expense's
      // OPERATOR claim already holds is an atomic no-op — the state is
      // already exactly what was asked for, so nothing is rewritten and no
      // duplicate decision is recorded. (A different row, or an 'auto'
      // reservation on this row, IS a new decision below: an A-then-B-then-A
      // re-selection is three operator decisions and reads as three.)
      const sameOperatorSelection = await trx
        .selectFrom('bank_settlement_usage')
        .select(['bank_transaction_id'])
        .where('expense_id', '=', expenseId)
        .where('origin', '=', 'operator')
        .where('bank_transaction_id', '=', bankTransactionId)
        .executeTakeFirst();
      if (sameOperatorSelection) {
        return;
      }
      // The expense's previous reservation (if any) is released — the
      // unposted draft's evidence follows the operator's current decision.
      await trx
        .deleteFrom('bank_settlement_usage')
        .where('expense_id', '=', expenseId)
        .execute();
      await trx
        .insertInto('bank_settlement_usage')
        .values({
          bank_transaction_id: bankTransactionId,
          expense_id: expenseId,
          origin: 'operator',
          created_at: now,
        })
        .execute();
      // The decision itself is on the record — APPEND-ONLY, one entry per
      // NEW decision, INSIDE the claim transaction (a same-state retry
      // records nothing; the claim state is what makes the latest one
      // authoritative), never silently collapsed.
      await this.auditLog.record(
        {
          actor: 'operator',
          action: 'expense.bank_settlement_fx_selection',
          outcome: 'selected',
          target_type: 'expense',
          target_id: expenseId,
          detail: {
            bank_transaction_id: bankTransactionId,
            bank_statement_id: await this.resolveSourceStatementId(txn),
            transaction_date: txn.transaction_date,
            tax_point_date: expense.tax_point_date,
            source_currency: txn.source_currency,
            source_amount: txn.source_amount,
            settled_currency: txn.currency,
            debit_amount: Math.abs(txn.amount),
            fx_rate: txn.fx_rate,
            fx_rate_decimals: txn.fx_rate_decimals,
            conversion_fee: txn.conversion_fee,
            counterparty_descriptor: txn.counterparty_descriptor,
            supplier_id: expense.supplier_id,
            reason:
              'operator disambiguation of same-day settlement lines sharing ' +
              'the merchant, original currency and original amount; every ' +
              'link validation re-ran at selection and the valuation runs ' +
              'through the normal draft generation',
          },
        },
        trx,
      );
    });

    return { expense_id: expenseId, bank_transaction_id: bankTransactionId };
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
      // BANK-ROW guard, atomically inside the claim transaction (issue
      // #403's disposition races): the settlement line itself is re-read
      // HERE. A whole-line disposition (a personal spend recorded on the
      // line — it posts the FULL cash and flips the row's status without any
      // reconciliation match) or a statement DELETION (the row vanishes and
      // cascades the claim away) can land between the draft generation's FX
      // wait and this claim; claiming a disposed or deleted line would post
      // a second full valuation on cash the books already own. A row that
      // no longer exists, or is no longer OPEN, refuses — nothing claimed,
      // nothing posted.
      const bankRow = await trx
        .selectFrom('bank_transaction')
        .select(['status'])
        .where('id', '=', link.bankTransactionId)
        .executeTakeFirst();
      if (!bankRow) {
        throw new FxRateUnavailableError(
          link.sourceCurrency,
          link.settledCurrency,
          link.transactionDate,
          `bank settlement line ${link.bankTransactionId} was deleted (its ` +
            `statement was removed) while this draft was being valued; ` +
            `nothing was claimed or posted — post it again and the evidence ` +
            `is re-resolved from what exists`,
          'no_rate_for_date',
        );
      }
      if (bankRow.status !== 'open') {
        throw new FxRateUnavailableError(
          link.sourceCurrency,
          link.settledCurrency,
          link.transactionDate,
          `bank settlement line ${link.bankTransactionId} was recorded as a ` +
            `'${bankRow.status}' disposition while this draft was being ` +
            `valued — the line's cash is already accounted for on the ` +
            `books; nothing was claimed or posted. If this purchase really ` +
            `settled on it, book it manually with your accountant`,
          'no_rate_for_date',
        );
      }

      // ALLOCATION guard, atomically inside the claim transaction (issue
      // #403): a reconciliation match can ACTIVATE on this line while a
      // draft generation waits on the FX authority — the books then already
      // own part of this line's cash, and a full-settlement claim posted on
      // it would double-claim allocated cash. Re-read the ACTIVE
      // allocations HERE, inside the same transaction that claims: a racing
      // activation cannot slip in between this check and the claim (the
      // single SQLite writer serializes both). A line already allocated to
      // ANOTHER business object is refused — partial/combined settlements
      // get an explicit typed outcome, never a silent full-bank valuation.
      const allocatedNow = await this.activeCashAllocated(
        link.bankTransactionId,
        trx,
      );
      if (allocatedNow > 0) {
        throw new FxRateUnavailableError(
          link.sourceCurrency,
          link.settledCurrency,
          link.transactionDate,
          `bank settlement line ${link.bankTransactionId} already has ` +
            `${allocatedNow} of its cash allocated on the books while this ` +
            `draft was being valued — a line with an existing settlement is ` +
            `not free full-settlement evidence for this purchase; nothing ` +
            `was claimed or posted. If this purchase really settled on it, ` +
            `book it manually with your accountant`,
          'no_rate_for_date',
        );
      }

      // SELECTION-CHANGE guard (issue #403): the operator's settlement
      // selection is authoritative for an unposted draft. A stale draft
      // generation (paused mid-FX before the operator selected) finding the
      // expense now holding a DIFFERENT OPERATOR-selected line must NOT
      // evict the selection nor claim its own line alongside it — the usage
      // table constrains uniqueness per bank line, not per expense, so an
      // unguarded insert would leave the draft holding BOTH. It refuses: the
      // operator's selection stands, the stale draft is not posted, and the
      // next generation values the SELECTED line.
      //
      // An 'auto' reservation (a PRIOR generation's own transient claim) is
      // NOT a decision: the fresh generation replaces it — otherwise the
      // very first automatic claim would collide with itself forever.
      const reservations = await trx
        .selectFrom('bank_settlement_usage')
        .select(['bank_transaction_id', 'expense_id', 'origin'])
        .where('expense_id', '=', expense.id)
        .execute();
      const otherSelection = reservations.find(
        (r) =>
          r.origin === 'operator' &&
          r.bank_transaction_id !== link.bankTransactionId,
      );
      if (otherSelection) {
        throw new FxRateUnavailableError(
          link.sourceCurrency,
          link.settledCurrency,
          link.transactionDate,
          `the purchase's settlement selection changed to bank line ` +
            `${otherSelection.bank_transaction_id} while this draft was ` +
            `being valued on line ${link.bankTransactionId}; the selection ` +
            `stands and nothing was claimed or posted — post it again and ` +
            `the entry is valued on the selected line`,
          'no_rate_for_date',
        );
      }
      // Replace this expense's own stale AUTO reservations (an operator
      // claim for the SAME line stays — the guard above only refuses a
      // different one, and the insert below is a no-op on it).
      await trx
        .deleteFrom('bank_settlement_usage')
        .where('expense_id', '=', expense.id)
        .where('origin', '=', 'auto')
        .execute();
      await trx
        .insertInto('bank_settlement_usage')
        .values({
          bank_transaction_id: link.bankTransactionId,
          expense_id: expense.id,
          origin: 'auto',
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
    patch: FinancialPatch,
  ): Promise<DraftVoucher> {
    if (patch.category !== undefined) {
      await this.categoryService.assertValid(patch.category);
    }
    const expense = await this.getExpenseById(expenseId);
    if (Object.keys(patch).length > 0) {
      const parsed = patchExpenseDraftSchema.safeParse(patch);
      if (!parsed.success)
        throw new BadRequestException({
          message: 'Invalid expense correction facts',
          issues: parsed.error.issues,
        });
    }
    const patched: Expense = {
      ...expense,
      ...patch,
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
        euVatFacts: expense.eu_vat_facts ?? undefined,
        ...(expense.eu_vat_facts?.supplyType && {
          supplyType: expense.eu_vat_facts.supplyType,
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
    // The draft's OWN evidence identity (issue #403): when THIS draft booked
    // the bank's own rate, its concrete bank line travels on the draft so
    // the posting transaction's guard revalidates exactly what this
    // valuation used — not the claim (which cascades with the statement)
    // and not the valuation audit history (which is deduplicated per
    // valuation and cannot distinguish an A→B→A re-selection's latest).
    if (
      settlement?.kind === 'link' &&
      draft.lines.some((l) => l.fx_rate_source === BANK_STATEMENT_RATE_SOURCE)
    ) {
      draft.bank_settlement = {
        bankTransactionId: settlement.link.bankTransactionId,
        statementId: settlement.link.statementId,
      };
    }
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
      | 'voucher_id'
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

    // ── The operator's selected line takes precedence (issue #403) ──────
    // An expense holding a bank_settlement_usage claim got it either from
    // a draft generation or from the operator's EXPLICIT settlement
    // selection (selectSettlementFx) — the disambiguation of same-day lines
    // the deterministic query cannot tell apart. The claimed line is
    // RE-VALIDATED here, every check the automatic candidates get, because
    // a selection disambiguates WHICH line, never waiving identity, amount,
    // date or currency.
    const claim = await this.db
      .selectFrom('bank_settlement_usage')
      .select(['bank_transaction_id'])
      .where('expense_id', '=', expense.id)
      .executeTakeFirst();
    const selectedId = claim?.bank_transaction_id ?? null;
    if (selectedId !== null) {
      const selected = await this.db
        .selectFrom('bank_transaction')
        .selectAll()
        .where('id', '=', selectedId)
        .executeTakeFirst();
      // A POSTED expense's OWN settled line is legitimate at ANY disposition
      // status (issue #403's correction fidelity): its own full normal flow —
      // the principal settlement match plus the explicit fee disposition —
      // consumes the whole line and flips its status to 'bank_fee'; a
      // correction of THAT purchase must still re-derive its historical
      // valuation. Validated STRUCTURALLY below (every ACTIVE match is the
      // expense's own principal or the line's own fee leg), never re-valuing
      // another expense's evidence and never acquiring new cash or a claim
      // (the preview path claims nothing). An UNPOSTED draft keeps the
      // strict status guard: for it a disposed line is a race, not history.
      const postedOwnLine =
        expense.voucher_id !== null &&
        selected !== undefined &&
        selected.amount < 0 &&
        (await this.allActiveMatchesBelongToOwnSettlement(
          selected.id,
          expense.voucher_id,
          selected.conversion_fee,
        ));
      const stillValid =
        selected !== undefined &&
        selected.amount < 0 &&
        (postedOwnLine || selected.status === 'open') &&
        selected.source_currency === expense.currency &&
        selected.source_amount === expense.gross_amount &&
        selected.transaction_date === expense.tax_point_date &&
        // The counterparty identity is the descriptor OR the IBAN — a card
        // line may carry only an IBAN (issue #403: IBAN-only identity is a
        // reliable link when the supplier has the identifier recorded).
        (selected.counterparty_descriptor ?? selected.counterparty_iban) !==
          null;
      if (stillValid && selected) {
        const supplierIdentity = await this.loadSupplierIdentityValues(
          expense.supplier_id,
          supplierName,
        );
        const identityValues = supplierIdentity.values;
        const descriptor =
          selected.counterparty_descriptor ?? selected.counterparty_iban;
        if (
          descriptor !== null &&
          identityValues.some((v) => descriptorMatchesIdentity(descriptor, v))
        ) {
          return {
            kind: 'link',
            link: {
              bankTransactionId: selected.id,
              statementId: await this.resolveSourceStatementId(selected),
              supplierId: expense.supplier_id,
              bookingDate: selected.booking_date,
              transactionDate: selected.transaction_date,
              sourceCurrency: selected.source_currency ?? '',
              sourceAmount: selected.source_amount ?? 0,
              settledCurrency: selected.currency,
              settledAmount: selected.amount,
              fxRate: selected.fx_rate,
              fxRateDecimals: selected.fx_rate_decimals,
              conversionFee: selected.conversion_fee,
              bankReferenceRate: selected.bank_reference_rate,
            },
          };
        }
      }
      // The selected line no longer validates: an honest, actionable
      // outcome naming the resolution path, never a silent fall-through to
      // the ambiguous many (the operator resolved this once already).
      return {
        kind: 'unresolved',
        reason:
          'the operator-selected settlement line no longer matches this ' +
          'purchase (its facts, status or counterparty identity changed) — ' +
          `re-select via POST /api/expenses/${expense.id}/settlement-fx`,
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

    // ── The expense's OWN settled line (issue #403's correction fidelity) ──
    // A posted purchase's full normal flow (principal settlement + the
    // explicit fee disposition) fully consumes its line and flips the line's
    // status away from 'open' — a correction of THAT purchase must still
    // re-derive its historical bank valuation and provenance, so its own
    // claimed line rejoins the candidates here. The OWN-settlement pattern
    // is validated below (all active matches are the expense's own
    // principal or its own fee part); an UNPOSTED draft has no voucher and
    // never gets this exemption — for it the strict open/deleted/personal
    // guards apply unchanged.
    const ownClaimed: typeof candidates =
      expense.voucher_id !== null
        ? await this.db
            .selectFrom('bank_transaction')
            .innerJoin(
              'bank_settlement_usage',
              'bank_settlement_usage.bank_transaction_id',
              'bank_transaction.id',
            )
            .selectAll('bank_transaction')
            .where('bank_settlement_usage.expense_id', '=', expense.id)
            .execute()
        : [];
    const candidateIds = new Set(candidates.map((c) => c.id));
    const ownLines = ownClaimed.filter((c) => !candidateIds.has(c.id));

    if (candidates.length === 0 && ownLines.length === 0) {
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
    const supplierIdentity = await this.loadSupplierIdentityValues(
      expense.supplier_id,
      supplierName,
    );
    const identityValues = supplierIdentity.values;
    const matchesIdentity = (c: (typeof candidates)[number]): boolean => {
      const descriptor = c.counterparty_descriptor ?? c.counterparty_iban;
      if (descriptor == null) return false;
      return identityValues.some((v) =>
        descriptorMatchesIdentity(descriptor, v),
      );
    };
    const linked = candidates.filter(matchesIdentity);
    const ownLinked = ownLines.filter(matchesIdentity);

    // Exclusivity, fast path: a bank line already CLAIMED by another expense
    // is not evidence for this one (a retry of the same expense keeps its own
    // claim). The atomic guarantee is the UNIQUE claim insert at draft time
    // (claimBankSettlementUsage); this pre-read only avoids building a draft
    // that the claim would immediately refuse.
    const usage = await this.bankSettlementUsage();
    // Existing allocations (issue #403's reliable-link fidelity): a line
    // whose cash the books have already drawn on — an ACTIVE reconciliation
    // match (a posted purchase's settlement, a fee disposition) — is not
    // FREE full-settlement evidence for a different purchase. Status 'open'
    // does NOT mean unallocated: a partial/combined settlement keeps the
    // line open with a remainder. Such lines are refused with the
    // allocation named, never offered as automatic evidence.
    const unallocated: typeof linked = [];
    const allocatedLines: { id: number; allocated: number }[] = [];
    for (const c of linked) {
      // OWN allocations are exempt: a line whose ACTIVE matches all belong
      // to THIS expense's own voucher is this purchase's own settlement —
      // re-previewing/correcting the already-settled purchase re-reads its
      // own evidence and must not be refused by its own allocation.
      const ownAllocation =
        expense.voucher_id !== null &&
        (await this.allActiveMatchesBelongToVoucher(c.id, expense.voucher_id));
      if (ownAllocation) {
        unallocated.push(c);
        continue;
      }
      const allocated = await this.activeAllocation(c.id);
      if (allocated > 0) {
        allocatedLines.push({ id: c.id, allocated });
        continue;
      }
      unallocated.push(c);
    }

    // The expense's OWN settled lines (the correction path): each is
    // validated against the OWN-settlement pattern — every ACTIVE match is
    // this expense's own principal or its own fee part — before it re-enters
    // the candidate set with its historical valuation. A claimed line that
    // does NOT satisfy the pattern (another object's claim on the cash) is
    // refused below with the allocation named.
    for (const c of ownLinked) {
      const ownSettled =
        expense.voucher_id !== null &&
        (await this.allActiveMatchesBelongToOwnSettlement(
          c.id,
          expense.voucher_id,
          c.conversion_fee,
        ));
      if (ownSettled) {
        unallocated.push(c);
      } else {
        const allocated = await this.activeAllocation(c.id);
        allocatedLines.push({
          id: c.id,
          allocated: allocated || Math.abs(c.amount),
        });
      }
    }

    const free = unallocated.filter(
      (c) => !(c.id in usage) || usage[c.id] === expense.id,
    );

    if (free.length === 0) {
      return {
        kind: 'unresolved',
        reason:
          allocatedLines.length > 0
            ? `the matching bank settlement line(s) (${allocatedLines
                .map((a) => `#${a.id} with ${a.allocated} already allocated`)
                .join(
                  '; ',
                )}) already have cash allocated on the books — a line with an existing settlement is not free full-settlement evidence for this purchase; if this purchase really settled on it, book it manually with your accountant`
            : unallocated.length > 0
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
          `date and counterparty; the link is ambiguous — select the one ` +
          `that settled this purchase via POST /api/expenses/${expense.id}/` +
          `settlement-fx with {"bank_transaction_id": N}, then post again`,
      };
    }
    const txn = free[0];
    return {
      kind: 'link',
      link: {
        bankTransactionId: txn.id,
        statementId: await this.resolveSourceStatementId(txn),
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
   * The supplier's identity VALUES a bank line's counterparty is matched
   * against (issue #403): the supplier's own name plus every recorded
   * merchant_descriptor / name_alias / IBAN identifier. ONE loader for the
   * three consumers — the automatic link, the claimed-row precedence and the
   * explicit settlement selection — so the identity policy (which identifiers
   * count, and how the name is sourced) is defined once; the callers keep
   * their own error outcomes.
   *
   * `supplierName` overrides the row's name when the caller already read a
   * FRESHER one (the projection's supplier read); absent it, the entity row
   * is the authority.
   */
  private async loadSupplierIdentityValues(
    supplierId: number,
    supplierName?: string | null,
    executor: Kysely<Database> = this.db,
  ): Promise<{ name: string; values: string[] }> {
    const supplierRow = await executor
      .selectFrom('entity')
      .select(['id', 'name'])
      .where('id', '=', supplierId)
      .executeTakeFirst();
    const identifiers = await executor
      .selectFrom('entity_identifier')
      .select(['kind', 'value'])
      .where('entity_id', '=', supplierId)
      .execute();
    const name = supplierName ?? supplierRow?.name ?? '';
    const values = [
      ...(name !== '' ? [name] : []),
      ...identifiers
        .filter((i) =>
          ['merchant_descriptor', 'name_alias', 'iban'].includes(i.kind),
        )
        .map((i) => i.value),
    ];
    return { name, values };
  }

  /**
   * The CASH already allocated to a bank line by the books (issue #403): the
   * sum of the line's ACTIVE reconciliation matches (a draft/cancelled match
   * allocates nothing). Status 'open' alone does NOT mean unallocated — a
   * posted purchase can settle part of the line while its remainder stays
   * open, and treating such a line as a fresh purchase's FULL settlement
   * evidence would double-claim cash the books already own.
   */
  private async activeCashAllocated(
    bankTransactionId: number,
    executor: Kysely<Database> = this.db,
  ): Promise<number> {
    const rows = await executor
      .selectFrom('reconciliation_match')
      .select(['amount_matched', 'cash_base_amount'])
      .where('bank_transaction_id', '=', bankTransactionId)
      .where('status', '=', 'active')
      .execute();
    return rows.reduce(
      (sum, r) => sum + (r.cash_base_amount ?? r.amount_matched),
      0,
    );
  }

  /**
   * Whether every ACTIVE reconciliation match on a bank line belongs to THIS
   * expense's OWN settlement chain (issue #403's correction fidelity): the
   * principal part matched to the expense's own voucher, plus the FEE part —
   * the partial match equal to the line's evidenced conversion fee, written
   * only by the fee disposition of a line this expense claimed. A posted
   * purchase's correction must re-derive its historical bank valuation even
   * though its own full settlement (principal + fee) flipped the line's
   * status away from 'open' — while a NEW or unposted draft never gets this
   * exemption (it has no own voucher, so the strict open/deleted guards
   * apply unchanged).
   */
  private async allActiveMatchesBelongToOwnSettlement(
    bankTransactionId: number,
    expenseVoucherId: number,
    conversionFee: number | null,
    executor: Kysely<Database> = this.db,
  ): Promise<boolean> {
    const matches = await executor
      .selectFrom('reconciliation_match')
      .select(['voucher_id', 'amount_matched'])
      .where('bank_transaction_id', '=', bankTransactionId)
      .where('status', '=', 'active')
      .execute();
    if (matches.length === 0) return false;
    for (const m of matches) {
      // The principal part: this expense's own voucher.
      if (m.voucher_id === expenseVoucherId) continue;
      // The FEE part: identified STRUCTURALLY, never by amount alone — a
      // non-own voucher on this line is acceptable only if it IS the line's
      // fee disposition: a voucher whose single EXPENSE_BANK_FEE leg books
      // exactly the line's EVIDENCED conversion fee. Amount equality alone
      // is not authoritative provenance (another voucher could book the
      // same figure for other reasons).
      if (conversionFee === null || m.amount_matched !== conversionFee) {
        return false;
      }
      const feeLegs = await executor
        .selectFrom('voucher_line')
        .innerJoin('account', 'account.id', 'voucher_line.account_id')
        .select(['voucher_line.base_amount'])
        .where('voucher_line.voucher_id', '=', m.voucher_id)
        .where('account.code', '=', 'EXPENSE_BANK_FEE')
        .execute();
      if (feeLegs.length !== 1 || feeLegs[0].base_amount !== conversionFee) {
        return false;
      }
    }
    return true;
  }

  /**
   * Whether every ACTIVE reconciliation match on a bank line belongs to the
   * GIVEN voucher (issue #403): the own-settlement exemption — a settled
   * purchase's own matches are its own evidence, not another object's claim
   * on the cash.
   */
  private async allActiveMatchesBelongToVoucher(
    bankTransactionId: number,
    voucherId: number,
    executor: Kysely<Database> = this.db,
  ): Promise<boolean> {
    const rows = await executor
      .selectFrom('reconciliation_match')
      .select(['voucher_id'])
      .where('bank_transaction_id', '=', bankTransactionId)
      .where('status', '=', 'active')
      .execute();
    return rows.length > 0 && rows.every((r) => r.voucher_id === voucherId);
  }

  /**
   * Whether a bank line's cash is already allocated to OTHER business
   * objects (issue #403's reliable-link fidelity): an existing ACTIVE
   * reconciliation match on the line means the books have already drawn on
   * this settlement — the line is not free FULL-settlement evidence for a
   * different purchase, and linking it as such would double-claim cash.
   * Returns the offending allocation total for the typed outcome.
   */
  private async activeAllocation(
    bankTransactionId: number,
    executor: Kysely<Database> = this.db,
  ): Promise<number> {
    return this.activeCashAllocated(bankTransactionId, executor);
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
        'eu_vat_facts',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!expense) {
      throw new NotFoundException(`Expense ${id} not found`);
    }
    // The bank-settlement reservation (issue #403): an OPERATOR settlement
    // selection landing between the draft generation and the posting
    // transaction swaps the evidence the draft was valued on — the
    // fingerprint must refuse the stale entry inside the posting transaction,
    // exactly as an expense-fact edit does. Only the OPERATOR decision is a
    // posting fact: an 'auto' reservation is the generation's own transient
    // state (the pre-generation fingerprint cannot have seen it, and
    // mistaking it for an edit would 409 every first automatic post).
    const claim = await executor
      .selectFrom('bank_settlement_usage')
      .select(['bank_transaction_id'])
      .where('expense_id', '=', id)
      .where('origin', '=', 'operator')
      .executeTakeFirst();

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
    return JSON.stringify([
      expense,
      supplier ?? null,
      org ?? null,
      claim?.bank_transaction_id ?? null,
    ]);
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
    draft?: DraftVoucher,
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

    // ── Bank-settlement evidence revalidation, INSIDE the posting
    // transaction (issue #403's allocation timing). WHEN THE CONCRETE DRAFT
    // IS PROVIDED (every internal expense caller passes it — the pipeline
    // both auto-post and hold, and ApprovalsService), the validation runs on
    // exactly the evidence THIS draft used (draft.bank_settlement below):
    // a reference-valued draft skips bank evidence entirely — even if a
    // STALE claim from an abandoned earlier bank valuation sits on a line
    // whose cash has since been allocated, that is not this draft's evidence
    // and must not block it. The CLAIM-based block below is the fallback for
    // a draftless caller only: a reconciliation match can ACTIVATE on the
    // claimed line between the draft generation and this post, and posting a
    // FULL bank valuation on it would double-claim allocated cash. At posting
    // the expense's voucher does not exist yet, so any ACTIVE allocation on
    // its claimed line is another object's claim on the cash — a typed
    // refusal, nothing posted.
    if (draft) {
      // Validated below via draft.bank_settlement (the concrete evidence).
    } else {
      const claim = await trx
        .selectFrom('bank_settlement_usage')
        .select(['bank_transaction_id'])
        .where('expense_id', '=', id)
        .executeTakeFirst();
      if (claim) {
        const allocatedMatches = await trx
          .selectFrom('reconciliation_match')
          .select(['voucher_id'])
          .where('bank_transaction_id', '=', claim.bank_transaction_id)
          .where('status', '=', 'active')
          .execute();
        if (allocatedMatches.length > 0) {
          throw new ConflictException(
            `Expense ${id}'s bank settlement evidence (line ` +
              `${claim.bank_transaction_id}) had cash allocated on the books ` +
              `while this entry was being posted, so the full bank valuation ` +
              `would double-claim allocated cash. Nothing was posted or held — ` +
              `retry the post; if this purchase really settled on that line, ` +
              `book it manually with your accountant.`,
          );
        }
      }
    }

    // ── The DRAFT'S OWN evidence, validated by WHAT THE DRAFT USED (issue
    // #403's disposition/deletion timing): a whole-line disposition (a
    // personal spend — it posts the FULL cash and flips the row's status
    // without any reconciliation match) or a statement DELETION (the row
    // vanishes and the claim CASCADES away with it) can land between the
    // draft generation and this post. Guards that only re-check the CURRENT
    // claim or the valuation-audit history cannot answer "which evidence did
    // THIS prepared draft use" (an A→B→A re-selection leaves the audit's
    // latest entry on the abandoned B). The generator therefore stamps the
    // draft itself with the bank line its valuation used, and THAT line is
    // revalidated here, inside the posting transaction: it must still EXIST
    // and still be an OPEN, unallocated settlement. Reference-valued drafts
    // carry no bank evidence and skip this entirely.
    if (draft?.bank_settlement) {
      const evidenceTxnId = draft.bank_settlement.bankTransactionId;
      const row = await trx
        .selectFrom('bank_transaction')
        .select(['status'])
        .where('id', '=', evidenceTxnId)
        .executeTakeFirst();
      if (!row) {
        throw new ConflictException(
          `Expense ${id}'s bank settlement evidence (line ${evidenceTxnId}) ` +
            `was deleted — its statement was removed — while this entry ` +
            `was being posted, so the full bank valuation has no remaining ` +
            `evidence. Nothing was posted or held — retry the post and the ` +
            `entry is re-valued from what exists.`,
        );
      }
      if (row.status !== 'open') {
        throw new ConflictException(
          `Expense ${id}'s bank settlement evidence (line ${evidenceTxnId}) ` +
            `was recorded as a '${row.status}' disposition while this ` +
            `entry was being posted — the line's cash is already ` +
            `accounted for on the books, so the full bank valuation would ` +
            `double-claim it. Nothing was posted or held; if this purchase ` +
            `really settled on that line, book it manually with your ` +
            `accountant.`,
        );
      }
      const evidenceAllocations = await trx
        .selectFrom('reconciliation_match')
        .select(['voucher_id'])
        .where('bank_transaction_id', '=', evidenceTxnId)
        .where('status', '=', 'active')
        .execute();
      if (evidenceAllocations.length > 0) {
        throw new ConflictException(
          `Expense ${id}'s bank settlement evidence (line ${evidenceTxnId}) ` +
            `had cash allocated on the books while this entry was being ` +
            `posted, so the full bank valuation would double-claim allocated ` +
            `cash. Nothing was posted or held — retry the post; if this ` +
            `purchase really settled on that line, book it manually with ` +
            `your accountant.`,
        );
      }
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
        eu_vat_facts:
          patch.eu_vat_facts === undefined
            ? current.eu_vat_facts
            : patch.eu_vat_facts === null
              ? null
              : JSON.stringify(patch.eu_vat_facts),
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

  async patchAmounts(id: number, patch: FinancialPatch): Promise<Expense> {
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
        ...(patch.service_place_rule !== undefined && {
          service_place_rule: patch.service_place_rule,
        }),
        ...(patch.place_of_supply_country !== undefined && {
          place_of_supply_country: patch.place_of_supply_country,
        }),
        ...(patch.eu_vat_facts !== undefined && {
          eu_vat_facts:
            patch.eu_vat_facts === null
              ? null
              : JSON.stringify(euVatFactsSchema.parse(patch.eu_vat_facts)),
        }),
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
    patch: FinancialPatch,
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
        ...(patch.service_place_rule !== undefined && {
          service_place_rule: patch.service_place_rule,
        }),
        ...(patch.place_of_supply_country !== undefined && {
          place_of_supply_country: patch.place_of_supply_country,
        }),
        ...(patch.eu_vat_facts !== undefined && {
          eu_vat_facts:
            patch.eu_vat_facts === null
              ? null
              : JSON.stringify(euVatFactsSchema.parse(patch.eu_vat_facts)),
        }),
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
    eu_vat_facts?: string | null;
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
      eu_vat_facts:
        row.eu_vat_facts == null
          ? null
          : euVatFactsSchema.parse(JSON.parse(row.eu_vat_facts)),
      ai_confidence: row.ai_confidence ?? null,
      ai_document_type: row.ai_document_type ?? null,
      ai_kind: row.ai_kind ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
