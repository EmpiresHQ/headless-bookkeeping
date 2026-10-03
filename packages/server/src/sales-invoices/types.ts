import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { BusinessObjectStatus } from '../common/types/business-object-status';
import type { ServicePlaceRule } from '../plugins/country-plugin.interface';
import {
  currencyCodeSchema,
  grossMinorSchema,
  isoDateSchema,
  draftEditObject,
  vatMinorSchema,
} from '../common/draft-edit';

/** The place-of-supply rules a caller may declare for a service invoice. */
export const SERVICE_PLACE_RULES = [
  'general',
  'immovable_property',
  'passenger_transport',
  'cultural_artistic_sporting_admission',
  'restaurant_catering',
  'short_term_hire_of_means_of_transport',
  'electronically_supplied_to_consumer',
  'other_special',
] as const;

export type SalesInvoiceStatus = BusinessObjectStatus;

export interface SalesInvoice {
  id: number;
  customer_id: number | null;
  invoice_number: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  due_date: string | null;
  status: SalesInvoiceStatus;
  sent_at: number | null;
  voucher_id: number | null;
  document_vat_marking: string | null;
  document_id: number | null;
  /** What this invoice supplies; null ⇒ inherit the customer's nature. */
  supply_type: 'goods' | 'services' | null;
  /** Place-of-supply rule declared for a service supply (KMS §10). */
  service_place_rule: ServicePlaceRule;
  created_at: number;
  updated_at: number;
}

export const createSalesInvoiceSchema = z.object({
  customer_id: z.number().int().nullable().optional(),
  invoice_number: z.string(),
  // Reject a non-positive document at CREATE — a zero/negative gross cannot be a
  // real invoice, and letting it through only surfaces a cryptic "amount must be
  // positive" at approve-time after the object is already stuck in pending (A1).
  gross_amount: z.number().positive(),
  vat_amount: z.number().nonnegative(),
  currency: z.string(),
  tax_point_date: z.string(),
  due_date: z.string().nullable().optional(),
  document_vat_marking: z.string().nullable().optional(),
  document_id: z.number().int().nullable().optional(),
  // What this invoice supplies (issue #209). Omitted ⇒ the customer entity's
  // goods_vs_services decides, which is how invoices were classified before.
  supply_type: z.enum(['goods', 'services']).nullable().optional(),
  // Which place-of-supply rule the CALLER declares for a service supply.
  // Omitted ⇒ 'general', the residual rule of KMS §10 lg 1 / lg 2 — so
  // declaring nothing means "the general rule applies", not "unknown". Any
  // named exception is refused at posting rather than auto-classified.
  service_place_rule: z.enum(SERVICE_PLACE_RULES).optional(),
});

export class CreateSalesInvoiceDto extends createZodDto(
  createSalesInvoiceSchema,
) {}

// Optional override body: a plain POST with no body must still validate, so an
// absent body (undefined/null) is treated as an empty object and both fields
// are optional. When supplied, an override carries both fields.
export const salesInvoicePostOverrideSchema = z.preprocess(
  (v) => v ?? {},
  z.object({
    ruleType: z.string().optional(),
    reason: z.string().optional(),
  }),
);

export class SalesInvoicePostOverrideDto extends createZodDto(
  salesInvoicePostOverrideSchema,
) {}

/** The facts an operator may correct on a draft/pending invoice (issues #209, #247). */
export const SALES_INVOICE_DRAFT_EDITABLE_FIELDS = [
  'invoice_number',
  'customer_id',
  'gross_amount',
  'vat_amount',
  'currency',
  'tax_point_date',
  'due_date',
  'supply_type',
  'service_place_rule',
] as const;

/**
 * Fields a draft edit refuses BY NAME, with the reason — never silently dropped.
 * `invoice_number` / `customer_id` are editable but only until the invoice has
 * been SENT (enforced in the service, 409): after that the customer holds a
 * document with that identity.
 */
const SALES_INVOICE_DRAFT_IMMUTABLE: Record<string, string> = {
  document_id:
    'document_id is the source document (provenance) and cannot be changed on an existing invoice',
  document_vat_marking:
    'document_vat_marking is read from the source document and cannot be edited',
  sent_at: 'sent_at changes only through POST /api/sales-invoices/:id/send',
  status: 'status changes only through submit/approve/reject, never by editing',
  voucher_id: 'voucher_id is owned by the posting pipeline',
  category: 'a sales invoice always posts to revenue; category is not editable',
  id: 'id is immutable',
};

/**
 * A draft-only correction of the facts a posting is derived from (issues
 * #209, #247).
 *
 * The refusals tell a caller to fix an invoice's supply facts or amounts and
 * post again, and a rejection asks for the same, so there has to be a
 * supported way to do exactly that on the SAME draft: the invoice number is
 * unique, so "create it again" is not a remedy. Only a `draft` (or a `pending`
 * one, whose approval is then superseded) can be patched — a POSTED invoice's
 * voucher is immutable and is corrected by reversal (ADR-0006), never by
 * editing the object underneath it.
 *
 * Identity (invoice number, customer) is patchable only while the invoice has
 * never been sent: once the customer holds the document, a different number or
 * customer is a different invoice (409). A new number must still be unique.
 */
export const patchSalesInvoiceDraftSchema = draftEditObject(
  {
    invoice_number: z.string().trim().min(1).max(100).optional(),
    customer_id: z.number().int().positive().nullable().optional(),
    gross_amount: grossMinorSchema.optional(),
    vat_amount: vatMinorSchema.optional(),
    currency: currencyCodeSchema.optional(),
    tax_point_date: isoDateSchema.optional(),
    due_date: isoDateSchema.nullable().optional(),
    supply_type: z.enum(['goods', 'services']).nullable().optional(),
    service_place_rule: z.enum(SERVICE_PLACE_RULES).optional(),
  },
  SALES_INVOICE_DRAFT_IMMUTABLE,
).refine(
  (v) => SALES_INVOICE_DRAFT_EDITABLE_FIELDS.some((k) => v[k] !== undefined),
  {
    message: `Supply at least one field to patch (${SALES_INVOICE_DRAFT_EDITABLE_FIELDS.join(', ')})`,
  },
);

export class PatchSalesInvoiceDraftDto extends createZodDto(
  patchSalesInvoiceDraftSchema,
) {}

export type PatchSalesInvoiceDraftInput = z.infer<
  typeof patchSalesInvoiceDraftSchema
>;
