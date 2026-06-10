import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { PostingService } from '../ledger/posting/posting.service';
import { VoucherLineRepository } from '../ledger/voucher/voucher-line.repository';
import { AccountService } from '../ledger/account/account.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import {
  DraftVoucher,
  DraftVoucherLine,
  VoucherLine,
} from '../ledger/voucher/types';
import { CreditNote, CreditNoteKind, CreateCreditNoteDto } from './types';

/**
 * The counterparty account code per credited object: a sales invoice's voucher
 * settles through Accounts Receivable (`AR`), an expense's through Accounts
 * Payable (`AP`) (migration 002). The credit note's mirror voucher absorbs the
 * rounding residual on THIS line so it balances exactly — see {@link buildMirrorVoucher}.
 */
const COUNTERPARTY_CODE: Record<'sales_invoice' | 'expense', string> = {
  sales_invoice: 'AR',
  expense: 'AP',
};

/**
 * The minimal shape we read off the credited object — both `sales_invoice` and
 * `expense` rows carry these (their voucher is the thing we mirror).
 */
interface CreditedObject {
  gross_amount: number;
  currency: string;
  status: string;
  voucher_id: number | null;
}

/**
 * CreditNotesService — posts a credit note: a first-class "negative invoice"
 * that credits a posted `sales_invoice` or `expense`. Creating one posts a
 * voucher that is the sign-flipped, proportionally-scaled MIRROR of the
 * original's voucher.
 *
 * Behind the small `create` surface live the parts a caller must not have to
 * know about:
 *  1. The cap guard: cumulative POSTED credit notes against an object may never
 *     exceed the object's gross — a credit note cannot over-credit it.
 *  2. The balanced mirror (sign-flipped, scaled by `gross/originalGross`), with
 *     the rounding residual absorbed on the counterparty line (AR/AP) so the
 *     voucher balances EXACTLY in both amount and base_amount.
 *  3. Locked-period REDIRECTION (ADR-0009), reusing PeriodLockService: a credit
 *     note dated into a locked period is re-dated into the current open period.
 *
 * A credit note is NOT a correction artifact: it sets neither `reverses_id` nor
 * `corrects_object_*`. The original document stays `posted`.
 */
