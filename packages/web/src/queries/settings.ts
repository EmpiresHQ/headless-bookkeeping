import { useQuery, type QueryClient } from '@tanstack/react-query';
import {
  getEntity,
  getMailboxConnectors,
  getOrganization,
  getPolicyConfig,
  getSettings,
  type Entity,
  type EntityIdentifier,
  type EntityRole,
  type Expense,
  type SalesInvoice,
  type Setting,
} from '../api';
import { sharedKeys } from './keys';

/**
 * Settings data layer. Entity/category/organization READS ride the frozen
 * sharedKeys (bank/inbox/books already populate them); this module adds the
 * Settings-only reads and the PURE model (role segments, alias kinds, entity
 * stats, classification-memory derivation) so everything is unit-testable
 * without React. NO refetchInterval anywhere here (Global Constraints).
 */
export const settingsKeys = {
  all: ['settings'] as const,
  admin: ['settings', 'admin'] as const,
  policy: ['settings', 'policy-config'] as const,
  mailbox: ['settings', 'mailbox-connectors'] as const,
};

/** Detail nests under the FROZEN entities prefix so sharedKeys.entities
 *  prefix-invalidation covers list AND details. */
export const entityDetailKey = (id: number) =>
  [...sharedKeys.entities, 'detail', id] as const;

// ── Hooks ──────────────────────────────────────────────────────────────────

/** Full organization object — same cache entry as useOrganizationCountry
 *  (identical key + fn; that hook merely selects country). */
export const useOrganization = () =>
  useQuery({ queryKey: sharedKeys.organization, queryFn: getOrganization });

export const settingsMap = (list: Setting[]): Record<string, string> =>
  Object.fromEntries(list.map((s) => [s.key, s.value]));

/** All admin settings as a key→value record (Reality #2: 19 known keys,
 *  string values). */
export const useAdminSettings = () =>
  useQuery({
    queryKey: settingsKeys.admin,
    queryFn: getSettings,
    select: settingsMap,
  });

export const usePolicyConfig = () =>
  useQuery({ queryKey: settingsKeys.policy, queryFn: getPolicyConfig });

export const useMailboxConnectors = () =>
  useQuery({ queryKey: settingsKeys.mailbox, queryFn: getMailboxConnectors });

export const useEntityDetail = (id: number, enabled = true) =>
  useQuery({
    queryKey: entityDetailKey(id),
    queryFn: () => getEntity(id),
    enabled,
  });

// ── Invalidation (Global Constraints fan-outs) ─────────────────────────────

export const invalidateEntities = (qc: QueryClient): Promise<void> =>
  // Prefix covers the list AND every ['entities','detail',id]; Books/Inbox
  // name-joins read through the same shared key.
  qc.invalidateQueries({ queryKey: sharedKeys.entities });

export const invalidateOrganization = (qc: QueryClient): Promise<void> =>
  Promise.all([
    qc.invalidateQueries({ queryKey: sharedKeys.organization }),
    // period-config (frequency options) and final-download eligibility (VAT
    // registration number) are org-derived Reports inputs (Reality #1).
    qc.invalidateQueries({ queryKey: ['reports'] }),
  ]).then(() => undefined);

export const invalidateAdminSettings = (qc: QueryClient): Promise<void> =>
  qc.invalidateQueries({ queryKey: settingsKeys.admin });

export const invalidateMailbox = (qc: QueryClient): Promise<void> =>
  Promise.all([
    qc.invalidateQueries({ queryKey: settingsKeys.mailbox }),
    // A sync harvests documents straight into the triage queue.
    qc.invalidateQueries({ queryKey: ['inbox'] }),
  ]).then(() => undefined);

export const invalidatePolicy = (qc: QueryClient): Promise<void> =>
  qc.invalidateQueries({ queryKey: settingsKeys.policy });

// ── Pure model ─────────────────────────────────────────────────────────────

export const ROLE_LABEL: Record<EntityRole, string> = {
  supplier: 'Supplier',
  customer: 'Customer',
  employee: 'Employee',
  director: 'Director',
};

