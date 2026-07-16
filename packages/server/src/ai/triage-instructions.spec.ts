import { withCategoryList, withDocumentHints } from './triage-instructions';

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
