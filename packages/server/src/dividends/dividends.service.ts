import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { PostingService } from '../ledger/posting/posting.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { CurrencyService } from '../currency/currency.service';
import { BankTransactionRepository } from '../bank/bank-transaction.repository';
import { DraftVoucher } from '../ledger/voucher/types';
import {
  DividendDeclarationDto,
  DividendDeclarationResult,
  DividendSettlementResult,
} from './types';

/** Account codes for dividend distribution. */
const RETAINED_EARNINGS = 'RETAINED_EARNINGS';
const DIVIDEND_PAYABLE = 'DIVIDEND_PAYABLE';
const DIVIDEND_WITHHOLDING_TAX_PAYABLE = 'DIVIDEND_WITHHOLDING_TAX_PAYABLE';

@Injectable()
export class DividendsService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly postingService: PostingService,
    private readonly orgContextResolver: OrgContextResolver,
    private readonly currencyService: CurrencyService,
    private readonly transactionRepo: BankTransactionRepository,
    private readonly ledgerBalance: LedgerBalanceService,
  ) {}

  /**
   * Declare a dividend distribution.
   *
   * Posts a declaration voucher through the full pipeline (Rules → Policy → post):
   *   Dr RETAINED_EARNINGS              (gross + distribution tax, total equity hit)
   *   Cr DIVIDEND_PAYABLE               (net to owner, after withholding)
   *   Cr DIVIDEND_WITHHOLDING_TAX_PAYABLE  (withheld portion, if any)
   *   Cr DISTRIBUTION_TAX_PAYABLE       (company-level on-top tax, if any — e.g. EE CIT 22/78)
   *
   * The fourth line (DISTRIBUTION_TAX_PAYABLE) is only booked when the country
   * plugin returns a non-null distribution tax via `resolveDistributionTax`.
   * In that case the RETAINED_EARNINGS debit equals gross + distTaxAmount (not
   * just gross), so the voucher balances across all four lines.
   * For jurisdictions without a distribution tax (IE, Null) the three-line
   * schema is unchanged.
   *
   * The country plugin resolves:
   * - Withholding rate (dividendWithholdingRate)
   * - Company-level distribution tax on top (resolveDistributionTax)
   * - Distributable-profits check (assertDistributable)
   *
   * Per ADR-0023: dividend is an equity distribution, NOT a P&L expense.
   * Per ADR-0002: withholding, distribution tax, and profits-cap are country-plugin rules only.
   * Per ADR-0027: distribution tax is distinct from withholding — it is paid by the
   *   company on top; the shareholder receives the full declared amount.
   *
   * @param dto - Declaration input (gross amount, tax-point date, optional reason)
   * @returns The posted declaration voucher + breakdown
   */
  async declare(
    dto: DividendDeclarationDto,
  ): Promise<DividendDeclarationResult> {
    if (dto.gross_amount <= 0) {
      throw new BadRequestException('gross_amount must be positive');
    }

    // Resolve the country plugin + org for this org (e.g. EE → EstoniaCountryPlugin).
    const { organization: org, plugin } =
      await this.orgContextResolver.resolve();

    // The declaration voucher books equity accounts entirely in base currency
    // (amounts are base-currency cents), so the OrgContext here carries the
    // *effective* base currency (override ?? plugin default) the voucher lines
    // are denominated in — not the raw nullable org.base_currency override. The
    // country plugin only reads orgContext.country here, so this value is inert
    // for its decisions but kept consistent with the voucher's currency.
    const baseCurrency = await this.currencyService.getBaseCurrency();
    const orgContext = {
      country: org.country,
      vatRegistered: !!org.vat_registered,
      baseCurrency,
    };

    // ── Distributable-profits check (plugin-driven) ──────────────────
    // The kernel computes the *live* distributable figure (RETAINED_EARNINGS +
    // current net income − prior distributions); the plugin owns only the cap
    // rule. v1 has no year-end close, so the bare RE balance is meaningless.
    const distributableProfits = await this.getDistributableProfits();
    const distributable = plugin.assertDistributable(
      dto.gross_amount,
      distributableProfits,
      orgContext,
    );
    if (!distributable) {
      throw new BadRequestException(
        `Dividend of ${dto.gross_amount} cents exceeds distributable profits ` +
          `(${distributableProfits} cents)`,
      );
    }

    // ── Withholding rate (plugin-driven) ─────────────────────────────
    const withholdingRate = plugin.dividendWithholdingRate(orgContext);
    const withholdingAmount = Math.round(dto.gross_amount * withholdingRate);
    const netPayable = dto.gross_amount - withholdingAmount;

    // ── Company-level distribution tax on top (plugin-driven) ────────
    // Distinct from withholding: this is a tax paid BY the company on top of the
    // dividend (e.g. Estonia CIT 22/78 of net). Returns null for IE/Null/DK.
    const distTax = plugin.resolveDistributionTax(netPayable, orgContext);
    const distTaxAmount = distTax?.amount ?? 0;
    // The retained-earnings debit equals the total equity hit: gross + on-top tax.
    const retainedDebit = dto.gross_amount + distTaxAmount;

    // ── Build declaration voucher lines (all in base currency) ───────
    const lines: DraftVoucher['lines'] = [
      // Dr RETAINED_EARNINGS (gross + distTax)
      {
        account_code: RETAINED_EARNINGS,
        amount: retainedDebit,
        currency: baseCurrency,
        base_amount: retainedDebit,
        fx_rate: 1.0,
        is_debit: true,
      },
      // Cr DIVIDEND_PAYABLE (net to owner)
      {
        account_code: DIVIDEND_PAYABLE,
        amount: netPayable,
        currency: baseCurrency,
        base_amount: netPayable,
        fx_rate: 1.0,
        is_debit: false,
      },
    ];

    // If withholding applies, add the withholding tax payable line.
    if (withholdingAmount > 0) {
      lines.push({
        account_code: DIVIDEND_WITHHOLDING_TAX_PAYABLE,
        amount: withholdingAmount,
        currency: baseCurrency,
        base_amount: withholdingAmount,
        fx_rate: 1.0,
        is_debit: false,
      });
    }

    // If company-level distribution tax applies, add its payable line.
    if (distTax && distTaxAmount > 0) {
      lines.push({
        account_code: distTax.accountCode,
        amount: distTaxAmount,
        currency: baseCurrency,
        base_amount: distTaxAmount,
        fx_rate: 1.0,
        is_debit: false,
      });
    }

    const draft: DraftVoucher = {
      tax_point_date: dto.tax_point_date,
      reason: dto.reason ?? `Dividend declaration: ${dto.gross_amount} cents`,
      lines,
    };

    const voucher = await this.postingService.postVoucher(draft);

    return {
      voucher_id: voucher.id,
      gross_amount: dto.gross_amount,
      net_payable: netPayable,
      withholding_amount: withholdingAmount,
    };
  }

  /**
   * Settle a dividend against a bank transaction.
   *
   * Posts a settlement voucher through the pipeline:
   *   Dr DIVIDEND_PAYABLE  (amount of bank outflow)
   *   Cr BANK_EUR          (same amount)
   *
   * Then creates an N:M reconciliation_match linking the bank transaction
   * to the declaration voucher, so the payable is drawn down.
   *
   * The bank transaction must have status 'dividend' (reserved in Wave 5).
   *
   * @param bankTransactionId - The bank transaction to settle against
   * @param declarationVoucherId - The declaration voucher to draw down
   * @returns Settlement result with voucher + reconciliation match
   */
  async settle(
    bankTransactionId: number,
    declarationVoucherId: number,
  ): Promise<DividendSettlementResult> {
    // 1. Look up bank transaction.
    const txn = await this.transactionRepo.findById(bankTransactionId);
    if (!txn) {
      throw new NotFoundException(
        `Bank transaction ${bankTransactionId} not found`,
      );
    }

    // 2. Validate status is 'dividend'.
    if (txn.status !== 'dividend') {
      throw new BadRequestException(
        `Transaction ${bankTransactionId} is not a dividend (status: ${txn.status})`,
      );
    }

    // 3. Validate the declaration voucher exists.
    const declarationVoucher = await this.db
      .selectFrom('voucher')
      .select('id')
      .where('id', '=', declarationVoucherId)
      .executeTakeFirst();
    if (!declarationVoucher) {
      throw new NotFoundException(
        `Declaration voucher ${declarationVoucherId} not found`,
      );
    }

    // 4. Idempotency: a dividend bank line settles exactly once. If it already
    // carries a reconciliation match, refuse to double-post the settlement.
    const existingMatch = await this.db
      .selectFrom('reconciliation_match')
      .select('id')
      .where('bank_transaction_id', '=', bankTransactionId)
      .executeTakeFirst();
    if (existingMatch) {
      throw new BadRequestException(
        `Bank transaction ${bankTransactionId} is already settled (match ${existingMatch.id})`,
      );
    }

    // 5. Resolve the REAL bank account from the transaction's statement and
    // convert the outflow to base currency (mirrors the Wave-5 reconciliation
    // services — never assume the bank line is already in base currency).
    const bankAccount = await this.db
      .selectFrom('bank_transaction')
      .innerJoin(
        'bank_statement',
        'bank_statement.id',
        'bank_transaction.statement_id',
      )
      .innerJoin('account', 'account.id', 'bank_statement.account_id')
      .select('account.code as account_code')
      .where('bank_transaction.id', '=', bankTransactionId)
      .executeTakeFirstOrThrow();
    const resolvedBankCode = bankAccount.account_code;

    const absAmount = Math.abs(txn.amount);
    // CurrencyService owns base-currency resolution, the same-currency
    // short-circuit, the plugin reference-rate fetch, and the cents rounding
    // (ADR-0004). We book the bank leg at the same rate it returns.
    const {
      baseCurrency,
      rate: fxRate,
      baseAmount,
    } = await this.currencyService.toBase(
      absAmount,
      txn.currency,
      txn.transaction_date,
    );

    // 6. Post settlement voucher: Dr DIVIDEND_PAYABLE (base) / Cr {bank} (txn ccy).
    const draft: DraftVoucher = {
      tax_point_date: txn.transaction_date,
      reason: `Dividend settlement for declaration voucher ${declarationVoucherId}`,
      lines: [
        {
          account_code: DIVIDEND_PAYABLE,
          amount: baseAmount,
          currency: baseCurrency,
          base_amount: baseAmount,
          fx_rate: 1.0,
          is_debit: true,
        },
        {
          account_code: resolvedBankCode,
          amount: absAmount,
          currency: txn.currency,
          base_amount: baseAmount,
          fx_rate: fxRate,
          is_debit: false,
        },
      ],
    };

    const prepared = await this.postingService.prepare(draft);

    return this.db.transaction().execute(async (trx) => {
      const voucher = await this.postingService.postVoucherTx(
        trx,
        prepared.draft,
        prepared.resolved,
      );

      const now = Math.floor(Date.now() / 1000);
      const match = await this.insertSettlementMatchTx(trx, {
        bankTransactionId,
        declarationVoucherId,
        baseAmount,
        createdAt: now,
      });

      return {
        voucher_id: voucher.id,
        reconciliation_match_id: match.id,
        amount_settled: baseAmount,
      };
    });
  }

  private async insertSettlementMatchTx(
    trx: Kysely<Database>,
    input: {
      bankTransactionId: number;
      declarationVoucherId: number;
      baseAmount: number;
      createdAt: number;
    },
  ): Promise<{ id: number }> {
    const [match] = await trx
      .insertInto('reconciliation_match')
      .values({
        bank_transaction_id: input.bankTransactionId,
        voucher_id: input.declarationVoucherId,
        match_type: 'exact',
        amount_matched: input.baseAmount,
        created_at: input.createdAt,
      })
      .returning('id')
      .execute();
    return match;
  }

  /**
   * Live distributable profits in base-currency cents (ADR-0023, amended).
   *
   * v1 has no year-end close, so net income is never swept into RETAINED_EARNINGS.
   * Distributable = RETAINED_EARNINGS balance + current net income
   * (ΣRevenue − ΣExpense), all measured credit-positive. Prior dividend
   * declarations already debited RETAINED_EARNINGS, so they are reflected.
   */
  private getDistributableProfits(): Promise<number> {
    // RETAINED_EARNINGS (equity, by code) + current net income across all
    // revenue/expense accounts (by type), measured credit-positive — equity and
    // revenue are credit-normal, so a profit is positive and a loss negative.
    // The signed-sum convention is owned by LedgerBalanceService.
    return this.ledgerBalance.getLedgerNet(
      { codes: [RETAINED_EARNINGS], types: ['revenue', 'expense'] },
      { creditPositive: true },
    );
  }
}
