import { IDENTITY_RATE_SOURCE } from '../fx/fx-rate.types';
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
import type { OrganizationBasisRow } from '../organization/ledger-basis';
import { EntitiesService } from '../entities/entities.service';
import {
  DraftVoucher,
  DraftVoucherLine,
  PostedVoucher,
} from '../ledger/voucher/types';
import { OutstandingVoucherService } from './outstanding-voucher.service';
import {
  AdvanceTaxFacts,
  AdvanceTaxTreatment,
  PrepaymentAdvance,
  PrepaymentAllocationRepository,
} from './prepayment-allocation.repository';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { NULL_VAT_CODE } from '../ledger/posting/vat-constants';
import { UnresolvedVatTreatmentError } from '../plugins/vat-treatment.errors';

/** Accounts used for prepayment vouchers. */
const CUSTOMER_PREPAYMENTS = 'CUSTOMER_PREPAYMENTS';
const SUPPLIER_PREPAYMENTS = 'SUPPLIER_PREPAYMENTS';
const AR = 'AR';
const AP = 'AP';
/** Output VAT control — the advance's tax point declares into this (issue #213). */
const VAT_PAYABLE = 'VAT_PAYABLE';

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
 * - `unclassified_tax_treatment`: money arrived and nobody has said what it is
 *   (issue #213). It is recorded, but it is neither spent nor settled until it
 *   is classified: an unclassified receipt must not silently become an untaxed
 *   advance against a taxable supply.
 * - `vat_relief_unverified`: a counter-voucher in this advance's history
 *   mirrors it only partly, or was itself reversed, so how much of the
 *   declared advance VAT is still outstanding cannot be PROVED from the
 *   ledger. Held rather than guessed in either direction.
 */
export type PrepaymentUnresolvedReason =
  | 'no_advance_record'
  | 'unknown_counterparty'
  | 'balance_unverified'
  | 'advance_reversed'
  | 'unclassified_tax_treatment'
  | 'vat_relief_unverified';

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
  /** What the money IS, and the VAT it declared at its receipt (issue #213). */
  tax: AdvanceTaxFacts;
  /**
   * Advance VAT declared and not yet released, and the GROSS credit still
   * available (net remaining + that VAT). The gross is what a draw-down
   * relieves against an invoice; null whenever the net remaining is unknown.
   */
  remainingVat: number | null;
  remainingGross: number | null;
}

/**
 * The tax facts a caller states about an advance (issue #213). The treatment is
 * the operator's statement about what the money IS — never derived from
 * description text, and never defaulted to "not taxable".
 */
export interface AdvanceTaxInput {
  treatment: AdvanceTaxTreatment;
  /** Required for `taxable_supply`: the jurisdiction output VAT code. */
  vatCode?: string;
  /** Required for `taxable_supply`: WHICH supply this is an advance on. */
  supplyDescription?: string;
  /** The advance/pro-forma document number issued for this payment, if any. */
  advanceDocumentNumber?: string;
}