@Injectable()
export class CreditNotesService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly postingService: PostingService,
    private readonly voucherLineRepository: VoucherLineRepository,
    private readonly accountService: AccountService,
    private readonly periodLock: PeriodLockService,
  ) {}

  async create(dto: CreateCreditNoteDto): Promise<CreditNote> {
    const table = dto.credits_object_type;

    // 1. Load + state-guard the credited object.
    const original = await this.loadOriginal(table, dto.credits_object_id);
    if (!original) {
      throw new NotFoundException(
        `${table} ${dto.credits_object_id} not found`,
      );
    }
    if (original.status !== 'posted') {
      throw new BadRequestException(
        `Cannot credit a ${original.status} ${table}: only a posted document can be credited`,
      );
    }
    if (original.voucher_id === null) {
      throw new BadRequestException(
        `${table} ${dto.credits_object_id} has no posted voucher to mirror`,
      );
    }

    // 2. Cap guard: cumulative posted credit notes must not exceed the gross.
    const priorGross = await this.sumPostedCreditNotes(
      table,
      dto.credits_object_id,
    );
    if (priorGross + dto.gross_amount > original.gross_amount) {
      const remaining = original.gross_amount - priorGross;
      throw new BadRequestException(
        `Credit note exceeds remaining creditable amount (requested ${dto.gross_amount}, remaining ${remaining})`,
      );
    }

    // 3. Period-lock redirect (ADR-0009): a credit note dated into a locked
    // period is re-dated into the current open period.
    const taxPointDate = await this.resolveTaxPointDate(dto.tax_point_date);

    // 4. Build the balanced, sign-flipped, scaled mirror voucher.
    const originalLines = await this.voucherLineRepository.getLinesByVoucherId(
      original.voucher_id,
    );
    const draft = await this.buildMirrorVoucher({
      table,
      originalGross: original.gross_amount,
      creditGross: dto.gross_amount,
      originalLines,
      taxPointDate,
      creditNoteNumber: dto.credit_note_number,
    });

    // 5. Post the voucher + insert the credit_note row atomically.
    const kind: CreditNoteKind =
      table === 'sales_invoice' ? 'sales' : 'purchase';
    const now = Date.now();

    // Resolve + validate OUTSIDE the transaction — the better-sqlite3 single
    // connection forbids reads (account resolution) inside an open transaction.
    const prepared = await this.postingService.prepare(draft);

    return this.db.transaction().execute(async (trx) => {
      const posted = await this.postingService.postVoucherTx(
        trx,
        prepared.draft,
        prepared.resolved,
      );

      const row = await trx
        .insertInto('credit_note')
        .values({
          kind,
          credits_object_type: table,
          credits_object_id: dto.credits_object_id,
          credit_note_number: dto.credit_note_number,
          gross_amount: dto.gross_amount,
          vat_amount: dto.vat_amount,
          currency: original.currency, // INHERITED from the original
          tax_point_date: taxPointDate,
          status: 'posted',
          voucher_id: posted.id,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return this.mapRow(row);
    });
  }

  async list(): Promise<CreditNote[]> {
    const rows = await this.db
      .selectFrom('credit_note')
      .selectAll()
      .orderBy('id')
      .execute();
    return rows.map((r) => this.mapRow(r));
  }

  async getById(id: number): Promise<CreditNote> {
    const row = await this.db
      .selectFrom('credit_note')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) {
      throw new NotFoundException(`CreditNote ${id} not found`);
    }
    return this.mapRow(row);
  }

  private async loadOriginal(
    table: 'sales_invoice' | 'expense',
    id: number,
  ): Promise<CreditedObject | undefined> {
    const row = await this.db
      .selectFrom(table)
      .select(['gross_amount', 'currency', 'status', 'voucher_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row ?? undefined;
  }

  private async sumPostedCreditNotes(
    table: 'sales_invoice' | 'expense',
    id: number,
  ): Promise<number> {
    const rows = await this.db
      .selectFrom('credit_note')
      .select('gross_amount')
      .where('credits_object_type', '=', table)
      .where('credits_object_id', '=', id)
      .where('status', '=', 'posted')
      .execute();
    return rows.reduce((sum, r) => sum + r.gross_amount, 0);
  }

  /**
   * Resolve the credit note's effective tax-point date (ADR-0009). If the
   * requested date is inside a locked period, redirect into the current open
   * period's start; if none is open, refuse. Otherwise the requested date stands.
   */
  private async resolveTaxPointDate(requested: string): Promise<string> {
    const lockedPeriod = await this.periodLock.findLockedPeriod(requested);
    if (!lockedPeriod) {
      return requested;
    }
    const openPeriod = await this.periodLock.getCurrentOpenPeriod();
    if (!openPeriod) {
      throw new ConflictException(
        `Cannot post a credit note into locked period ${lockedPeriod.name}: no open period to receive it`,
      );
    }
    return openPeriod.start_date;
  }

  /**
   * Build the sign-flipped, proportionally-scaled mirror of the original
   * voucher's lines, then absorb the rounding residual on the counterparty line
   * (AR for a sales invoice, AP for an expense) so the credit voucher balances
   * EXACTLY in both `amount` and `base_amount`.
   */
  private async buildMirrorVoucher(args: {
    table: 'sales_invoice' | 'expense';
    originalGross: number;
    creditGross: number;
    originalLines: VoucherLine[];
    taxPointDate: string;
    creditNoteNumber: string;
  }): Promise<DraftVoucher> {
    const {
      table,
      originalGross,
      creditGross,
      originalLines,
      taxPointDate,
      creditNoteNumber,
    } = args;

    const f = creditGross / originalGross;

    const accountIds = [...new Set(originalLines.map((l) => l.account_id))];
    const accounts = await this.accountService.getAccountsByIds(accountIds);
    const byId = new Map(accounts.map((a) => [a.id, a]));

    const counterpartyCode = COUNTERPARTY_CODE[table];

    const lines: DraftVoucherLine[] = originalLines.map((l) => {
      const account = byId.get(l.account_id);
      if (!account) {
        throw new Error(`Account ${l.account_id} not found`);
      }
      return {
        account_code: account.code,
        amount: Math.round(l.amount * f),
        currency: l.currency,
        base_amount: Math.round(l.base_amount * f),
        fx_rate: l.fx_rate,
        vat_code: l.vat_code, // inherited
        is_debit: !l.is_debit, // sign-flipped
      };
    });

    // Identify the counterparty line by ROLE (its account code), not position.
    const counterparty = lines.find((l) => l.account_code === counterpartyCode);
    if (!counterparty) {
      throw new Error(
        `Cannot identify the counterparty line (${counterpartyCode}) on the original voucher; refusing to post an unbalanced credit note`,
      );
    }

    // Residual = sum(debit) - sum(credit). Absorb it on the counterparty line so
    // both totals net to zero: subtract if the counterparty is a debit line,
    // add if it is a credit line.
    const amountImbalance = this.imbalance(lines, (l) => l.amount);
    const baseImbalance = this.imbalance(lines, (l) => l.base_amount);
    const sign = counterparty.is_debit ? -1 : 1;
    counterparty.amount += sign * amountImbalance;
    counterparty.base_amount += sign * baseImbalance;

    return {
      tax_point_date: taxPointDate,
      lines,
      reason: `credit note ${creditNoteNumber}`,
    };
  }

  private imbalance(
    lines: DraftVoucherLine[],
    pick: (l: DraftVoucherLine) => number,
  ): number {
    const debit = lines
      .filter((l) => l.is_debit)
      .reduce((s, l) => s + pick(l), 0);
    const credit = lines
      .filter((l) => !l.is_debit)
      .reduce((s, l) => s + pick(l), 0);
    return debit - credit;
  }

  private mapRow(row: {
    id: number;
    kind: string;
    credits_object_type: string;
    credits_object_id: number;
    credit_note_number: string;
    gross_amount: number;
    vat_amount: number;
    currency: string;
    tax_point_date: string;
    status: string;
    voucher_id: number | null;
    created_at: number;
    updated_at: number;
  }): CreditNote {
    return {
      id: row.id,
      kind: this.validateKind(row.kind),
      credits_object_type: this.validateObjectType(row.credits_object_type),
      credits_object_id: row.credits_object_id,
      credit_note_number: row.credit_note_number,
      gross_amount: row.gross_amount,
      vat_amount: row.vat_amount,
      currency: row.currency,
      tax_point_date: row.tax_point_date,
      status: this.validateStatus(row.status),
      voucher_id: row.voucher_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private validateKind(kind: string): CreditNote['kind'] {
    if (kind === 'sales' || kind === 'purchase') return kind;
    throw new Error(`Invalid credit note kind: ${kind}`);
  }

  private validateObjectType(t: string): CreditNote['credits_object_type'] {
    if (t === 'sales_invoice' || t === 'expense') return t;
    throw new Error(`Invalid credits_object_type: ${t}`);
  }

  private validateStatus(status: string): CreditNote['status'] {
    if (status === 'draft' || status === 'posted' || status === 'reversed') {
      return status;
    }
    throw new Error(`Invalid credit note status: ${status}`);
  }
}
