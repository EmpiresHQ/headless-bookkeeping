import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import {
  recordSubmissionEvent,
  type RecordableSubmissionKind,
  type SubmissionEvent,
  type SubmissionEventKind,
} from '../api';
import { absoluteDate } from '../inbox/format';
import { useSheet } from '../lib/useSheet';
import {
  invalidateReports,
  periodTitle,
  submissionLine,
  SUBMISSION_STATUS,
  useSubmissionState,
} from '../queries/reports';
import { useReportingPeriods } from '../queries/shared';
import { ScreenHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { LoadError } from '../ui/LoadError';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

/** Human timeline labels per event kind (ADR-0037 lifecycle). */
const EVENT_LABELS: Record<SubmissionEventKind, string> = {
  prepared: 'Prepared — declaration frozen at close',
  submitted: 'Submitted to the tax authority',
  accepted: 'Accepted',
  rejected: 'Rejected',
  correction_submitted: 'Correction (parandusdeklaratsioon) submitted',
  correction_accepted: 'Correction accepted',
};

/** Short labels for the picker + the outcome-stating button. */
const RECORDABLE: { value: RecordableSubmissionKind; label: string }[] = [
  { value: 'submitted', label: 'Submitted' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'correction_submitted', label: 'Correction submitted' },
  { value: 'correction_accepted', label: 'Correction accepted' },
];

function EventRow({ event }: { event: SubmissionEvent }) {
  const meta = [absoluteDate(event.occurred_at), event.actor];
  if (event.external_ref !== null) meta.push(`ref ${event.external_ref}`);
  return (
    <div className="flex gap-3 border-b border-line px-3.5 py-3 last:border-b-0">
      <span
        aria-hidden
        className="mt-1.5 h-2 w-2 flex-none rounded-full bg-accent"
      />
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold">
          {EVENT_LABELS[event.event_kind]}
        </p>
        <p className="text-[12.5px] text-ink-2">{meta.join(' · ')}</p>
        {event.note !== null && (
          <p className="mt-0.5 text-[12.5px] italic text-ink-2">{event.note}</p>
        )}
      </div>
    </div>
  );
}

/** Operator-attested lifecycle record (Reality #9) — the timestamp is the
 *  SERVER clock at recording, honestly not backdatable. */
function AddEventSheet({
  periodId,
  open,
  onOpenChange,
}: {
  periodId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<RecordableSubmissionKind>('submitted');
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');

  const record = useMutation({
    mutationFn: () => {
      const input: {
        event_kind: RecordableSubmissionKind;
        external_ref?: string;
        note?: string;
      } = { event_kind: kind };
      if (ref.trim() !== '') input.external_ref = ref.trim();
      if (note.trim() !== '') input.note = note.trim();
      return recordSubmissionEvent(periodId, input);
    },
    onSuccess: async (ev) => {
      await invalidateReports(qc);
      toastOk(`Recorded — ${EVENT_LABELS[ev.event_kind]}`);
      onOpenChange(false);
    },
    onError: (e) =>
      toastErr(e instanceof Error ? e.message : 'Could not record the event'),
  });

  const label = RECORDABLE.find((r) => r.value === kind)?.label ?? kind;

  // Refuse to close while the record mutation is in flight — a vaul
  // backdrop/swipe dismissal mid-mutation would unmount this component and
  // lose the onSuccess invalidate + receipt toast.
  const guardedOnOpenChange = (o: boolean) => {
    if (record.isPending && !o) return;
    onOpenChange(o);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={guardedOnOpenChange}
      title="Record what happened"
    >
      <div className="space-y-3 px-6">
        <p className="text-[13.5px] text-ink-2">
          The system never talks to e-MTA — you report back what happened there
          and it goes on the permanent record.
        </p>
        <Field label="What happened">
          <SelectInput
            aria-label="What happened"
            value={kind}
            onChange={(e) =>
              setKind(e.target.value as RecordableSubmissionKind)
            }
          >
            {RECORDABLE.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label="Confirmation reference" hint="e-MTA reference, if any">
          <TextInput
            aria-label="Confirmation reference"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
          />
        </Field>
        <Field label="Note">
          <TextInput
            aria-label="Note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <Button
          className="w-full"
          busy={record.isPending}
          onClick={() => record.mutate()}
        >
          Record: {label}
        </Button>
      </div>
    </Sheet>
  );
}

/** /reports/periods/:id/submissions — the append-only filing history
 *  (ADR-0037): fold status on top, the event log below, add-event on demand. */
export function SubmissionsScreen() {
  const { id } = useParams();
  const periodId = Number(id);
  const periodsQ = useReportingPeriods();
  const period = (periodsQ.data ?? []).find((p) => p.id === periodId);
  const locked = period?.status === 'locked';
  const stateQ = useSubmissionState(periodId, locked);
  const add = useSheet();

  const title =
    period !== undefined ? `${periodTitle(period.name)} — filing` : 'Filing';

  if (periodsQ.isPending) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Filing" backTo="/reports" />
        <SkeletonRows count={3} />
      </div>
    );
  }
  if (periodsQ.isError) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Filing" backTo="/reports" />
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
        <ScreenHeader title="Filing" backTo="/reports" />
        <EmptyState icon="🔍" title="This period does not exist" />
      </div>
    );
  }
  if (!locked) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title={title} backTo={`/reports/periods/${period.id}`} />
        <EmptyState
          icon="🗓️"
          title="Close the period first"
          hint="Submission events attach to the frozen declaration — an open period has nothing filed yet"
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader
        title={title}
        backTo={`/reports/periods/${period.id}`}
        trailing={
          stateQ.data !== undefined ? (
            <Chip tone={SUBMISSION_STATUS[stateQ.data.status].tone}>
              {SUBMISSION_STATUS[stateQ.data.status].label}
            </Chip>
          ) : undefined
        }
      />
      {stateQ.isPending && <SkeletonRows count={3} />}
      {stateQ.isError && (
        <LoadError
          message={
            stateQ.error instanceof Error
              ? stateQ.error.message
              : 'Failed to load the filing history'
          }
          onRetry={() => void stateQ.refetch()}
        />
      )}
      {stateQ.data !== undefined && (
        <>
          <p className="mb-2 px-5 text-[12.5px] text-ink-2">
            {submissionLine(stateQ.data)}
            {stateQ.data.submissionCount > 1 &&
              ` · filed ${stateQ.data.submissionCount}×`}
          </p>
          <div className="mx-3.5 mb-3.5 overflow-hidden rounded-2xl bg-surface">
            {stateQ.data.history.map((ev) => (
              <EventRow key={ev.id} event={ev} />
            ))}
            {stateQ.data.history.length === 0 && (
              <p className="px-3.5 py-3 text-[13px] text-ink-2">
                No events recorded for this period yet.
              </p>
            )}
          </div>
          {stateQ.data.status === 'rejected' && (
            <div className="mx-3.5 mb-3.5 rounded-2xl bg-warn-bg px-4 py-3 text-[13px] text-warn">
              A rejection never reopens the period. Wrong file format — download
              the XML again and resubmit, then record another "Submitted". Wrong
              figures — correct forward in the open period via Books, then
              record the correction here.
            </div>
          )}
          <div className="mx-3.5 mb-3.5">
            <Button className="w-full" onClick={() => add.open()}>
              Record what happened…
            </Button>
          </div>
        </>
      )}
      {add.epoch > 0 && (
        <AddEventSheet
          key={`${period.id}-${add.epoch}`}
          periodId={period.id}
          open={add.isOpen}
          onOpenChange={(o) => !o && add.close()}
        />
      )}
    </div>
  );
}
