import { Navigate, useSearchParams } from 'react-router-dom';
import { relativeTime } from '../relativeTime';
import { LargeTitleHeader } from '../shell/Headers';
import {
  splitTodayEarlier,
  useInboxQueue,
  approvalDisplay,
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
import {
  humanizePolicyReason,
  triageChipLabel,
  triageSubtitle,
} from './reason';

const SEGMENTS: readonly InboxSegment[] = ['all', 'triage', 'approvals'];

function EntryIcon({ entry }: { entry: InboxEntry }) {
  const [bg, glyph] =
    entry.kind === 'approval'
      ? ['bg-[#E3EFE8] text-accent', '✓']
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
}: {
  entry: InboxEntry;
  facts: Parameters<typeof approvalDisplay>[1];
}) {
  if (entry.kind === 'triage') {
    return (
      <ListRow
        to={entry.route}
        leading={<EntryIcon entry={entry} />}
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
      leading={<EntryIcon entry={entry} />}
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

/** /inbox — the unified decision queue: needs-triage documents + pending
 *  approvals, ONE FIFO list (oldest on top — the queue must end). Polls at
 *  30s while mounted; see queries/inbox.ts for the polling rule. */
export function InboxScreen() {
  const [params, setParams] = useSearchParams();
  // Legacy bookmarks used ?tab= (LegacyTabs); accept it as an alias.
  const rawSeg = params.get('seg') ?? params.get('tab');
  const seg: InboxSegment = SEGMENTS.includes(rawSeg as InboxSegment)
    ? (rawSeg as InboxSegment)
    : 'all';
  const { entries, counts, triageQ, approvalsQ, isPending } = useInboxQueue(
    seg,
    { poll: true },
  );
  const expensesQ = useExpenses();
  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();
  const facts = {
    expenses: expensesQ.data ?? [],
    invoices: invoicesQ.data ?? [],
    entities: entitiesQ.data ?? [],
  };
  const { today, earlier } = splitTodayEarlier(entries);
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
          <span className="text-[12.5px] font-semibold text-ink-2">
            {total === 1 ? '1 task' : `${total} tasks`}
          </span>
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
          onChange={(v) => setParams({ seg: v }, { replace: true })}
        />
      </div>
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
            <QueueRow key={e.route} entry={e} facts={facts} />
          ))}
        </ListGroup>
      )}
      {today.length > 0 && (
        <ListGroup label={`Today · ${today.length}`}>
          {today.map((e) => (
            <QueueRow key={e.route} entry={e} facts={facts} />
          ))}
        </ListGroup>
      )}
      {entries.length > 0 && (
        <p className="pb-2 text-center text-[10.5px] text-ink-2">
          Oldest first — the queue clears FIFO
        </p>
      )}
    </div>
  );
}
