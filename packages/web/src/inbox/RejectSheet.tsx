import { useState } from 'react';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import { Button } from '../ui/Button';
import { Field, INPUT_CLS, PendingFieldset } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import type { RejectCopy } from './approvalSemantics';

/** Reject = a deliberate decision with a MANDATORY reason (ADR-0015; the
 *  server persists it on the approval). Never window.prompt. What rejecting
 *  does depends on the object type — `copy` says it (issue #290). */
export function RejectSheet({
  copy,
  open,
  onOpenChange,
  busy,
  onSubmit,
}: {
  copy: RejectCopy;
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
      title={copy.title}
      guard={guard}
      busy={busy}
    >
      <PendingFieldset pending={busy} className="space-y-3 px-5 pb-2">
        <p className="text-[13px] text-ink-2">{copy.intro}</p>
        <Field label="Reason" hint="Required — it lands in the audit trail">
          <textarea
            className={INPUT_CLS}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={copy.placeholder}
          />
        </Field>
        <Button
          className="w-full"
          busy={busy}
          disabled={reason.trim() === ''}
          onClick={() => onSubmit(reason.trim(), guard.release)}
        >
          {copy.action}
        </Button>
      </PendingFieldset>
    </Sheet>
  );
}
