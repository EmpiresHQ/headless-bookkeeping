import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { OrganizationService } from '../organization/organization.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CurrencyService } from '../currency/currency.service';
import { SupplierFacts, OrgContext } from '../plugins/country-plugin.interface';
import { DraftVoucher, DraftVoucherLine } from '../ledger/voucher/types';
import { Expense, CreateExpenseDto, ExpenseStatus } from './types';

@Injectable()
export class ExpensesService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly organizationService: OrganizationService,
    private readonly pluginLoader: PluginLoader,
    private readonly currencyService: CurrencyService,
  ) {}

  async createExpense(dto: CreateExpenseDto): Promise<Expense> {
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
        status: 'draft',
        voucher_id: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.mapRow(result);
  }

  async getExpenses(): Promise<Expense[]> {
    const rows = await this.db
      .selectFrom('expense')
      .selectAll()
      .orderBy('id')
      .execute();
    return rows.map((r) => this.mapRow(r));
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

  async generateDraftVoucher(expenseId: number): Promise<DraftVoucher> {
    const expense = await this.getExpenseById(expenseId);
    return this.buildDraftVoucher(expense);
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
    const expense = await this.getExpenseById(expenseId);
    const patched: Expense = {
      ...expense,
      ...(patch.gross_amount !== undefined && {
        gross_amount: patch.gross_amount,
      }),
      ...(patch.vat_amount !== undefined && { vat_amount: patch.vat_amount }),
      ...(patch.category !== undefined && { category: patch.category }),
    };
    return this.buildDraftVoucher(patched);
  }

  private async buildDraftVoucher(expense: Expense): Promise<DraftVoucher> {
    const org = await this.organizationService.getOrganization();

    const plugin = this.pluginLoader.resolve(org.country);

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
      expense.category,
      supplierFacts,
      orgContext,
    );

    const baseCurrency = await this.currencyService.getBaseCurrency();
    const netAmount = expense.gross_amount - expense.vat_amount;
    const fxRate = plugin.getReferenceRate(
      expense.currency,
      baseCurrency,
      expense.tax_point_date,
    );
    const baseAmount = (amount: number) => Math.round(amount * fxRate);

    const lines: DraftVoucherLine[] = [
      {
        account_code: mapping.accountCode,
        amount: netAmount,
        currency: expense.currency,
        base_amount: baseAmount(netAmount),
        fx_rate: fxRate,
        vat_code: mapping.vatCode,
        is_debit: true,
      },
      ...(expense.vat_amount > 0
        ? [
            {
              account_code: 'VAT_RECEIVABLE',
              amount: expense.vat_amount,
              currency: expense.currency,
              base_amount: baseAmount(expense.vat_amount),
              fx_rate: fxRate,
              vat_code: mapping.vatCode,
              is_debit: true,
            },
          ]
        : []),
      {
        account_code: 'AP',
        amount: expense.gross_amount,
        currency: expense.currency,
        base_amount: baseAmount(expense.gross_amount),
        fx_rate: fxRate,
        vat_code: null,
        is_debit: false,
      },
    ];

    return {
      voucher_number: 'PENDING',
      tax_point_date: expense.tax_point_date,
      lines,
    };
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

  async updateDraft(
    id: number,
    patch: {
      gross_amount?: number;
      vat_amount?: number;
      category?: string;
    },
  ): Promise<Expense> {
    const expense = await this.getExpenseById(id);
    if (expense.status !== 'draft' && expense.status !== 'pending') {
      throw new Error(
        `Cannot update draft: expense ${id} is ${expense.status}`,
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

  async markReversed(id: number, newVoucherId: number): Promise<void> {
    await this.updateExpenseStatus(id, 'reversed', newVoucherId);
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

  /**
   * Mark the expense reversed and re-point it at the corrected voucher inside an
   * existing transaction (trx) — the transactional twin of {@link markReversed}.
   */
  async markReversedTx(
    trx: Kysely<Database>,
    id: number,
    newVoucherId: number,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await trx
      .updateTable('expense')
      .set({ status: 'reversed', voucher_id: newVoucherId, updated_at: now })
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
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
