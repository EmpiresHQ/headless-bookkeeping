import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { uploadDocument } from '../api';
import { writeImportPointer } from '../bank/importResume';
import { usePendingOperation } from '../lib/pendingOperation';
import { useOriginState } from '../lib/returnNavigation';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import { useEntities } from '../queries/shared';
import { Button } from '../ui/Button';
import { Field, PendingFieldset, SelectInput } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';
import {
  claimantOptions,
  continuation,
  continueUpload,
  failedStage,
  payerMismatch,
  storedPayerLabel,
  type StagedUpload,
  type UploadResult,
} from './uploadFlow';

type Failure = { documentId: number; stage: 'processing' | 'result' };

/**
 * "Upload a document" — the same sheet from Books and from the Inbox
 * (issue #258): same input (file + who paid), same continuation. The
 * caller's page is recorded as the origin of a triage item it opens, so
 * that item is a SINGLE item returning to the caller (#252/#253).
 */
export function UploadDocumentSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const origin = useOriginState();
  const entitiesQ = useEntities();
  // The chosen File (identity) — also what is uploaded.
  const [file, setFile] = useState<File | null>(null);
  const [claimantId, setClaimantId] = useState('');
  const op = usePendingOperation('Upload a document');
  const busy = op.pending;
  // What the server accepted (issue #251), bound to the File it was sent
  // as: the same File never uploads again, and its payer is fixed with it.
  const staged = useRef<StagedUpload | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const partial =
    staged.current !== null && staged.current.file === file
      ? staged.current
      : null;
  const guard = useUnsavedChanges({
    label: 'Upload a document',
    active: open,
    values: { file, claimantId },
    baseline: { file: null as File | null, claimantId: '' },
  });

  const entities = entitiesQ.data ?? [];
  // ADR-0036: the employee/director who paid out-of-pocket.
  const claimants = claimantOptions(entities);
  // The payer must be KNOWN before anything is sent: while the list loads
  // or failed, "company paid" would be an implicit answer. A selection can
  // outlive a refetch (entity deleted or no longer an employee/director): it
  // stays visible and must be corrected — never sent unseen. A staged upload
  // already has its (immutable) payer.
  const staleSelection =
    claimantId !== '' && !claimants.some((c) => String(c.id) === claimantId);
  const payerReady =
    partial !== null || (entitiesQ.data !== undefined && !staleSelection);
  const mismatch = partial !== null && payerMismatch(partial);
  const shownFailure =
    partial !== null && failure?.documentId === partial.document.id
      ? failure.stage
      : null;

  const selectedLabel = (id: string) =>
    id === ''
      ? 'company paid'
      : `paid by ${entities.find((e) => String(e.id) === id)?.name ?? `entity #${id}`}`;

  const submit = () => {
    if (file === null || !payerReady) return;
    const chosen = { file, claimantId };
    const resume = partial;
    op.run(
      async (
        ctx,
      ): Promise<
        { stop: 'payer' } | { stop: null; result: UploadResult; dup: boolean }
      > => {
        let current: StagedUpload;
        if (resume !== null) {
          current = resume;
        } else {
          const up = await uploadDocument(chosen.file, {
            claimantId:
              chosen.claimantId === '' ? null : Number(chosen.claimantId),
          });
          current = {
            ...chosen,
            document: up.document,
            deduplicated: up.deduplicated,
            outcome: null,
          };
          staged.current = current;
          ctx.check();
          // A known file keeps its stored payer: stop and say so before
          // anything continues — never as if the new choice was saved.
          if (payerMismatch(current)) return { stop: 'payer' };
        }
        // Stage boundary: never start processing under another session.
        ctx.check();
        const result = await continueUpload(qc, current, ctx.check);
        return { stop: null, result, dup: current.deduplicated };
      },
      {
        onSuccess: (r) => {
          if (r.stop === 'payer') {
            setFailure(null);
            return;
          }
          const c = continuation(r.result, r.dup);
          if (c.tone === 'ok') toastOk(c.message);
          else toastErr(c.message);
          // A statement import this operation just started is the tab's
          // import (#254): a plain return to /bank/import resumes IT, not an
          // older job. (Never for a known duplicate — nothing started.)
          if (r.result.kind === 'bank_statement')
            writeImportPointer(r.result.jobId);
          staged.current = null;
          guard.release();
          onOpenChange(false);
          // A triage item opened from here is a single item returning to
          // this page; everything else is ordinary browsing.
          if (r.result.kind === 'needs_triage')
            navigate(c.to, { state: origin });
          else navigate(c.to);
        },
        onError: (e) => {
          const message = e instanceof Error ? e.message : String(e);
          const up =
            staged.current !== null && staged.current.file === chosen.file
              ? staged.current
              : null;
          const stage = failedStage(up);
          if (up === null || stage === 'upload') {
            toastErr(`Upload failed: ${message}`);
            return;
          }
          setFailure({ documentId: up.document.id, stage });
          toastErr(
            stage === 'processing'
              ? `Uploaded as document #${up.document.id}, but processing failed: ${message}`
              : `Document #${up.document.id} is stored, but loading its result failed: ${message}`,
          );
        },
      },
    );
  };

  const docLink = (id: number) => (
    <Link className="font-semibold underline" to={`/books/documents/${id}`}>
      document #{id}
    </Link>
  );

  const buttonLabel =
    partial === null
      ? 'Upload & process'
      : shownFailure === 'result'
        ? 'Reload result'
        : shownFailure === 'processing'
          ? 'Retry processing'
          : mismatch
            ? `Continue with document #${partial.document.id}`
            : 'Retry processing';

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Upload a document"
      guard={guard}
      busy={busy}
    >
      <PendingFieldset
        pending={busy}
        status="AI is reading the document — this can take a minute…"
        className="space-y-3 px-5 pb-2"
      >
        <Field label="File">
          <input
            type="file"
            className="w-full text-[14px]"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        {entitiesQ.isError && entitiesQ.data === undefined ? (
          <div className="rounded-2xl bg-err-bg px-4 py-3">
            <p className="text-[13px] font-semibold text-err">
              Could not load who can pay out of pocket — choose the payer before
              uploading.
            </p>
            <Button
              variant="secondary"
              className="mt-2"
              onClick={() => void entitiesQ.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : entitiesQ.data === undefined ? (
          <Field label="Paid by (claimant)">
            <SelectInput value="" disabled>
              <option value="">Loading payers…</option>
            </SelectInput>
          </Field>
        ) : (
          (claimants.length > 0 || claimantId !== '') && (
            <Field
              label="Paid by (claimant)"
              error={
                staleSelection && partial === null
                  ? 'This person can no longer be chosen as the payer — choose again'
                  : undefined
              }
              hint={
                partial !== null
                  ? 'Fixed for this file once uploaded — the same file sent again keeps its stored payer'
                  : 'Only when an employee or director paid out of pocket — the expense is then held for approval'
              }
            >
              <SelectInput
                value={claimantId}
                disabled={partial !== null}
                onChange={(e) => setClaimantId(e.target.value)}
              >
                <option value="">— company paid —</option>
                {staleSelection && (
                  <option value={claimantId}>
                    {entities.find((e) => String(e.id) === claimantId)?.name ??
                      `Entity #${claimantId}`}{' '}
                    (not eligible)
                  </option>
                )}
                {claimants.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </SelectInput>
            </Field>
          )
        )}
        {partial !== null && mismatch && (
          <p className="rounded-2xl bg-warn-bg px-4 py-3 text-[13px] text-warn">
            This file is already uploaded as {docLink(partial.document.id)},
            stored as {storedPayerLabel(partial.document, entities)}.{' '}
            {`Uploading again never changes a stored document, so your choice (${selectedLabel(partial.claimantId)}) was not applied.`}{' '}
            Continuing uses the document as stored.
          </p>
        )}
        {partial !== null && shownFailure === 'processing' && (
          <p className="rounded-2xl bg-warn-bg px-4 py-3 text-[13px] text-warn">
            This file is already uploaded as {docLink(partial.document.id)} —
            only processing failed. Retrying re-runs processing; it does not
            upload the file again.
          </p>
        )}
        {partial !== null && shownFailure === 'result' && (
          <p className="rounded-2xl bg-warn-bg px-4 py-3 text-[13px] text-warn">
            This file is stored as {docLink(partial.document.id)}
            {partial.outcome !== null ? ' and was processed' : ''}, but its
            result could not be loaded. Retrying only reloads the result — it
            does not upload or process the file again.
          </p>
        )}
        <Button
          className="w-full"
          busy={busy}
          disabled={file === null || busy || !payerReady}
          onClick={submit}
        >
          {buttonLabel}
        </Button>
      </PendingFieldset>
    </Sheet>
  );
}
