import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import type {
  Approval,
  Entity,
  Expense,
  PeriodWarning,
  SalesInvoice,
} from '../api';
import { absoluteDateFromIso } from '../inbox/format';
import { useOriginState } from '../lib/returnNavigation';
import { entityName, shortDate } from '../queries/books';
import { usePendingApprovals } from '../queries/inbox';
import { periodTitle, usePeriodWarnings } from '../queries/reports';
import {
  useEntities,
  useExpenses,
  useInvoices,
  useReportingPeriods,
} from '../queries/shared';
import { ScreenHeader } from '../shell/Headers';
import { AmountText } from '../ui/AmountText';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { LinkButton } from '../ui/LinkButton';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError, RefetchError } from '../ui/LoadError';
import { CheckNotice, checkState, type CheckState } from './checkStatus';
import {
  approvalFor,
  bucketWarnings,
  isPeriodBucket,
  objectHref,
  objectLabel,
  PERIOD_BUCKETS,
  periodHref,
  type PeriodBucket,
} from './periodItems';

/** A list the rows join against: its load state decides how much a row may
 *  claim (a cached list proves nothing about deletion; a failed one says so).
 *  Row membership itself is ONLY the live warnings result. */
interface Lookup<T> {
  data: T[] | undefined;
  isError: boolean;
}

/** How far a join result can be trusted right now. */
type JoinState = 'loading' | 'failed' | 'current' | 'unconfirmed';

function joinState(q: Lookup<unknown>, check: CheckState): JoinState {
  if (q.data === undefined) return q.isError ? 'failed' : 'loading';
  return check === 'checked' ? 'current' : 'unconfirmed';
}

type Tone = 'ok' | 'warn' | 'err' | 'muted' | 'accent';

/** A row's short status chip plus its explanation. Chips never wrap, so they
 *  stay a word or two; the explanation wraps under them (320px screens). */
interface Flag {
  tone: Tone;
  chip: string;
  note?: string;
}

function objectFacts(
  w: PeriodWarning,
  lists: {
    expenses: { q: Lookup<Expense>; state: JoinState };
    invoices: { q: Lookup<SalesInvoice>; state: JoinState };
  },
  entities: Entity[],
): {
  title: string;
  subtitle: string | undefined;
  amount: { cents: number; currency: string } | null;
  flag: Flag | null;
} {
  const label = objectLabel(w.object_type, w.object_id);
  const list =
    w.object_type === 'expense'
      ? lists.expenses
      : w.object_type === 'sales_invoice'
        ? lists.invoices
        : null;
  if (list === null)
    return { title: label, subtitle: w.type, amount: null, flag: null };
  const { q, state } = list;
  if (q.data === undefined) {
    return {
      title: label,
      subtitle: undefined,
      amount: null,
      flag:
        state === 'failed'
          ? {
              tone: 'err',
              chip: 'No details',
              note: 'The Books list could not be loaded.',
            }
          : { tone: 'muted', chip: 'Loading details' },
    };
  }
  const missing = {
    title: label,
    subtitle: undefined,
    amount: null,
    flag:
      state === 'current'
        ? {
            tone: 'warn' as const,
            chip: 'Not in Books',
            note: 'Not in the Books list — it may have been deleted.',
          }
        : {
            tone: 'muted' as const,
            chip: 'Unconfirmed',
            note: 'Not in the last loaded Books list — not confirmed current.',
          },
  };
  if (w.object_type === 'expense') {
    const e = (q.data as Expense[]).find((x) => x.id === w.object_id);
    if (e === undefined) return missing;
    return {
      title: entityName(entities, e.supplier_id) ?? e.category,
      subtitle: `${label} · ${e.category} · ${shortDate(e.tax_point_date)}`,
      amount: { cents: -e.gross_amount, currency: e.currency },
      flag: null,
    };
  }
  const i = (q.data as SalesInvoice[]).find((x) => x.id === w.object_id);
  if (i === undefined) return missing;
  return {
    title: entityName(entities, i.customer_id) ?? i.invoice_number,
    subtitle: `${label} · ${i.invoice_number} · ${shortDate(i.tax_point_date)}`,
    amount: { cents: i.gross_amount, currency: i.currency },
    flag: null,
  };
}

/** Where an approval-bucket row leads: the exact pending approval of the
 *  typed object, else (stated) the object's Books record. */
