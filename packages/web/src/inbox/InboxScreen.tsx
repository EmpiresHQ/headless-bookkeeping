import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { fmtCents, triageDocument, uploadDocument } from '../api';
import { relativeTime } from '../relativeTime';
import { LargeTitleHeader } from '../shell/Headers';
import {
  splitTodayEarlier,
  useInboxQueue,
  approvalDisplay,
  invalidateInbox,
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
import { toastErr, toastOk } from '../ui/toast';
import {
  humanizePolicyReason,
  outcomeText,
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

function InboxHero({
  periodName,
  monthTotalCents,
  taskCount,
  firstRoute,
}: {
  periodName: string;
  monthTotalCents: number;
  taskCount: number;
  firstRoute: string | null;
}) {
  return (
    <div className="mx-3.5 mb-3.5 rounded-2xl bg-accent-deep px-5 py-4 text-white">
      <p className="text-[11px] font-bold uppercase tracking-wide opacity-70">
        {periodName} · open
      </p>
      <p className="mt-1 whitespace-nowrap text-[28px] font-extrabold tabular-nums">
        −{fmtCents(monthTotalCents)} €
      </p>
      <p className="text-[12.5px] opacity-70">expenses this period</p>
      {taskCount > 0 && firstRoute !== null && (
        // The mint hero CTA is the ONE sanctioned bespoke button (spec:
        // `signal` token is hero-CTA-only).
        <Link
          to={firstRoute}
          viewTransition
          className="mt-3 block rounded-xl bg-signal px-4 py-2.5 text-center text-[15px] font-bold text-accent-deep"
        >
          Start clearing · {taskCount}
        </Link>
      )}
    </div>
  );
}

/** Minimal upload entry point (legacy IntakeView capability kept): upload →
 *  auto-triage → outcome toast. The full upload flow (claimant dropdown,
 *  ADR-0036) belongs to the Books plan. */
function UploadAction() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const onPick = async (file: File) => {
    setBusy(true);
    try {
      const { document, deduplicated } = await uploadDocument(file);
      if (deduplicated)
        toastOk('Already uploaded — using the existing document');
      const outcome = await triageDocument(document.id);
      if (outcome.kind === 'unknown') toastErr(outcomeText(outcome));
      else toastOk(outcomeText(outcome));
      await invalidateInbox(qc);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        aria-label="Upload document"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onPick(f);
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
        className="text-[15px] font-semibold text-accent disabled:opacity-50"
      >
        {busy ? 'Processing…' : 'Upload'}
      </button>
    </>
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
  const hero = useInboxHero();
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
          <div className="flex items-center gap-3">
            <span className="text-[12.5px] font-semibold text-ink-2">
              {total === 1 ? '1 task' : `${total} tasks`}
            </span>
            <UploadAction />
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
          onChange={(v) => setParams({ seg: v }, { replace: true })}
        />
      </div>
      {hero !== null && (
        <InboxHero
          periodName={hero.periodName}
          monthTotalCents={hero.monthTotalCents}
          taskCount={entries.length}
          firstRoute={entries[0]?.route ?? null}
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
