import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { uploadDocument } from '../api';
import { writeImportPointer } from '../bank/importResume';
import { usePendingOperation } from '../lib/pendingOperation';
import {
  useResultLog,
  writeChain,
  type ChainSlot,
  type ResultInit,
} from '../lib/resultLog';
import { useOriginState } from '../lib/returnNavigation';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import { useEntities } from '../queries/shared';
import { Button } from '../ui/Button';
import { Field, PendingFieldset, SelectInput } from '../ui/Form';
import { lookupState, LookupNotice } from '../ui/Lookup';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';
import {
  claimantOptions,
  continuation,
  continueUpload,
  failedStage,
  needsProcessing,
  outcomeLinks,
  payerMismatch,
  resultLinks,
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
  // The durable record of the staged upload (#259): one entry per staged
  // document, updated by every later stage and retry.
  const log = useResultLog();
  // Bound to the File: a failed upload request's receipt, then the staged
  // document's stages — a retry of the same File supersedes, never adds.
  // Written through writeChain, so a handle of an ended log generation is
  // never reused (a retry after a sign-in elsewhere records anew).
  const chain = useRef<{
    file: File;
    slot: ChainSlot;
    last: ResultInit | null;
  } | null>(null);
  /** Write this File's record: a full entry, or a patch over its last. */
  const writeFile = (
    f: File,
    next: ResultInit | Partial<ResultInit>,
    live?: () => boolean,
  ) => {
    if (chain.current?.file !== f)
      chain.current = { file: f, slot: { current: null }, last: null };
    const c = chain.current;
    if (c.last === null && !('action' in next)) return;
    c.last = { ...c.last, ...next } as ResultInit;
    writeChain(c.slot, log.record, c.last, live);
  };
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
          // Recorded the moment the server accepted it: a later failure or
          // a reload never loses which document now exists.
          const docId = up.document.id;
          const accepted: ResultInit = {
            action: 'Upload',
            title: chosen.file.name,
            outcome: up.deduplicated
              ? `Already uploaded as document #${docId} — nothing new was stored.`
              : `Stored as document #${docId} — processing…`,
            tone: 'running',
            links: [
              {
                label: `Document #${docId}`,
                to: `/books/documents/${docId}`,
              },
            ],
          };
          writeFile(chosen.file, accepted, ctx.live);
          // A known file keeps its stored payer: stop and say so before
          // anything continues — never as if the new choice was saved.
          if (payerMismatch(current)) {
            writeFile(
              current.file,
              {
                outcome: `Already uploaded as document #${docId}, stored as ${storedPayerLabel(current.document, entities)} — your payer choice was not applied and nothing was processed yet.`,
                tone: 'warn',
              },
              ctx.live,
            );
            return { stop: 'payer' };
          }
        }
        // Stage boundary: never start processing under another session.
        ctx.check();
        // Honest stage copy: only a document that still needs a processing
        // call is "processing"; a handled duplicate or a result-only retry
        // just reads what is stored.
        writeFile(
          current.file,
          {
            outcome: needsProcessing(current)
              ? `Document #${current.document.id} — processing…`
              : `Document #${current.document.id} — reading its stored result…`,
            tone: 'running',
          },
          ctx.live,
        );
        const result = await continueUpload(qc, current, ctx.check, (o) =>
          writeFile(
            current.file,
            {
              outcome: `Document #${o.document_id} was processed — loading the result…`,
              tone: 'running',
              links: outcomeLinks(o),
            },
            ctx.live,
          ),
        );
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
          // Stored and processed, but not routed to a result is PARTIAL —
          // never a failure, never a finished success.
          if (staged.current !== null)
            writeFile(staged.current.file, {
              outcome: c.message,
              tone: c.tone === 'ok' ? 'ok' : 'partial',
              links: resultLinks(r.result),
            });
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
            // No document id came back — whether the server stored the
            // file is not known here, so nothing is claimed either way.
            const failed: ResultInit = {
              action: 'Upload',
              title: chosen.file.name,
              outcome: `The upload was not confirmed — no document ID was received (${message}). The file may or may not be stored: retry from this sheet while it is open (it keeps your file; an identical stored file is recognized, not stored twice), or check Documents.`,
              tone: 'error',
              links: [{ label: 'Documents', to: '/books?seg=documents' }],
            };
            writeFile(chosen.file, failed);
            return;
          }
          setFailure({ documentId: up.document.id, stage });
          writeFile(
            up.file,
            stage === 'processing'
              ? {
                  outcome: `Stored as document #${up.document.id}, but processing was not confirmed: ${message}. Retry processing while this upload sheet is still open; after it is closed or the page reloads, open the document for its current state — uploading the same file again does not re-process it.`,
                  tone: 'partial',
                }
              : {
                  outcome: `Document #${up.document.id} is stored${up.outcome !== null ? ' and was processed' : ''}, but its result could not be loaded: ${message}.`,
                  tone: 'partial',
                  ...(up.outcome !== null
                    ? { links: outcomeLinks(up.outcome) }
                    : {}),
                },
          );
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
          // Never hidden (#260): a known-empty list still states the answer
          // — company paid — and why nothing else can be chosen.
          <div>
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
                  : claimants.length === 0 && claimantId === ''
                    ? // Absence is only claimed from a FRESH list (#260).
                      lookupState(entitiesQ) === 'stale'
                      ? 'The list loaded earlier had no employee or director, and it could not be refreshed — retry it before relying on company paid'
                      : 'No employee or director is on file, so only company paid can be chosen — add one under Settings → Entities to record an out-of-pocket payment'
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
            {partial === null && (
              <LookupNotice query={entitiesQ} what="payers" />
            )}
          </div>
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
