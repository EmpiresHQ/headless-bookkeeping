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
import { Expense, CreateExpenseDto, ExpenseStatus } from './types';

@Injectable()
export class ExpensesService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly projection: VoucherProjectionService,
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
   */
  private async buildDraftVoucher(expense: Expense): Promise<DraftVoucher> {
    return this.projection.project(
      {
        category: expense.category,
        grossAmount: expense.gross_amount,
        vatAmount: expense.vat_amount,
        currency: expense.currency,
        taxPointDate: expense.tax_point_date,
      },
      'purchase',
    );
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
