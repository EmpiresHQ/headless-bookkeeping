import { Injectable } from '@nestjs/common';
import { OrganizationService } from '../../organization/organization.service';
import { PluginLoader } from '../../plugins/plugin-loader.service';
import { CurrencyService } from '../../currency/currency.service';
import {
  OrgContext,
  SupplierFacts,
} from '../../plugins/country-plugin.interface';
import { DraftVoucher, DraftVoucherLine } from '../voucher/types';
import { EconomicFacts, Direction } from './types';

/**
 * VoucherProjectionService — the single deep module that projects a business
 * object's economic facts into a balanced draft Voucher (ADR-0006: the business
 * object is the source of fact, the Voucher is its generated projection).
 *
 * It owns the orchestration that Expense and SalesInvoice used to copy-paste:
 *   1. resolve the Organization → country plugin,
 *   2. ask the plugin (the SOLE resolver, ADR-0002) for the Category → Account +
 *      VAT code mapping,
 *   3. resolve one uniform FX rate via {@link CurrencyService.toBase} and round
 *      every line through {@link CurrencyService.convertToBaseRounded}
 *      (ADR-0004 Wave-3 amendment), and
 *   4. emit the balanced double-entry lines.
 *
 * The projection does NOT embed mapping rules — it asks the plugin. Expense and
 * SalesInvoice differ ONLY in `direction` (purchase vs sale), which decides
 * which canonical accounts the net / VAT / gross legs hit and their debit/credit
 * sense. That difference is data here, not duplicated procedure.
 */
