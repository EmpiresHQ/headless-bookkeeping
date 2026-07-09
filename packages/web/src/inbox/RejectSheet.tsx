import { useState } from 'react';
import { Button } from '../ui/Button';
import { Field, INPUT_CLS } from '../ui/Form';
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
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Reject">
      <div className="space-y-3 px-5 pb-2">
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
          onClick={() => onSubmit(reason.trim())}
        >
          Reject &amp; return to draft
        </Button>
      </div>
    </Sheet>
  );
}
