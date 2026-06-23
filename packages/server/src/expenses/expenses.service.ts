import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { DraftVoucher } from '../ledger/voucher/types';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { CategoryService } from '../categories/category.service';
import { Expense, CreateExpenseDto, ExpenseStatus } from './types';

@Injectable()
export class ExpensesService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly projection: VoucherProjectionService,
    private readonly periodLock: PeriodLockService,
    private readonly categoryService: CategoryService,
  ) {}

  async createExpense(dto: CreateExpenseDto): Promise<Expense> {
    await this.categoryService.assertValid(dto.category);
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
        status: 'draft',
        voucher_id: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.mapRow(result);
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
    if (patch.category !== undefined) {
      await this.categoryService.assertValid(patch.category);
    }
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

  /**
   * Thin adapter over the deep projection module (ADR-0006): an Expense supplies
   * its economic facts and the `purchase` direction; the projection produces the
   * balanced draft Voucher (Dr category / Dr VAT_RECEIVABLE / Cr AP).
   *
   * When the expense names a supplier we also hand the projection the supplier's
   * country + goods/services nature so the plugin can resolve cross-border
   * treatment (e.g. an imported service → reverse charge). Without a supplier the
   * facts are omitted and the projection assumes a domestic counterparty.
   */
  private async buildDraftVoucher(expense: Expense): Promise<DraftVoucher> {
    const supplier =
      expense.supplier_id !== null
        ? await this.db
            .selectFrom('entity')
            .select(['country', 'goods_vs_services'])
            .where('id', '=', expense.supplier_id)
            .executeTakeFirst()
        : undefined;

    return this.projection.project(
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
        }),
        claimantId: expense.claimant_id ?? null,
        companyAddressedReceipt:
          expense.claimant_id !== null
            ? expense.company_addressed_receipt === null
              ? null
              : Boolean(expense.company_addressed_receipt)
            : undefined,
      },
      'purchase',
    );
  }

  /** Map the entity's free-form goods/services column onto the projection enum. */
  private normalizeGoodsVsServices(
    value: string | null,
  ): 'goods' | 'services' | 'unknown' {
    return value === 'goods' || value === 'services' ? value : 'unknown';
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

  async updateDraft(
    id: number,
    patch: {
      gross_amount?: number;
      vat_amount?: number;
      category?: string;
    },
  ): Promise<Expense> {
    if (patch.category !== undefined) {
      await this.categoryService.assertValid(patch.category);
    }
    const expense = await this.getExpenseById(id);
    if (expense.status !== 'draft' && expense.status !== 'pending') {
      throw new Error(
        `Cannot update draft: expense ${id} is ${expense.status}`,
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const row = await this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('expense')
        .set({
          ...(patch.gross_amount !== undefined && {
            gross_amount: patch.gross_amount,
          }),
          ...(patch.vat_amount !== undefined && {
            vat_amount: patch.vat_amount,
          }),
          ...(patch.category !== undefined && { category: patch.category }),
          ...(expense.status === 'pending' && {
            status: 'draft',
            voucher_id: null,
          }),
          updated_at: now,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();

      if (expense.status === 'pending') {
        await trx
          .updateTable('approval')
          .set({
            status: 'superseded',
            resolved_at: now,
          })
          .where('object_type', '=', 'expense')
          .where('object_id', '=', id)
          .where('status', '=', 'pending')
          .execute();
      }

      return updated;
    });

    return this.mapRow(row);
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
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
