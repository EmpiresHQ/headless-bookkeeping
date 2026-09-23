import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { DocThumbLightbox } from './DocThumbLightbox';
import { signedEuros } from '../lib/money';
import { useOriginState } from '../lib/returnNavigation';
import { useSeg } from '../lib/useSeg';
import { relativeTime } from '../relativeTime';
import { LargeTitleHeader } from '../shell/Headers';
import {
  splitTodayEarlier,
  useInboxQueue,
  approvalDisplay,
  useInboxHero,
  type InboxEntry,
  type InboxSegment,
} from '../queries/inbox';
import { useEntities, useExpenses, useInvoices } from '../queries/shared';
import { AmountText } from '../ui/AmountText';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { SegmentedControl } from '../ui/SegmentedControl';
import { UploadDocumentSheet } from '../upload/UploadDocumentSheet';
import { useSheet } from '../lib/useSheet';
import {
  humanizePolicyReason,
  triageChipLabel,
  triageSubtitle,
} from './reason';
import { runState } from './queueRun';

const SEGMENTS: readonly InboxSegment[] = ['all', 'triage', 'approvals'];

/** The fallback reason glyph — used directly for approval rows (no document
 *  id to fetch a thumbnail for) and as DocThumb's `fallback` for triage rows
 *  (no preview / non-visual document). */
function ReasonGlyph({ entry }: { entry: InboxEntry }) {
  const [bg, glyph] =
    entry.kind === 'approval'
      ? ['bg-tint text-accent', '✓']
      : entry.item.reason_type === 'ocr_failed' ||
          entry.item.reason_type === 'not_a_document'
        ? ['bg-err-bg text-err', '!']
        : ['bg-warn-bg text-warn', '?'];
  return (
    <span
      aria-hidden
      className={`flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] text-[15px] font-bold ${bg}`}
    >
      {glyph}
    </span>
  );
}

function QueueRow({
  entry,
  facts,
  run,
}: {
  entry: InboxEntry;
  facts: Parameters<typeof approvalDisplay>[1];
  run: ReturnType<typeof runState>;
}) {
  // Opening an item records this Inbox entry as its origin (issue #252)
  // and starts a queue run over the visible segment (issue #253).
  const origin = { ...run, ...useOriginState() };
  if (entry.kind === 'triage') {
    return (
      <ListRow
        to={entry.route}
        state={origin}
        leading={
          <DocThumbLightbox
            id={entry.item.id}
            className="h-[34px] w-[34px] rounded-[10px] border border-line"
            fallback={<ReasonGlyph entry={entry} />}
          />
        }
        title={entry.item.filename}
        subtitle={triageSubtitle(entry.item)}
        chip={
          <Chip tone="warn">{triageChipLabel(entry.item.reason_type)}</Chip>
        }
        trailing={
          <div className="text-[12px] text-ink-2">
            {relativeTime(entry.item.created_at)}
          </div>
        }
      />
    );
  }
  const d = approvalDisplay(entry.approval, facts);
  return (
    <ListRow
      to={entry.route}
      state={origin}
      leading={<ReasonGlyph entry={entry} />}
      title={d.title}
      subtitle={humanizePolicyReason(entry.approval.policy_reason)}
      chip={<Chip tone="accent">approve?</Chip>}
      trailing={
        <div className="flex-none">
          {d.amountCents != null && (
            <AmountText
              cents={d.amountCents}
              showSign
              className="block whitespace-nowrap text-[14px]"
            />
          )}
          <div className="text-[12px] text-ink-2">
            {relativeTime(entry.approval.created_at)}
          </div>
        </div>
      }
    />
  );
}

function InboxHero({
  periodName,
  monthTotalCents,
  taskCount,
  firstRoute,
  run,
}: {
  periodName: string;
  monthTotalCents: number;
  taskCount: number;
  firstRoute: string | null;
  run: ReturnType<typeof runState>;
}) {
  const origin = { ...run, ...useOriginState() };
  return (
    <div className="mx-3.5 mb-3.5 rounded-2xl bg-accent-deep px-5 py-4 text-white">
      <p className="text-[11px] font-bold uppercase tracking-wide opacity-70">
        {periodName} · open
      </p>
      <p className="mt-1 whitespace-nowrap text-[28px] font-extrabold tabular-nums">
        {signedEuros(-monthTotalCents)}
      </p>
      <p className="text-[12.5px] opacity-70">expenses this period</p>
      {taskCount > 0 && firstRoute !== null && (
        // The mint hero CTA is the ONE sanctioned bespoke button (spec:
        // `signal` token is hero-CTA-only).
        <Link
          to={firstRoute}
          state={origin}
          className="mt-3 block rounded-xl bg-signal px-4 py-2.5 text-center text-[15px] font-bold text-accent-deep"
        >
          Start clearing · {taskCount}
        </Link>
      )}
    </div>
  );
}

