import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../../database/types';
import { AccountService } from '../account/account.service';
import { LedgerValidationService } from '../validation/ledger-validation.service';
import { ValidatableLine } from '../validation/types';
import { DraftVoucher, PostedVoucher, VoucherLine } from '../voucher/types';
import { ValidationError } from './types';
import { GENESIS_HASH, computeVoucherHash } from './voucher-hash';

@Injectable()
export class PostingService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly accountService: AccountService,
    private readonly validation: LedgerValidationService,
  ) {}

  async postVoucher(draft: DraftVoucher): Promise<PostedVoucher> {
    const accounts = await this.accountService.getAccounts();
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const validIds = new Set(accounts.map((a) => a.id));

    const resolved: ValidatableLine[] = draft.lines.map((l) => {
      const account = byCode.get(l.account_code);
      return {
        account_id: account?.id ?? -1, // -1 = unknown code; fails the existence check
        amount: l.amount,
        currency: l.currency,
        base_amount: l.base_amount,
        fx_rate: l.fx_rate,
        is_debit: l.is_debit,
        account_currency: account?.currency ?? null,
      };
    });

    const result = this.validation.validateVoucherLines(resolved, validIds);
    if (!result.isValid) {
      throw new ValidationError(result.errors);
    }

    const postedAt = Math.floor(Date.now() / 1000);

    return this.db.transaction().execute(async (trx) => {
      const previousHash = await this.chainHead(trx);

      const voucher = await trx
        .insertInto('voucher')
        .values({
          voucher_number: draft.voucher_number,
          tax_point_date: draft.tax_point_date,
          posted_at: postedAt,
          previous_hash: previousHash,
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

      return { ...voucher, lines };
    });
  }

  /**
   * The hash of the latest posted voucher, or GENESIS_HASH if the ledger is
   * empty. ADR-0013: the new voucher's previous_hash links to this.
   */
  private async chainHead(trx: Kysely<Database>): Promise<string> {
    const prev = await trx
      .selectFrom('voucher')
      .selectAll()
      .where('posted_at', 'is not', null)
      .orderBy('id desc')
      .limit(1)
      .executeTakeFirst();
    if (!prev) return GENESIS_HASH;

    const prevLines = await trx
      .selectFrom('voucher_line')
      .selectAll()
      .where('voucher_id', '=', prev.id)
      .orderBy('id')
      .execute();

    return computeVoucherHash(
      prev,
      prevLines.map((l) => ({
        account_id: l.account_id,
        amount: l.amount,
        currency: l.currency,
        base_amount: l.base_amount,
        fx_rate: l.fx_rate,
        is_debit: l.is_debit === 1,
      })),
    );
  }
}
