import {
  withCategoryList,
  withDocumentHints,
  withOrgIdentity,
} from './triage-instructions';

describe('withCategoryList', () => {
  const cats = [
    { key: 'software', label: 'Software', accountCode: 'EXPENSE_SOFTWARE' },
    { key: 'rent', label: 'Rent', accountCode: 'EXPENSE_RENT' },
  ];

  it('appends the exact valid category keys to the base instructions', () => {
    const out = withCategoryList('BASE PROMPT', cats);
    expect(out).toContain('BASE PROMPT');
    expect(out).toContain('software');
    expect(out).toContain('rent');
  });

  it('directs the model to choose exactly one and never invent a category', () => {
    const out = withCategoryList('BASE', cats);
    expect(out.toLowerCase()).toContain('exactly one');
    expect(out.toLowerCase()).toContain('never invent');
  });

  it('is a no-op suffix when there are no categories', () => {
    expect(withCategoryList('BASE', [])).toBe('BASE');
  });
});

describe('withDocumentHints', () => {
  it('appends non-empty hints', () => {
    const out = withDocumentHints('BASE', 'HINTBLOCK');
    expect(out).toContain('BASE');
    expect(out).toContain('HINTBLOCK');
  });

  it('returns the base unchanged for empty hints', () => {
    expect(withDocumentHints('BASE', '')).toBe('BASE');
    expect(withDocumentHints('BASE', '   ')).toBe('BASE');
  });
});

describe('withOrgIdentity (pure helper)', () => {
  it('appends org identity block to instructions', () => {
    const base = 'BASE INSTRUCTIONS';
    const result = withOrgIdentity(base, {
      name: 'Acme OÜ',
      vatNumber: 'EE123456789',
      iban: 'EE382200221020145685',
      directionHint: 'outgoing',
    });

    expect(result).toContain('BASE INSTRUCTIONS');
    expect(result).toContain('YOUR ORGANIZATION');
    expect(result).toContain('name="Acme OÜ"');
    expect(result).toContain('VAT="EE123456789"');
    expect(result).toContain('IBAN="EE382200221020145685"');
    expect(result).toContain('direction="outgoing"');
    expect(result).toContain('new_sales_invoice');
    expect(result).toContain('customer_proposal');
    expect(result).toContain('outgoing_signals');
  });

  it('substitutes "unknown" for null fields', () => {
    const result = withOrgIdentity('BASE', {
      name: null,
      vatNumber: null,
      iban: null,
      directionHint: 'incoming',
    });

    expect(result).toContain('name="unknown"');
    expect(result).toContain('VAT="unknown"');
    expect(result).toContain('IBAN="unknown"');
    expect(result).toContain('direction="incoming"');
    expect(result).toContain('new_expense');
  });

  it('references incoming supplier_proposal path when direction is incoming', () => {
    const result = withOrgIdentity('BASE', {
      name: 'Co',
      vatNumber: 'EE1',
      iban: 'EE123',
      directionHint: 'incoming',
    });

    expect(result).toContain('supplier_proposal');
    expect(result).toContain('new_expense');
  });
});
