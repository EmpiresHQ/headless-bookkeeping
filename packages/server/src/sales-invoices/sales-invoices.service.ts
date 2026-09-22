import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { DraftVoucher } from '../ledger/voucher/types';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import {
  SalesInvoice,
  SalesInvoiceStatus,
  CreateSalesInvoiceDto,
  PatchSalesInvoiceDraftInput,
  SERVICE_PLACE_RULES,
} from './types';
import type { ServicePlaceRule } from '../plugins/country-plugin.interface';
import { UnresolvedVatTreatmentError } from '../plugins/vat-treatment.errors';

/**
 * Whether a thrown error is the SQLite UNIQUE-constraint violation on
 * sales_invoice.invoice_number — a duplicate invoice number. Used by both
 * SalesInvoicesController (maps to 409) and ProposeDraftService (maps to
 * `duplicate-number` outcome → needs_triage).
 */
export function isInvoiceNumberConflict(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes('UNIQUE constraint failed') &&
    err.message.includes('invoice_number')
  );
}

@Injectable()
export class SalesInvoicesService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly projection: VoucherProjectionService,
  ) {}

  async createInvoice(dto: CreateSalesInvoiceDto): Promise<SalesInvoice> {
    const duplicate = await this.db
      .selectFrom('sales_invoice')
      .select('id')
      .where('invoice_number', '=', dto.invoice_number)
      .executeTakeFirst();
    if (duplicate) {
      throw new ConflictException(
        `Invoice number ${dto.invoice_number} already exists`,
      );
    }

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
        document_id: dto.document_id ?? null,
        supply_type: dto.supply_type ?? null,
        service_place_rule: dto.service_place_rule ?? 'general',
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

  async getInvoices(): Promise<(SalesInvoice & { reconciled: boolean })[]> {
    const rows = await this.db
      .selectFrom('sales_invoice')
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
   * reconciliation_match — i.e. the invoice's posted voucher is matched to a
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

  /**
   * Delete a sales invoice — ONLY while it is a `draft` (no approval, no posted
   * voucher). A posted invoice's voucher is immutable (correct via reversal);
   * a pending one must have its approval rejected first. Clears probe/junk drafts.
   */
  async deleteDraft(id: number): Promise<SalesInvoice> {
    const invoice = await this.getInvoiceById(id);
    if (invoice.status !== 'draft') {
      throw new ConflictException(
        `SalesInvoice ${id} is ${invoice.status}; only a draft invoice can be deleted ` +
          `(a posted voucher is immutable — correct via reversal; reject a pending approval first).`,
      );
    }
    await this.db.deleteFrom('sales_invoice').where('id', '=', id).execute();
    return invoice;
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
            .select(['country', 'goods_vs_services', 'tax_status'])
            .where('id', '=', invoice.customer_id)
            .executeTakeFirst()
        : undefined;

    if (invoice.customer_id !== null && !customer) {
      // The invoice names a customer we cannot read. Falling through here would
      // hand the projection no country, and the projection's "no counterparty ⇒
      // domestic" fallback would quietly book a foreign sale at Estonian 24%.
      // A named-but-missing customer is a broken fact, not a domestic one.
      // Defense in depth: the sales_invoice.customer_id FK already makes this
      // unreachable through the database, so this guards the case where a row
      // arrives by some other route — it must never resolve to "domestic".
      throw new UnresolvedVatTreatmentError({
        code: 'customer_entity_missing',
        message:
          `Sales invoice ${invoice.id} names customer ${invoice.customer_id}, ` +
          `but no such entity exists — its country and tax status cannot be read.`,
        missingFacts: [`entity ${invoice.customer_id}`],
        howToResolve:
          'Point the invoice at an existing customer entity (POST /api/entities ' +
          'to create one), then post it again.',
      });
    }

    return this.projection.project(
      {
        category: 'revenue',
        grossAmount: invoice.gross_amount,
        vatAmount: invoice.vat_amount,
        currency: invoice.currency,
        taxPointDate: invoice.tax_point_date,
        ...(invoice.supply_type && { supplyType: invoice.supply_type }),
        servicePlaceRule: invoice.service_place_rule,
        ...(customer && {
          supplierCountry: customer.country,
          goodsVsServices: this.normalizeGoodsVsServices(
            customer.goods_vs_services,
          ),
          taxStatus: this.normalizeTaxStatus(customer.tax_status),
        }),
      },
      'sale',
    );
  }

  /**
   * Map the customer's stored tax status onto the plugin enum. A NULL column
   * (never recorded) and a literal 'unknown' mean the same thing and are kept
   * distinct from 'non_taxable' — the plugin refuses on unknown rather than
   * treating the customer as a consumer.
   */
  private normalizeTaxStatus(
    value: string | null,
  ): 'taxable_business' | 'non_taxable' | 'unknown' {
    return value === 'taxable_business' || value === 'non_taxable'
      ? value
      : 'unknown';
  }

  /**
   * A fingerprint of every fact a draft voucher for this invoice is derived
   * from — the invoice's own amounts/currency/tax point/supply facts AND the
   * customer facts that decide its VAT treatment (issue #209).
   *
   * Taken before the draft is generated and re-checked inside the posting
   * transaction, it closes the reverse-order race the status claim cannot see:
   * generate a draft → correct the draft (still `draft`) → post. The status is
   * unchanged, so the claim succeeds, and without this the OLD draft would post
   * against the NEW invoice. `status` is deliberately NOT part of it: the
   * transition claims that separately, and including it would fight the claim.
   */
  async draftFactsFingerprint(
    id: number,
    executor: Kysely<Database> = this.db,
  ): Promise<string> {
    const invoice = await executor
      .selectFrom('sales_invoice')
      .select([
        'id',
        'customer_id',
        'gross_amount',
        'vat_amount',
        'currency',
        'tax_point_date',
        'supply_type',
        'service_place_rule',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!invoice) {
      throw new NotFoundException(`SalesInvoice ${id} not found`);
    }
    const customer =
      invoice.customer_id !== null
        ? await executor
            .selectFrom('entity')
            .select(['id', 'country', 'goods_vs_services', 'tax_status'])
            .where('id', '=', invoice.customer_id)
            .executeTakeFirst()
        : undefined;
    // The organisation's OWN registration is a fact the sale's classifier reads
    // (issue #211): the EE plugin refuses to auto-classify a sale made under a
    // LIMITED registration, which charges no Estonian VAT on its own supplies.
    // Without this, a draft prepared under an ordinary registration would still
    // post after the registration was switched — the invoice and the customer
    // both unchanged, so the guard would see nothing move.
    const org = await executor
      .selectFrom('organization')
      .select(['country', 'vat_registered', 'vat_registration_kind'])
      .executeTakeFirst();
    return JSON.stringify([invoice, customer ?? null, org ?? null]);
  }

  /**
   * Refuse the write when the facts moved under an already-generated draft.
   * Runs on the posting transaction's executor, so the comparison and the write
   * see one consistent state.
   */
  async assertDraftFactsUnchangedTx(
    trx: Kysely<Database>,
    id: number,
    expected: string,
  ): Promise<void> {
    const actual = await this.draftFactsFingerprint(id, trx);
    if (actual !== expected) {
      throw new ConflictException(
        `Sales invoice ${id} was changed while it was being posted (its own ` +
          `facts, the customer's, or the organisation's VAT registration), so ` +
          `the prepared entry no longer matches it. Nothing was posted or held — ` +
          `post it again and the entry is recomputed from the current facts.`,
      );
    }
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

  /**
   * Patch a draft (or pending) invoice's amounts and supply facts.
   *
   * This is the supported remedy the refusals point at (issue #209): an invoice
   * whose `supply_type` / `service_place_rule` was stated wrongly, or whose VAT
   * amount contradicts its treatment, is corrected HERE and posted again — the
   * invoice number is unique, so re-creating it is not an option. A posted
   * invoice is refused: its voucher is immutable and is corrected by reversal.
   */
  async updateDraft(
    id: number,
    // `category` arrives from the corrections flow's shared amount patch and
    // is ignored: an invoice always posts to revenue.
    patch: PatchSalesInvoiceDraftInput & { category?: string },
  ): Promise<SalesInvoice> {
    const now = Math.floor(Date.now() / 1000);

    // Everything — the state check, the amount validation and the write — runs
    // inside ONE transaction, and the write CLAIMS the row conditionally
    // (`status IN (draft, pending) AND voucher_id IS NULL`). A status read taken
    // before the transaction would be a TOCTOU window: a post or an approval
    // landing in between would leave this UPDATE rewriting the financial facts
    // of an already-POSTED invoice and resetting its voucher_id, silently
    // detaching an immutable voucher from the object it was projected from
    // (ADR-0021 uses the same conditional-claim shape for the posting path).
    const row = await this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('sales_invoice')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!current) {
        throw new NotFoundException(`SalesInvoice ${id} not found`);
      }
      this.assertEditable(id, current.status);
      this.assertPatchedAmounts(id, current, patch);
      await this.assertIdentityPatch(trx, id, current, patch);

      const updated = await trx
        .updateTable('sales_invoice')
        .set({
          ...(patch.invoice_number !== undefined && {
            invoice_number: patch.invoice_number,
          }),
          ...(patch.customer_id !== undefined && {
            customer_id: patch.customer_id,
          }),
          ...(patch.currency !== undefined && { currency: patch.currency }),
          ...(patch.tax_point_date !== undefined && {
            tax_point_date: patch.tax_point_date,
          }),
          ...(patch.due_date !== undefined && { due_date: patch.due_date }),
          ...(patch.gross_amount !== undefined && {
            gross_amount: patch.gross_amount,
          }),
          ...(patch.vat_amount !== undefined && {
            vat_amount: patch.vat_amount,
          }),
          ...(patch.supply_type !== undefined && {
            supply_type: patch.supply_type,
          }),
          ...(patch.service_place_rule !== undefined && {
            service_place_rule: patch.service_place_rule,
          }),
          ...(current.status === 'pending' && {
            status: 'draft',
            voucher_id: null,
          }),
          updated_at: now,
        })
        .where('id', '=', id)
        // The claim: only an editable, voucher-less row is touched. Zero rows
        // means the state changed under us — nothing is written.
        .where('status', 'in', ['draft', 'pending'])
        .where('voucher_id', 'is', null)
        .returningAll()
        .executeTakeFirst();

      if (!updated) {
        const actual = await trx
          .selectFrom('sales_invoice')
          .select(['status', 'voucher_id'])
          .where('id', '=', id)
          .executeTakeFirst();
        throw new ConflictException(
          `Cannot update draft: sales invoice ${id} is ` +
            `${actual?.status ?? 'gone'} (voucher ${String(actual?.voucher_id)}) ` +
            `— it changed while this edit was being applied, so nothing was changed.`,
        );
      }

      // Only once the editable row is actually claimed does the pending
      // approval it was holding get superseded — never on a row we did not win.
      if (current.status === 'pending') {
        const approval = await trx
          .updateTable('approval')
          .set({
            status: 'superseded',
            resolved_at: now,
          })
          .where('object_type', '=', 'sales_invoice')
          .where('object_id', '=', id)
          .where('status', '=', 'pending')
          .returning('id')
          .executeTakeFirst();

        if (approval) {
          await trx
            .updateTable('audit_finding')
            .set({
              status: 'resolved',
              resolved_at: now,
              transitioned_by: null,
              transition_reason: 'Draft updated; approval superseded',
            })
            .where('finding_type', '=', 'pending_approval')
            .where('referenced_object_type', '=', 'approval')
            .where('referenced_object_id', '=', approval.id)
            .where('status', '=', 'open')
            .execute();
        }
      }

      return updated;
    });

    return this.mapRow(row);
  }

  /**
   * Identity (number, customer) may change only on an invoice that has never
   * been sent — after that the customer holds a document with that identity,
   * and a different number or customer is a different invoice. A new number
   * must stay unique (the UNIQUE constraint is the backstop; this check gives
   * the caller a clear 409 first). A changed customer must exist and be one.
   */
  private async assertIdentityPatch(
    trx: Kysely<Database>,
    id: number,
    current: {
      invoice_number: string;
      customer_id: number | null;
      sent_at: number | null;
    },
    patch: { invoice_number?: string; customer_id?: number | null },
  ): Promise<void> {
    const numberChanges =
      patch.invoice_number !== undefined &&
      patch.invoice_number !== current.invoice_number;
    const customerChanges =
      patch.customer_id !== undefined &&
      patch.customer_id !== current.customer_id;
    if (!numberChanges && !customerChanges) return;

    if (current.sent_at !== null) {
      const fields = [
        numberChanges && 'invoice_number',
        customerChanges && 'customer_id',
      ].filter(Boolean);
      throw new ConflictException(
        `Sales invoice ${id} has already been sent to the customer, so its ` +
          `identity (${fields.join(', ')}) is immutable: the customer holds a ` +
          `document with that number and addressee. Amounts, dates and supply ` +
          `facts remain editable while it is a draft.`,
      );
    }

    if (numberChanges) {
      const taken = await trx
        .selectFrom('sales_invoice')
        .select('id')
        .where('invoice_number', '=', patch.invoice_number!)
        .where('id', '!=', id)
        .executeTakeFirst();
      if (taken) {
        throw new ConflictException(
          `Invoice number ${patch.invoice_number} already exists`,
        );
      }
    }

    if (customerChanges && patch.customer_id != null) {
      const customer = await trx
        .selectFrom('entity')
        .select(['id', 'role'])
        .where('id', '=', patch.customer_id)
        .executeTakeFirst();
      if (!customer) {
        throw new UnprocessableEntityException(
          `customer_id: entity ${patch.customer_id} does not exist`,
        );
      }
      if (customer.role !== 'customer') {
        throw new UnprocessableEntityException(
          `customer_id: entity ${patch.customer_id} is a ${customer.role}, expected customer`,
        );
      }
    }
  }

  /** Only a draft (or a pending invoice, whose approval is then superseded) is editable. */
  private assertEditable(id: number, status: string): void {
    if (status !== 'draft' && status !== 'pending') {
      throw new ConflictException(
        `Cannot update draft: sales invoice ${id} is ${status} ` +
          `(a posted voucher is immutable — correct it via POST ` +
          `/api/sales-invoices/${id}/correct)`,
      );
    }
  }

  /**
   * Validate the amounts the invoice will HAVE, not the fields the caller
   * happened to send. A partial patch is a merge: sending `vat_amount: 5000`
   * alone against a gross of 1000 is a VAT charge larger than the invoice, and
   * per-field validation cannot see it because each field is fine on its own.
   */
  private assertPatchedAmounts(
    id: number,
    current: { gross_amount: number; vat_amount: number },
    patch: { gross_amount?: number; vat_amount?: number },
  ): void {
    const gross = patch.gross_amount ?? current.gross_amount;
    const vat = patch.vat_amount ?? current.vat_amount;
    if (gross <= 0) {
      throw new BadRequestException(
        `Sales invoice ${id}: gross_amount must be positive (would be ${gross})`,
      );
    }
    if (vat < 0) {
      throw new BadRequestException(
        `Sales invoice ${id}: vat_amount cannot be negative (would be ${vat})`,
      );
    }
    if (vat > gross) {
      throw new BadRequestException(
        `Sales invoice ${id}: vat_amount ${vat} would exceed gross_amount ` +
          `${gross} — the net would be negative.`,
      );
    }
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
    document_id: number | null;
    supply_type: string | null;
    service_place_rule: string;
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
      document_id: row.document_id,
      supply_type: this.validateSupplyType(row.supply_type),
      service_place_rule: this.validateServicePlaceRule(row.service_place_rule),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async findByDocumentId(
    documentId: number,
  ): Promise<SalesInvoice | undefined> {
    const row = await this.db
      .selectFrom('sales_invoice')
      .selectAll()
      .where('document_id', '=', documentId)
      .orderBy('id', 'asc')
      .executeTakeFirst();
    return row ? this.mapRow(row) : undefined;
  }

  private validateSupplyType(
    value: string | null,
  ): 'goods' | 'services' | null {
    if (value === null) return null;
    if (value === 'goods' || value === 'services') return value;
    throw new Error(`Invalid sales invoice supply_type: ${value}`);
  }

  private validateServicePlaceRule(value: string): ServicePlaceRule {
    const known = SERVICE_PLACE_RULES as readonly string[];
    if (known.includes(value)) return value as ServicePlaceRule;
    throw new Error(`Invalid sales invoice service_place_rule: ${value}`);
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
