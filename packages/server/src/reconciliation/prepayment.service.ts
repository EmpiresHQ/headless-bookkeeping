import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, Transaction } from 'kysely';
import { Database } from '../database/types';
import { BankTransactionRepository } from '../bank/bank-transaction.repository';
import { PostingService } from '../ledger/posting/posting.service';
import { CurrencyService } from '../currency/currency.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { EntitiesService } from '../entities/entities.service';
import {
  DraftVoucher,
  DraftVoucherLine,
  PostedVoucher,
} from '../ledger/voucher/types';
import { OutstandingVoucherService } from './outstanding-voucher.service';
import {
  PrepaymentAdvance,
  PrepaymentAllocationRepository,
} from './prepayment-allocation.repository';

/** Accounts used for prepayment vouchers. */
const CUSTOMER_PREPAYMENTS = 'CUSTOMER_PREPAYMENTS';
const SUPPLIER_PREPAYMENTS = 'SUPPLIER_PREPAYMENTS';
const AR = 'AR';
const AP = 'AP';

/** Which side of the books an advance lives on. */
export type AdvanceKind = 'customer' | 'supplier';

/** The counterparty evidence a bank line carries. */
export interface BankLineCounterparty {
  counterparty_iban: string | null;
  counterparty_descriptor: string | null;
}

/**
 * Why an advance cannot be allocated. Reported to the operator instead of a
 * fabricated balance or a guessed owner (issue #201).
 *
 * - `no_advance_record`: a prepayment voucher exists with no advance record at
 *   all (posted outside this service). Its drawn-down total is unknown.
 * - `unknown_counterparty`: the advance is registered but nobody could be
 *   resolved deterministically from its bank provenance.
 * - `balance_unverified`: a historical draw-down of this kind could not be
 *   attributed to a specific advance, so this advance's remaining balance is
 *   UNKNOWN.
 * - `advance_reversed`: the advance voucher itself was reversed — the credit no
 *   longer exists and never becomes available again.
 */
export type PrepaymentUnresolvedReason =
  | 'no_advance_record'
  | 'unknown_counterparty'
  | 'balance_unverified'
  | 'advance_reversed';

/** Result of looking up a prepayment voucher's remaining balance. */
export interface PrepaymentBalance {
  advanceId: number | null;
  voucherId: number;
  accountCode: string;
  /** The counterparty that owns this advance; null while unresolved. */
  entityId: number | null;
  originalAmount: number;
  /** Null when the drawn total cannot be established (see `unresolvedReason`). */
  drawnDown: number | null;
  /** Null when the remaining balance cannot be established. */
  remaining: number | null;
  currency: string;
  taxPointDate: string;
  /** False when a draw-down would be unsafe; `unresolvedReason` says why. */
  allocatable: boolean;
  unresolvedReason: PrepaymentUnresolvedReason | null;
}

/**
 * One historical draw-down the operator explicitly attributes to this advance:
 * the posted allocation voucher that performed it and the invoice voucher it
 * relieved. Both are verified against the ledger before anything is written —
 * this is a LINK, never a typed-in total.
 */
export interface AdvanceDrawDownLink {
  allocationVoucherId: number;
  invoiceVoucherId: number;
}

/** The operator's repair of one unresolved advance. */
export interface ResolveAdvanceInput {
  entityId: number;
  /**
   * Historical draw-downs drawn from THIS advance. Required (in full) before an
   * advance whose balance is unverified can be unblocked: every unlinked
   * draw-down of its kind must end up attributed, so the flag is lifted by
   * evidence rather than by a scalar offset that names no invoice.
   */
  drawDowns?: AdvanceDrawDownLink[];
}

