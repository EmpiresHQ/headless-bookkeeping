import { BadRequestException } from '@nestjs/common';
import { CategoryService } from './category.service';

function makeService(categories: { key: string; label: string; accountCode: string }[]) {
  const plugin = { getCategories: () => categories };
  const pluginLoader = { resolve: jest.fn().mockReturnValue(plugin) };
  const organizationService = {
    getOrganization: jest.fn().mockResolvedValue({ country: 'IE' }),
  };
  return new CategoryService(pluginLoader as never, organizationService as never);
}

const CATS = [
  { key: 'software', label: 'Software', accountCode: 'EXPENSE_SOFTWARE' },
  { key: 'rent', label: 'Rent', accountCode: 'EXPENSE_RENT' },
];

describe('CategoryService', () => {
  it('list() returns the active plugin categories', async () => {
    const svc = makeService(CATS);
    expect(await svc.list()).toEqual(CATS);
  });
  it('isValid() is true for a known key, false otherwise', async () => {
    const svc = makeService(CATS);
    expect(await svc.isValid('software')).toBe(true);
    expect(await svc.isValid('not-a-category')).toBe(false);
  });
  it('assertValid() throws BadRequestException for an unknown category', async () => {
    const svc = makeService(CATS);
    await expect(svc.assertValid('garbage')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.assertValid('software')).resolves.toBeUndefined();
  });
});
