import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { importBankStatement } from '../api';
import {
  bankKeys,
  isNotFound,
  isTerminalImportStatus,
  useImportJob,
} from '../queries/bank';
import { Button } from '../ui/Button';
import { Field, PendingFieldset, TextInput } from '../ui/Form';
import { LinkButton } from '../ui/LinkButton';
import { ScreenHeader } from '../shell/Headers';
import { usePendingOperation } from '../lib/pendingOperation';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import { isSameSession, sessionStamp } from '../auth';
import {
  clearImportPointer,
  importPointerOwner,
  parseJobId,
  readImportPointer,
  rememberImportPointer,
  writeImportPointer,
} from './importResume';

type StepState = 'done' | 'active' | 'failed' | 'unknown' | 'idle';

function Step({ state, label }: { state: StepState; label: string }) {
  const icon =
    state === 'done'
      ? '✓'
      : state === 'active'
        ? '…'
        : state === 'failed'
          ? '✕'
          : state === 'unknown'
            ? '?'
            : '·';
  const tone =
    state === 'done'
      ? 'bg-ok-bg text-ok'
      : state === 'active' || state === 'unknown'
        ? 'bg-warn-bg text-warn'
        : state === 'failed'
          ? 'bg-err-bg text-err'
          : 'bg-line text-ink-2';
  return (
    <div className="flex items-center gap-3 border-b border-line px-3.5 py-3 last:border-b-0">
      <span
        aria-hidden
        className={`flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] text-[15px] font-bold ${tone}`}
      >
        {icon}
      </span>
      <span
        className={`text-[14.5px] font-semibold ${state === 'idle' ? 'text-ink-2' : ''}`}
      >
        {label}
      </span>
    </div>
  );
}

/** /bank/import — explicit async import flow (ADR-0031): upload → the server
 *  runs LLM column mapping + rules → statement created.
 *
 *  Issue #254: an accepted upload is observed at `/bank/import?job=<id>`
 *  (refresh and copied links resume it); a per-tab pointer makes a plain
 *  return to /bank/import resume a job whose outcome this tab has not seen.
 *  A failed STATUS READ is not a failed import: it never offers a re-upload. */
export function ImportScreen() {
  const [params] = useSearchParams();
  const raw = params.get('job');
  if (raw === null) {
    const resume = readImportPointer();
    if (resume !== null) {
      return <Navigate replace to={`/bank/import?job=${resume}`} />;
    }
  }
  const jobId = raw === null ? null : parseJobId(raw);
  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Import statement" backTo="/bank" />
      {raw === null ? (
        <ImportForm />
      ) : jobId === null ? (
        <InvalidJobLink raw={raw} />
      ) : (
        <ImportJobView key={jobId} jobId={jobId} />
      )}
    </div>
  );
}

/** An explicit `?job=` that is not a job id: say so — never a silent fresh
 *  form, and never touching the tab's resume pointer. */
function InvalidJobLink({ raw }: { raw: string }) {
  return (
    <div className="mx-3.5 rounded-2xl bg-surface px-4 py-3.5">
      <p className="text-[13px] font-semibold">
        This import link is not valid
        {raw === '' ? '' : ` (“${raw.slice(0, 40)}”)`}.
      </p>
      <p className="mt-1 text-[12.5px] text-ink-2">
        An import link names a job number, e.g. /bank/import?job=41.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <LinkButton to="/bank/import" variant="secondary">
          Go to Import statement
        </LinkButton>
        <LinkButton to="/bank" variant="secondary">
          Back to Bank
        </LinkButton>
      </div>
    </div>
  );
}

