import {
  manualClassifySchema,
  supplierProposalSchema,
  triageResultSchema,
} from './types';

describe('manualClassifySchema — target-discriminated union (backward compatible)', () => {
  it('accepts a legacy expense payload with NO target (defaults to expense arm)', () => {
    const parsed = manualClassifySchema.parse({
      supplier_id: 3,
      category: 'transport',
      document_vat_marking: null,
      gross_amount: 1525,
      vat_amount: 285,
      currency: 'EUR',
      tax_point_date: '2026-03-15',
      supplier_invoice_number: null,
    });
    // No discriminant on a legacy payload — the expense arm matched.
    expect('supplier_id' in parsed).toBe(true);
    expect((parsed as { target?: string }).target).toBeUndefined();
  });

  it('accepts an explicit target:expense payload', () => {
    const parsed = manualClassifySchema.parse({
      target: 'expense',
      supplier_id: 3,
      category: 'transport',
      document_vat_marking: null,
      gross_amount: 1525,
      vat_amount: 285,
      currency: 'EUR',
      tax_point_date: '2026-03-15',
    });
    expect((parsed as { target?: string }).target).toBe('expense');
  });

  it('accepts a target:sales_invoice payload', () => {
    const parsed = manualClassifySchema.parse({
      target: 'sales_invoice',
      customer_id: 7,
      invoice_number: 'INV-77',
      gross_amount: 12200,
      vat_amount: 2200,
      currency: 'EUR',
      tax_point_date: '2026-06-01',
      document_vat_marking: null,
    });
    expect(parsed).toMatchObject({
      target: 'sales_invoice',
      invoice_number: 'INV-77',
    });
  });

  it('rejects a sales_invoice payload missing the required invoice_number', () => {
    expect(() =>
      manualClassifySchema.parse({
        target: 'sales_invoice',
        gross_amount: 12200,
        vat_amount: 2200,
        currency: 'EUR',
        tax_point_date: '2026-06-01',
      }),
    ).toThrow();
  });
});

describe('triageResultSchema — sales-invoice kind, outgoing_signals, document_type', () => {
  it('accepts kind new_sales_invoice with a customer_proposal and outgoing_signals', () => {
    const parsed = triageResultSchema.parse({
      kind: 'new_sales_invoice',
      gross_amount: 12200,
      vat_amount: 2200,
      tax_point_date: '2026-06-01',
      category: 'revenue',
      document_type: 'invoice',
      customer_proposal: { mode: 'match', match_entity_id: 7 },
      outgoing_signals: { org_name_is_issuer: true, org_vat_is_issuer: true },
    });
    expect(parsed.kind).toBe('new_sales_invoice');
    expect(parsed.customer_proposal).toEqual({
      mode: 'match',
      match_entity_id: 7,
    });
    expect(parsed.outgoing_signals.has_buyer_block).toBe(false); // defaulted
  });

  it('defaults document_type to "other" and outgoing_signals to all-false', () => {
    const parsed = triageResultSchema.parse({
      kind: 'new_expense',
      gross_amount: 100,
      vat_amount: 0,
      tax_point_date: '2026-06-01',
      category: 'EXPENSE_OTHER',
    });
    expect(parsed.document_type).toBe('other');
    expect(parsed.outgoing_signals).toEqual({
      org_name_is_issuer: false,
      org_vat_is_issuer: false,
      has_buyer_block: false,
      self_identifies_as_invoice: false,
    });
  });
});

/**
 * The supplier_proposal contract (ADR-0014 / ADR-0024 friction #7): the Zod
 * discriminated union must admit EXACTLY ONE of
 *   { mode: 'match', match_entity_id }
 *   { mode: 'create', create_name, create_country, create_registration_key }
 * and reject ambiguous / half-filled / empty shapes — so an invalid proposal
 * fails validation (→ the bounded-retry → needs_triage path) and "only
 * schema-validated structured output crosses into the kernel".
 */
