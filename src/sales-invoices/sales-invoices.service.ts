import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { DraftVoucher } from '../ledger/voucher/types';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import {
  SalesInvoice,
  SalesInvoiceStatus,
  CreateSalesInvoiceDto,
} from './types';

@Injectable()
export class SalesInvoicesService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly projection: VoucherProjectionService,
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
        document_vat_marking: dto.document_vat_marking ?? null,
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
    return this.buildDraftVoucher(invoice);
  }

  /**
   * Build the draft voucher for an invoice as if `patch` were applied, WITHOUT
   * persisting it. Used by the atomic correction flow (see ExpensesService for
   * the rationale). The invoice's draft posts the fixed 'revenue' category, so a
   * `category` patch has no effect here.
   */
  async previewPatchedDraft(
    id: number,
    patch: { gross_amount?: number; vat_amount?: number; category?: string },
  ): Promise<DraftVoucher> {
    const invoice = await this.getInvoiceById(id);
    const patched: SalesInvoice = {
      ...invoice,
      ...(patch.gross_amount !== undefined && {
        gross_amount: patch.gross_amount,
      }),
      ...(patch.vat_amount !== undefined && { vat_amount: patch.vat_amount }),
    };
    return this.buildDraftVoucher(patched);
  }

  /**
   * Thin adapter over the deep projection module (ADR-0006): a SalesInvoice
   * supplies its economic facts (fixed 'revenue' Category) and the `sale`
   * direction; the projection produces the balanced draft Voucher
   * (Dr AR / Cr revenue / Cr VAT_PAYABLE).
   */
  private async buildDraftVoucher(
    invoice: SalesInvoice,
  ): Promise<DraftVoucher> {
    // Hand the projection the customer's country + goods/services nature so the
    // plugin can classify the sale (e.g. a service sold to an EU-VAT customer →
    // 0% intra-EU käive, Art. 196). Without a customer the facts are omitted and
    // the plugin maps the standard domestic rate.
    const customer =
      invoice.customer_id !== null
        ? await this.db
            .selectFrom('entity')
            .select(['country', 'goods_vs_services'])
            .where('id', '=', invoice.customer_id)
            .executeTakeFirst()
        : undefined;

    return this.projection.project(
      {
        category: 'revenue',
        grossAmount: invoice.gross_amount,
        vatAmount: invoice.vat_amount,
        currency: invoice.currency,
        taxPointDate: invoice.tax_point_date,
        ...(customer && {
          supplierCountry: customer.country,
          goodsVsServices: this.normalizeGoodsVsServices(
            customer.goods_vs_services,
          ),
        }),
      },
      'sale',
    );
  }

  /** Map the entity's free-form goods/services column onto the projection enum. */
  private normalizeGoodsVsServices(
    value: string | null,
  ): 'goods' | 'services' | 'unknown' {
    return value === 'goods' || value === 'services' ? value : 'unknown';
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

  async updateDraft(
    id: number,
    patch: {
      gross_amount?: number;
      vat_amount?: number;
      category?: string;
    },
  ): Promise<SalesInvoice> {
    const invoice = await this.getInvoiceById(id);
    if (invoice.status !== 'draft' && invoice.status !== 'pending') {
      throw new Error(
        `Cannot update draft: sales invoice ${id} is ${invoice.status}`,
      );
    }

    return this.patchAmounts(id, patch);
  }

  async patchAmounts(
    id: number,
    patch: {
      gross_amount?: number;
      vat_amount?: number;
      category?: string;
    },
  ): Promise<SalesInvoice> {
    const now = Math.floor(Date.now() / 1000);
    const row = await this.db
      .updateTable('sales_invoice')
      .set({
        ...(patch.gross_amount !== undefined && {
          gross_amount: patch.gross_amount,
        }),
        ...(patch.vat_amount !== undefined && {
          vat_amount: patch.vat_amount,
        }),
        updated_at: now,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.mapRow(row);
  }

  /**
   * Apply an amount patch inside an existing transaction (trx) — transactional
   * twin of {@link patchAmounts} for the atomic correction flow.
   */
  async patchAmountsTx(
    trx: Kysely<Database>,
    id: number,
    patch: { gross_amount?: number; vat_amount?: number; category?: string },
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await trx
      .updateTable('sales_invoice')
      .set({
        ...(patch.gross_amount !== undefined && {
          gross_amount: patch.gross_amount,
        }),
        ...(patch.vat_amount !== undefined && {
          vat_amount: patch.vat_amount,
        }),
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
    document_vat_marking: string | null;
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
      document_vat_marking: row.document_vat_marking,
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
