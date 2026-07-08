import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { Database } from '../database/types';
import { ExpensesService } from '../expenses/expenses.service';
import { FIXED_ASSET_CODES } from '../fixed-assets/fixed-asset-class-map';

@Injectable()
export class TelegramApprovalSupportService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly expensesService: ExpensesService,
  ) {}

  /**
   * Mirrors the Todo-4 Telegram approval gate: only pending sales invoices and
   * non-fixed-asset expenses may receive actionable Telegram buttons.
   */
  async isTelegramApprovable(approvalId: number): Promise<boolean> {
    const approval = await this.db
      .selectFrom('approval')
      .select(['object_type', 'object_id', 'status'])
      .where('id', '=', approvalId)
      .executeTakeFirst();

    if (!approval || approval.status !== 'pending') {
      return false;
    }

    switch (approval.object_type) {
      case 'sales_invoice':
        return true;
      case 'expense': {
        const draft = await this.expensesService.generateDraftVoucher(
          approval.object_id,
        );
        return !draft.lines.some((line) =>
          FIXED_ASSET_CODES.includes(line.account_code),
        );
      }
      case 'allowance':
      case 'reconciliation_match':
        return false;
      default:
        return false;
    }
  }
}
