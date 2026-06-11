import { supplierProposalSchema, triageResultSchema } from './types';

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

  it('rejects a create proposal without a registration key', () => {
    const parsed = supplierProposalSchema.safeParse({
      mode: 'create',
      create_name: 'Acme Ltd',
      create_country: 'IE',
    });
    expect(parsed.success).toBe(false);
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