function approvalTarget(
  w: PeriodWarning,
  approvalsQ: Lookup<Approval>,
  state: JoinState,
): { to: string | null; flag: Flag } {
  const record = objectHref(w.object_type, w.object_id);
  if (approvalsQ.data === undefined) {
    return {
      to: record,
      flag:
        state === 'failed'
          ? {
              tone: 'err',
              chip: 'Approval unknown',
              note: 'Approvals could not be loaded — opens the Books record.',
            }
          : { tone: 'muted', chip: 'Finding approval' },
    };
  }
  const a = approvalFor(w, approvalsQ.data);
  if (a === null) {
    return {
      to: record,
      flag:
        state === 'current'
          ? {
              tone: 'warn',
              chip: 'No approval',
              note: 'No pending approval found for it — opens the Books record.',
            }
          : {
              tone: 'muted',
              chip: 'Unconfirmed',
              note: 'No approval in the last loaded list — not confirmed current. Opens the Books record.',
            },
    };
  }
  return {
    to: `/inbox/approval/${a.id}`,
    flag: { tone: 'accent', chip: `Approval #${a.id}` },
  };
}

function Flags({ flags }: { flags: Flag[] }) {
  if (flags.length === 0) return null;
  return (
    <>
      <span className="flex flex-wrap gap-1">
        {flags.map((f) => (
          <Chip key={f.chip} tone={f.tone}>
            {f.chip}
          </Chip>
        ))}
      </span>
      {flags.map(
        (f) =>
          f.note !== undefined && (
            <span
              key={f.chip}
              className="mt-0.5 block text-[12px] text-ink-2 [overflow-wrap:anywhere]"
            >
              {f.note}
            </span>
          ),
      )}
    </>
  );
}

function Shell({
  title,
  backTo,
  children,
}: {
  title: string;
  backTo: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title={title} backTo={backTo} />
      {children}
    </div>
  );
}

/**
 * /reports/periods/:id/undecided/:bucket (issue #261): one pre-close warning
 * bucket of one period — exactly the typed objects the period check returns,
 * LIVE (the same warnings query the period card counts from, re-checked on
 * every entry). Each row opens one item on its own (#253: never a queue or
 * batch); the list is that item's recorded origin (#252), so a decided
 * approval returns here and the count re-checks.
 */
