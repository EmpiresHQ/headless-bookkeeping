import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { OrganizationService } from '../organization/organization.service';
import { CurrencyService } from '../currency/currency.service';
import { SupplierFacts, OrgContext } from '../plugins/country-plugin.interface';
import { DraftVoucher } from '../ledger/voucher/types';
import {
  SalesInvoice,
  SalesInvoiceStatus,
  CreateSalesInvoiceDto,
} from './types';

@Injectable()
export class SalesInvoicesService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly pluginLoader: PluginLoader,
    private readonly organizationService: OrganizationService,
    private readonly currencyService: CurrencyService,
  ) {}

  async createInvoice(dto: CreateSalesInvoiceDto): Promise<SalesInvoice> {
    const now = Math.floor(Date.now() / 1000);
    const row = await this.db
      .insertInto('sales_invoice')
      .values({
        customer_id: dto.customer_id ?? null,
        invoice_number: dto.invoice_number,
        gross_amount: dto.gross_amount,
        vat_amount: dto.vat_amount,
        currency: dto.currency,
        tax_point_date: dto.tax_point_date,
        due_date: dto.due_date ?? null,
        status: 'draft',
        sent_at: null,
        voucher_id: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.mapRow(row);
  }

  async getInvoices(): Promise<SalesInvoice[]> {
    const rows = await this.db
      .selectFrom('sales_invoice')
      .selectAll()
      .orderBy('id')
      .execute();
    return rows.map((r) => this.mapRow(r));
  }

  async getInvoiceById(id: number): Promise<SalesInvoice> {
    const row = await this.db
      .selectFrom('sales_invoice')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundException(`SalesInvoice ${id} not found`);
    }

    return this.mapRow(row);
  }

  async generateDraftVoucher(id: number): Promise<DraftVoucher> {
    const invoice = await this.getInvoiceById(id);

    const org = await this.organizationService.getOrganization();
    const plugin = this.pluginLoader.resolve(org.country);
    const baseCurrency = await this.currencyService.getBaseCurrency();

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

    const mapping = plugin.resolveCategoryMapping(
      'revenue',
      supplierFacts,
      orgContext,
    );

    const isBaseCurrency = invoice.currency === baseCurrency;
    const fxRate = isBaseCurrency ? 1 : 1;
    const netAmount = invoice.gross_amount - invoice.vat_amount;

    const draft: DraftVoucher = {
      voucher_number: invoice.invoice_number,
      tax_point_date: invoice.tax_point_date,
      lines: [
        {
          account_code: 'AR',
          amount: invoice.gross_amount,
          currency: invoice.currency,
          base_amount: invoice.gross_amount,
          fx_rate: fxRate,
          vat_code: null,
          is_debit: true,
        },
        {
          account_code: mapping.accountCode,
          amount: netAmount,
          currency: invoice.currency,
          base_amount: netAmount,
          fx_rate: fxRate,
          vat_code: mapping.vatCode,
          is_debit: false,
        },
        {
          account_code: 'VAT_PAYABLE',
          amount: invoice.vat_amount,
          currency: invoice.currency,
          base_amount: invoice.vat_amount,
          fx_rate: fxRate,
          vat_code: mapping.vatCode,
          is_debit: false,
        },
      ],
    };

    return draft;
  }

  async sendInvoice(id: number): Promise<SalesInvoice> {
    await this.getInvoiceById(id); // throws NotFoundException if missing

    const now = Math.floor(Date.now() / 1000);
    const row = await this.db
      .updateTable('sales_invoice')
      .set({ sent_at: now, updated_at: now })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.mapRow(row);
  }

  async updateInvoiceStatus(
    id: number,
    status: SalesInvoiceStatus,
    voucherId: number | null,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .updateTable('sales_invoice')
      .set({
        status,
        voucher_id: voucherId,
        updated_at: now,
      })
      .where('id', '=', id)
      .execute();
  }

  private mapRow(row: {
    id: number;
    customer_id: number | null;
    invoice_number: string;
    gross_amount: number;
    vat_amount: number;
    currency: string;
    tax_point_date: string;
    due_date: string | null;
    status: string;
    sent_at: number | null;
    voucher_id: number | null;
    created_at: number;
    updated_at: number;
  }): SalesInvoice {
    return {
      id: row.id,
      customer_id: row.customer_id,
      invoice_number: row.invoice_number,
      gross_amount: row.gross_amount,
      vat_amount: row.vat_amount,
      currency: row.currency,
      tax_point_date: row.tax_point_date,
      due_date: row.due_date,
      status: this.validateStatus(row.status),
      sent_at: row.sent_at,
      voucher_id: row.voucher_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private validateStatus(status: string): SalesInvoiceStatus {
    if (
      status === 'draft' ||
      status === 'pending' ||
      status === 'posted' ||
      status === 'reversed'
    ) {
      return status;
    }
    throw new Error(`Invalid sales invoice status: ${status}`);
  }
}
