import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  downloadStatutoryReport,
  fmtCents,
  type KmdDeclaration,
  type ReportingPeriod,
} from '../api';
import { absoluteDate, absoluteDateFromIso } from '../inbox/format';
import { useSheet } from '../lib/useSheet';
import {
  displayFlags,
  KMD_ROWS,
  netVatLabel,
  oldestOpen,
  periodTitle,
  submissionLine,
  useKmd,
  useSubmissionState,
} from '../queries/reports';
import { useReportingPeriods } from '../queries/shared';
import { ScreenHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { ListGroup, ListRow, KeyValue, GroupLabel } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { toastErr } from '../ui/toast';
import { LockSheet } from './LockSheet';
import { InfGapsSection, InPeriodSection, StragglersSection } from './sections';

/** Info banner — live vs frozen is THE §7 marking decision. */
function StatusBanner({ period }: { period: ReportingPeriod }) {
  if (period.status === 'open') {
    return (
      <div className="mx-3.5 mb-3.5 rounded-2xl bg-tint px-4 py-3 text-[13px] text-accent">
        Live preview — recomputed from the posted books every time you open this
        screen.
      </div>
    );
  }
  return (
    <div className="mx-3.5 mb-3.5 rounded-2xl bg-surface px-4 py-3 text-[13px] text-ink-2">
      Frozen — closed{' '}
      {period.filed_at !== null ? absoluteDate(period.filed_at) : 'earlier'}.
      The declaration can no longer change; corrections go forward into the open
      period.
    </div>
  );
}

/** The declaration itself: seven human-labeled boxes + the highlighted net
 *  line + the VD 3S row with its manual-filing notice (Reality #5/#6). */
function DeclarationGroup({ decl }: { decl: KmdDeclaration }) {
  return (
    <>
      <GroupLabel>KMD declaration</GroupLabel>
      <div className="mx-3.5 mb-1.5 overflow-hidden rounded-2xl bg-surface">
        {KMD_ROWS.map((r) => (
          <KeyValue key={r.key} k={r.label} v={`${fmtCents(decl[r.key])} €`} />
        ))}
        <div className="flex items-center justify-between gap-4 bg-ok-bg px-3.5 py-2.5 text-sm">
          <span className="font-bold">{netVatLabel(decl.net_vat_due)}</span>
          <span className="whitespace-nowrap font-bold tabular-nums">
            {fmtCents(Math.abs(decl.net_vat_due))} €
          </span>
        </div>
      </div>
      {decl.vd_intra_eu_services > 0 && (
        <div className="mx-3.5 mb-3.5 space-y-1.5">
          <div className="overflow-hidden rounded-2xl bg-surface">
            <KeyValue
              k="Intra-EU services for the VD report (3S)"
              v={`${fmtCents(decl.vd_intra_eu_services)} €`}
            />
          </div>
          <p className="rounded-2xl bg-warn-bg px-4 py-3 text-[13px] text-warn">
            File the VD koondaruanne (tähis 3S) manually in e-MTA — the system
            does not submit it.
          </p>
        </div>
      )}
    </>
  );
}

function ReviewFlags({ flags }: { flags: string[] }) {
  const shown = displayFlags(flags);
  if (shown.length === 0) return null;
  return (
    <>
      <GroupLabel>Review before filing</GroupLabel>
      <div className="mx-3.5 mb-3.5 space-y-1.5">
        {shown.map((f) => (
          <p
            key={f}
            className="rounded-2xl bg-warn-bg px-4 py-3 text-[13px] text-warn"
          >
            {f}
          </p>
        ))}
      </div>
    </>
  );
}

function Downloads({ period }: { period: ReportingPeriod }) {
  const [busy, setBusy] = useState<'xml' | 'csv' | null>(null);
  const run = (format: 'xml' | 'csv') => {
    setBusy(format);
    downloadStatutoryReport(period.id, format)
      .catch((e) =>
        toastErr(e instanceof Error ? e.message : 'Download failed'),
      )
      // Two interleaved downloads must not clear each other's busy slot —
      // only clear if THIS format is still the one showing busy.
      .finally(() => setBusy((b) => (b === format ? null : b)));
  };
  return (
    <div className="mx-3.5 mb-3.5 space-y-1.5">
      <div className="flex gap-2.5">
        <Button
          variant="secondary"
          className="flex-1"
          busy={busy === 'xml'}
          onClick={() => run('xml')}
        >
          Download XML
        </Button>
        <Button
          variant="secondary"
          className="flex-1"
          busy={busy === 'csv'}
          onClick={() => run('csv')}
        >
          Download CSV
        </Button>
      </div>
      <p className="px-1 text-[12px] text-ink-2">
        {period.status === 'open'
          ? 'Draft files — the declaration can still change until the period is closed.'
          : 'Final files from the frozen declaration.'}
      </p>
    </div>
  );
}

/** /reports/periods/:id — the KMD declaration reimagined per the data-display
 *  rules: human labels, tabular cents, explicit live/frozen state (asset §7). */
export function PeriodScreen() {
  const { id } = useParams();
  const periodId = Number(id);
  // The route param is not statically constrained to digits — guard the
  // NaN case here rather than firing GET /api/reporting-periods/NaN/kmd
  // (useKmd's `enabled` gate was added in this task for exactly this;
  // see task-5-report.md self-review / adjudication note). Number.isFinite
  // alone admits non-integers too (e.g. '7.5' → GET .../7.5/kmd) — require
  // a positive integer.
  const validPeriodId = Number.isInteger(periodId) && periodId > 0;
  const periodsQ = useReportingPeriods();
  const period = (periodsQ.data ?? []).find((p) => p.id === periodId);
  const kmdQ = useKmd(periodId, validPeriodId);
  const submissionQ = useSubmissionState(periodId, period?.status === 'locked');
  const lock = useSheet();
  const oldest = oldestOpen(periodsQ.data ?? []);

  if (periodsQ.isPending) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Period" backTo="/reports" />
        <SkeletonRows count={5} />
      </div>
    );
  }
  if (periodsQ.isError) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Period" backTo="/reports" />
        <LoadError
          message={
            periodsQ.error instanceof Error
              ? periodsQ.error.message
              : 'Failed to load periods'
          }
          onRetry={() => void periodsQ.refetch()}
        />
      </div>
    );
  }
  if (period === undefined) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Period" backTo="/reports" />
        <EmptyState
          icon="🔍"
          title="This period does not exist"
          hint="It may have been removed — go back to Reports"
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader
        title={periodTitle(period.name)}
        backTo="/reports"
        trailing={
          <Chip tone={period.status === 'open' ? 'ok' : 'muted'}>
            {period.status}
          </Chip>
        }
      />
      <p className="mb-2 px-5 text-[12.5px] text-ink-2">
        {absoluteDateFromIso(period.start_date)} –{' '}
        {absoluteDateFromIso(period.end_date)}
      </p>
      <StatusBanner period={period} />
      {period.status === 'locked' && submissionQ.data !== undefined && (
        <ListGroup>
          <ListRow
            to={`/reports/periods/${period.id}/submissions`}
            title="Submission history"
            subtitle={submissionLine(submissionQ.data)}
          />
        </ListGroup>
      )}
      {kmdQ.isPending && <SkeletonRows count={4} />}
      {kmdQ.isError && (
        <LoadError
          message={
            kmdQ.error instanceof Error
              ? kmdQ.error.message
              : 'Failed to load the declaration'
          }
          onRetry={() => void kmdQ.refetch()}
        />
      )}
      {kmdQ.data !== undefined && (
        <>
          <DeclarationGroup decl={kmdQ.data} />
          <ReviewFlags flags={kmdQ.data.review_flags} />
        </>
      )}
      <InfGapsSection period={period} />
      <StragglersSection period={period} />
      <InPeriodSection period={period} />
      <Downloads period={period} />
      {period.status === 'open' && period.id === oldest?.id && (
        <div className="mx-3.5 mb-3.5">
          <Button className="w-full" onClick={() => lock.open()}>
            Close period…
          </Button>
        </div>
      )}
      {period.status === 'open' &&
        oldest !== null &&
        period.id !== oldest.id && (
          <p className="mx-6 mb-3.5 text-[12.5px] text-ink-2">
            File {periodTitle(oldest.name)} first — filing proceeds
            oldest-first.
          </p>
        )}
      {lock.epoch > 0 && (
        <LockSheet
          key={`${period.id}-${lock.epoch}`}
          period={period}
          netVatDueCents={
            kmdQ.data !== undefined ? kmdQ.data.net_vat_due : null
          }
          open={lock.isOpen}
          onOpenChange={(o) => !o && lock.close()}
        />
      )}
    </div>
  );
}
