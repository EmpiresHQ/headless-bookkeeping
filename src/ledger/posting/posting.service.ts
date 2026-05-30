import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../../database/types';
import { toBool } from '../../database/helpers';
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

  /**
   * Post a draft voucher as a standalone operation (own transaction).
   * Resolves account codes, validates, then delegates to postVoucherTx.
   */
  async postVoucher(draft: DraftVoucher): Promise<PostedVoucher> {
    const codes = [...new Set(draft.lines.map((l) => l.account_code))];
    const accounts = await this.accountService.getAccountsByCodes(codes);
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

    return this.db.transaction().execute(async (trx) => {
      return this.postVoucherTx(trx, draft, resolved);
    });
  }

  /**
   * Post a draft voucher inside an existing transaction (trx).
   *
   * Used by PostingPipelineService so the voucher insert and the business-object
   * status update happen atomically in a single transaction.
   *
   * Caller is responsible for account resolution and structural validation
   * before calling this method — it does NOT re-resolve or re-validate.
   */
  async postVoucherTx(
    trx: Kysely<Database>,
    draft: DraftVoucher,
    resolved: ValidatableLine[],
  ): Promise<PostedVoucher> {
    const postedAt = Math.floor(Date.now() / 1000);

    const previousHash = await this.chainHead(trx);

    const voucher = await trx
      .insertInto('voucher')
      .values({
        voucher_number: draft.voucher_number,
        tax_point_date: draft.tax_point_date,
        posted_at: postedAt,
        previous_hash: previousHash,
        reverses_id: draft.reverses_id ?? null,
        corrects_object_type: draft.corrects_object_type ?? null,
        corrects_object_id: draft.corrects_object_id ?? null,
        reason: draft.reason ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const insertedLines = await trx
      .insertInto('voucher_line')
      .values(
        draft.lines.map((l, i) => ({
          voucher_id: voucher.id,
          account_id: resolved[i].account_id,
          amount: l.amount,
          currency: l.currency,
          base_amount: l.base_amount,
          fx_rate: l.fx_rate,
          vat_code: l.vat_code ?? null,
          is_debit: l.is_debit ? 1 : 0,
        })),
      )
      .returningAll()
      .execute();

    const lines: VoucherLine[] = insertedLines.map((r) => ({
      id: r.id,
      voucher_id: r.voucher_id,
      account_id: r.account_id,
      amount: r.amount,
      currency: r.currency,
      base_amount: r.base_amount,
      fx_rate: r.fx_rate,
      vat_code: r.vat_code,
      is_debit: toBool(r.is_debit),
    }));

    return { ...voucher, lines };
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
      .orderBy('id', 'desc')
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
        is_debit: toBool(l.is_debit),
      })),
    );
  }
}