/** /inbox — the unified decision queue: needs-triage documents + pending
 *  approvals, ONE FIFO list (oldest on top — the queue must end). Polls at
 *  30s while mounted; see queries/inbox.ts for the polling rule. */
export function InboxScreen() {
  const [params] = useSearchParams();
  const [seg, setSeg] = useSeg<InboxSegment>(SEGMENTS, 'all');
  const { entries, counts, triageQ, approvalsQ, isPending } = useInboxQueue(
    seg,
    { poll: true },
  );
  const hero = useInboxHero();
  // The same upload flow as Books (issue #258).
  const uploadSheet = useSheet();
  const expensesQ = useExpenses();
  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();
  const facts = {
    expenses: expensesQ.data ?? [],
    invoices: invoicesQ.data ?? [],
    entities: entitiesQ.data ?? [],
  };
  const { today, earlier } = splitTodayEarlier(entries);
  // The rows as rendered — Earlier, then Today — are the run's snapshot
  // order (issue #253); "Start clearing" opens its first member.
  const ordered = [...earlier, ...today];
  const run = runState(seg, ordered);
  const total = counts.triage + counts.approvals;
  const listError = triageQ.error ?? approvalsQ.error;

  // Legacy /intake?expand=N deep link (redirect chain preserves the param).
  const expand = params.get('expand');
  if (expand !== null && /^\d+$/.test(expand)) {
    return <Navigate to={`/inbox/doc/${expand}`} replace />;
  }

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <LargeTitleHeader
        title="Inbox"
        trailing={
          <div className="flex items-center gap-3">
            <span className="text-[12.5px] font-semibold text-ink-2">
              {total === 1 ? '1 task' : `${total} tasks`}
            </span>
            <button
              type="button"
              onClick={() => uploadSheet.open()}
              className="text-[15px] font-semibold text-accent"
            >
              Upload
            </button>
          </div>
        }
      />
      <div className="px-4 pb-3">
        <SegmentedControl
          options={[
            { value: 'all' as const, label: 'All' },
            { value: 'triage' as const, label: `Triage ${counts.triage}` },
            {
              value: 'approvals' as const,
              label: `Approvals ${counts.approvals}`,
            },
          ]}
          value={seg}
          onChange={setSeg}
        />
      </div>
      {hero !== null && (
        <InboxHero
          periodName={hero.periodName}
          monthTotalCents={hero.monthTotalCents}
          taskCount={entries.length}
          firstRoute={ordered[0]?.route ?? null}
          run={run}
        />
      )}
      {isPending && <SkeletonRows count={4} />}
      {listError != null && (
        <LoadError
          message={
            listError instanceof Error
              ? listError.message
              : 'Failed to load the queue'
          }
          onRetry={() => {
            void triageQ.refetch();
            void approvalsQ.refetch();
          }}
        />
      )}
      {!isPending && listError == null && entries.length === 0 && (
        <EmptyState
          icon="🎉"
          title="Inbox zero"
          hint="Nothing needs a decision right now."
        />
      )}
      {earlier.length > 0 && (
        <ListGroup label={`Earlier · ${earlier.length}`}>
          {earlier.map((e) => (
            <QueueRow key={e.route} entry={e} facts={facts} run={run} />
          ))}
        </ListGroup>
      )}
      {today.length > 0 && (
        <ListGroup label={`Today · ${today.length}`}>
          {today.map((e) => (
            <QueueRow key={e.route} entry={e} facts={facts} run={run} />
          ))}
        </ListGroup>
      )}
      {entries.length > 0 && (
        <p className="pb-2 text-center text-[10.5px] text-ink-2">
          Oldest first — the queue clears FIFO
        </p>
      )}
      {/* Remount-on-open (epoch key), as in Books. */}
      {uploadSheet.epoch > 0 && (
        <UploadDocumentSheet
          key={`upload-${uploadSheet.epoch}`}
          open={uploadSheet.isOpen}
          onOpenChange={(o) => !o && uploadSheet.close()}
        />
      )}
    </div>
  );
}
