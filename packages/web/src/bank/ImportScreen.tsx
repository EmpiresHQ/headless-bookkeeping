import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { importBankStatement } from '../api';
import { bankKeys, useImportJob } from '../queries/bank';
import { Button } from '../ui/Button';
import { Field, TextInput } from '../ui/Form';
import { ScreenHeader } from '../shell/Headers';

type StepState = 'done' | 'active' | 'failed' | 'idle';

function Step({ state, label }: { state: StepState; label: string }) {
  const icon =
    state === 'done'
      ? '✓'
      : state === 'active'
        ? '…'
        : state === 'failed'
          ? '✕'
          : '·';
  const tone =
    state === 'done'
      ? 'bg-ok-bg text-ok'
      : state === 'active'
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
 *  runs LLM column mapping + rules → statement created. Failure is a first-
 *  class state with the server's error and a re-upload CTA. */
export function ImportScreen() {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [accountCode, setAccountCode] = useState('BANK_EUR');
  const [jobId, setJobId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const jobQ = useImportJob(jobId);
  const job = jobQ.data;

  const onSubmit = async () => {
    if (!file) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { jobId: id } = await importBankStatement(file, accountCode);
      setJobId(id);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setJobId(null);
    setFile(null);
    setSubmitError(null);
  };

  // A finished import added a statement — refresh the list cache.
  const jobStatus = job?.status;
  useEffect(() => {
    if (jobStatus === 'done') {
      void qc.invalidateQueries({ queryKey: bankKeys.statements });
    }
  }, [jobStatus, qc]);

  const showForm = jobId === null;
  const mappingState: StepState =
    job === undefined
      ? 'active'
      : job.status === 'running'
        ? 'active'
        : job.status === 'failed'
          ? 'failed'
          : 'done';

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Import statement" backTo="/bank" />
      {showForm ? (
        <div className="mx-3.5 space-y-4 rounded-2xl bg-surface p-4">
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
            <p className="text-[13px] font-semibold text-err">{submitError}</p>
          )}
          <Button
            className="h-[46px] w-full"
            disabled={file == null || accountCode.trim() === ''}
            busy={submitting}
            onClick={() => void onSubmit()}
          >
            Import statement
          </Button>
        </div>
      ) : (
        <>
          <div className="mx-3.5 overflow-hidden rounded-2xl bg-surface">
            <Step state="done" label="File uploaded" />
            <Step state={mappingState} label="AI mapping & rules" />
            <Step
              state={job?.status === 'done' ? 'done' : 'idle'}
              label="Statement created"
            />
          </div>
          {(job === undefined || job.status === 'running') && (
            <p className="px-6 pt-3 text-center text-[12.5px] text-ink-2">
              The AI infers the column mapping and rules run — this can take a
              minute. Leave this screen open.
            </p>
          )}
          {job?.status === 'failed' && (
            <div className="mx-3.5 mt-3 rounded-2xl bg-err-bg px-4 py-3.5">
              <p className="text-[13px] font-semibold text-err">
                {job.error ?? 'Import failed'}
              </p>
              <Button variant="secondary" className="mt-2" onClick={reset}>
                Try again
              </Button>
            </div>
          )}
          {job?.status === 'done' && job.statement_id !== null && (
            <div className="px-4 pt-4">
              <Link
                to={`/bank/statements/${job.statement_id}`}
                viewTransition
                className="block h-[46px] rounded-xl bg-accent text-center text-[14px] font-bold leading-[46px] text-white"
              >
                Open statement
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  );
}