function ImportForm() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [accountCode, setAccountCode] = useState('BANK_EUR');
  const op = usePendingOperation('Import statement');
  const submitting = op.pending;
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Only the form is input to keep; once the server accepted the file (a
  // job exists) the import runs server-side and its address is the URL.
  const guard = useUnsavedChanges({
    label: 'Import statement',
    values: { file, accountCode },
    baseline: { file: null, accountCode: 'BANK_EUR' },
  });

  const onSubmit = () => {
    if (!file) return;
    const started = op.run(() => importBankStatement(file, accountCode), {
      // Live scope only (#251): a late upload of an ended session never
      // writes the pointer or navigates.
      onSuccess: ({ jobId: id }) => {
        guard.release();
        writeImportPointer(id);
        void navigate(`/bank/import?job=${id}`, { replace: true });
      },
      onError: (e) =>
        setSubmitError(e instanceof Error ? e.message : String(e)),
    });
    if (started) setSubmitError(null);
  };

  return (
    <PendingFieldset
      pending={submitting}
      status="Uploading… the form is locked until the server answers."
      className="mx-3.5 space-y-4 rounded-2xl bg-surface p-4"
    >
      <Field
        label="Statement file"
        hint="CSV export from your bank — a fresh AI mapping runs on every upload."
      >
        <input
          type="file"
          aria-label="Statement file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="w-full text-sm"
        />
      </Field>
      <Field label="Account code" hint="Ledger bank account, e.g. BANK_EUR">
        <TextInput
          value={accountCode}
          onChange={(e) => setAccountCode(e.target.value)}
        />
      </Field>
      {submitError != null && (
        <div role="alert" className="space-y-1">
          <p className="text-[13px] font-semibold text-err">{submitError}</p>
          <p className="text-[12.5px] text-ink-2">
            The upload was not confirmed. If you are not sure it reached the
            server, check the statements list before uploading again.
          </p>
        </div>
      )}
      <Button
        className="h-[46px] w-full"
        disabled={file == null || accountCode.trim() === ''}
        busy={submitting}
        onClick={onSubmit}
      >
        Import statement
      </Button>
    </PendingFieldset>
  );
}

type JobView =
  | 'checking'
  | 'running'
  | 'done'
  | 'failed'
  | 'statusError'
  | 'notFound'
  | 'unknown';