@Injectable()
export class PrepaymentService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly transactionRepo: BankTransactionRepository,
    private readonly postingService: PostingService,
    private readonly currencyService: CurrencyService,
    private readonly orgContextResolver: OrgContextResolver,
    private readonly entitiesService: EntitiesService,
    private readonly allocations: PrepaymentAllocationRepository,
    private readonly outstandingVouchers: OutstandingVoucherService,
  ) {}

  /**
   * Build the bank leg + prepayment leg for a prepayment voucher.
   *
   * The bank leg resolves the transaction's REAL bank account (via the
   * statement → account join) and carries the transaction's own currency,
   * converted to base currency via the country plugin's reference rate (D4,
   * 1.0 for same-currency). The prepayment leg is denominated in base
   * currency.
   *
   * Returns the two lines in [bank, prepayment] order; callers set is_debit
   * via the direction flags.
   */
  private async buildBankAndPrepaymentLegs(
    transactionId: number,
    txn: { amount: number; currency: string; transaction_date: string },
    opts: {
      prepaymentAccountCode: string;
      bankIsDebit: boolean;
    },
  ): Promise<[DraftVoucherLine, DraftVoucherLine]> {
    const absAmount = Math.abs(txn.amount);

    // Resolve the REAL bank account code for this transaction by joining
    // statement → account.
    const bankAccount = await this.db
      .selectFrom('bank_transaction')
      .innerJoin(
        'bank_statement',
        'bank_statement.id',
        'bank_transaction.statement_id',
      )
      .innerJoin('account', 'account.id', 'bank_statement.account_id')
      .select('account.code as account_code')
      .where('bank_transaction.id', '=', transactionId)
      .executeTakeFirstOrThrow();
    const resolvedBankCode = bankAccount.account_code;

    const { plugin } = await this.orgContextResolver.resolve();
    const baseCurrency = await this.currencyService.getBaseCurrency();
    const fxRate = plugin.getReferenceRate(
      txn.currency,
      baseCurrency,
      txn.transaction_date,
    );
    const baseAmount = Math.round(absAmount * fxRate);

    const bankLeg: DraftVoucherLine = {
      account_code: resolvedBankCode,
      amount: absAmount,
      currency: txn.currency,
      base_amount: baseAmount,
      fx_rate: fxRate,
      is_debit: opts.bankIsDebit,
    };

    const prepaymentLeg: DraftVoucherLine = {
      account_code: opts.prepaymentAccountCode,
      amount: baseAmount,
      currency: baseCurrency,
      base_amount: baseAmount,
      fx_rate: 1.0,
      is_debit: !opts.bankIsDebit,
    };

    return [bankLeg, prepaymentLeg];
  }

  // ── Creation ──────────────────────────────────────────────────────

  /**
   * Create a prepayment from a bank transaction, dispatching based on amount sign.
   * Incoming (positive) → customer prepayment; outgoing (negative) → supplier prepayment.
   */
  async createPrepaymentFromTransaction(
    transactionId: number,
    entityId?: number,
  ): Promise<PostedVoucher> {
    const txn = await this.transactionRepo.findById(transactionId);
    if (!txn) {
      throw new NotFoundException(
        `Bank transaction ${transactionId} not found`,
      );
    }
    if (txn.amount > 0) {
      return this.createCustomerPrepayment(transactionId, entityId);
    }
    if (txn.amount < 0) {
      return this.createSupplierPrepayment(transactionId, entityId);
    }
    throw new BadRequestException(
      `Transaction ${transactionId} has zero amount — cannot create prepayment`,
    );
  }

  /**
   * Create a customer prepayment from an unmatched incoming bank payment.
   *
   * Posts: Dr {resolved real bank account} / Cr CUSTOMER_PREPAYMENTS (liability)
   * and registers the advance with its owner + source bank provenance, in the
   * SAME transaction as the post.
   *
   * The bank transaction amount must be positive (incoming).
   */
  async createCustomerPrepayment(
    transactionId: number,
    entityId?: number,
  ): Promise<PostedVoucher> {
    return this.createAdvance(transactionId, 'customer', entityId);
  }

  /**
   * Create a supplier prepayment from an unmatched outgoing bank payment.
   *
   * Posts: Dr SUPPLIER_PREPAYMENTS / Cr {resolved real bank account} (asset)
   * and registers the advance with its owner + source bank provenance.
   *
   * The bank transaction amount must be negative (outgoing).
   */
  async createSupplierPrepayment(
    transactionId: number,
    entityId?: number,
  ): Promise<PostedVoucher> {
    return this.createAdvance(transactionId, 'supplier', entityId);
  }

  /**
   * The one creation path for both sides. Ownership is established HERE, at
   * creation, from evidence that belongs to the money itself — the caller's
   * explicit counterparty, or the bank transaction's own confirmed identifiers
   * — and persisted with the advance. It is never inferred later from whoever
   * happens to query (the #201 candidate-lookup bug), and an advance whose
   * owner cannot be resolved is stored UNRESOLVED rather than attributed.
   */
  private async createAdvance(
    transactionId: number,
    kind: AdvanceKind,
    entityId?: number,
  ): Promise<PostedVoucher> {
    const txn = await this.transactionRepo.findById(transactionId);
    if (!txn) {
      throw new NotFoundException(
        `Bank transaction ${transactionId} not found`,
      );
    }
    if (txn.status !== 'open') {
      throw new BadRequestException(
        `Transaction ${transactionId} is not open (status: ${txn.status})`,
      );
    }
    if (kind === 'customer' && txn.amount <= 0) {
      throw new BadRequestException(
        `Customer prepayment requires a positive (incoming) amount, got ${txn.amount}`,
      );
    }
    if (kind === 'supplier' && txn.amount >= 0) {
      throw new BadRequestException(
        `Supplier prepayment requires a negative (outgoing) amount, got ${txn.amount}`,
      );
    }

    const accountCode =
      kind === 'customer' ? CUSTOMER_PREPAYMENTS : SUPPLIER_PREPAYMENTS;

    // Money received → Dr bank / Cr CUSTOMER_PREPAYMENTS (liability).
    // Money sent → Dr SUPPLIER_PREPAYMENTS (asset) / Cr bank.
    const lines = await this.buildBankAndPrepaymentLegs(transactionId, txn, {
      prepaymentAccountCode: accountCode,
      bankIsDebit: kind === 'customer',
    });

    const owner = await this.resolveOwner(kind, entityId, txn);

    const draft: DraftVoucher = {
      tax_point_date: txn.transaction_date,
      lines,
    };

    const prepared = await this.postingService.prepare(draft);
    const prepaymentLeg = lines[1];

    return this.db.transaction().execute(async (trx) => {
      const voucher = await this.postingService.postVoucherTx(
        trx,
        prepared.draft,
        prepared.resolved,
      );
      await this.allocations.insertAdvance(
        {
          voucherId: voucher.id,
          kind,
          accountCode,
          entityId: owner,
          bankTransactionId: transactionId,
          originalBaseAmount: prepaymentLeg.base_amount,
          currency: prepaymentLeg.currency,
          needsReview: false,
          origin: 'service',
        },
        trx,
      );
      await this.transactionRepo.updateStatus(transactionId, 'prepayment', trx);
      return voucher;
    });
  }

  /**
   * Resolve the counterparty that owns an advance: the caller's explicit
   * choice (validated against the entity's role), else the bank transaction's
   * own confirmed IBAN / merchant-descriptor identifiers. An ambiguous or
   * absent identifier yields null — an UNRESOLVED advance, never a guess.
   */
  private async resolveOwner(
    kind: AdvanceKind,
    entityId: number | undefined,
    txn: BankLineCounterparty,
  ): Promise<number | null> {
    if (entityId !== undefined) {
      const entity = await this.entitiesService.findById(entityId);
      this.assertRole(entity.role, kind, entityId);
      return entity.id;
    }
    return this.resolveBankLineOwner(kind, txn);
  }

  /**
   * The counterparty a bank line deterministically belongs to, or null when the
   * evidence is absent or ambiguous. Public because the settlement path needs
   * the SAME answer this service used at creation: a bank line whose owner is
   * unknown or ambiguous is never treated as a match for somebody's advance.
   */
  async resolveBankLineOwner(
    kind: AdvanceKind,
    txn: BankLineCounterparty,
  ): Promise<number | null> {
    const candidates: { kind: string; value: string }[] = [];
    if (txn.counterparty_iban) {
      candidates.push({ kind: 'iban', value: txn.counterparty_iban });
    }
    if (txn.counterparty_descriptor) {
      candidates.push({
        kind: 'merchant_descriptor',
        value: txn.counterparty_descriptor,
      });
    }
    if (candidates.length === 0) return null;

    // The SAME confirmed-identifier lookup the reconciliation engine uses to
    // name a bank line's counterparty (`iban` / `merchant_descriptor` are match
    // keys there, not in the registration-key/email/phone merge set).
    const expectedRole = kind === 'customer' ? 'customer' : 'supplier';
    const matching = new Set<number>();
    for (const candidate of candidates) {
      const entity = await this.entitiesService.resolveByIdentifier(
        candidate.kind,
        candidate.value,
      );
      if (entity && entity.role === expectedRole) matching.add(entity.id);
    }
    // Exactly one match is evidence; zero or several is not.
    return matching.size === 1 ? [...matching][0] : null;
  }

  private assertRole(role: string, kind: AdvanceKind, entityId: number): void {
    const expected = kind === 'customer' ? 'customer' : 'supplier';
    if (role !== expected) {
      throw new BadRequestException(
        `Entity ${entityId} has role '${role}' — a ${kind} prepayment requires a '${expected}'`,
      );
    }
  }

  // ── Draw-down ─────────────────────────────────────────────────────

  /**
   * Draw down a prepayment against an invoice — one ALLOCATION: this advance,
   * this invoice, this counterparty, this amount, evidenced by one posted
   * clearing voucher.
   *
   * For customer prepayments: Dr CUSTOMER_PREPAYMENTS / Cr AR
   * For supplier prepayments: Dr AP / Cr SUPPLIER_PREPAYMENTS
   *
   * The actual amount drawn is min(advance remaining, invoice remaining,
   * requested), and the allocation row is written in the SAME transaction as
   * the voucher, after RE-CHECKING both remaining balances on that connection
   * — so two concurrent (or repeated) draw-downs cannot overdraw the advance
   * or over-relieve the invoice.
   */
  async drawDownPrepayment(
    prepaymentVoucherId: number,
    invoiceVoucherId: number,
    amount: number,
  ): Promise<PostedVoucher> {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException(
        'Draw-down amount must be a positive whole number of minor units',
      );
    }

    // The advance — its owner, kind and remaining balance come from its own
    // record and its OWN allocations, never from a ledger-wide draw-down sum.
    const advance =
      await this.allocations.findAdvanceByVoucherId(prepaymentVoucherId);
    if (!advance) {
      throw new NotFoundException(
        `Prepayment voucher ${prepaymentVoucherId} not found (no advance record). ` +
          `Register its owner via POST /api/prepayments/${prepaymentVoucherId}/ownership before drawing it down.`,
      );
    }

    const isCustomer = advance.kind === 'customer';

    // Look up the invoice voucher and find its AR/AP line.
    const invoiceBalance = await this.getInvoiceBalance(invoiceVoucherId);
    if (!invoiceBalance) {
      throw new NotFoundException(
        `Invoice voucher ${invoiceVoucherId} not found`,
      );
    }

    // Validate that prepayment type matches invoice type.
    if (isCustomer && invoiceBalance.accountCode !== AR) {
      throw new BadRequestException(
        'Customer prepayment can only be drawn down against an AR invoice',
      );
    }
    if (!isCustomer && invoiceBalance.accountCode !== AP) {
      throw new BadRequestException(
        'Supplier prepayment can only be drawn down against an AP invoice',
      );
    }

    await this.assertAdvanceAllocatable(advance);

    // Same counterparty on both sides — an advance is a debt to ONE party.
    const invoiceEntityId = await this.resolveInvoiceCounterparty(
      invoiceVoucherId,
      advance.kind,
    );
    if (invoiceEntityId === null) {
      throw new BadRequestException(
        `Invoice voucher ${invoiceVoucherId} has no resolved counterparty — cannot verify it belongs to the same party as prepayment ${prepaymentVoucherId}`,
      );
    }
    if (invoiceEntityId !== advance.entityId) {
      throw new BadRequestException(
        `Cross-counterparty allocation refused: prepayment ${prepaymentVoucherId} belongs to entity ${advance.entityId}, invoice ${invoiceVoucherId} to entity ${invoiceEntityId}`,
      );
    }

    const advanceRemaining = await this.advanceRemaining(advance);
    if (advanceRemaining <= 0) {
      throw new BadRequestException(
        `Prepayment voucher ${prepaymentVoucherId} has no remaining balance`,
      );
    }
    if (invoiceBalance.remaining <= 0) {
      throw new BadRequestException(
        `Invoice voucher ${invoiceVoucherId} has no remaining balance`,
      );
    }

    // Clamp the draw-down amount.
    const drawAmount = Math.min(
      amount,
      advanceRemaining,
      invoiceBalance.remaining,
    );

    if (drawAmount <= 0) {
      throw new BadRequestException('No amount available to draw down');
    }

    // Relief is computed in BASE currency (D3-family). `drawAmount` is the min
    // of base-tracked remaining balances, so both legs are booked explicitly in
    // base currency at fx 1.0. This balances in base and relieves AR/AP and the
    // prepayment by the same base amount. Any residual invoice balance (because
    // the invoice was booked at a different rate than the prepayment was
    // received) correctly remains OPEN AR/AP, to be settled later by cash —
    // realized FX is recognised at that settlement, NOT here at draw-down.
    const currency = await this.currencyService.getBaseCurrency();
    const taxPointDate = new Date().toISOString().slice(0, 10);

    const reliefAccount = isCustomer
      ? CUSTOMER_PREPAYMENTS
      : SUPPLIER_PREPAYMENTS;
    const invoiceAccount = isCustomer ? AR : AP;

    const draft: DraftVoucher = {
      tax_point_date: taxPointDate,
      reason: `Draw-down of prepayment V-${prepaymentVoucherId} against invoice V-${invoiceVoucherId}`,
      lines: [
        {
          // Customer: Dr CUSTOMER_PREPAYMENTS / Cr AR.
          // Supplier: Dr AP / Cr SUPPLIER_PREPAYMENTS.
          account_code: isCustomer ? reliefAccount : invoiceAccount,
          amount: drawAmount,
          currency,
          base_amount: drawAmount,
          fx_rate: 1.0,
          is_debit: true,
        },
        {
          account_code: isCustomer ? invoiceAccount : reliefAccount,
          amount: drawAmount,
          currency,
          base_amount: drawAmount,
          fx_rate: 1.0,
          is_debit: false,
        },
      ],
    };

    const prepared = await this.postingService.prepare(draft);

    return this.db.transaction().execute(async (trx) => {
      // Re-check BOTH sides on this connection, so a concurrent or repeated
      // draw-down that raced past the clamp above cannot overdraw.
      // Re-read the reversal state on THIS connection: a reversal committed
      // between the checks above and here must not be drawn against.
      await this.assertAdvanceAllocatable(advance, trx);
      if (await this.allocations.isVoucherReversed(invoiceVoucherId, trx)) {
        throw new ConflictException(
          `Invoice voucher ${invoiceVoucherId} has been reversed`,
        );
      }

      const freshAdvanceRemaining = await this.advanceRemaining(advance, trx);
      if (drawAmount > freshAdvanceRemaining) {
        throw new ConflictException(
          `Prepayment voucher ${prepaymentVoucherId} has only ${freshAdvanceRemaining} remaining — cannot allocate ${drawAmount}`,
        );
      }
      const freshInvoiceRemaining = await this.invoiceRemaining(
        invoiceVoucherId,
        trx,
      );
      if (drawAmount > freshInvoiceRemaining) {
        throw new ConflictException(
          `Invoice voucher ${invoiceVoucherId} has only ${freshInvoiceRemaining} remaining — cannot allocate ${drawAmount}`,
        );
      }

      const voucher = await this.postingService.postVoucherTx(
        trx,
        prepared.draft,
        prepared.resolved,
      );
      await this.allocations.insertAllocation(
        {
          advanceId: advance.id,
          invoiceVoucherId,
          entityId: advance.entityId,
          baseAmount: drawAmount,
          currency,
          allocationVoucherId: voucher.id,
          origin: 'service',
        },
        trx,
      );
      return voucher;
    });
  }

  // ── Listing ───────────────────────────────────────────────────────

  /**
   * List prepayment vouchers with their remaining balances.
   *
   * Each row is one ADVANCE voucher (a draw-down voucher's own prepayment leg
   * is not an advance and never appears here). A row whose balance or owner
   * cannot be established is still listed — with a null balance and an
   * `unresolvedReason` — rather than silently reported as fully available.
   */
  async listOutstandingPrepayments(): Promise<PrepaymentBalance[]> {
    const rows = await this.advanceVoucherRows();

    const results: PrepaymentBalance[] = [];

    for (const row of rows) {
      const advance = await this.allocations.findAdvanceByVoucherId(
        row.voucher_id,
      );

      if (!advance) {
        results.push({
          advanceId: null,
          voucherId: row.voucher_id,
          accountCode: row.account_code,
          entityId: null,
          originalAmount: row.original_amount,
          drawnDown: null,
          remaining: null,
          currency: row.currency,
          taxPointDate: row.tax_point_date,
          allocatable: false,
          unresolvedReason: 'no_advance_record',
        });
        continue;
      }

      const base: Omit<
        PrepaymentBalance,
        'drawnDown' | 'remaining' | 'allocatable' | 'unresolvedReason'
      > = {
        advanceId: advance.id,
        voucherId: advance.voucherId,
        accountCode: advance.accountCode,
        entityId: advance.entityId,
        originalAmount: advance.originalBaseAmount,
        currency: advance.currency,
        taxPointDate: row.tax_point_date,
      };

      if (advance.needsReview) {
        results.push({
          ...base,
          drawnDown: null,
          remaining: null,
          allocatable: false,
          unresolvedReason: 'balance_unverified',
        });
        continue;
      }

      // A reversed advance voucher is cancelled credit: reported, never
      // re-offered.
      if (await this.allocations.isVoucherReversed(advance.voucherId)) {
        results.push({
          ...base,
          drawnDown: null,
          remaining: 0,
          allocatable: false,
          unresolvedReason: 'advance_reversed',
        });
        continue;
      }

      const remaining = await this.advanceRemaining(advance);
      const drawnDown = advance.originalBaseAmount - remaining;

      if (remaining <= 0 && advance.entityId !== null) continue;

      results.push({
        ...base,
        drawnDown,
        remaining,
        allocatable: advance.entityId !== null && remaining > 0,
        unresolvedReason:
          advance.entityId === null ? 'unknown_counterparty' : null,
      });
    }

    return results;
  }

  // ── Operator repair ───────────────────────────────────────────────

  /**
   * Resolve an advance an automatic path could not: assign its owner and,
   * where a historical draw-down was never linked, attribute those draw-down
   * VOUCHERS explicitly to their source advance and target invoice.
   *
   * This is the ONLY way an advance acquires an owner after the fact, and it is
   * one-way: an advance that already has one is never silently re-pointed at a
   * different counterparty. Every link is verified against the ledger, so a
   * repair can neither invent a draw-down nor free an invoice a draw-down
   * already relieved. It writes reconciliation records only — no posted voucher
   * is edited (ADR-0009: the ledger is corrected by counter-vouchers, never in
   * place).
   */
  async resolveAdvanceOwnership(
    prepaymentVoucherId: number,
    input: ResolveAdvanceInput,
  ): Promise<PrepaymentBalance> {
    const entity = await this.entitiesService.findById(input.entityId);
    const links = input.drawDowns ?? [];

    // Everything that can be read is read (and rejected) BEFORE the write
    // transaction opens — better-sqlite3 forbids a top-level read inside one —
    // and every figure that a concurrent writer could move is re-checked on the
    // transaction's own connection below.
    const existing =
      await this.allocations.findAdvanceByVoucherId(prepaymentVoucherId);
    const kind = await this.advanceKind(prepaymentVoucherId, existing);
    this.assertRole(entity.role, kind, entity.id);
    if (
      existing !== null &&
      existing.entityId !== null &&
      existing.entityId !== entity.id
    ) {
      throw new ConflictException(
        `Prepayment voucher ${prepaymentVoucherId} already belongs to entity ${existing.entityId}`,
      );
    }
    const prepared = await this.verifyDrawDownLinks(kind, entity.id, links);
    if (existing !== null) {
      await this.assertRecordedHistoryBelongsTo(existing, entity.id);
    }

    await this.db.transaction().execute(async (trx) => {
      const advance = await this.claimAdvance(
        prepaymentVoucherId,
        kind,
        entity.id,
        trx,
      );

      // Source cap: the advance's own canonical remaining, which already nets
      // active bank matches and active allocations. A link whose own voucher
      // was reversed is history, not consumption, so it costs nothing.
      let advanceRemaining =
        await this.outstandingVouchers.getRemainingPrepaymentBalance(
          advance.voucherId,
          trx,
        );
      // Target caps: one running remaining per invoice, from the same canonical
      // path — so a repair can never relieve an invoice twice.
      const invoiceRemaining = new Map<number, number>();

      for (const p of prepared) {
        // Re-check on THIS connection: another repair may have linked it since.
        const already = await this.allocations.findAllocationByVoucherId(
          p.allocationVoucherId,
          trx,
        );
        if (already) {
          throw new ConflictException(
            `Draw-down voucher ${p.allocationVoucherId} is already linked to an advance`,
          );
        }

        if (!p.released) {
          advanceRemaining -= p.baseAmount;
          if (advanceRemaining < 0) {
            throw new BadRequestException(
              `Linked draw-downs exceed the remaining balance of advance ${advance.voucherId}`,
            );
          }

          let target = invoiceRemaining.get(p.invoiceVoucherId);
          if (target === undefined) {
            target = await this.invoiceRemaining(p.invoiceVoucherId, trx);
          }
          target -= p.baseAmount;
          if (target < 0) {
            throw new BadRequestException(
              `Linked draw-down ${p.allocationVoucherId} exceeds the remaining balance of invoice ${p.invoiceVoucherId}`,
            );
          }
          invoiceRemaining.set(p.invoiceVoucherId, target);
        }

        await this.allocations.insertAllocation(
          {
            advanceId: advance.id,
            invoiceVoucherId: p.invoiceVoucherId,
            entityId: entity.id,
            baseAmount: p.baseAmount,
            currency: p.currency,
            allocationVoucherId: p.allocationVoucherId,
            origin: 'operator',
          },
          trx,
        );
      }

      await this.allocations.setAdvanceEntity(advance.id, entity.id, trx);
      await this.allocations.setAllocationEntityForAdvance(
        advance.id,
        entity.id,
        trx,
      );

      // The flag is about the KIND's unattributed history, so it lifts only
      // once no unlinked draw-down of that kind is left anywhere — never
      // because a total was typed in.
      const stillUnlinked = await this.allocations.listUnlinkedDrawDowns(
        kind,
        trx,
      );
      if (stillUnlinked.length === 0) {
        await this.allocations.clearNeedsReviewForKind(kind, trx);
      }
    });

    const resolved = await this.getPrepaymentBalance(prepaymentVoucherId);
    if (!resolved) {
      throw new NotFoundException(
        `Prepayment voucher ${prepaymentVoucherId} not found`,
      );
    }
    return resolved;
  }

  /** Which side an advance sits on, whether or not it is registered yet. */
  private async advanceKind(
    prepaymentVoucherId: number,
    existing: PrepaymentAdvance | null,
  ): Promise<AdvanceKind> {
    if (existing) return existing.kind;
    const row = await this.advanceVoucherRow(prepaymentVoucherId);
    if (!row) {
      throw new NotFoundException(
        `Voucher ${prepaymentVoucherId} is not a prepayment advance voucher`,
      );
    }
    return row.account_code === CUSTOMER_PREPAYMENTS ? 'customer' : 'supplier';
  }

  /**
   * Read the advance inside the repair transaction, registering it first if the
   * prepayment voucher was posted outside this service. Re-asserts ownership on
   * THIS connection, so two concurrent repairs cannot assign two owners: the
   * second sees the first's owner and is refused unless it names the same one.
   */
  private async claimAdvance(
    prepaymentVoucherId: number,
    kind: AdvanceKind,
    entityId: number,
    trx: Transaction<Database>,
  ): Promise<PrepaymentAdvance> {
    let advance = await this.allocations.findAdvanceByVoucherId(
      prepaymentVoucherId,
      trx,
    );

    if (!advance) {
      const row = await this.advanceVoucherRow(prepaymentVoucherId, trx);
      if (!row) {
        throw new NotFoundException(
          `Voucher ${prepaymentVoucherId} is not a prepayment advance voucher`,
        );
      }
      const unlinked = await this.allocations.listUnlinkedDrawDowns(kind, trx);
      const advanceId = await this.allocations.insertAdvance(
        {
          voucherId: prepaymentVoucherId,
          kind,
          accountCode: row.account_code,
          entityId: null,
          bankTransactionId: null,
          originalBaseAmount: row.original_amount,
          currency: row.currency,
          // A prepayment voucher this service never registered may already have
          // been drawn down by an unrecorded clearing voucher.
          needsReview: unlinked.length > 0,
          origin: 'operator',
        },
        trx,
      );
      advance = {
        id: advanceId,
        voucherId: prepaymentVoucherId,
        kind,
        accountCode: row.account_code,
        entityId: null,
        bankTransactionId: null,
        originalBaseAmount: row.original_amount,
        currency: row.currency,
        needsReview: unlinked.length > 0,
        origin: 'operator',
      };
    }

    if (advance.entityId !== null && advance.entityId !== entityId) {
      throw new ConflictException(
        `Prepayment voucher ${prepaymentVoucherId} already belongs to entity ${advance.entityId}`,
      );
    }
    return advance;
  }

  /**
   * One historical draw-down, verified against the ledger and ready to link.
   */
  private async verifyDrawDownLinks(
    kind: AdvanceKind,
    entityId: number,
    links: AdvanceDrawDownLink[],
  ): Promise<
    {
      allocationVoucherId: number;
      invoiceVoucherId: number;
      baseAmount: number;
      currency: string;
      released: boolean;
    }[]
  > {
    if (links.length === 0) return [];

    const unlinked = await this.allocations.listUnlinkedDrawDowns(kind);
    const byVoucher = new Map(unlinked.map((d) => [d.voucherId, d]));

    const seen = new Set<number>();
    const verified = [];

    for (const link of links) {
      if (seen.has(link.allocationVoucherId)) {
        throw new BadRequestException(
          `Draw-down voucher ${link.allocationVoucherId} listed twice`,
        );
      }
      seen.add(link.allocationVoucherId);

      const drawDown = byVoucher.get(link.allocationVoucherId);
      if (!drawDown) {
        throw new BadRequestException(
          `Voucher ${link.allocationVoucherId} is not an unlinked ${kind} draw-down voucher`,
        );
      }

      // It must relieve the invoice it is claimed against, on the right side.
      if (
        !(await this.clearingRelievesInvoice(kind, link, drawDown.baseAmount))
      ) {
        throw new BadRequestException(
          `Voucher ${link.allocationVoucherId} does not relieve invoice ${link.invoiceVoucherId} by ${drawDown.baseAmount}`,
        );
      }

      await this.assertInvoiceBelongsTo(link.invoiceVoucherId, kind, entityId);

      verified.push({
        allocationVoucherId: link.allocationVoucherId,
        invoiceVoucherId: link.invoiceVoucherId,
        baseAmount: drawDown.baseAmount,
        currency: drawDown.currency,
        released: await this.allocations.isVoucherReversed(
          link.allocationVoucherId,
        ),
      });
    }

    return verified;
  }

  /**
   * Every invoice this advance's ALREADY RECORDED allocations relieved must
   * belong to the counterparty about to be named as its owner. Backfilled
   * allocations carry no counterparty of their own, so assigning an owner is
   * also a claim about that history — a claim that must hold, or the repair is
   * refused rather than confirming a cross-counterparty draw-down.
   */
  private async assertRecordedHistoryBelongsTo(
    advance: PrepaymentAdvance,
    entityId: number,
  ): Promise<void> {
    const recorded = await this.allocations.listAllocationsForAdvance(
      advance.id,
    );
    for (const allocation of recorded) {
      await this.assertInvoiceBelongsTo(
        allocation.invoiceVoucherId,
        advance.kind,
        entityId,
      );
    }
  }

  private async assertInvoiceBelongsTo(
    invoiceVoucherId: number,
    kind: AdvanceKind,
    entityId: number,
  ): Promise<void> {
    const invoiceEntityId = await this.resolveInvoiceCounterparty(
      invoiceVoucherId,
      kind,
    );
    if (invoiceEntityId !== entityId) {
      throw new BadRequestException(
        `Invoice ${invoiceVoucherId} belongs to entity ${invoiceEntityId ?? 'unknown'}, not ${entityId}`,
      );
    }
  }

  /**
   * Does this clearing voucher actually relieve the named invoice's AR/AP side
   * by `amount`? Checked against the ledger, so a repair can never point a
   * draw-down at an invoice it never touched.
   */
  private async clearingRelievesInvoice(
    kind: AdvanceKind,
    link: AdvanceDrawDownLink,
    amount: number,
  ): Promise<boolean> {
    const relievedCode = kind === 'customer' ? AR : AP;
    // Customer: Dr CUSTOMER_PREPAYMENTS / Cr AR. Supplier: Dr AP / Cr SUPPLIER_PREPAYMENTS.
    const relievedIsDebit = kind === 'customer' ? 0 : 1;

    const relief = await this.db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select('voucher_line.base_amount as base_amount')
      .where('voucher_line.voucher_id', '=', link.allocationVoucherId)
      .where('account.code', '=', relievedCode)
      .where('voucher_line.is_debit', '=', relievedIsDebit)
      .executeTakeFirst();
    if (!relief || relief.base_amount !== amount) return false;

    // The invoice must carry that AR/AP leg in its OPENING direction.
    const invoiceLeg = await this.db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select('voucher_line.id')
      .where('voucher_line.voucher_id', '=', link.invoiceVoucherId)
      .where('account.code', '=', relievedCode)
      .where('voucher_line.is_debit', '=', relievedIsDebit === 1 ? 0 : 1)
      .executeTakeFirst();
    return invoiceLeg !== undefined;
  }

  /**
   * May this advance's credit be spent at all? The question every WRITE path
   * asks — a draw-down here, and a **ReconciliationMatch** activation in
   * {@link ReconciliationService} — separately from how MUCH is left. Hiding an
   * unsafe advance from candidate discovery is not enough: a stale draft match
   * or a direct API call reaches the write path without ever consulting the
   * candidate list.
   *
   * Registered, owned, balance-verified and not reversed. Arithmetic (the
   * remaining balance and its caps) is deliberately NOT folded in here, so the
   * operator repair path can still reason about amounts on an advance that is
   * not yet allocatable.
   */
  async assertAdvanceAllocatable(
    advance: PrepaymentAdvance,
    executor: Kysely<Database> | Transaction<Database> = this.db,
  ): Promise<void> {
    if (advance.needsReview) {
      throw new ConflictException(
        `Prepayment voucher ${advance.voucherId} has an unverified remaining balance ` +
          `(a historical draw-down could not be attributed to it). Resolve it via ` +
          `POST /api/prepayments/${advance.voucherId}/ownership first.`,
      );
    }
    if (advance.entityId === null) {
      throw new ConflictException(
        `Prepayment voucher ${advance.voucherId} has no resolved counterparty. ` +
          `Assign its owner via POST /api/prepayments/${advance.voucherId}/ownership first.`,
      );
    }
    if (await this.allocations.isVoucherReversed(advance.voucherId, executor)) {
      throw new ConflictException(
        `Prepayment voucher ${advance.voucherId} has been reversed — its credit no longer exists`,
      );
    }
  }

  /**
   * The advance a settlement is about to consume, refusing everything the
   * draw-down path refuses PLUS a counterparty the bank line does not support.
   * Called inside the settling transaction, so the state it checks is the state
   * that will be written against.
   */
  async assertAdvanceSettleableBy(
    advanceVoucherId: number,
    bankLineEntityId: number | null,
    executor: Kysely<Database> | Transaction<Database>,
  ): Promise<void> {
    const advance = await this.allocations.findAdvanceByVoucherId(
      advanceVoucherId,
      executor,
    );
    if (!advance) {
      throw new ConflictException(
        `Voucher ${advanceVoucherId} carries no prepayment advance record — it cannot be settled as a prepayment`,
      );
    }
    await this.assertAdvanceAllocatable(advance, executor);
    if (bankLineEntityId === null) {
      throw new ConflictException(
        `Bank line counterparty is unknown or ambiguous — it cannot settle prepayment voucher ${advanceVoucherId}`,
      );
    }
    if (bankLineEntityId !== advance.entityId) {
      throw new ConflictException(
        `Bank line belongs to entity ${bankLineEntityId}, prepayment voucher ${advanceVoucherId} to entity ${advance.entityId}`,
      );
    }
  }

  /** The kind of a registered advance, or null when it is not registered. */
  async findAdvanceKind(advanceVoucherId: number): Promise<AdvanceKind | null> {
    const advance =
      await this.allocations.findAdvanceByVoucherId(advanceVoucherId);
    return advance?.kind ?? null;
  }

  // ── Internal helpers ──────────────────────────────────────────────

  /**
   * The remaining balance of ONE advance, through the SAME canonical primitive
   * the reconciliation engine uses: its own prepayment net, minus what active
   * **ReconciliationMatch**es have settled against it, minus what its OWN
   * still-active allocations have consumed. Nothing another advance does can
   * move this number — the point of #201 — and a draw-down and a bank match
   * can never both spend the same credit.
   */
  private async advanceRemaining(
    advance: PrepaymentAdvance,
    executor: Kysely<Database> | Transaction<Database> = this.db,
  ): Promise<number> {
    return this.outstandingVouchers.getRemainingPrepaymentBalance(
      advance.voucherId,
      executor,
    );
  }

  /**
   * The remaining balance of a prepayment voucher, for callers that hold only
   * the voucher id. Null when the voucher carries no prepayment advance leg.
   */
  private async getPrepaymentBalance(
    voucherId: number,
  ): Promise<PrepaymentBalance | null> {
    const all = await this.listOutstandingPrepayments();
    const found = all.find((p) => p.voucherId === voucherId);
    if (found) return found;

    // Fully drawn advances are omitted from the outstanding list; report the
    // zero balance rather than nothing.
    const advance = await this.allocations.findAdvanceByVoucherId(voucherId);
    const row = await this.advanceVoucherRow(voucherId);
    if (!advance || !row) return null;
    const remaining = await this.advanceRemaining(advance);
    return {
      advanceId: advance.id,
      voucherId,
      accountCode: advance.accountCode,
      entityId: advance.entityId,
      originalAmount: advance.originalBaseAmount,
      drawnDown: advance.originalBaseAmount - remaining,
      remaining,
      currency: advance.currency,
      taxPointDate: row.tax_point_date,
      allocatable: false,
      unresolvedReason: null,
    };
  }

  /**
   * Get the remaining balance of an invoice voucher. The AR/AP line is read
   * here only to report WHICH side the invoice sits on; the number itself comes
   * from the canonical outstanding path.
   */
  private async getInvoiceBalance(voucherId: number): Promise<{
    accountCode: string;
    remaining: number;
  } | null> {
    const line = await this.db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select('account.code as account_code')
      .where('voucher_line.voucher_id', '=', voucherId)
      .where('account.code', 'in', [AR, AP])
      .executeTakeFirst();

    if (!line) return null;

    return {
      accountCode: line.account_code,
      remaining: await this.invoiceRemaining(voucherId),
    };
  }

  /**
   * The invoice's remaining outstanding, from the ONE canonical path
   * ({@link OutstandingVoucherService}) that already nets active reconciliation
   * matches AND active prepayment allocations. Subtracting allocations again
   * here would double-count them.
   */
  private invoiceRemaining(
    voucherId: number,
    executor: Kysely<Database> | Transaction<Database> = this.db,
  ): Promise<number> {
    return this.outstandingVouchers.getRemainingVoucherBalance(
      voucherId,
      executor,
    );
  }

  /** The counterparty an invoice voucher belongs to, via its business object. */
  private async resolveInvoiceCounterparty(
    voucherId: number,
    kind: AdvanceKind,
  ): Promise<number | null> {
    if (kind === 'customer') {
      const row = await this.db
        .selectFrom('sales_invoice')
        .select('customer_id')
        .where('voucher_id', '=', voucherId)
        .executeTakeFirst();
      return row?.customer_id ?? null;
    }
    const row = await this.db
      .selectFrom('expense')
      .select('supplier_id')
      .where('voucher_id', '=', voucherId)
      .executeTakeFirst();
    return row?.supplier_id ?? null;
  }

  /**
   * The prepayment ADVANCE vouchers in the ledger, NETTED per voucher.
   *
   * An advance voucher moves a prepayment account in its opening direction
   * (customer credit / supplier debit) and carries no AR/AP leg. A draw-down
   * voucher moves the same account the other way against AR/AP and is therefore
   * excluded — it consumes an advance, it is not one.
   *
   * The net is taken over ALL of a voucher's legs on that account, so a legal
   * multi-leg advance is ONE row carrying its full original amount — the same
   * grouping the backfill uses. Reading line by line would both duplicate the
   * advance in the listing and register only its first leg's amount.
   */
  private async advanceVoucherRows(
    executor: Kysely<Database> | Transaction<Database> = this.db,
    voucherId?: number,
  ): Promise<
    {
      voucher_id: number;
      account_code: string;
      original_amount: number;
      currency: string;
      tax_point_date: string;
    }[]
  > {
    let query = executor
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .innerJoin('voucher', 'voucher.id', 'voucher_line.voucher_id')
      .select('voucher_line.voucher_id as voucher_id')
      .select('account.code as account_code')
      .select('voucher.tax_point_date as tax_point_date')
      .select((eb) => eb.fn.min('voucher_line.currency').as('currency'))
      .select((eb) =>
        eb.fn
          .sum<number>(
            eb
              .case()
              .when('voucher_line.is_debit', '=', 1)
              .then(eb.ref('voucher_line.base_amount'))
              .else(eb.neg(eb.ref('voucher_line.base_amount')))
              .end(),
          )
          .as('net'),
      )
      .where('account.code', 'in', [CUSTOMER_PREPAYMENTS, SUPPLIER_PREPAYMENTS])
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('voucher_line as arap')
              .innerJoin(
                'account as araccount',
                'araccount.id',
                'arap.account_id',
              )
              .select('arap.id')
              .whereRef('arap.voucher_id', '=', 'voucher_line.voucher_id')
              .where('araccount.code', 'in', [AR, AP]),
          ),
        ),
      )
      .groupBy([
        'voucher_line.voucher_id',
        'account.code',
        'voucher.tax_point_date',
      ]);

    if (voucherId !== undefined) {
      query = query.where('voucher_line.voucher_id', '=', voucherId);
    }

    const rows = await query.execute();

    return rows
      .filter((r) =>
        r.account_code === CUSTOMER_PREPAYMENTS ? r.net < 0 : r.net > 0,
      )
      .map((r) => ({
        voucher_id: r.voucher_id,
        account_code: r.account_code,
        original_amount: Math.abs(r.net),
        currency: r.currency ?? '',
        tax_point_date: r.tax_point_date,
      }));
  }

  private async advanceVoucherRow(
    voucherId: number,
    executor: Kysely<Database> | Transaction<Database> = this.db,
  ) {
    const rows = await this.advanceVoucherRows(executor, voucherId);
    return rows[0];
  }
}
