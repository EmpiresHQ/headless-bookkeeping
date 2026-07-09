/**
 * Cross-domain query keys — the single source of truth once more than one
 * domain reads the same resource (bank + inbox both need entities/categories/
 * organization; inbox adds expenses/invoices/reporting-periods that Books and
 * Reports will adopt).
 *
 * COMPATIBILITY: entities/categories/organization literals predate this
 * factory (inline in queries/bank.ts since Plan 02) and MUST stay
 * byte-identical — existing invalidations and cached data key off them.
 */
export const sharedKeys = {
  entities: ['entities'] as const,
  categories: ['categories'] as const,
  organization: ['organization'] as const,
  expenses: ['expenses'] as const,
  invoices: ['invoices'] as const,
  reportingPeriods: ['reporting-periods'] as const,
};
