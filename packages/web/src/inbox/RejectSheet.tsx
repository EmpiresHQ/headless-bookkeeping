import { useState } from 'react';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import { Button } from '../ui/Button';
import { Field, INPUT_CLS, PendingFieldset } from '../ui/Form';
import { Sheet } from '../ui/Sheet';

/** Reject = a deliberate decision with a MANDATORY reason (ADR-0015; the
 *  server persists it on the draft). Never window.prompt. */
export function RejectSheet({
  open,
  onOpenChange,
  busy,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  busy: boolean;
  /** `release` marks the reason saved — call it on success before leaving. */
  onSubmit: (reason: string, release: () => void) => void;
}) {
  const [reason, setReason] = useState('');
  const guard = useUnsavedChanges({
    label: 'Reject',
    active: open,
    values: reason.trim(),
    baseline: '',
  });
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Reject"
      guard={guard}
      busy={busy}
    >
      <PendingFieldset pending={busy} className="space-y-3 px-5 pb-2">
        <p className="text-[13px] text-ink-2">
          The item returns to draft with your reason attached — nothing is
          deleted. (A rejected bank match is discarded instead.)
        </p>
        <Field label="Reason" hint="Required — it lands in the audit trail">
          <textarea
            className={INPUT_CLS}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why this should not be posted…"
          />
        </Field>
        <Button
          className="w-full"
          busy={busy}
          disabled={reason.trim() === ''}
          onClick={() => onSubmit(reason.trim(), guard.release)}
        >
          Reject &amp; return to draft
        </Button>
      </PendingFieldset>
    </Sheet>
  );
}
