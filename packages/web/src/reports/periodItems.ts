import type { Approval, PeriodWarning } from '../api';

/**
 * Period warning drill-down (issue #261). A pre-close warning bucket opens
 * ITS OWN objects — the typed (object_type, object_id) pairs the period's
 * warnings endpoint returned — at `/reports/periods/:id/undecided/:bucket`,
 * never the global Inbox/Books list. Period and bucket live in the URL, so
 * reload, direct entry and Back/Forward keep the scope.
 *
 * The list is LIVE: it reads the same warnings query the period card counts
 * from, so the card and the list always show one result.
 */
export type PeriodBucket =
  | 'approvals'
  | 'expense-drafts'
  | 'invoice-drafts'
  | 'other';

interface BucketDef {
  key: PeriodBucket;
  /** Screen title / short name. */
  title: string;
  /** Lower-case noun phrase for status lines. */
  noun: string;
  label: (n: number) => string;
  subtitle: string;
}

const KNOWN: {
  key: Exclude<PeriodBucket, 'other'>;
  match: (w: PeriodWarning) => boolean;
}[] = [
  { key: 'approvals', match: (w) => w.type === 'pending_approval' },
  {
    key: 'expense-drafts',
    match: (w) => w.type === 'unposted_draft' && w.object_type === 'expense',
  },
  {
    key: 'invoice-drafts',
    match: (w) =>
      w.type === 'unposted_draft' && w.object_type === 'sales_invoice',
  },
];

export const PERIOD_BUCKETS: Record<PeriodBucket, BucketDef> = {
  approvals: {
    key: 'approvals',
    title: 'Awaiting approval',
    noun: 'items awaiting approval',
    label: (n) => `${n} awaiting approval`,
    subtitle:
      'they enter the declaration only once approved — approving after close posts into the next open period',
  },
  'expense-drafts': {
    key: 'expense-drafts',
    title: 'Expense drafts',
    noun: 'unposted expense drafts',
    label: (n) => `${n} expense ${n === 1 ? 'draft' : 'drafts'} not posted`,
    subtitle: 'drafts are not part of the declaration',
  },
  'invoice-drafts': {
    key: 'invoice-drafts',
    title: 'Invoice drafts',
    noun: 'unposted invoice drafts',
    label: (n) => `${n} invoice ${n === 1 ? 'draft' : 'drafts'} not posted`,
    subtitle: 'drafts are not part of the declaration',
  },
  other: {
    key: 'other',
    title: 'Other flagged items',
    noun: 'other flagged items',
    label: (n) => `${n} other ${n === 1 ? 'item' : 'items'} flagged`,
    subtitle: 'review before closing',
  },
};

export const BUCKET_ORDER: PeriodBucket[] = [
  'approvals',
  'expense-drafts',
  'invoice-drafts',
  'other',
];

export function isPeriodBucket(v: unknown): v is PeriodBucket {
  return typeof v === 'string' && (BUCKET_ORDER as string[]).includes(v);
}

/** The bucket a warning belongs to. A shape this client does not know is
 *  `other` — visible, never silently dropped (issue #255). */
export function bucketOf(w: PeriodWarning): PeriodBucket {
  return KNOWN.find((b) => b.match(w))?.key ?? 'other';
}

/** The warnings of one bucket, in server order. */
export function bucketWarnings(
  warnings: PeriodWarning[],
  bucket: PeriodBucket,
): PeriodWarning[] {
  return warnings.filter((w) => bucketOf(w) === bucket);
}

export function periodHref(periodId: number): string {
  return `/reports/periods/${periodId}`;
}

export function periodItemsHref(
  periodId: number,
  bucket: PeriodBucket,
): string {
  return `${periodHref(periodId)}/undecided/${bucket}`;
}

const ITEMS_PATH =
  /^\/reports\/periods\/([1-9]\d*)\/undecided\/(approvals|expense-drafts|invoice-drafts|other)$/;

/** A period drill-down list pathname → its scope (null for anything else). */
export function parsePeriodItemsPath(
  path: string,
): { periodId: number; bucket: PeriodBucket } | null {
  const m = ITEMS_PATH.exec(path);
  return m ? { periodId: Number(m[1]), bucket: m[2] as PeriodBucket } : null;
}

export const isPeriodItemsPath = (path: string): boolean =>
  parsePeriodItemsPath(path) !== null;

/** Books detail of a warned object — null for an object type the client
 *  has no screen for. */
export function objectHref(objectType: string, id: number): string | null {
  if (objectType === 'expense') return `/books/expenses/${id}`;
  if (objectType === 'sales_invoice') return `/books/invoices/${id}`;
  return null;
}

export function objectLabel(objectType: string, id: number): string {
  if (objectType === 'expense') return `Expense #${id}`;
  if (objectType === 'sales_invoice') return `Invoice #${id}`;
  return `${objectType} #${id}`;
}

/**
 * The PENDING approval of exactly this warned object. `object_id` is the
 * object's own ID, never an approval ID, and IDs are per type: expense 12
 * and sales invoice 12 are different objects — the typed pair must match.
 * Other approval kinds (e.g. bank reconciliation matches) never match.
 * Several pending for one object (should not happen): the newest one.
 */
export function approvalFor(
  w: Pick<PeriodWarning, 'object_type' | 'object_id'>,
  approvals: Approval[],
): Approval | null {
  const found = approvals.filter(
    (a) =>
      a.status === 'pending' &&
      a.object_type === w.object_type &&
      a.object_id === w.object_id,
  );
  if (found.length === 0) return null;
  return found.reduce((a, b) => (b.id > a.id ? b : a));
}