function ImportJobView({ jobId }: { jobId: number }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const jobQ = useImportJob(jobId);
  // The sign-in this view observes for; a later one never inherits it.
  const [owner] = useState(() => ({
    stamp: sessionStamp(),
    id: importPointerOwner(),
  }));
  const job = jobQ.data;
  const status = job?.status;
  const terminal = isTerminalImportStatus(status);
  const notFound = !terminal && jobQ.isError && isNotFound(jobQ.error);

  // A terminal answer is immutable, so it wins over any later read error.
  const view: JobView = terminal
    ? (status as 'done' | 'failed')
    : notFound
      ? 'notFound'
      : jobQ.isError
        ? 'statusError'
        : job === undefined
          ? 'checking'
          : status === 'running'
            ? 'running'
            : 'unknown';

  // A finished import added a statement — refresh the list cache.
  useEffect(() => {
    if (status === 'done') {
      void qc.invalidateQueries({ queryKey: bankKeys.statements });
    }
  }, [status, qc]);

  // A job opened by an explicit link is remembered once the server has
  // answered for it (any status), so leaving and returning resumes it too.
  const observed = jobQ.data !== undefined;
  useEffect(() => {
    if (observed && isSameSession(owner.stamp)) {
      rememberImportPointer(jobId, owner.id);
    }
  }, [observed, jobId, owner]);

  // The pointer outlives the outcome (a result that arrived while the
  // operator was away is still shown on return); only an explicit
  // acknowledgement below clears it.
  const acknowledge = () => clearImportPointer(jobId);
  const newImport = () => {
    acknowledge();
    void navigate('/bank/import');
  };
  const forget = () => {
    acknowledge();
    void navigate('/bank');
  };

  const mappingState: StepState =
    view === 'done'
      ? 'done'
      : view === 'failed'
        ? 'failed'
        : view === 'statusError' || view === 'unknown'
          ? 'unknown'
          : 'active';

  return (
    <>
      <p className="px-4 pb-2 text-[13px] text-ink-2">
        Import{' '}
        <span className="font-semibold text-ink select-all">#{jobId}</span>
        {job?.account_code ? ` · ${job.account_code}` : ''}
      </p>
      {view === 'notFound' ? (
        <div
          role="status"
          className="mx-3.5 rounded-2xl bg-surface px-4 py-3.5"
        >
          <p className="text-[13px] font-semibold">
            The server did not find import #{jobId}.
          </p>
          <p className="mt-1 text-[12.5px] text-ink-2">
            That does not mean the import failed: the link may belong to another
            sign-in, or the server may not know the job right now. Check again,
            or look in the statements list — don’t upload the file again before
            you have checked.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              busy={jobQ.isFetching}
              onClick={() => void jobQ.refetch()}
            >
              Check again
            </Button>
            <LinkButton to="/bank" variant="secondary">
              Back to Bank
            </LinkButton>
          </div>
          <p className="mt-3 text-[12.5px] text-ink-2">
            Forget removes #{jobId} from this tab and returns to Bank. It does
            not cancel anything on the server: if the file was accepted, its
            statement appears in the statements list.
          </p>
          <button
            type="button"
            className="mt-1 text-[12.5px] font-semibold text-ink-2 underline"
            onClick={forget}
          >
            Forget this import
          </button>
        </div>
      ) : (
        <div className="mx-3.5 overflow-hidden rounded-2xl bg-surface">
          <Step state="done" label="File uploaded" />
          <Step state={mappingState} label="AI mapping & rules" />
          <Step
            state={view === 'done' ? 'done' : 'idle'}
            label="Statement created"
          />
        </div>
      )}
      {(view === 'checking' || view === 'running') && (
        <p className="px-6 pt-3 text-center text-[12.5px] text-ink-2">
          {view === 'checking'
            ? `Checking import #${jobId}…`
            : 'The AI infers the column mapping and rules run — this can take a minute.'}{' '}
          The import runs on the server: you can leave and come back to Import
          statement, or reload this page.
        </p>
      )}
      {view === 'statusError' && (
        <div
          role="alert"
          className="mx-3.5 mt-3 rounded-2xl bg-warn-bg px-4 py-3.5"
        >
          <p className="text-[13px] font-semibold text-warn">
            Couldn’t check the status of import #{jobId}.
          </p>
          <p className="mt-1 text-[12.5px] text-ink-2">
            {jobQ.error instanceof Error
              ? jobQ.error.message
              : 'Status check failed'}
          </p>
          {status === 'running' && (
            <p className="mt-1 text-[12.5px] text-ink-2">
              Last known status: running.
            </p>
          )}
          <p className="mt-1 text-[12.5px] text-ink-2">
            The import itself may still be running — don’t upload the file
            again. This page keeps its address; check again now or later.
          </p>
          <Button
            variant="secondary"
            className="mt-2"
            busy={jobQ.isFetching}
            onClick={() => void jobQ.refetch()}
          >
            Check again
          </Button>
        </div>
      )}
      {view === 'unknown' && (
        <div className="mx-3.5 mt-3 rounded-2xl bg-warn-bg px-4 py-3.5">
          <p className="text-[13px] font-semibold text-warn">
            The server reported an unexpected status “{status}” for import #
            {jobId}.
          </p>
          <Button
            variant="secondary"
            className="mt-2"
            busy={jobQ.isFetching}
            onClick={() => void jobQ.refetch()}
          >
            Check again
          </Button>
        </div>
      )}
      {view === 'failed' && (
        <div className="mx-3.5 mt-3 rounded-2xl bg-err-bg px-4 py-3.5">
          <p className="text-[13px] font-semibold text-err">
            {job?.error ?? 'Import failed'}
          </p>
          <Button variant="secondary" className="mt-2" onClick={newImport}>
            Try again
          </Button>
        </div>
      )}
      {view === 'done' && (
        <div className="space-y-2 px-4 pt-4">
          {job?.statement_id != null && (
            <LinkButton
              to={`/bank/statements/${job.statement_id}`}
              onClick={acknowledge}
              className="block"
            >
              Open statement
            </LinkButton>
          )}
          <Button variant="secondary" className="w-full" onClick={newImport}>
            New import
          </Button>
        </div>
      )}
    </>
  );
}
