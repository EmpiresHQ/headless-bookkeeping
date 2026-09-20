import { BadRequestException, Injectable } from '@nestjs/common';
import { OrgContextResolver } from '../../organization/org-context.resolver';
import { CurrencyService } from '../../currency/currency.service';
import {
  SupplierFacts,
  SupplyFacts,
} from '../../plugins/country-plugin.interface';
import { DraftVoucher, DraftVoucherLine } from '../voucher/types';
import { EconomicFacts, Direction } from './types';
import type {
  CountryPlugin,
  CrossBorderTreatment,
  OrgContext,
} from '../../plugins/country-plugin.interface';
import type { InputVatEntitlement } from '../../plugins/input-vat-entitlement.types';
import {
  NO_ENTITLEMENT,
  assertValidEntitlement,
  splitInputVat,
} from '../../plugins/input-vat-entitlement.types';
import { ResolvedFxRate } from '../../fx/fx-rate.types';

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
    private readonly orgContextResolver: OrgContextResolver,
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
    const {
      organization: org,
      plugin,
      orgContext,
    } = await this.orgContextResolver.resolve();

    const supplierFacts: SupplierFacts = {
      // The counterparty's real country drives cross-border treatment; absent a
      // supplier we fall back to the org's own country (a domestic transaction).
      country: facts.supplierCountry ?? org.country,
      goodsVsServices: facts.goodsVsServices ?? 'unknown',
      classificationMemory: [],
      taxStatus: facts.taxStatus ?? 'unknown',
    };

    const supplyFacts: SupplyFacts = {
      supplyType: facts.supplyType,
      servicePlaceRule: facts.servicePlaceRule,
    };

    const mapping = plugin.resolveCategoryMapping(
      facts.category,
      supplierFacts,
      orgContext,
      supplyFacts,
    );

    const netAmount = facts.grossAmount - facts.vatAmount;

    // A purchase whose stated tax exceeds its gross is not a document any
    // treatment can rescue, so it is refused HERE — before entitlement, before
    // the cross-border branch, and independently of both (issue #211).
    //
    // It used to be caught downstream, by the negative net producing a negative
    // line that structural validation rejected. That only worked because the
    // net was always gross − vat. Once a non-deductible purchase books its tax
    // into the cost, the contradiction cancels itself out — a gross of 100 with
    // a stated VAT of 200 becomes a tidy cost of 100 — and an impossible
    // document would post without anyone seeing it. The check therefore has to
    // be its own statement about the source amounts, not a side effect of the
    // arithmetic.
    if (direction === 'purchase') {
      this.assertCoherentPurchaseAmounts(facts);
    }

    // A sale's stated tax must agree with the treatment the plugin resolved —
    // where the PLUGIN says that is checkable (issue #209). The kernel owns no
    // VAT arithmetic of its own (ADR-0002), so it only asks.
    if (direction === 'sale') {
      plugin.assertSaleTaxAmount?.({
        netMinorUnits: netAmount,
        vatMinorUnits: facts.vatAmount,
        vatCode: mapping.vatCode,
        taxPointDate: facts.taxPointDate,
        counterpartyFacts: supplierFacts,
        supplyFacts,
      });
    }
    // Single owner of currency→base conversion (ADR-0004): one uniform rate per
    // draft, sourced from the country plugin, rounded by the currency module.
    // We take the rate from the same place we book it.
    // The rate AND its provenance: which publication date it came from and
    // who published it (issue #203). Both travel onto every line, so a posted
    // voucher records the rate it was booked at *and* why that rate governs —
    // a Saturday tax point legitimately carrying Friday's publication is then
    // visible as such, instead of looking like a date-blind constant.
    const fx: ResolvedFxRate = await this.currencyService
      .toBase(netAmount, facts.currency, facts.taxPointDate)
      .then((c) => ({
        rate: c.rate,
        rateDate: c.rateDate,
        source: c.rateSource,
      }));
    // Round each leg to base-currency minor units via the active plugin's rule
    // (ADR-0002: rounding is a jurisdiction rule). The plugin is the same one
    // resolved above; CurrencyService owns the multiply, the plugin the round.
    const baseAmount = (amount: number) =>
      plugin.roundToBaseMinorUnits(
        this.currencyService.convertToBase(amount, facts.currency, fx.rate),
      );

    // Cross-border treatment is a purchase-side concern (the supplier's VAT
    // territory). A reverse-charge acquisition (intra-EU service, or an imported
    // non-EU service under KMS §10) is self-assessed: we owe the supplier only
    // the net, and book the output VAT we owe on it — plus whatever part of
    // that tax we are ENTITLED to deduct (issue #211), which is not always all
    // of it and is not always any of it.
    if (direction === 'purchase') {
      const cross = plugin.resolveCrossBorderTreatment(
        supplierFacts,
        orgContext,
        { vatCharged: facts.vatAmount > 0 },
      );
      if (cross.treatment === 'reverse_charge') {
        const rcCode = cross.vatCode ?? mapping.vatCode;
        const entitlement = this.resolveEntitlement(
          plugin,
          orgContext,
          facts,
          cross.treatment,
          rcCode,
        );
        return {
          voucher_number: 'PENDING',
          tax_point_date: facts.taxPointDate,
          input_vat_entitlement: entitlement,
          lines: this.reverseChargeLines(
            facts,
            mapping,
            rcCode,
            // The rate AS AT the tax point, not today's: a reverse charge is
            // self-assessed at the rate in force when the acquisition occurred,
            // and this call was dropping the date.
            plugin.getVatRate(rcCode, facts.taxPointDate),
            entitlement,
            fx,
            baseAmount,
          ),
        };
      }
      const entitlement = this.resolveEntitlement(
        plugin,
        orgContext,
        facts,
        cross.treatment,
        mapping.vatCode,
      );
      return {
        voucher_number: 'PENDING',
        tax_point_date: facts.taxPointDate,
        input_vat_entitlement: entitlement,
        lines: this.purchaseLines(facts, mapping, entitlement, fx, baseAmount),
      };
    }

    return {
      voucher_number: 'PENDING',
      tax_point_date: facts.taxPointDate,
      lines: this.saleLines(facts, netAmount, mapping, fx, baseAmount),
    };
  }

  /**
   * The source amounts a purchase must satisfy before any treatment is chosen:
   * a positive gross, a non-negative tax, and a tax that does not exceed the
   * gross it is part of. These are facts about the DOCUMENT, so no entitlement,
   * receipt status or cross-border treatment can make a failing one postable.
   */
  private assertCoherentPurchaseAmounts(facts: EconomicFacts): void {
    const { grossAmount, vatAmount } = facts;
    if (!Number.isSafeInteger(grossAmount) || grossAmount <= 0) {
      throw new BadRequestException(
        `A purchase must have a positive gross amount; received ${grossAmount}. ` +
          `Nothing was posted.`,
      );
    }
    if (!Number.isSafeInteger(vatAmount) || vatAmount < 0) {
      throw new BadRequestException(
        `A purchase's VAT amount cannot be negative; received ${vatAmount}. ` +
          `Nothing was posted.`,
      );
    }
    if (vatAmount > grossAmount) {
      throw new BadRequestException(
        `A purchase's VAT amount (${vatAmount}) cannot exceed its gross amount ` +
          `(${grossAmount}) — the tax is part of the gross, not additional to ` +
          `it. Correct the document's amounts; nothing was posted.`,
      );
    }
  }

  /**
   * How much of this purchase's input VAT may be deducted (issue #211), settled
   * BEFORE any VAT_RECEIVABLE leg is composed.
   *
   * Two independent restrictions, in order:
   *
   *  1. the FISCAL entitlement, which the country plugin owns (ADR-0002): the
   *     organisation's registration and its recorded right to deduct. The
   *     kernel does not interpret those facts, it only checks that the fraction
   *     it gets back is a usable one, because that fraction multiplies money.
   *
   *  2. the DOCUMENTARY restriction the kernel already applied: a receipt that
   *     is not addressed to the organisation supports no deduction whatever the
   *     entitlement is. It overrides downwards and never upwards — it cannot
   *     grant a deduction the jurisdiction withheld.
   *
   * The result — the EFFECTIVE fraction, after both — is what gets recorded on
   * the voucher, so the provenance says what was actually deducted rather than
   * what the settings alone would have allowed.
   */
  private resolveEntitlement(
    plugin: CountryPlugin,
    orgContext: OrgContext,
    facts: EconomicFacts,
    treatment: CrossBorderTreatment,
    vatCode: string,
  ): InputVatEntitlement {
    const entitlement = plugin.resolveInputVatEntitlement(orgContext, {
      treatment,
      vatCode,
    });
    assertValidEntitlement(entitlement);

    // undefined (a non-claimant expense) means the question was never raised;
    // false and null both mean "not established", and neither supports a claim.
    const receiptSupportsReclaim =
      facts.companyAddressedReceipt === undefined
        ? true
        : facts.companyAddressedReceipt === true;

    if (!receiptSupportsReclaim) {
      return NO_ENTITLEMENT('receipt_not_company_addressed');
    }
    return entitlement;
  }

  /**
   * Reverse-charge purchase legs (pöördmaksustamine). The foreign document
   * carries no reclaimable domestic VAT, so the whole gross is the taxable base
   * and the amount owed to the supplier. We self-assess VAT at OUR rate on that
   * base and book it as output tax — always in full, because the duty to
   * declare it does not depend on any deduction right. What the entitlement
   * decides is only the INPUT side (issue #211):
   *
   *   Dr category(base)          rcCode              ← the acquisition's base
   *   Dr category(nonDeductible) null                ← irrecoverable VAT, cost
   *   Dr VAT_RECEIVABLE(deduct)  rcCode              ← input, deducted
   *   Cr AP(base)                —
   *   Cr VAT_PAYABLE(rcVat)      rcCode              ← output, self-assessed
   *
   * The irrecoverable part is a SEPARATE leg carrying NO VAT code, and that is
   * the whole point of splitting it. The KMD reads the taxable base off the
   * lines that carry the reverse-charge code, so folding the extra cost into
   * the coded leg would declare an acquisition of 124 where the supplier
   * invoiced 100 — inflating rows 1 and 6/7 by the tax itself. The cost still
   * reaches the expense or asset account; it just does not pretend to be part
   * of what was acquired.
   *
   * With full entitlement the middle leg is absent and the legs are exactly the
   * ones this method produced before.
   */
  private reverseChargeLines(
    facts: EconomicFacts,
    mapping: { accountCode: string; vatCode: string },
    reverseChargeCode: string,
    rate: number,
    entitlement: InputVatEntitlement,
    fx: ResolvedFxRate,
    baseAmount: (amount: number) => number,
  ): DraftVoucherLine[] {
    const base = facts.grossAmount;
    const rcVat = Math.round(base * rate);
    const { deductible, nonDeductible } = splitInputVat(rcVat, entitlement);
    // The base-currency split is derived the same way — one converted total,
    // partitioned — so the two legs sum to the converted tax exactly. Two
    // independently rounded conversions could differ from it by a cent and
    // leave the voucher unbalanced in base currency.
    const baseRcVat = baseAmount(rcVat);
    const baseDeductible = baseAmount(deductible);
    const baseNonDeductible = baseRcVat - baseDeductible;

    // When the reverse-charge purchase was paid by a Claimant out of pocket,
    // the credit leg is CLAIMANT_PAYABLE (not AP) — same rule as purchaseLines().
    const creditAccountCode =
      facts.claimantId != null ? 'CLAIMANT_PAYABLE' : 'AP';
    const common = {
      currency: facts.currency,
      fx_rate: fx.rate,
      fx_rate_date: fx.rateDate,
      fx_rate_source: fx.source,
    };
    return [
      {
        ...common,
        account_code: mapping.accountCode,
        amount: base,
        base_amount: baseAmount(base),
        vat_code: reverseChargeCode,
        is_debit: true,
      },
      ...(nonDeductible > 0
        ? [
            {
              ...common,
              account_code: mapping.accountCode,
              amount: nonDeductible,
              base_amount: baseNonDeductible,
              vat_code: null,
              is_debit: true,
            },
          ]
        : []),
      ...(deductible > 0
        ? [
            {
              ...common,
              account_code: 'VAT_RECEIVABLE',
              amount: deductible,
              base_amount: baseDeductible,
              vat_code: reverseChargeCode,
              is_debit: true,
            },
          ]
        : []),
      {
        ...common,
        account_code: creditAccountCode,
        amount: base,
        base_amount: baseAmount(base),
        vat_code: null,
        is_debit: false,
      },
      {
        ...common,
        account_code: 'VAT_PAYABLE',
        amount: rcVat,
        base_amount: baseRcVat,
        vat_code: reverseChargeCode,
        is_debit: false,
      },
    ];
  }

  /**
   * Purchase legs (Expense): Dr category(net + irrecoverable VAT)
   * [, Dr VAT_RECEIVABLE(deductible)], Cr AP|CLAIMANT_PAYABLE(gross).
   *
   * Credit account: CLAIMANT_PAYABLE when facts.claimantId is set (the expense
   * was paid by a claimant, not a supplier); AP otherwise.
   *
   * VAT reclaim is whatever {@link resolveEntitlement} settled — the
   * jurisdiction's deduction right, already narrowed by the company-addressed
   * receipt rule. Any part of the tax that is not deductible is NOT dropped: it
   * stays in the debit to the category account, because irrecoverable VAT is
   * part of what the thing cost. The gross owed to the counterparty never moves.
   *
   * The category leg keeps the resolved VAT code unless the RECEIPT restriction
   * applied (see below). A domestic input code places no taxable base on the
   * KMD, so a partly deducted or wholly non-deducted leg keeps its code without
   * distorting any row — while row 5 is fed by the VAT_RECEIVABLE account, and
   * therefore only by what was actually deducted.
   */
  private purchaseLines(
    facts: EconomicFacts,
    mapping: { accountCode: string; vatCode: string },
    entitlement: InputVatEntitlement,
    fx: ResolvedFxRate,
    baseAmount: (amount: number) => number,
  ): DraftVoucherLine[] {
    const { deductible } = splitInputVat(facts.vatAmount, entitlement);
    // Cost = everything owed that we cannot reclaim. Derived by subtraction
    // from the gross rather than added up from parts, so the debits equal the
    // credit exactly — in the document currency and, below, in base currency.
    const costAmount = facts.grossAmount - deductible;
    const baseGross = baseAmount(facts.grossAmount);
    const baseDeductible = baseAmount(deductible);
    const baseCost = baseGross - baseDeductible;

    // The code describes the supply's VAT TREATMENT, not our deduction. A
    // purchase we may not reclaim still bore the tax it bore, so the code
    // stays — which also keeps it subject to the plugin's own VAT-code
    // validation instead of quietly exempting every non-deductible line from
    // it. The one case that does clear it is the DOCUMENTARY restriction: a
    // receipt not addressed to us evidences no VAT treatment of ours at all.
    const effectiveVatCode =
      entitlement.basis === 'receipt_not_company_addressed'
        ? null
        : mapping.vatCode;

    const creditAccountCode =
      facts.claimantId != null ? 'CLAIMANT_PAYABLE' : 'AP';
    const common = {
      currency: facts.currency,
      fx_rate: fx.rate,
      fx_rate_date: fx.rateDate,
      fx_rate_source: fx.source,
    };

    return [
      {
        ...common,
        account_code: mapping.accountCode,
        amount: costAmount,
        base_amount: baseCost,
        vat_code: effectiveVatCode,
        is_debit: true,
      },
      ...(deductible > 0
        ? [
            {
              ...common,
              account_code: 'VAT_RECEIVABLE',
              amount: deductible,
              base_amount: baseDeductible,
              vat_code: mapping.vatCode,
              is_debit: true,
            },
          ]
        : []),
      {
        ...common,
        account_code: creditAccountCode,
        amount: facts.grossAmount,
        base_amount: baseGross,
        vat_code: null,
        is_debit: false,
      },
    ];
  }

  /**
   * Sale legs (SalesInvoice): Dr AR(gross), Cr category(net) [, Cr VAT_PAYABLE(vat)].
   * The VAT_PAYABLE leg is omitted when there is no VAT — a 0% / exempt supply
   * (e.g. an intra-EU B2B service) books just Dr AR / Cr REVENUE, because the
   * voucher_line CHECK (amount > 0) forbids a zero-amount leg. Symmetric to the
   * purchase side, which already elides a zero VAT_RECEIVABLE.
   */
  private saleLines(
    facts: EconomicFacts,
    netAmount: number,
    mapping: { accountCode: string; vatCode: string },
    fx: ResolvedFxRate,
    baseAmount: (amount: number) => number,
  ): DraftVoucherLine[] {
    return [
      {
        account_code: 'AR',
        amount: facts.grossAmount,
        currency: facts.currency,
        base_amount: baseAmount(facts.grossAmount),
        fx_rate: fx.rate,
        fx_rate_date: fx.rateDate,
        fx_rate_source: fx.source,
        vat_code: null,
        is_debit: true,
      },
      {
        account_code: mapping.accountCode,
        amount: netAmount,
        currency: facts.currency,
        base_amount: baseAmount(netAmount),
        fx_rate: fx.rate,
        fx_rate_date: fx.rateDate,
        fx_rate_source: fx.source,
        vat_code: mapping.vatCode,
        is_debit: false,
      },
      ...(facts.vatAmount > 0
        ? [
            {
              account_code: 'VAT_PAYABLE',
              amount: facts.vatAmount,
              currency: facts.currency,
              base_amount: baseAmount(facts.vatAmount),
              fx_rate: fx.rate,
              fx_rate_date: fx.rateDate,
              fx_rate_source: fx.source,
              vat_code: mapping.vatCode,
              is_debit: false,
            },
          ]
        : []),
    ];
  }
}
