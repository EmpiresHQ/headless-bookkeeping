import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fmtCents, type ReportingPeriod } from '../api';
import { absoluteDateFromIso } from '../inbox/format';
import {
  currentOpen,
  netVatLabel,
  oldestOpen,
  periodTitle,
  sortPeriodsNewestFirst,
  submissionLine,
  SUBMISSION_STATUS,
  useKmd,
  useSubmissionStates,
} from '../queries/reports';
import { useReportingPeriods } from '../queries/shared';
import { LargeTitleHeader } from '../shell/Headers';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { GroupHeader } from '../ui/GroupHeader';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { Button } from '../ui/Button';
import { NewPeriodSheet } from './NewPeriodSheet';

const dateRange = (p: Pick<ReportingPeriod, 'start_date' | 'end_date'>) =>
  `${absoluteDateFromIso(p.start_date)} – ${absoluteDateFromIso(p.end_date)}`;

/** Hero for the CURRENT open period: identity + a live net-VAT line from the
 *  derived declaration (Reality #5). The whole card navigates to the detail. */
function CurrentPeriodHero({ period }: { period: ReportingPeriod }) {
  const kmdQ = useKmd(period.id);
  const net = kmdQ.data?.net_vat_due;
  return (
    <Link
      to={`/reports/periods/${period.id}`}
      viewTransition
      className="mx-3.5 mb-3.5 block rounded-2xl bg-accent-deep p-4 text-white"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-[19px] font-extrabold">
          {periodTitle(period.name)}
        </span>
        <Chip tone="ok">open</Chip>
      </div>
      <p className="mt-0.5 text-[12.5px] text-white/70">{dateRange(period)}</p>
      <p className="mt-2 whitespace-nowrap text-[14px] font-bold tabular-nums">
        {net === undefined
          ? 'Live declaration ›'
          : `${netVatLabel(net)} so far · ${fmtCents(Math.abs(net))} €`}
      </p>
    </Link>
  );
}

/** /reports — the periods list. Current open period as a hero; every other
 *  period one row with ONE honest status line: open / open — file first /
 *  the folded submission state (ADR-0037, asset §7 decision 6). */
export function ReportsScreen() {
  const periodsQ = useReportingPeriods();
  const [newOpen, setNewOpen] = useState(false);

  const periods = sortPeriodsNewestFirst(periodsQ.data ?? []);
  const current = currentOpen(periods);
  const oldest = oldestOpen(periods);
  const lockedIds = periods
    .filter((p) => p.status === 'locked')
    .map((p) => p.id);
  const submissionStates = useSubmissionStates(lockedIds);

  const rows = periods.filter((p) => p.id !== current?.id);
  const byYear = new Map<string, ReportingPeriod[]>();
  for (const p of rows) {
    const year = p.start_date.slice(0, 4);
    const bucket = byYear.get(year);
    if (bucket) bucket.push(p);
    else byYear.set(year, [p]);
  }

  const statusChipFor = (p: ReportingPeriod) => {
    if (p.status === 'open') {
      return p.id === oldest?.id && p.id !== current?.id ? (
        <Chip tone="warn">open — file first</Chip>
      ) : (
        <Chip tone="ok">open</Chip>
      );
    }
    const state = submissionStates.get(p.id);
    if (state === undefined) return <Chip tone="muted">locked</Chip>;
    return (
      <Chip tone={SUBMISSION_STATUS[state.status].tone}>
        {submissionLine(state)}
      </Chip>
    );
  };

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <LargeTitleHeader
        title="Reports"
        trailing={
          <Button variant="secondary" onClick={() => setNewOpen(true)}>
            ＋ New period
          </Button>
        }
      />
      {periodsQ.isPending && <SkeletonRows count={4} />}
      {periodsQ.isError && (
        <LoadError
          message={
            periodsQ.error instanceof Error
              ? periodsQ.error.message
              : 'Failed to load periods'
          }
          onRetry={() => void periodsQ.refetch()}
        />
      )}
      {periodsQ.isSuccess && periods.length === 0 && (
        <EmptyState
          icon="📄"
          title="No reporting periods yet"
          hint="Open the first period to start collecting the VAT declaration"
          action={
            <Button onClick={() => setNewOpen(true)}>Open first period</Button>
          }
        />
      )}
      {current != null && <CurrentPeriodHero period={current} />}
      {[...byYear.entries()].map(([year, ps]) => (
        <ListGroup
          key={year}
          label={<GroupHeader label={year} trailing={`${ps.length}`} />}
        >
          {ps.map((p) => (
            <ListRow
              key={p.id}
              to={`/reports/periods/${p.id}`}
              title={periodTitle(p.name)}
              subtitle={dateRange(p)}
              chip={statusChipFor(p)}
            />
          ))}
        </ListGroup>
      ))}
      {newOpen && (
        <NewPeriodSheet open onOpenChange={(o) => !o && setNewOpen(false)} />
      )}
    </div>
  );
}
