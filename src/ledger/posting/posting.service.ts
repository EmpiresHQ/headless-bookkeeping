import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../../database/types';
import { AccountService } from '../account/account.service';
import { LedgerValidationService } from '../validation/ledger-validation.service';
import { ValidatableLine } from '../validation/types';
import { DraftVoucher, PostedVoucher, VoucherLine } from '../voucher/types';
import { ValidationError } from './types';

@Injectable()
export class PostingService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly accountService: AccountService,
    private readonly validation: LedgerValidationService,
  ) {}

  async postVoucher(draft: DraftVoucher): Promise<PostedVoucher> {
    const accounts = await this.accountService.getAccounts();
    const idByCode = new Map(accounts.map((a) => [a.code, a.id]));
    const validIds = new Set(accounts.map((a) => a.id));

    const resolved: ValidatableLine[] = draft.lines.map((l) => ({
      account_id: idByCode.get(l.account_code) ?? 0,
      amount: l.amount,
      currency: l.currency,
      base_amount: l.base_amount,
      fx_rate: l.fx_rate,
      is_debit: l.is_debit,
    }));

    const result = this.validation.validateVoucherLines(resolved, validIds);
    if (!result.isValid) {
      throw new ValidationError(result.errors);
    }

    const postedAt = Math.floor(Date.now() / 1000);

    return this.db.transaction().execute(async (trx) => {
      const voucher = await trx
        .insertInto('voucher')
        .values({
          voucher_number: draft.voucher_number,
          tax_point_date: draft.tax_point_date,
          posted_at: postedAt,
          previous_hash: null,
          reverses_id: null,
          corrects_object_type: null,
          corrects_object_id: null,
          reason: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const lines: VoucherLine[] = [];
      for (let i = 0; i < draft.lines.length; i++) {
        const draftLine = draft.lines[i];
        const inserted = await trx
          .insertInto('voucher_line')
          .values({
            voucher_id: voucher.id,
            account_id: resolved[i].account_id,
            amount: draftLine.amount,
            currency: draftLine.currency,
            base_amount: draftLine.base_amount,
            fx_rate: draftLine.fx_rate,
            vat_code: draftLine.vat_code ?? null,
            is_debit: draftLine.is_debit ? 1 : 0,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        lines.push({
          id: inserted.id,
          voucher_id: inserted.voucher_id,
          account_id: inserted.account_id,
          amount: inserted.amount,
          currency: inserted.currency,
          base_amount: inserted.base_amount,
          fx_rate: inserted.fx_rate,
          vat_code: inserted.vat_code,
          is_debit: inserted.is_debit === 1,
        });
      }

      return {
        id: voucher.id,
        voucher_number: voucher.voucher_number,
        tax_point_date: voucher.tax_point_date,
        posted_at: voucher.posted_at,
        previous_hash: voucher.previous_hash,
        reverses_id: voucher.reverses_id,
        corrects_object_type: voucher.corrects_object_type,
        corrects_object_id: voucher.corrects_object_id,
        reason: voucher.reason,
        lines,
      };
    });
  }
}
