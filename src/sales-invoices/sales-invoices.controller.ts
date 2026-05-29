import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { SalesInvoicesService } from './sales-invoices.service';
import { AccountService } from '../ledger/account/account.service';
import { RulesService } from '../rules/rules.service';
import { PolicyService } from '../policy/policy.service';
import { PostingService } from '../ledger/posting/posting.service';
import { OrganizationService } from '../organization/organization.service';
import { mustReject } from '../rules/rules.guards';
import {
  ResolvedLine,
  SemanticValidationContext,
  RuleResult,
} from '../rules/types';
import { SupplierFacts, OrgContext } from '../plugins/country-plugin.interface';
import { SalesInvoice } from './types';
import type { CreateSalesInvoiceDto } from './types';
import { DraftVoucher } from '../ledger/voucher/types';

@Controller('api/sales-invoices')
export class SalesInvoicesController {
  constructor(
    private readonly service: SalesInvoicesService,
    private readonly accountService: AccountService,
    private readonly rulesService: RulesService,
    private readonly policyService: PolicyService,
    private readonly postingService: PostingService,
    private readonly organizationService: OrganizationService,
  ) {}

  @Get()
  async getInvoices(): Promise<{ invoices: SalesInvoice[] }> {
    return { invoices: await this.service.getInvoices() };
  }

  @Post()
  async createInvoice(
    @Body() dto: CreateSalesInvoiceDto,
  ): Promise<SalesInvoice> {
    try {
      return await this.service.createInvoice(dto);
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(
          `Invoice number ${dto.invoice_number} already exists`,
        );
      }
      throw err;
    }
  }

  @Post(':id/generate-draft')
  async generateDraft(
    @Param('id') id: string,
  ): Promise<{ draft: DraftVoucher }> {
    const draft = await this.service.generateDraftVoucher(Number(id));
    return { draft };
  }

  @Post(':id/send')
  async sendInvoice(@Param('id') id: string): Promise<SalesInvoice> {
    return this.service.sendInvoice(Number(id));
  }

  /**
   * Full pipeline endpoint: draft → Rules → Policy → post or hold.
   *
   * Idempotent: if the invoice is not in 'draft' status, returns 409
   * without double-posting (AC-9).
   */
  @Post(':id/post')
  async postInvoice(@Param('id') id: string) {
    const invoiceId = Number(id);
    const invoice = await this.service.getInvoiceById(invoiceId);
    if (!invoice) {
      throw new NotFoundException(`SalesInvoice ${invoiceId} not found`);
    }

    // Idempotent posting guard (AC-9)
    if (invoice.status !== 'draft') {
      throw new ConflictException(
        `SalesInvoice ${invoiceId} is already ${invoice.status}`,
      );
    }

    // 1. Generate transient draft voucher (not persisted — ADR-0020)
    const draft = await this.service.generateDraftVoucher(invoiceId);

    // 2. Resolve account codes to {account_id, account_currency} (AC-4)
    const codes = [...new Set(draft.lines.map((l) => l.account_code))];
    const accounts = await this.accountService.getAccountsByCodes(codes);
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const validAccountIds = new Set(accounts.map((a) => a.id));

    // 3. Build ResolvedLine[] for structural + hard validation (all lines)
    const resolvedLines: ResolvedLine[] = draft.lines.map((l) => {
      const account = byCode.get(l.account_code);
      return {
        account_id: account?.id ?? -1,
        amount: l.amount,
        currency: l.currency,
        base_amount: l.base_amount,
        fx_rate: l.fx_rate,
        is_debit: l.is_debit,
        account_currency: account?.currency ?? null,
        vat_code: l.vat_code ?? 'NULL_STANDARD',
        category: l.account_code === 'REVENUE' ? 'revenue' : '',
      };
    });

    // 4. Build semantic validation context
    const org = await this.organizationService.getOrganization();
    const supplierFacts: SupplierFacts = {
      country: org.country,
      goodsVsServices: 'unknown',
      classificationMemory: [],
    };
    const orgContext: OrgContext = {
      country: org.country,
      vatRegistered: org.vat_registered,
      baseCurrency: org.base_currency,
    };
    const semanticContext: SemanticValidationContext = {
      countryCode: org.country,
      supplierFacts,
      orgContext,
    };

    // 5. Run Rules validation (structural + hard + semantic)
    const structuralResult = this.rulesService.validate(
      resolvedLines,
      validAccountIds,
      'structural',
    );
    if (mustReject(structuralResult)) {
      throw new BadRequestException({
        message: 'Structural validation failed',
        errors: [structuralResult.message],
      });
    }

    const hardResult = this.rulesService.validate(
      resolvedLines,
      validAccountIds,
      'hard',
    );
    if (mustReject(hardResult)) {
      throw new BadRequestException({
        message: 'Hard process validation failed',
        errors: [hardResult.message],
      });
    }

    // Semantic validation: only on lines with a real VAT code
    const semanticLines = resolvedLines.filter(
      (l) => l.vat_code !== 'NULL_STANDARD',
    );
    let semanticResult: RuleResult = {
      passed: true,
      ruleType: 'semantic',
      message: 'Semantic validation skipped (no lines with VAT code)',
      overrideable: true,
    };
    if (semanticLines.length > 0) {
      semanticResult = this.rulesService.validate(
        semanticLines,
        validAccountIds,
        'semantic',
        semanticContext,
      );
    }

    const ruleResults = [structuralResult, hardResult, semanticResult];

    // 6. Policy gate
    const policyDecision = this.policyService.decide(draft, ruleResults);

    if (policyDecision.action === 'auto-post') {
      // 7a. Post the voucher (atomic, immutable, hash-chained)
      const voucher = await this.postingService.postVoucher(draft);
      await this.service.updateInvoiceStatus(invoiceId, 'posted', voucher.id);
      return {
        invoice: await this.service.getInvoiceById(invoiceId),
        voucher,
        policy: policyDecision,
      };
    }

    // 7b. Hold for approval — object → pending, NO voucher persisted (ADR-0020)
    await this.service.updateInvoiceStatus(invoiceId, 'pending', null);
    return {
      invoice: await this.service.getInvoiceById(invoiceId),
      voucher: null,
      policy: policyDecision,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Error &&
      err.message.includes('UNIQUE constraint failed') &&
      err.message.includes('invoice_number')
    );
  }
}