describe('supplierProposalSchema (discriminated union)', () => {
  it('accepts a valid match proposal', () => {
    const parsed = supplierProposalSchema.safeParse({
      mode: 'match',
      match_entity_id: 42,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.mode).toBe('match');
    }
  });

  it('accepts a valid create proposal (name + country + registration key)', () => {
    const parsed = supplierProposalSchema.safeParse({
      mode: 'create',
      create_name: 'Acme Ltd',
      create_country: 'IE',
      create_registration_key: 'IE1234567',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.mode === 'create') {
      expect(parsed.data.create_name).toBe('Acme Ltd');
      expect(parsed.data.create_country).toBe('IE');
      expect(parsed.data.create_registration_key).toBe('IE1234567');
    }
  });

  it('accepts a create proposal without a registration key (all identifiers nullable)', () => {
    const parsed = supplierProposalSchema.safeParse({
      mode: 'create',
      create_name: 'Acme Ltd',
      create_country: 'IE',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.mode === 'create') {
      expect(parsed.data.create_registration_key).toBeNull();
    }
  });

  it('rejects a proposal with no mode discriminant', () => {
    const parsed = supplierProposalSchema.safeParse({ match_entity_id: 42 });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty proposal', () => {
    const parsed = supplierProposalSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('rejects an ambiguous proposal mixing match + create fields', () => {
    // mode: 'match' but ALSO carrying create_* fields. The match branch is a
    // closed object that does not admit create_name/create_country, AND it
    // requires match_entity_id which is absent here.
    const parsed = supplierProposalSchema.safeParse({
      mode: 'match',
      create_name: 'Acme Ltd',
      create_country: 'IE',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a half-filled create proposal (name only)', () => {
    const parsed = supplierProposalSchema.safeParse({
      mode: 'create',
      create_name: 'Acme Ltd',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a half-filled create proposal (empty country)', () => {
    const parsed = supplierProposalSchema.safeParse({
      mode: 'create',
      create_name: 'Acme Ltd',
      create_country: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a match proposal with a non-positive entity id', () => {
    const parsed = supplierProposalSchema.safeParse({
      mode: 'match',
      match_entity_id: 0,
    });
    expect(parsed.success).toBe(false);
  });

  describe('create proposal — nullable identifiers (multi-key dedup)', () => {
    it('parses a create proposal with NO registration key but an email', () => {
      const parsed = supplierProposalSchema.parse({
        mode: 'create',
        create_name: 'Anomaly',
        create_country: 'US',
        create_email: 'help@anoma.ly',
      });
      expect(parsed).toMatchObject({
        mode: 'create',
        create_registration_key: null,
        create_email: 'help@anoma.ly',
        create_phone: null,
        create_address: null,
      });
    });

    it('still parses a create proposal with only a registration key', () => {
      const parsed = supplierProposalSchema.parse({
        mode: 'create',
        create_name: 'Acme OÜ',
        create_country: 'EE',
        create_registration_key: 'EE100200300',
      });
      expect(parsed.mode).toBe('create');
      if (parsed.mode === 'create') {
        expect(parsed.create_registration_key).toBe('EE100200300');
        expect(parsed.create_email).toBeNull();
      }
    });
  });
});

describe('triageResultSchema supplier_proposal integration', () => {
  const base = {
    kind: 'new_expense' as const,
    document_type: 'receipt' as const,
    gross_amount: 1525,
    vat_amount: 285,
    currency: 'EUR',
    tax_point_date: '2026-03-15',
    category: 'transport',
    document_vat_marking: 'IE_INPUT_23',
    supplier_invoice_number: null,
    confidence: 0.94,
  };

  it('accepts a TriageResult with no supplier_proposal (optional)', () => {
    expect(triageResultSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a TriageResult with a valid match supplier_proposal', () => {
    const parsed = triageResultSchema.safeParse({
      ...base,
      supplier_proposal: { mode: 'match', match_entity_id: 7 },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a TriageResult with a valid create supplier_proposal', () => {
    const parsed = triageResultSchema.safeParse({
      ...base,
      supplier_proposal: {
        mode: 'create',
        create_name: 'New Supplier',
        create_country: 'IE',
        create_registration_key: 'IE7654321',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a TriageResult whose supplier_proposal is ambiguous/half-filled', () => {
    const parsed = triageResultSchema.safeParse({
      ...base,
      // Half-filled create (no country) — must invalidate the whole result so
      // the kernel never receives an under-specified proposal.
      supplier_proposal: { mode: 'create', create_name: 'New Supplier' },
    });
    expect(parsed.success).toBe(false);
  });
});