@Injectable()
export class VoucherProjectionService {
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly pluginLoader: PluginLoader,
    private readonly currencyService: CurrencyService,
  ) {}

  /**
   * Project the given economic facts into a balanced draft Voucher.
   *
   * The produced lines balance in base currency (debits == credits) — the
   * structural invariant (ADR-0005) — because every leg is converted at the
   * same uniform rate and the gross leg equals net + VAT by construction.
   */
  async project(
    facts: EconomicFacts,
    direction: Direction,
  ): Promise<DraftVoucher> {
    const org = await this.organizationService.getOrganization();
    const plugin = this.pluginLoader.resolve(org.country);

    const supplierFacts: SupplierFacts = {
      // The counterparty's real country drives cross-border treatment; absent a
      // supplier we fall back to the org's own country (a domestic transaction).
      country: facts.supplierCountry ?? org.country,
      goodsVsServices: facts.goodsVsServices ?? 'unknown',
      classificationMemory: [],
    };

    const orgContext: OrgContext = {
      country: org.country,
      vatRegistered: org.vat_registered,
      baseCurrency: org.base_currency,
    };

    const mapping = plugin.resolveCategoryMapping(
      facts.category,
      supplierFacts,
      orgContext,
    );

    const netAmount = facts.grossAmount - facts.vatAmount;
    // Single owner of currency→base conversion (ADR-0004): one uniform rate per
    // draft, sourced from the country plugin, rounded by the currency module.
    // We take the rate from the same place we book it.
    const { rate: fxRate } = await this.currencyService.toBase(
      netAmount,
      facts.currency,
      facts.taxPointDate,
    );
    // Round each leg to base-currency minor units via the active plugin's rule
    // (ADR-0002: rounding is a jurisdiction rule). The plugin is the same one
    // resolved above; CurrencyService owns the multiply, the plugin the round.
    const baseAmount = (amount: number) =>
      plugin.roundToBaseMinorUnits(
        this.currencyService.convertToBase(amount, facts.currency, fxRate),
      );

    // Cross-border treatment is a purchase-side concern (the supplier's VAT
    // territory). A reverse-charge acquisition (intra-EU service, or an imported
    // non-EU service under KMS §10) is self-assessed: we owe the supplier only
    // the net, and book equal-and-opposite output/input VAT legs at OUR rate.
    if (direction === 'purchase') {
      const cross = plugin.resolveCrossBorderTreatment(
        supplierFacts,
        orgContext,
        { vatCharged: facts.vatAmount > 0 },
      );
      if (cross.treatment === 'reverse_charge') {
        return {
          voucher_number: 'PENDING',
          tax_point_date: facts.taxPointDate,
          lines: this.reverseChargeLines(
            facts,
            mapping,
            cross.vatCode ?? mapping.vatCode,
            plugin.getVatRate(cross.vatCode ?? mapping.vatCode),
            fxRate,
            baseAmount,
          ),
        };
      }
    }

    const lines: DraftVoucherLine[] =
      direction === 'purchase'
        ? this.purchaseLines(facts, netAmount, mapping, fxRate, baseAmount)
        : this.saleLines(facts, netAmount, mapping, fxRate, baseAmount);

    return {
      voucher_number: 'PENDING',
      tax_point_date: facts.taxPointDate,
      lines,
    };
  }

  /**
   * Reverse-charge purchase legs (pöördmaksustamine). The foreign document
   * carries no reclaimable domestic VAT, so the whole gross is the taxable base
   * and the amount owed to the supplier. We self-assess VAT at OUR rate on that
   * base, booking it on BOTH sides — Cr VAT_PAYABLE (output, declared) and
   * Dr VAT_RECEIVABLE (input, deducted) — so the net cash effect is zero while
   * the supply still reaches the VAT return. The base + VAT legs all carry the
   * reverse-charge code so the VAT report can bucket the acquisition correctly.
   *
   *   Dr category(gross)        EE_REVERSE_CHARGE
   *   Dr VAT_RECEIVABLE(rcVat)  EE_REVERSE_CHARGE   (input — deducted)
   *   Cr AP(gross)              —
   *   Cr VAT_PAYABLE(rcVat)     EE_REVERSE_CHARGE   (output — self-assessed)
   */
  private reverseChargeLines(
    facts: EconomicFacts,
    mapping: { accountCode: string; vatCode: string },
    reverseChargeCode: string,
    rate: number,
    fxRate: number,
    baseAmount: (amount: number) => number,
  ): DraftVoucherLine[] {
    const base = facts.grossAmount;
    const rcVat = Math.round(base * rate);
    return [
      {
        account_code: mapping.accountCode,
        amount: base,
        currency: facts.currency,
        base_amount: baseAmount(base),
        fx_rate: fxRate,
        vat_code: reverseChargeCode,
        is_debit: true,
      },
      {
        account_code: 'VAT_RECEIVABLE',
        amount: rcVat,
        currency: facts.currency,
        base_amount: baseAmount(rcVat),
        fx_rate: fxRate,
        vat_code: reverseChargeCode,
        is_debit: true,
      },
      {
        account_code: 'AP',
        amount: base,
        currency: facts.currency,
        base_amount: baseAmount(base),
        fx_rate: fxRate,
        vat_code: null,
        is_debit: false,
      },
      {
        account_code: 'VAT_PAYABLE',
        amount: rcVat,
        currency: facts.currency,
        base_amount: baseAmount(rcVat),
        fx_rate: fxRate,
        vat_code: reverseChargeCode,
        is_debit: false,
      },
    ];
  }

  /**
   * Purchase legs (Expense): Dr category(net) [, Dr VAT_RECEIVABLE(vat)], Cr AP(gross).
   * The VAT leg is omitted when there is no VAT — matching today's behavior.
   */
  private purchaseLines(
    facts: EconomicFacts,
    netAmount: number,
    mapping: { accountCode: string; vatCode: string },
    fxRate: number,
    baseAmount: (amount: number) => number,
  ): DraftVoucherLine[] {
    return [
      {
        account_code: mapping.accountCode,
        amount: netAmount,
        currency: facts.currency,
        base_amount: baseAmount(netAmount),
        fx_rate: fxRate,
        vat_code: mapping.vatCode,
        is_debit: true,
      },
      ...(facts.vatAmount > 0
        ? [
            {
              account_code: 'VAT_RECEIVABLE',
              amount: facts.vatAmount,
              currency: facts.currency,
              base_amount: baseAmount(facts.vatAmount),
              fx_rate: fxRate,
              vat_code: mapping.vatCode,
              is_debit: true,
            },
          ]
        : []),
      {
        account_code: 'AP',
        amount: facts.grossAmount,
        currency: facts.currency,
        base_amount: baseAmount(facts.grossAmount),
        fx_rate: fxRate,
        vat_code: null,
        is_debit: false,
      },
    ];
  }

  /**
   * Sale legs (SalesInvoice): Dr AR(gross), Cr category(net), Cr VAT_PAYABLE(vat).
   * The VAT_PAYABLE leg is always present (the invoice draft never elides it).
   */
  private saleLines(
    facts: EconomicFacts,
    netAmount: number,
    mapping: { accountCode: string; vatCode: string },
    fxRate: number,
    baseAmount: (amount: number) => number,
  ): DraftVoucherLine[] {
    return [
      {
        account_code: 'AR',
        amount: facts.grossAmount,
        currency: facts.currency,
        base_amount: baseAmount(facts.grossAmount),
        fx_rate: fxRate,
        vat_code: null,
        is_debit: true,
      },
      {
        account_code: mapping.accountCode,
        amount: netAmount,
        currency: facts.currency,
        base_amount: baseAmount(netAmount),
        fx_rate: fxRate,
        vat_code: mapping.vatCode,
        is_debit: false,
      },
      {
        account_code: 'VAT_PAYABLE',
        amount: facts.vatAmount,
        currency: facts.currency,
        base_amount: baseAmount(facts.vatAmount),
        fx_rate: fxRate,
        vat_code: mapping.vatCode,
        is_debit: false,
      },
    ];
  }
}