export function PeriodItemsScreen() {
  const { id, bucket: bucketParam } = useParams();
  const periodId = Number(id);
  const validId = Number.isInteger(periodId) && periodId > 0;
  const bucket: PeriodBucket | null = isPeriodBucket(bucketParam)
    ? bucketParam
    : null;
  const def = bucket !== null ? PERIOD_BUCKETS[bucket] : null;

  const periodsQ = useReportingPeriods();
  const period = validId
    ? (periodsQ.data ?? []).find((p) => p.id === periodId)
    : undefined;
  const open = period?.status === 'open';
  // Both reads are gated on the period list, which may still be loading:
  // `refetchOnMount` alone would not re-check when the gate opens over fresh
  // cached data (no fetch → never "fetched after mount" → stuck checking).
  // `staleTime: 0` on these observers makes enabling itself fetch.
  const warningsQ = usePeriodWarnings(periodId, open && bucket !== null, {
    refetchOnMount: 'always',
    staleTime: 0,
  });
  const approvalsQ = usePendingApprovals({
    enabled: open && bucket === 'approvals',
    refetchOnMount: 'always',
    staleTime: 0,
  });
  const expensesQ = useExpenses();
  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();
  const originState = useOriginState();

  const back = validId ? periodHref(periodId) : '/reports';

  if (!validId || def === null) {
    return (
      <Shell title="Period items" backTo={back}>
        <EmptyState
          icon="🔍"
          title="This list does not exist"
          hint="The link names no known period list."
          action={
            <LinkButton to={back} variant="secondary">
              {validId ? 'Return to the period' : 'Return to Reports'}
            </LinkButton>
          }
        />
      </Shell>
    );
  }

  if (periodsQ.isPending) {
    return (
      <Shell title={def.title} backTo={back}>
        <SkeletonRows count={4} />
      </Shell>
    );
  }
  if (periodsQ.isError && periodsQ.data === undefined) {
    return (
      <Shell title={def.title} backTo={back}>
        <LoadError
          message={
            periodsQ.error instanceof Error
              ? periodsQ.error.message
              : 'Failed to load periods'
          }
          onRetry={() => void periodsQ.refetch()}
        />
      </Shell>
    );
  }
  if (period === undefined) {
    return (
      <Shell title={def.title} backTo="/reports">
        <EmptyState
          icon="🔍"
          title="This period does not exist"
          hint="It may have been removed — go back to Reports"
          action={
            <LinkButton to="/reports" variant="secondary">
              Return to Reports
            </LinkButton>
          }
        />
      </Shell>
    );
  }

  const name = periodTitle(period.name);
  const returnButton = (
    <div className="mx-3.5 mb-3.5">
      <LinkButton to={back} variant="secondary" className="w-full">
        Return to {name}
      </LinkButton>
    </div>
  );
  const heading = (
    <div className="mb-3.5 px-5">
      <p className="text-[17px] font-bold">
        {name} · {def.title}{' '}
        <span className="align-[2px]">
          <Chip tone={open ? 'ok' : 'muted'}>{period.status}</Chip>
        </span>
      </p>
      <p className="text-[12.5px] text-ink-2">
        {absoluteDateFromIso(period.start_date)} –{' '}
        {absoluteDateFromIso(period.end_date)}
      </p>
    </div>
  );

  if (!open) {
    return (
      <Shell title={def.title} backTo={back}>
        {heading}
        <p className="mx-3.5 mb-3.5 rounded-2xl bg-surface px-4 py-3 text-[13px] text-ink-2">
          This period is closed. The undecided-items check runs only while a
          period is open — anything decided now goes into the next open period.
        </p>
        {returnButton}
      </Shell>
    );
  }

  const rows =
    warningsQ.data !== undefined ? bucketWarnings(warningsQ.data, def.key) : [];
  // afterMount: a cached result from before this entry is not "current".
  const state = checkState([warningsQ], true);
  const entities = entitiesQ.data ?? [];
  // Joins are checked like the warnings themselves (issue #255): stated,
  // retryable, and never a basis for "not found" unless current.
  const approvalsCheck = checkState([approvalsQ], true);
  const approvalsState = joinState(approvalsQ, approvalsCheck);
  const lists = {
    expenses: {
      q: expensesQ,
      state: joinState(expensesQ, checkState([expensesQ])),
    },
    invoices: {
      q: invoicesQ,
      state: joinState(invoicesQ, checkState([invoicesQ])),
    },
  };
  const detailQueries = [
    ...(rows.some((w) => w.object_type === 'expense') ? [expensesQ] : []),
    ...(rows.some((w) => w.object_type === 'sales_invoice') ? [invoicesQ] : []),
  ];

  return (
    <Shell title={def.title} backTo={back}>
      <RefetchError query={periodsQ} />
      {heading}
      <p className="mx-3.5 mb-3.5 rounded-2xl bg-tint px-4 py-3 text-[13px] text-accent">
        Live list — exactly the items this period&apos;s pre-close check
        currently reports as {def.noun}. Decided items drop out; new ones dated
        in the period appear. Each item opens on its own.
      </p>
      <CheckNotice what={def.noun} queries={[warningsQ]} afterMount />
      {bucket === 'approvals' && rows.length > 0 && (
        <CheckNotice
          what="the matching approvals"
          queries={[approvalsQ]}
          afterMount
        />
      )}
      {rows.length > 0 && detailQueries.length > 0 && (
        <CheckNotice what="item details" queries={detailQueries} />
      )}
      {rows.length > 0 && (
        <ListGroup>
          {rows.map((w) => {
            const facts = objectFacts(w, lists, entities);
            const target =
              def.key === 'approvals'
                ? approvalTarget(w, approvalsQ, approvalsState)
                : {
                    to: objectHref(w.object_type, w.object_id),
                    flag:
                      def.key === 'other'
                        ? {
                            tone: 'warn' as const,
                            chip: 'Unknown check',
                            note: `Flagged by a check this screen does not know (${w.type}).`,
                          }
                        : null,
                  };
            const flags = [target.flag, facts.flag].filter(
              (f): f is Flag => f !== null,
            );
            const chip = flags.length > 0 ? <Flags flags={flags} /> : undefined;
            const trailing =
              facts.amount !== null ? (
                <AmountText
                  cents={facts.amount.cents}
                  currency={facts.amount.currency}
                  className="block text-[14px]"
                />
              ) : undefined;
            const key = `${w.type}:${w.object_type}:${w.object_id}`;
            return target.to !== null ? (
              <ListRow
                key={key}
                to={target.to}
                state={originState}
                title={facts.title}
                subtitle={facts.subtitle}
                chip={chip}
                trailing={trailing}
              />
            ) : (
              <ListRow
                key={key}
                title={facts.title}
                subtitle={facts.subtitle}
                chip={chip}
                trailing={trailing}
              />
            );
          })}
        </ListGroup>
      )}
      {rows.length === 0 &&
        warningsQ.data !== undefined &&
        (state === 'checked' ? (
          <EmptyState
            icon="✓"
            title="Resolved"
            hint={`Nothing left: no ${def.noun} in ${name}.`}
          />
        ) : (
          <p className="mx-6 mb-3.5 text-[12.5px] text-ink-2">
            None in the last loaded result — not confirmed current.
          </p>
        ))}
      {returnButton}
    </Shell>
  );
}