/** What an operator supplies to refund an advance (issue #213). */
export interface RefundAdvanceInput {
  bankTransactionId: number;
  /** The cancellation/credit document the fiscal relief is taken under. */
  creditReference: string;
  reason: string;
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
    private readonly periodLock: PeriodLockService,
  ) {}

  /**
   * Build the legs of a prepayment voucher: the bank leg, the prepayment leg,
   * and — for an advance on an identified taxable supply — the output VAT leg
   * the receipt itself declares (issue #213).
   *
   * The bank leg resolves the transaction's REAL bank account (via the
   * statement → account join) and carries the transaction's own currency,
   * converted to base currency via the country plugin's reference rate (D4,
   * 1.0 for same-currency). The prepayment and VAT legs are denominated in
   * base currency.
   *
   * The VAT is INSIDE the money received: a 124 EUR advance at 24% is a 100 EUR
   * liability to the customer and 24 EUR owed to the tax authority, computed at
   * the rate in force on the RECEIPT date and frozen there. The gross is split
   * once and the net is the remainder, so the two parts always sum back to the
   * cash exactly.
   *
   * Returns the lines in [bank, prepayment, (vat)] order plus the split, so the
   * caller records exactly what it posted.
   */
  private async buildAdvanceLegs(
    transactionId: number,
    txn: { amount: number; currency: string; transaction_date: string },
    opts: {
      prepaymentAccountCode: string;
      bankIsDebit: boolean;
      /** Set only for a taxable advance: the code its VAT is declared under. */
      vatCode?: string;
    },
  ): Promise<{
    lines: DraftVoucherLine[];
    prepaymentLeg: DraftVoucherLine;
    grossBase: number;
    netBase: number;
    vatBase: number;
    vatRatePermille: number | null;
    /** The measurement basis these amounts were converted under (issue #215). */
    basis: OrganizationBasisRow;
  }> {
    const absAmount = Math.abs(txn.amount);

    // Sampled FIRST, before any other read of the organisation (issue #215).
    // An advance off a bank transaction can be the ledger's very first voucher,
    // so the measurement window to guard starts here — and taking the earliest
    // sample is what makes the guard sound: the plugin, the rate and the
    // rounding are all resolved AFTER this point, so a settings edit that lands
    // anywhere in between leaves the stamp disagreeing with the row the posting
    // transaction reads, and the post is refused. Sampling it last would
    // instead record the NEW basis against amounts measured by the OLD plugin,
    // and the check would wave it through.
    const { baseCurrency, basis } = await this.currencyService.getLedgerBasis();

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
    // Resolved BEFORE the settling transaction opens: since #203 this is an
    // authoritative lookup that may reach the network, and better-sqlite3's
    // single synchronous connection forbids that inside an open transaction.
    const {
      rate: fxRate,
      rateDate,
      source: rateSource,
    } = await plugin.getReferenceRate(
      txn.currency,
      baseCurrency,
      txn.transaction_date,
    );
    const grossBase = Math.round(absAmount * fxRate);

    // The rate that governed the day the money arrived (KMS §11 lg 1 — the tax
    // point is the receipt), never today's. An advance paid under an earlier
    // standard rate keeps it when the supply is later made at a new one.
    const rate = opts.vatCode
      ? plugin.getVatRate(opts.vatCode, txn.transaction_date)
      : 0;
    const vatBase = opts.vatCode
      ? Math.round((grossBase * rate) / (1 + rate))
      : 0;
    const netBase = grossBase - vatBase;

    const bankLeg: DraftVoucherLine = {
      account_code: resolvedBankCode,
      amount: absAmount,
      currency: txn.currency,
      base_amount: grossBase,
      fx_rate: fxRate,
      fx_rate_date: rateDate,
      fx_rate_source: rateSource,
      is_debit: opts.bankIsDebit,
    };

    const prepaymentLeg: DraftVoucherLine = {
      account_code: opts.prepaymentAccountCode,
      amount: netBase,
      currency: baseCurrency,
      base_amount: netBase,
      // The prepayment leg is denominated in base currency: an identity
      // conversion, recorded as such so it is not read as unattributed.
      fx_rate: 1.0,
      fx_rate_date: txn.transaction_date,
      fx_rate_source: IDENTITY_RATE_SOURCE,
      // The taxable BASE of the advance turnover: this is the leg the KMD
      // reads for row 1, exactly as a sale reads its revenue leg.
      vat_code: opts.vatCode ?? null,
      is_debit: !opts.bankIsDebit,
    };

    const lines: DraftVoucherLine[] = [bankLeg, prepaymentLeg];
    // A zero-amount leg is forbidden by the voucher_line CHECK, so a 0% taxable
    // advance books no VAT leg — the same elision the sale path makes.
    if (vatBase > 0) {
      lines.push({
        account_code: VAT_PAYABLE,
        amount: vatBase,
        currency: baseCurrency,
        base_amount: vatBase,
        fx_rate: 1.0,
        fx_rate_date: txn.transaction_date,
        fx_rate_source: IDENTITY_RATE_SOURCE,
        vat_code: opts.vatCode ?? null,
        is_debit: !opts.bankIsDebit,
      });
    }

    return {
      lines,
      prepaymentLeg,
      grossBase,
      netBase,
      vatBase,
      vatRatePermille: opts.vatCode ? Math.round(rate * 1000) : null,
      basis,
    };
  }

  // ── Creation ──────────────────────────────────────────────────────

  /**
   * Create a prepayment from a bank transaction, dispatching based on amount sign.
   * Incoming (positive) → customer prepayment; outgoing (negative) → supplier prepayment.
   */
  async createPrepaymentFromTransaction(
    transactionId: number,
    entityId?: number,
    tax?: AdvanceTaxInput,
  ): Promise<PostedVoucher> {
    const txn = await this.transactionRepo.findById(transactionId);
    if (!txn) {
      throw new NotFoundException(
        `Bank transaction ${transactionId} not found`,
      );
    }
    if (txn.amount > 0) {
      return this.createCustomerPrepayment(transactionId, entityId, tax);
    }
    if (txn.amount < 0) {
      return this.createSupplierPrepayment(transactionId, entityId, tax);
    }
    throw new BadRequestException(
      `Transaction ${transactionId} has zero amount — cannot create prepayment`,
    );
  }

  /**
   * Create a customer prepayment from an unmatched incoming bank payment.
   *
   * What it posts depends on what the money IS (issue #213), which the caller
   * states and this service never infers:
   *
   *  - an advance on an identified TAXABLE supply — Dr {bank} gross /
   *    Cr CUSTOMER_PREPAYMENTS net / Cr VAT_PAYABLE vat, tax point = the
   *    receipt date, because EE VAT arises on the earlier of the supply and
   *    the payment for it (KMS §11 lg 1);
   *  - a non-taxable deposit — Dr {bank} / Cr CUSTOMER_PREPAYMENTS gross, a
   *    pure liability that declares nothing;
   *  - unclassified (the default when nothing is said) — the same gross
   *    posting, because the money really did arrive, but the advance is HELD:
   *    it cannot be drawn down or settled until somebody classifies it.
   *
   * The advance is registered with its owner + source bank provenance in the
   * SAME transaction as the post. The bank amount must be positive (incoming).
   */
  async createCustomerPrepayment(
    transactionId: number,
    entityId?: number,
    tax?: AdvanceTaxInput,
  ): Promise<PostedVoucher> {
    return this.createAdvance(transactionId, 'customer', entityId, tax);
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
    tax?: AdvanceTaxInput,
  ): Promise<PostedVoucher> {
    return this.createAdvance(transactionId, 'supplier', entityId, tax);
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
    tax?: AdvanceTaxInput,
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

    const treatment: AdvanceTaxTreatment = tax?.treatment ?? 'unresolved';
    const decided =
      treatment === 'taxable_supply'
        ? await this.assertTaxableAdvanceSupported(kind, tax, txn)
        : null;
    const vatCode = decided?.vatCode;

    // Money received → Dr bank / Cr CUSTOMER_PREPAYMENTS (liability), less the
    // output VAT the receipt itself declares when it pays for a taxable supply.
    // Money sent → Dr SUPPLIER_PREPAYMENTS (asset) / Cr bank.
    const built = await this.buildAdvanceLegs(transactionId, txn, {
      prepaymentAccountCode: accountCode,
      bankIsDebit: kind === 'customer',
      vatCode,
    });

    const owner = await this.resolveOwner(kind, entityId, txn);

    const draft: DraftVoucher = {
      tax_point_date: txn.transaction_date,
      measured_basis: built.basis,
      lines: built.lines,
    };

    const prepared = await this.postingService.prepare(draft);
    const prepaymentLeg = built.prepaymentLeg;

    const taxFacts: AdvanceTaxFacts = {
      treatment,
      vatCode: vatCode ?? null,
      vatRatePermille: built.vatRatePermille,
      grossBaseAmount: built.grossBase,
      vatBaseAmount: built.vatBase,
      supplyDescription: tax?.supplyDescription ?? null,
      advanceDocumentNumber: tax?.advanceDocumentNumber ?? null,
      // The advance tax point is the day the payment was received.
      advanceTaxPointDate: txn.transaction_date,
      supersededByAdvanceId: null,
    };

    return this.db.transaction().execute(async (trx) => {
      // The organisation's VAT facts were read before the FX lookup (which may
      // reach the network and cannot run inside the transaction). They are
      // re-asserted HERE, on the connection that writes: a registration kind
      // or a rate that changed in between must not be posted under the answer
      // this call started with.
      if (decided) {
        await this.assertPostedTaxPointUnchanged(kind, tax, txn, decided, trx);
      }
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
          tax: taxFacts,
        },
        trx,
      );
      // Claim the bank line conditionally, for the same reason the refund path
      // does: the FX and plugin lookups above run outside this transaction, so
      // another reconciliation may have consumed the line meanwhile. Losing
      // the claim rolls the whole creation back rather than booking the same
      // money twice.
      const claimed = await trx
        .updateTable('bank_transaction')
        .set({ status: 'prepayment' })
        .where('id', '=', transactionId)
        .where('status', '=', 'open')
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) === 0) {
        throw new ConflictException(
          `Bank transaction ${transactionId} is no longer open — it was consumed by another ` +
            `reconciliation while this prepayment was being prepared. Nothing was posted.`,
        );
      }
      return voucher;
    });
  }

  /**
   * Everything that must hold before an advance is declared as taxable
   * turnover, checked BEFORE anything is posted. Each refusal is a HOLD with
   * the missing fact named — never a guessed treatment.
   *
   * WHETHER a payment advances the tax point, and at what rate, is the
   * jurisdiction's question, so the country plugin answers it (ADR-0002): a
   * limited registration, an intra-Community supply, a 0% or specially-timed
   * code are all cases where an output VAT code exists and an advance still
   * declares nothing. The kernel only establishes the facts the plugin needs
   * and refuses what it will not support.
   *
   * Returns the validated VAT code and the rate the plugin decided, so the
   * caller can re-assert BOTH on the connection it posts with.
   */
  private async assertTaxableAdvanceSupported(
    kind: AdvanceKind,
    tax: AdvanceTaxInput | undefined,
    txn: { transaction_date: string },
    executor?: Kysely<Database>,
  ): Promise<{ vatCode: string; ratePermille: number }> {
    if (kind !== 'customer') {
      throw new BadRequestException(
        'A taxable advance is a SALES tax point. Money we PAY a supplier in ' +
          'advance declares no output VAT here; its input VAT follows the ' +
          "supplier's invoice and that entitlement decision (issue #211). " +
          'Leave it unclassified for review, or record it as a non-taxable ' +
          'deposit only if the facts really are a deposit.',
      );
    }

    const supply = tax?.supplyDescription?.trim();
    if (!supply) {
      throw new BadRequestException(
        "A taxable advance needs the supply it pays for: send 'supply_description'. " +
          'What the payment is FOR is the fact that makes it turnover; a bank ' +
          'narrative is not a tax classification.',
      );
    }

    const vatCode = tax?.vatCode;
    if (!vatCode) {
      throw new BadRequestException(
        "A taxable advance needs its VAT treatment: send 'vat_code' (e.g. the " +
          'domestic standard-rated output code). Nothing is inferred from the ' +
          'amount or the description.',
      );
    }

    const { organization, plugin, orgContext } =
      await this.orgContextResolver.resolve(executor);

    if (!plugin.getVATCodes().includes(vatCode)) {
      throw new BadRequestException(
        `VAT code '${vatCode}' is not a code of the ${organization.country} plugin.`,
      );
    }

    const decision = plugin.resolveAdvanceTaxPoint({
      vatCode,
      receiptDate: txn.transaction_date,
      orgContext,
    });
    if (!decision.supported) {
      // 422, like every other refusal to invent a VAT treatment (issue #209):
      // the facts are recorded and they do not support declaring turnover
      // here. Nothing is posted.
      throw new UnresolvedVatTreatmentError({
        code: decision.code,
        message: decision.message,
        missingFacts: [
          `vat_code=${vatCode}`,
          `receipt_date=${txn.transaction_date}`,
          `vat_registration_kind=${orgContext.vatRegistrationKind}`,
        ],
        howToResolve: decision.howToResolve,
      });
    }

    // The receipt is the tax point, so it must be in a period that can still
    // receive a posting. Refused up front, with the date named.
    await this.periodLock.assertPeriodOpen(txn.transaction_date, executor);

    return { vatCode: decision.vatCode, ratePermille: decision.ratePermille };
  }

  /**
   * Re-assert, on the writing connection, that the advance being posted is
   * still the advance that was validated: same support, same rate. A settings
   * change (or a rate era boundary crossed by a retry) between the first
   * resolution and the post must refuse, not silently post stale VAT.
   */
  private async assertPostedTaxPointUnchanged(
    kind: AdvanceKind,
    tax: AdvanceTaxInput | undefined,
    txn: { transaction_date: string },
    decided: { vatCode: string; ratePermille: number },
    trx: Transaction<Database>,
  ): Promise<void> {
    const now = await this.assertTaxableAdvanceSupported(kind, tax, txn, trx);
    if (
      now.vatCode !== decided.vatCode ||
      now.ratePermille !== decided.ratePermille
    ) {
      throw new ConflictException(
        `The VAT treatment of this advance changed while it was being posted: it was ` +
          `validated as ${decided.vatCode} at ${decided.ratePermille / 10}% and now resolves ` +
          `to ${now.vatCode} at ${now.ratePermille / 10}%. Nothing was posted — retry.`,
      );
    }
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

    // A taxable advance already put output VAT on a return; relieving it is a
    // fiscal act, so the invoice it is applied to must be one this kernel can
    // pair with it exactly (same code, same rate, an open period).
    const isTaxableAdvance =
      advance.tax.treatment === 'taxable_supply' &&
      advance.tax.vatBaseAmount > 0;
    const invoiceFacts = isTaxableAdvance
      ? await this.assertInvoiceRelievesAdvance(advance, invoiceVoucherId)
      : null;

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

    // What the advance still declares (issue #213): its net liability and the
    // output VAT its receipt already put on a return. A taxable advance is
    // drawn down GROSS — the receivable it relieves is gross — so both parts
    // move together and the declared VAT is released exactly once.
    const advanceRemaining = await this.advanceRemaining(advance);
    const vatRemaining = isTaxableAdvance
      ? await this.allocations.remainingAdvanceVat(advance)
      : 0;
    const grossRemaining = advanceRemaining + vatRemaining;
    if (grossRemaining <= 0) {
      throw new BadRequestException(
        `Prepayment voucher ${prepaymentVoucherId} has no remaining balance`,
      );
    }
    if (invoiceBalance.remaining <= 0) {
      throw new BadRequestException(
        `Invoice voucher ${invoiceVoucherId} has no remaining balance`,
      );
    }

    // Clamp the draw-down amount. For a taxable advance this is the GROSS
    // relief against the receivable; for everything else gross IS net, so the
    // clamp is the one it always was.
    const drawAmount = Math.min(
      amount,
      grossRemaining,
      invoiceBalance.remaining,
    );

    if (drawAmount <= 0) {
      throw new BadRequestException('No amount available to draw down');
    }

    // Split the gross into the liability it consumes and the declared VAT it
    // releases. The LAST slice takes the exact VAT that is left, so a sequence
    // of partial draw-downs sums back to the declared VAT to the cent instead
    // of drifting on rounding.
    const split = this.splitDrawDown(
      drawAmount,
      advanceRemaining,
      vatRemaining,
      advance,
    );

    // Relief is computed in BASE currency (D3-family). `drawAmount` is the min
    // of base-tracked remaining balances, so both legs are booked explicitly in
    // base currency at fx 1.0. This balances in base and relieves AR/AP and the
    // prepayment by the same base amount. Any residual invoice balance (because
    // the invoice was booked at a different rate than the prepayment was
    // received) correctly remains OPEN AR/AP, to be settled later by cash —
    // realized FX is recognised at that settlement, NOT here at draw-down.
    const currency = await this.currencyService.getBaseCurrency();
    // WHEN the relief belongs. For a taxable advance it is the tax point of the
    // SUPPLY it is being applied to — the invoice's own — so the invoice's
    // output VAT and the release of the advance's land in the SAME period
    // whenever the draw-down is keyed in. Dating it "today" would let a March
    // invoice declare 24 while the 24 the advance already declared came out in
    // April: the March return would double-declare and the April one would
    // carry relief for turnover it never saw. A draw-down whose invoice sits
    // in a locked period is refused above, never re-dated.
    //
    // A draw-down that moves no VAT is a pure balance-sheet reclassification;
    // it keeps the booking date it always had.
    const taxPointDate = isTaxableAdvance
      ? (invoiceFacts as { taxPointDate: string }).taxPointDate
      : new Date().toISOString().slice(0, 10);

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
          amount: split.net,
          currency,
          base_amount: split.net,
          fx_rate: 1.0,
          fx_rate_source: IDENTITY_RATE_SOURCE,
          // The taxable base coming back OUT of the advance turnover: the same
          // code the receipt declared it under, so KMD row 1 nets to the
          // invoice's own base and not to twice it.
          vat_code: advance.tax.vatCode,
          is_debit: true,
        },
        // The advance VAT released. Dr VAT_PAYABLE: what the receipt declared
        // is taken back now that the invoice declares the supply itself.
        ...(split.vat > 0
          ? [
              {
                account_code: VAT_PAYABLE,
                amount: split.vat,
                currency,
                base_amount: split.vat,
                fx_rate: 1.0,
                fx_rate_source: IDENTITY_RATE_SOURCE,
                vat_code: advance.tax.vatCode,
                is_debit: true,
              },
            ]
          : []),
        {
          account_code: isCustomer ? invoiceAccount : reliefAccount,
          amount: drawAmount,
          currency,
          base_amount: drawAmount,
          fx_rate: 1.0,
          fx_rate_source: IDENTITY_RATE_SOURCE,
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
      const freshVatRemaining = isTaxableAdvance
        ? await this.allocations.remainingAdvanceVat(advance, trx)
        : 0;
      if (split.net > freshAdvanceRemaining || split.vat > freshVatRemaining) {
        throw new ConflictException(
          `Prepayment voucher ${prepaymentVoucherId} has only ${freshAdvanceRemaining + freshVatRemaining} remaining — cannot allocate ${drawAmount}`,
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
          // The advance's liability consumed, and the advance VAT released
          // with it. Their SUM is what the receivable was relieved by.
          baseAmount: split.net,
          vatBaseAmount: split.vat,
          currency,
          allocationVoucherId: voucher.id,
          origin: 'service',
        },
        trx,
      );
      return voucher;
    });
  }

  /**
   * The invoice facts a taxable advance may be relieved against (issue #213),
   * or an explicit HOLD naming why this pairing is not supported.
   *
   * Two things must line up before declared VAT is taken back:
   *
   *  1. WHEN. The relief is dated at the INVOICE's tax point, so the period
   *     that declares the supply is the period that releases the advance's VAT.
   *     If that period is locked the draw-down is refused here — re-dating the
   *     relief into a later, open period would leave the filed period
   *     declaring the same turnover twice.
   *
   *  2. WHAT RATE. The advance is frozen at the rate in force when the money
   *     arrived; the invoice declares the supply at its own. When they differ
   *     — the 2025-07-01 22% → 24% change is the live example — the correct
   *     treatment is that the advance keeps 22% and only the remainder is
   *     taxed at 24% (EMTA rate-change guidance). Pairing a 22% release with a
   *     blanket-24% invoice would produce a wrong total in both boxes, so this
   *     kernel HOLDS the case instead of inventing an apportionment.
   */
  private async assertInvoiceRelievesAdvance(
    advance: PrepaymentAdvance,
    invoiceVoucherId: number,
  ): Promise<{ taxPointDate: string; vatCode: string }> {
    const invoice = await this.db
      .selectFrom('voucher')
      .select(['tax_point_date'])
      .where('id', '=', invoiceVoucherId)
      .executeTakeFirst();
    if (!invoice) {
      throw new NotFoundException(
        `Invoice voucher ${invoiceVoucherId} not found`,
      );
    }

    const codeRows = await this.db
      .selectFrom('voucher_line')
      .select('vat_code')
      .distinct()
      .where('voucher_id', '=', invoiceVoucherId)
      .where('vat_code', 'is not', null)
      .where('vat_code', '!=', NULL_VAT_CODE)
      .execute();
    const codes = [...new Set(codeRows.map((r) => r.vat_code as string))];

    if (codes.length !== 1) {
      throw new BadRequestException(
        `Advance ${advance.voucherId} declared VAT under '${advance.tax.vatCode}' at its ` +
          `receipt, and invoice ${invoiceVoucherId} carries ` +
          `${codes.length === 0 ? 'no VAT treatment' : `several VAT treatments (${codes.join(', ')})`}. ` +
          `Relieving an advance against a mixed or untaxed invoice is not supported: the share ` +
          `of the advance belonging to each treatment is not recorded anywhere. Issue the ` +
          `invoice so that the advanced supply is its own document, then draw down against it.`,
      );
    }

    const invoiceCode = codes[0];
    if (invoiceCode !== advance.tax.vatCode) {
      throw new BadRequestException(
        `Advance ${advance.voucherId} declared VAT under '${advance.tax.vatCode}' and invoice ` +
          `${invoiceVoucherId} declares '${invoiceCode}'. The advance's own treatment is what ` +
          `was filed; it is not re-treated at invoicing. Correct whichever document states the ` +
          `wrong treatment, then draw down.`,
      );
    }

    const { plugin } = await this.orgContextResolver.resolve();
    const invoiceRatePermille = Math.round(
      plugin.getVatRate(invoiceCode, invoice.tax_point_date) * 1000,
    );
    if (invoiceRatePermille !== advance.tax.vatRatePermille) {
      throw new BadRequestException(
        `Advance ${advance.voucherId} was taxed at ` +
          `${(advance.tax.vatRatePermille ?? 0) / 10}% (the rate in force on ` +
          `${advance.tax.advanceTaxPointDate}), and invoice ${invoiceVoucherId} is taxed at ` +
          `${invoiceRatePermille / 10}% on ${invoice.tax_point_date}. The advance keeps its own ` +
          `rate and only the remainder of the supply takes the new one; this kernel does not ` +
          `apportion an invoice across a rate change, so the draw-down is held. Issue the final ` +
          `invoice showing the advance at ${(advance.tax.vatRatePermille ?? 0) / 10}% and the ` +
          `remainder at ${invoiceRatePermille / 10}%, as separate documents, then draw down ` +
          `against the matching one.`,
      );
    }

    // The relief is dated at the invoice's tax point, so that period must
    // still accept a posting. Refused here, by name, rather than as a generic
    // posting error deep inside the transaction.
    const locked = await this.periodLock.findLockedPeriod(
      invoice.tax_point_date,
    );
    if (locked) {
      throw new ConflictException(
        `Invoice ${invoiceVoucherId} has tax point ${invoice.tax_point_date}, which falls in ` +
          `locked period "${locked.name}". The advance's declared VAT must be released in the ` +
          `SAME period that declares the supply, and a filed period cannot be moved, so this ` +
          `draw-down is refused rather than dated into an open period it does not belong to. ` +
          `Correct it through the statutory correction route for that period ` +
          `(POST /api/sales-invoices/{id}/correct), which redirects the replacement into the ` +
          `current period with both legs together.`,
      );
    }

    return { taxPointDate: invoice.tax_point_date, vatCode: invoiceCode };
  }

  /**
   * Split one gross draw-down into the advance liability it consumes and the
   * declared advance VAT it releases (issue #213).
   *
   * The proportion is the advance's OWN frozen rate, not today's: VAT inside a
   * gross amount at rate r is `gross × r / (1 + r)`. The final slice — the one
   * that exhausts the advance — takes exactly the VAT that is left rather than
   * a recomputed share, so a sequence of partial draw-downs releases the
   * declared VAT to the cent. Every result is clamped to what actually
   * remains on each side.
   */
  private splitDrawDown(
    gross: number,
    netRemaining: number,
    vatRemaining: number,
    advance: PrepaymentAdvance,
  ): { net: number; vat: number } {
    if (vatRemaining <= 0) return { net: gross, vat: 0 };

    // Exhausting the advance: the remainder IS the split, by construction.
    if (gross >= netRemaining + vatRemaining) {
      return { net: netRemaining, vat: vatRemaining };
    }

    const rate = (advance.tax.vatRatePermille ?? 0) / 1000;
    let vat = Math.min(
      vatRemaining,
      rate > 0 ? Math.round((gross * rate) / (1 + rate)) : 0,
    );
    let net = gross - vat;
    if (net > netRemaining) {
      net = netRemaining;
      vat = gross - net;
    }
    return { net, vat };
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
          // Nothing is registered, so nothing is known about what it was for.
          tax: unclassifiedTaxFacts(row.original_amount),
          remainingVat: null,
          remainingGross: null,
        });
        continue;
      }

      const remainingVat = await this.allocations.remainingAdvanceVat(advance);
      const base: Omit<
        PrepaymentBalance,
        | 'drawnDown'
        | 'remaining'
        | 'allocatable'
        | 'unresolvedReason'
        | 'remainingGross'
      > = {
        advanceId: advance.id,
        voucherId: advance.voucherId,
        accountCode: advance.accountCode,
        entityId: advance.entityId,
        originalAmount: advance.originalBaseAmount,
        currency: advance.currency,
        taxPointDate: row.tax_point_date,
        tax: advance.tax,
        remainingVat,
      };

      if (advance.needsReview) {
        results.push({
          ...base,
          drawnDown: null,
          remaining: null,
          remainingGross: null,
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
          remainingGross: 0,
          allocatable: false,
          unresolvedReason: 'advance_reversed',
        });
        continue;
      }

      const remaining = await this.advanceRemaining(advance);
      const drawnDown = advance.originalBaseAmount - remaining;
      // A taxable advance is spent GROSS: its remaining credit is the
      // liability left plus the declared VAT still attached to it.
      const remainingGross = remaining + remainingVat;

      if (remainingGross <= 0 && advance.entityId !== null) continue;

      // Why this advance cannot be spent, in the order an operator must fix
      // them: an owner first, then what the money IS, then anything whose
      // reversal cannot be proved (issue #213).
      const unproven =
        await this.allocations.listUnprovenReversalChains(advance);
      const unresolvedReason: PrepaymentUnresolvedReason | null =
        advance.entityId === null
          ? 'unknown_counterparty'
          : advance.kind === 'customer' &&
              advance.tax.treatment === 'unresolved'
            ? 'unclassified_tax_treatment'
            : unproven.length > 0
              ? 'vat_relief_unverified'
              : null;

      results.push({
        ...base,
        drawnDown,
        remaining,
        remainingGross,
        allocatable: unresolvedReason === null && remainingGross > 0,
        unresolvedReason,
      });
    }

    return results;
  }

  // ── Tax classification (issue #213) ───────────────────────────────

  /**
   * The VAT treatments an advance may be DECLARED under here, as this
   * jurisdiction's plugin defines them (ADR-0002). The list is asked for a
   * DATE, because the rate in force is part of the answer: a receipt in the
   * 22% era offers 22%.
   *
   * It exists so a client can offer the real choice instead of hard-coding a
   * country's codes — and so a code the plugin will not support at an advance
   * tax point never appears as an option.
   */
  async listAdvanceVatTreatments(
    receiptDate: string,
  ): Promise<{ vatCode: string; ratePermille: number }[]> {
    const { plugin, orgContext } = await this.orgContextResolver.resolve();
    const supported: { vatCode: string; ratePermille: number }[] = [];
    for (const vatCode of plugin.getVATCodes()) {
      const decision = plugin.resolveAdvanceTaxPoint({
        vatCode,
        receiptDate,
        orgContext,
      });
      if (decision.supported) {
        supported.push({
          vatCode: decision.vatCode,
          ratePermille: decision.ratePermille,
        });
      }
    }
    return supported.sort((a, b) => b.ratePermille - a.ratePermille);
  }

  /**
   * Say what a recorded receipt IS, after the fact: an advance on an
   * identified taxable supply, or a non-taxable deposit.
   *
   * This is the route for money that arrived unclassified — including every
   * prepayment posted before #213, which is held rather than assumed
   * non-taxable. It is also the ONLY route: an advance that already carries a
   * treatment is never silently re-treated, because the first answer may
   * already be on a filed return.
   *
   * To `non_taxable_deposit` nothing is posted: the gross liability the books
   * already carry IS that treatment, now said out loud.
   *
   * To `taxable_supply` the ledger must change — the receipt declared no VAT
   * and it should have. No posted voucher is edited (ADR-0009): the gross
   * advance voucher is REVERSED and a VAT-bearing advance is posted in its
   * place at the same receipt tax point, both inside one transaction. The old
   * advance record stays, pointing at its replacement. This is refused when
   * anything has already consumed the advance (its history would have to be
   * re-pointed) or when the receipt's period is locked (a filed return cannot
   * be moved — that is the statutory correction route, not this one).
   */
  async classifyAdvance(
    prepaymentVoucherId: number,
    tax: AdvanceTaxInput,
  ): Promise<PrepaymentBalance> {
    const advance =
      await this.allocations.findAdvanceByVoucherId(prepaymentVoucherId);
    if (!advance) {
      throw new NotFoundException(
        `Prepayment voucher ${prepaymentVoucherId} not found (no advance record). ` +
          `Register it via POST /api/prepayments/${prepaymentVoucherId}/ownership first.`,
      );
    }
    if (tax.treatment === 'unresolved') {
      throw new BadRequestException(
        "A classification says what the money IS: 'taxable_supply' or " +
          "'non_taxable_deposit'. An advance cannot be un-classified back to " +
          "'unresolved'.",
      );
    }
    if (advance.tax.treatment !== 'unresolved') {
      throw new ConflictException(
        `Prepayment voucher ${prepaymentVoucherId} is already classified as ` +
          `'${advance.tax.treatment}'. A treatment may already be on a filed return, so it is ` +
          `not re-stated here: correct the receipt through the correction route instead.`,
      );
    }

    if (tax.treatment === 'non_taxable_deposit') {
      // Claimed, not written over: the row must still be unclassified and
      // unsuperseded at the moment of the write, and only the fields this
      // classification states are set. A concurrent taxable reclassification
      // therefore cannot be undone by a stale copy of the row.
      const claimed = await this.db.transaction().execute((trx) =>
        this.allocations.claimAsDeposit(
          advance.id,
          {
            supplyDescription: tax.supplyDescription?.trim() ?? null,
            documentNumber: tax.advanceDocumentNumber ?? null,
          },
          trx,
        ),
      );
      if (!claimed) {
        throw new ConflictException(
          `Prepayment voucher ${prepaymentVoucherId} was classified by another request while ` +
            `this one was being handled. Nothing was changed — read it back and decide again.`,
        );
      }
      return this.requireBalance(prepaymentVoucherId);
    }

    return this.reclassifyAsTaxable(advance, tax);
  }

  /**
   * Reclassify a held receipt as taxable turnover: reverse the gross advance
   * and repost it split into net liability + output VAT, at the SAME tax point
   * the money arrived on.
   */
  private async reclassifyAsTaxable(
    advance: PrepaymentAdvance,
    tax: AdvanceTaxInput,
  ): Promise<PrepaymentBalance> {
    if (advance.bankTransactionId === null) {
      throw new BadRequestException(
        `Prepayment voucher ${advance.voucherId} records no source bank transaction, so the ` +
          `receipt date and the bank account its VAT split must be posted against cannot be ` +
          `established. Nothing is invented: post the corrected advance through the bank line ` +
          `it arrived on.`,
      );
    }

    const txn = await this.transactionRepo.findById(advance.bankTransactionId);
    if (!txn) {
      throw new NotFoundException(
        `Bank transaction ${advance.bankTransactionId} not found`,
      );
    }

    // Anything already taken out of this advance was taken out of a GROSS
    // liability. Re-pointing that history at a different, VAT-split advance is
    // not a reclassification — it is a rewrite of what was booked.
    const consumed =
      advance.tax.grossBaseAmount - (await this.advanceRemaining(advance));
    if (consumed !== 0) {
      throw new ConflictException(
        `Prepayment voucher ${advance.voucherId} has already been drawn down or settled ` +
          `(${consumed} of ${advance.tax.grossBaseAmount} used). Reclassifying it would have to ` +
          `rewrite that history. Reverse the allocations first, or correct the documents that ` +
          `consumed it.`,
      );
    }
    if (await this.allocations.isVoucherReversed(advance.voucherId)) {
      throw new ConflictException(
        `Prepayment voucher ${advance.voucherId} has been reversed — there is nothing left to ` +
          `classify.`,
      );
    }

    const decided = await this.assertTaxableAdvanceSupported(
      advance.kind,
      tax,
      txn,
    );
    const vatCode = decided.vatCode;

    // The replacement, built exactly as a taxable advance created on the day.
    const built = await this.buildAdvanceLegs(advance.bankTransactionId, txn, {
      prepaymentAccountCode: advance.accountCode,
      bankIsDebit: advance.kind === 'customer',
      vatCode,
    });

    const originalLines = await this.db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select([
        'account.code as account_code',
        'voucher_line.amount as amount',
        'voucher_line.currency as currency',
        'voucher_line.base_amount as base_amount',
        'voucher_line.fx_rate as fx_rate',
        'voucher_line.fx_rate_date as fx_rate_date',
        'voucher_line.fx_rate_source as fx_rate_source',
        'voucher_line.vat_code as vat_code',
        'voucher_line.is_debit as is_debit',
      ])
      .where('voucher_line.voucher_id', '=', advance.voucherId)
      .orderBy('voucher_line.id')
      .execute();

    const reversalDraft: DraftVoucher = {
      tax_point_date: txn.transaction_date,
      reason:
        `Reclassification of advance V-${advance.voucherId} as a taxable supply ` +
        `(issue #213): the receipt is the tax point`,
      reverses_id: advance.voucherId,
      lines: originalLines.map((l) => ({
        account_code: l.account_code,
        amount: l.amount,
        currency: l.currency,
        base_amount: l.base_amount,
        fx_rate: l.fx_rate,
        fx_rate_date: l.fx_rate_date,
        fx_rate_source: l.fx_rate_source,
        vat_code: l.vat_code === NULL_VAT_CODE ? null : l.vat_code,
        is_debit: l.is_debit !== 1,
      })),
    };

    const replacementDraft: DraftVoucher = {
      tax_point_date: txn.transaction_date,
      reason:
        `Advance on ${tax.supplyDescription?.trim()} — taxable at ${vatCode}, ` +
        `replacing V-${advance.voucherId}`,
      lines: built.lines,
    };

    const preparedReversal = await this.postingService.prepare(reversalDraft);
    const preparedReplacement =
      await this.postingService.prepare(replacementDraft);

    const taxFacts: AdvanceTaxFacts = {
      treatment: 'taxable_supply',
      vatCode,
      vatRatePermille: built.vatRatePermille,
      grossBaseAmount: built.grossBase,
      vatBaseAmount: built.vatBase,
      supplyDescription: tax.supplyDescription?.trim() ?? null,
      advanceDocumentNumber: tax.advanceDocumentNumber ?? null,
      advanceTaxPointDate: txn.transaction_date,
      supersededByAdvanceId: null,
    };

    const replacementVoucherId = await this.db
      .transaction()
      .execute(async (trx) => {
        // Same re-assertion as creation: the treatment must still hold on the
        // connection that writes it (issue #213).
        await this.assertPostedTaxPointUnchanged(
          advance.kind,
          tax,
          txn,
          decided,
          trx,
        );

        // Re-read the ADVANCE itself here too, and fail fast: its
        // classification, its owner and what has been taken out of it are all
        // read before this transaction opened, and every one of them can move.
        const fresh = await this.allocations.findAdvanceByVoucherId(
          advance.voucherId,
          trx,
        );
        if (
          !fresh ||
          fresh.tax.treatment !== 'unresolved' ||
          fresh.tax.supersededByAdvanceId !== null
        ) {
          throw new ConflictException(
            `Prepayment voucher ${advance.voucherId} was classified by another request while ` +
              `this one was being handled. Nothing was posted.`,
          );
        }
        if (await this.allocations.isVoucherReversed(advance.voucherId, trx)) {
          throw new ConflictException(
            `Prepayment voucher ${advance.voucherId} was reversed while this reclassification ` +
              `was being prepared. Nothing was posted.`,
          );
        }
        const freshRemaining = await this.advanceRemaining(fresh, trx);
        if (freshRemaining !== fresh.tax.grossBaseAmount) {
          throw new ConflictException(
            `Prepayment voucher ${advance.voucherId} was drawn down or settled while this ` +
              `reclassification was being prepared. Nothing was posted.`,
          );
        }

        const reversal = await this.postingService.postVoucherTx(
          trx,
          preparedReversal.draft,
          preparedReversal.resolved,
        );
        const replacement = await this.postingService.postVoucherTx(
          trx,
          preparedReplacement.draft,
          preparedReplacement.resolved,
        );
        const newAdvanceId = await this.allocations.insertAdvance(
          {
            voucherId: replacement.id,
            kind: advance.kind,
            accountCode: advance.accountCode,
            entityId: advance.entityId,
            bankTransactionId: advance.bankTransactionId,
            originalBaseAmount: built.prepaymentLeg.base_amount,
            currency: built.prepaymentLeg.currency,
            needsReview: advance.needsReview,
            origin: 'operator',
            tax: taxFacts,
          },
          trx,
        );
        // The superseded record keeps saying what the books said, and points at
        // what replaced it. `reversal` is evidence in the ledger, not a flag.
        //
        // This is also the CLAIM: it sets one column, conditionally on the row
        // still being unclassified and unsuperseded. Losing it means another
        // classification won, and throwing here rolls back BOTH postings — so
        // two concurrent reclassifications can never leave two reversals, two
        // replacement advances, or a supersession pointer overwritten by the
        // loser.
        const claimed = await this.allocations.claimSupersededBy(
          advance.id,
          newAdvanceId,
          trx,
        );
        if (!claimed) {
          throw new ConflictException(
            `Prepayment voucher ${advance.voucherId} was classified by another request while ` +
              `this one was posting. Nothing was posted.`,
          );
        }
        void reversal;
        return replacement.id;
      });

    // The advance that now stands: the VAT-bearing one, by its own id.
    return this.requireBalance(replacementVoucherId);
  }

  /**
   * Record the advance invoice number a receipt was documented under
   * (issue #213).
   *
   * Estonia expects that document within 7 calendar days of the payment, and
   * KMD INF part A reports the advance under its number — a filing is blocked
   * while a reportable advance has none. Classification is a decision and is
   * made once; this is the record of a document that exists, so it can be
   * supplied afterwards. It fills an EMPTY number only: a number already
   * recorded may be on a filed return, and replacing it is a correction, not
   * a data entry.
   */
  async recordAdvanceDocumentNumber(
    prepaymentVoucherId: number,
    documentNumber: string,
  ): Promise<PrepaymentBalance> {
    const number = documentNumber?.trim();
    if (!number) {
      throw new BadRequestException(
        "Send the advance invoice number as 'advance_document_number'.",
      );
    }

    const advance =
      await this.allocations.findAdvanceByVoucherId(prepaymentVoucherId);
    if (!advance) {
      throw new NotFoundException(
        `Prepayment voucher ${prepaymentVoucherId} not found (no advance record)`,
      );
    }
    if (advance.tax.advanceDocumentNumber === number) {
      return this.requireBalance(prepaymentVoucherId);
    }
    if (advance.tax.advanceDocumentNumber !== null) {
      throw new ConflictException(
        `Prepayment voucher ${prepaymentVoucherId} is already documented as ` +
          `'${advance.tax.advanceDocumentNumber}'. That number may already be on a filed ` +
          `return, so it is not replaced here — issue a credit for the wrong document instead.`,
      );
    }

    const claimed = await this.db
      .transaction()
      .execute((trx) =>
        this.allocations.claimAdvanceDocumentNumber(advance.id, number, trx),
      );
    if (!claimed) {
      throw new ConflictException(
        `Prepayment voucher ${prepaymentVoucherId} was documented by another request while ` +
          `this one was being handled.`,
      );
    }
    return this.requireBalance(prepaymentVoucherId);
  }

  // ── Refund (issue #213) ───────────────────────────────────────────

  /**
   * Give a customer advance back, and take its declared VAT back with it.
   *
   * Posts Dr CUSTOMER_PREPAYMENTS (net) / Dr VAT_PAYABLE (the share of the
   * declared VAT being returned) / Cr {bank} (gross), dated on the day the
   * money actually left. EMTA's adjustment rules key a cancellation or credit
   * to the period of that document, which is this one — a filed period is
   * never reopened.
   *
   * The fiscal relief is not taken on a bank line alone: the cancellation /
   * credit document is named and recorded, the outgoing line must belong to
   * the advance's OWN customer (an unidentifiable or unrelated payment is
   * refused, not booked as this customer's refund), and the refund is
   * idempotent per bank transaction, so a retry cannot relieve the VAT twice.
   */
  async refundAdvance(
    prepaymentVoucherId: number,
    input: RefundAdvanceInput,
  ): Promise<PostedVoucher> {
    const creditReference = input.creditReference?.trim();
    const reason = input.reason?.trim();
    if (!creditReference) {
      throw new BadRequestException(
        "A refund needs the document its fiscal relief is taken under: send 'credit_reference' " +
          '(the cancellation / credit document given to the customer). Declared VAT is not ' +
          'reversed on a bank movement alone.',
      );
    }
    if (!reason) {
      throw new BadRequestException("A refund needs a 'reason'.");
    }

    const advance =
      await this.allocations.findAdvanceByVoucherId(prepaymentVoucherId);
    if (!advance) {
      throw new NotFoundException(
        `Prepayment voucher ${prepaymentVoucherId} not found (no advance record)`,
      );
    }
    if (advance.kind !== 'customer') {
      throw new BadRequestException(
        `Prepayment voucher ${prepaymentVoucherId} is a supplier advance; money coming BACK ` +
          `from a supplier is not a customer refund.`,
      );
    }
    await this.assertAdvanceAllocatable(advance);

    const existing = await this.allocations.findRefundByBankTransaction(
      input.bankTransactionId,
    );
    if (existing) {
      throw new ConflictException(
        `Bank transaction ${input.bankTransactionId} is already recorded as refund voucher ` +
          `V-${existing.voucherId} of advance ${existing.advanceId}.`,
      );
    }

    const txn = await this.transactionRepo.findById(input.bankTransactionId);
    if (!txn) {
      throw new NotFoundException(
        `Bank transaction ${input.bankTransactionId} not found`,
      );
    }
    if (txn.status !== 'open') {
      throw new BadRequestException(
        `Transaction ${input.bankTransactionId} is not open (status: ${txn.status})`,
      );
    }
    if (txn.amount >= 0) {
      throw new BadRequestException(
        `A refund is money LEAVING: transaction ${input.bankTransactionId} has amount ${txn.amount}.`,
      );
    }

    // WHOSE money went out. The same deterministic identification the advance
    // itself was owned by — an unrelated payment cannot be booked as this
    // customer's refund just because the amount fits.
    const payeeId = await this.resolveBankLineOwner('customer', txn);
    if (payeeId === null) {
      throw new BadRequestException(
        `Bank transaction ${input.bankTransactionId} has no deterministically identified ` +
          `counterparty, so it cannot be shown to be a refund to the customer that holds ` +
          `advance ${prepaymentVoucherId}.`,
      );
    }
    if (payeeId !== advance.entityId) {
      throw new BadRequestException(
        `Bank transaction ${input.bankTransactionId} pays entity ${payeeId}; advance ` +
          `${prepaymentVoucherId} belongs to entity ${advance.entityId}. Refusing to book an ` +
          `unrelated payment as this customer's refund.`,
      );
    }

    // A foreign-currency refund is NOT supported, and it is refused here
    // rather than approximated. The advance's liability and its declared VAT
    // are carried in base currency at the rate of the day the money arrived.
    // Paying the same foreign amount back on a different day converts to a
    // different base amount: at a lower rate it would leave a phantom
    // remainder of advance and VAT behind, at a higher one it would look like
    // an over-refund and be rejected. Neither is an FX result — declared VAT
    // must never move with an exchange difference — and recognising the real
    // FX difference belongs to the settlement path, which this refund does not
    // go through.
    const baseCurrency = await this.currencyService.getBaseCurrency();
    if (txn.currency !== baseCurrency) {
      throw new BadRequestException(
        `Transaction ${input.bankTransactionId} is in ${txn.currency}; advance ` +
          `${prepaymentVoucherId} carries its liability and its declared VAT in ${baseCurrency}. ` +
          `Refunding across currencies would make the VAT released depend on the exchange ` +
          `rate, which it must not. Refund in ${baseCurrency}, or settle the advance through ` +
          `the invoice it belongs to.`,
      );
    }

    const netRemaining = await this.advanceRemaining(advance);
    const vatRemaining = await this.allocations.remainingAdvanceVat(advance);
    const grossRemaining = netRemaining + vatRemaining;
    if (grossRemaining <= 0) {
      throw new BadRequestException(
        `Prepayment voucher ${prepaymentVoucherId} has nothing left to refund`,
      );
    }

    const built = await this.buildAdvanceLegs(input.bankTransactionId, txn, {
      prepaymentAccountCode: advance.accountCode,
      // Money leaving: Cr bank, Dr the prepayment liability.
      bankIsDebit: false,
    });
    const refundGross = built.grossBase;
    if (refundGross > grossRemaining) {
      throw new BadRequestException(
        `Transaction ${input.bankTransactionId} pays back ${refundGross}, but advance ` +
          `${prepaymentVoucherId} has only ${grossRemaining} left. A refund never exceeds what ` +
          `is still held.`,
      );
    }

    const split = this.splitDrawDown(
      refundGross,
      netRemaining,
      vatRemaining,
      advance,
    );

    const currency = built.prepaymentLeg.currency;
    const draft: DraftVoucher = {
      tax_point_date: txn.transaction_date,
      reason: `Refund of advance V-${prepaymentVoucherId} under ${creditReference}: ${reason}`,
      lines: [
        {
          account_code: advance.accountCode,
          amount: split.net,
          currency,
          base_amount: split.net,
          fx_rate: 1.0,
          fx_rate_date: txn.transaction_date,
          fx_rate_source: IDENTITY_RATE_SOURCE,
          // The advance turnover coming back out of the return, under the code
          // that declared it.
          vat_code: advance.tax.vatCode,
          is_debit: true,
        },
        ...(split.vat > 0
          ? [
              {
                account_code: VAT_PAYABLE,
                amount: split.vat,
                currency,
                base_amount: split.vat,
                fx_rate: 1.0,
                fx_rate_date: txn.transaction_date,
                fx_rate_source: IDENTITY_RATE_SOURCE,
                vat_code: advance.tax.vatCode,
                is_debit: true,
              },
            ]
          : []),
        // The real money, in the currency it actually left in.
        { ...built.lines[0], is_debit: false },
      ],
    };

    const prepared = await this.postingService.prepare(draft);

    return this.db.transaction().execute(async (trx) => {
      // Re-check on THIS connection: a concurrent draw-down or refund must not
      // let the two together take out more than is held.
      const freshNet = await this.advanceRemaining(advance, trx);
      const freshVat = await this.allocations.remainingAdvanceVat(advance, trx);
      if (split.net > freshNet || split.vat > freshVat) {
        throw new ConflictException(
          `Prepayment voucher ${prepaymentVoucherId} has only ${freshNet + freshVat} left — ` +
            `cannot refund ${refundGross}`,
        );
      }
      if (
        await this.allocations.findRefundByBankTransaction(
          input.bankTransactionId,
          trx,
        )
      ) {
        throw new ConflictException(
          `Bank transaction ${input.bankTransactionId} has already been refunded`,
        );
      }

      // CLAIM the bank line on this connection, conditionally on it still
      // being open. The FX and plugin lookups above run outside the
      // transaction, and ordinary reconciliation can consume the same outgoing
      // line while they do; an unconditional status write would then book the
      // same money out twice. The claim is the same open→used flip the
      // reconciliation path makes, and losing it refuses instead of posting.
      const claimed = await trx
        .updateTable('bank_transaction')
        .set({ status: 'prepayment' })
        .where('id', '=', input.bankTransactionId)
        .where('status', '=', 'open')
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) === 0) {
        throw new ConflictException(
          `Bank transaction ${input.bankTransactionId} is no longer open — it was consumed by ` +
            `another reconciliation while this refund was being prepared. Nothing was posted.`,
        );
      }

      const voucher = await this.postingService.postVoucherTx(
        trx,
        prepared.draft,
        prepared.resolved,
      );
      await this.allocations.insertRefund(
        {
          advanceId: advance.id,
          voucherId: voucher.id,
          bankTransactionId: input.bankTransactionId,
          netBaseAmount: split.net,
          vatBaseAmount: split.vat,
          currency,
          creditReference,
          reason,
          refundDate: txn.transaction_date,
        },
        trx,
      );
      return voucher;
    });
  }

  /** The balance of one advance, or a NotFound naming the voucher. */
  private async requireBalance(voucherId: number): Promise<PrepaymentBalance> {
    const balance = await this.getPrepaymentBalance(voucherId);
    if (!balance) {
      throw new NotFoundException(`Prepayment voucher ${voucherId} not found`);
    }
    return balance;
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
          // A voucher posted outside this service says nothing about what the
          // money was for, so it is registered UNCLASSIFIED (issue #213) —
          // held until somebody states its treatment.
          tax: unclassifiedTaxFacts(row.original_amount),
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
        tax: unclassifiedTaxFacts(row.original_amount),
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
    // Money a CUSTOMER sent that nobody has classified is HELD (issue #213).
    // Spending it would decide, silently, that it was never taxable turnover —
    // the very omission this path used to make. The hold is an OUTPUT-VAT
    // question and therefore customer-only: an advance we PAY a supplier
    // declares no output VAT at all, and its input VAT follows the supplier's
    // invoice and the entitlement decision made there (issue #211), so a
    // supplier advance needs no tax classification to be usable.
    if (advance.kind === 'customer' && advance.tax.treatment === 'unresolved') {
      throw new ConflictException(
        `Prepayment voucher ${advance.voucherId} has no tax treatment: nobody has said ` +
          `whether it is an advance on a taxable supply (its receipt is then the tax point, ` +
          `KMS §11 lg 1) or a non-taxable deposit. Classify it via ` +
          `POST /api/prepayments/${advance.voucherId}/tax-treatment before it is used.`,
      );
    }
    // A counter-voucher that mirrors only part of this advance's history — or
    // a reversal that was itself reversed — leaves the declared VAT
    // unprovable. Held, in both directions, rather than guessed.
    const unproven = await this.allocations.listUnprovenReversalChains(
      advance,
      executor,
    );
    if (unproven.length > 0) {
      throw new ConflictException(
        `Prepayment voucher ${advance.voucherId} has voucher(s) ${unproven.join(', ')} whose ` +
          `reversal cannot be proved complete from the ledger, so how much of its declared VAT ` +
          `is still outstanding is unknown. Resolve those vouchers (a counter-voucher must ` +
          `mirror what it reverses) before this advance is used again.`,
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
    // A prepayment MATCH posts no voucher: it just spends the advance's credit
    // against a bank line. For a taxable advance that would consume the
    // liability while the output VAT the receipt declared stayed on the books
    // with nothing left to relieve it — so the fiscal paths are explicit ones.
    if (
      advance.tax.treatment === 'taxable_supply' &&
      advance.tax.vatBaseAmount > 0
    ) {
      throw new ConflictException(
        `Prepayment voucher ${advanceVoucherId} declared ${advance.tax.vatBaseAmount} of output ` +
          `VAT at its receipt. A bank match posts nothing, so it cannot release that VAT. ` +
          `Apply the advance to its invoice (POST /api/prepayments/${advanceVoucherId}/draw-down) ` +
          `or refund it (POST /api/prepayments/${advanceVoucherId}/refund), both of which move ` +
          `the VAT with the money.`,
      );
    }
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
    const remainingVat = await this.allocations.remainingAdvanceVat(advance);
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
      tax: advance.tax,
      remainingVat,
      remainingGross: remaining + remainingVat,
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

/**
 * The tax facts of an advance nobody has classified (issue #213): its gross is
 * whatever the ledger carries, it declared nothing, and it is HELD.
 */
function unclassifiedTaxFacts(grossBaseAmount: number): AdvanceTaxFacts {
  return {
    treatment: 'unresolved',
    vatCode: null,
    vatRatePermille: null,
    grossBaseAmount,
    vatBaseAmount: 0,
    supplyDescription: null,
    advanceDocumentNumber: null,
    advanceTaxPointDate: null,
    supersededByAdvanceId: null,
  };
}
