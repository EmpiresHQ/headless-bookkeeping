import { createListCategoriesTool } from './index';

describe('createListCategoriesTool', () => {
  it('returns the active plugin category keys (not a hardcoded list)', async () => {
    const categoryService = {
      list: jest.fn().mockResolvedValue([
        { key: 'software', label: 'Software', accountCode: 'EXPENSE_SOFTWARE' },
        { key: 'rent', label: 'Rent', accountCode: 'EXPENSE_RENT' },
      ]),
    };
    const tool = createListCategoriesTool(categoryService as never);
    const result = await tool.execute();
    expect(result).toEqual(['software', 'rent']);
  });
});