/** Chip tones per role — suppliers/customers neutral, team accent (they are
 *  the ADR-0036 claimants, visually distinct per asset §8). */
export const ROLE_TONE: Record<EntityRole, 'muted' | 'accent'> = {
  supplier: 'muted',
  customer: 'muted',
  employee: 'accent',
  director: 'accent',
};

/** ADR-0036: a claimant is an entity with one of these roles. */
export const CLAIMANT_ROLES: readonly EntityRole[] = ['employee', 'director'];

export const ENTITY_SEGMENTS = [
  'all',
  'suppliers',
  'customers',
  'team',
] as const;
export type EntitySegment = (typeof ENTITY_SEGMENTS)[number];

export function segmentEntities(
  entities: Entity[],
  seg: EntitySegment,
): Entity[] {
  switch (seg) {
    case 'all':
      return entities;
    case 'suppliers':
      return entities.filter((e) => e.role === 'supplier');
    case 'customers':
      return entities.filter((e) => e.role === 'customer');
    case 'team':
      return entities.filter((e) =>
        (CLAIMANT_ROLES as readonly string[]).includes(e.role),
      );
  }
}

export function entityMatchesQuery(e: Entity, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === '') return true;
  return e.name.toLowerCase().includes(needle);
}

export function identifierOf(e: Entity, kind: string): string | null {
  const hit = (e.identifiers ?? []).find((i) => i.kind === kind);
  return hit?.value ?? null;
}

/** The addable alias kinds (Reality #5: the aliases endpoint accepts exactly
 *  these three) — identity kinds (registration_key/email/…) are NOT aliases. */
export const ALIAS_KIND_LABEL: Record<string, string> = {
  iban: 'IBAN',
  merchant_descriptor: 'Bank-line descriptor',
  name_alias: 'Name alias',
};

export function aliasesOf(e: Entity): EntityIdentifier[] {
  return (e.identifiers ?? []).filter((i) => i.kind in ALIAS_KIND_LABEL);
}

/** Linked-bookings stat for the entity card (asset §8: «Расходов 12 ·
 *  −680,40 € ›»). Non-draft only (drafts are not bookings — Books total
 *  discipline, P04). Team roles: the expense list rows carry no claimant
 *  linkage — no stat rather than a fake one. */
export function entityStats(
  expenses: Expense[],
  invoices: SalesInvoice[],
  e: Entity,
): { label: string; count: number; totalCents: number } | null {
  if (e.role === 'supplier') {
    const rows = expenses.filter(
      (x) => x.supplier_id === e.id && x.status !== 'draft',
    );
    return {
      label: 'Expenses',
      count: rows.length,
      totalCents: rows.reduce((s, x) => s + x.gross_amount, 0),
    };
  }
  if (e.role === 'customer') {
    const rows = invoices.filter(
      (x) => x.customer_id === e.id && x.status !== 'draft',
    );
    return {
      label: 'Invoices',
      count: rows.length,
      totalCents: rows.reduce((s, x) => s + x.gross_amount, 0),
    };
  }
  return null;
}

/**
 * Client-side classification memory (asset §8): "usually <category>
 * (count of of)". Derived from POSTED expenses of this supplier — the same
 * evidence the server's internal AI tool gathers (Reality #6); labeled an
 * AI hint, not a rule (ADR-0014 advisory). Null when there is no evidence.
 */
export function classificationMemory(
  expenses: Expense[],
  entityId: number,
): { category: string; count: number; of: number } | null {
  const posted = expenses.filter(
    (x) => x.supplier_id === entityId && x.status === 'posted',
  );
  if (posted.length === 0) return null;
  const counts = new Map<string, number>();
  for (const x of posted)
    counts.set(x.category, (counts.get(x.category) ?? 0) + 1);
  let top: { category: string; count: number } | null = null;
  for (const [category, count] of counts)
    if (top === null || count > top.count) top = { category, count };
  return top === null
    ? null
    : { category: top.category, count: top.count, of: posted.length };
}
