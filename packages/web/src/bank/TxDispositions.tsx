import { fmtCents, type BankTransaction } from '../api';
import { Button } from '../ui/Button';
import { GroupLabel } from '../ui/List';
import { Sheet } from '../ui/Sheet';

/** The "Or" group — alternatives are always reachable, never the accent. */
export function OrRow({ onClick }: { onClick: () => void }) {
  return (
    <>
      <GroupLabel>Or</GroupLabel>
      <div className="mx-3.5 mb-3 overflow-hidden rounded-2xl bg-surface">
        <button
          type="button"
          onClick={onClick}
          className="flex min-h-[44px] w-full items-center gap-3 px-3.5 py-2.5 text-left"
        >
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[#4D534E]">
            Personal · Bank fee · Prepayment
          </span>
          <span aria-hidden className="flex-none text-base text-[#C2C7C1]">
            ›
          </span>
        </button>
      </div>
    </>
  );
}

/**
 * Disposition fan. Visibility is bound to the server contract:
 * personal → outflows only, open + matchless (endpoint 400s otherwise);
 * fee → composed create-expense (no fee endpoint), outflow + matchless;
 * prepayment → books the WHOLE line, so matchless lines only.
 */
export function OtherSheet({
  open,
  onOpenChange,
  tx,
  hasMatches,
  feeAvailable,
  busy,
  onPersonal,
  onFee,
  onPrepayment,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tx: BankTransaction;
  hasMatches: boolean;
  feeAvailable: boolean;
  busy: boolean;
  onPersonal: () => void;
  onFee: () => void;
  onPrepayment: () => void;
}) {
  const options: { label: string; sub: string; onPick: () => void }[] = [];
  if (tx.amount < 0 && !hasMatches) {
    options.push({
      label: 'Personal',
      sub: 'Not business — becomes your debt to the company',
      onPick: onPersonal,
    });
    if (feeAvailable) {
      options.push({
        label: 'Bank fee',
        sub: `Bank-fee expense, VAT 0 · ${fmtCents(tx.amount)} €`,
        onPick: onFee,
      });
    }
  }
  if (tx.amount !== 0 && !hasMatches) {
    options.push({
      label: 'Prepayment',
      sub: `Whole line on account · ${fmtCents(Math.abs(tx.amount))} €`,
      onPick: onPrepayment,
    });
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Other actions">
      <div className="px-4 pb-4">
        <div className="overflow-hidden rounded-2xl bg-surface">
          {options.map((o) => (
            <button
              key={o.label}
              type="button"
              disabled={busy}
              onClick={o.onPick}
              className="flex w-full items-center gap-3 border-b border-line px-3.5 py-3 text-left last:border-b-0 disabled:opacity-50"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14.5px] font-semibold">
                  {o.label}
                </div>
                <div className="truncate text-[12.5px] text-ink-2">{o.sub}</div>
              </div>
              <span aria-hidden className="flex-none text-base text-[#C2C7C1]">
                ›
              </span>
            </button>
          ))}
          {options.length === 0 && (
            <p className="px-3.5 py-3 text-[13px] text-ink-2">
              No dispositions apply — the line has matches or is incoming-only.
            </p>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/**
 * §6★b — personal NEVER shows a chart of accounts (ADR-0001/0017): the
 * country plugin resolves the account; the operator sees consequences in
 * human words. The owner-debt running balance is not exposed by any endpoint
 * (degradation, see appendix) — the sheet explains without the number.
 * This sheet IS the explicit confirm: markPersonal posts immediately and has
 * no undo endpoint.
 */
export function PersonalSheet({
  open,
  onOpenChange,
  tx,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tx: BankTransaction;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Personal spend">
      <p className="px-7 pb-2.5 text-center text-[12px] text-ink-2">
        {tx.description ?? 'Bank line'} · {fmtCents(tx.amount)} €
      </p>
      <div className="mx-4 mb-3 rounded-[13px] bg-warn-bg px-3.5 py-2.5 text-[12px] leading-[1.45] text-[#6D4A05]">
        <b className="mb-0.5 block text-[11px] uppercase tracking-wide">
          What happens
        </b>
        This is not a company expense: it will not enter the P&amp;L and no VAT
        is deducted. The amount is recorded as your debt to the company — repay
        it by transfer or settle it against a payout.
      </div>
      <div className="flex gap-2.5 px-4 pb-4">
        <Button
          variant="secondary"
          className="h-[46px] flex-1"
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button className="h-[46px] flex-1" busy={busy} onClick={onConfirm}>
          Record as personal
        </Button>
      </div>
      <p className="px-6 pb-3 text-center text-[10.5px] text-[#8A9089]">
        One attributable tap — you are the approver; recorded in the audit log
      </p>
    </Sheet>
  );
}

/** Whole-line prepayment — explicit confirm (posts immediately, no undo). */
export function PrepaymentSheet({
  open,
  onOpenChange,
  tx,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tx: BankTransaction;
  busy: boolean;
  onConfirm: () => void;
}) {
  const incoming = tx.amount > 0;
  const abs = fmtCents(Math.abs(tx.amount));
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Record prepayment">
      <p className="px-7 pb-2.5 text-center text-[12px] text-ink-2">
        {tx.description ?? 'Bank line'} · {incoming ? '+' : '-'}
        {abs} €
      </p>
      <div className="mx-4 mb-3 rounded-[13px] bg-warn-bg px-3.5 py-2.5 text-[12px] leading-[1.45] text-[#6D4A05]">
        <b className="mb-0.5 block text-[11px] uppercase tracking-wide">
          What happens
        </b>
        Records the whole {abs} € as a{' '}
        {incoming
          ? 'customer prepayment (money received on account)'
          : 'supplier prepayment (money paid on account)'}
        . It can settle {incoming ? 'invoices' : 'bills'} later — future lines
        will offer it as a match candidate.
      </div>
      <div className="flex gap-2.5 px-4 pb-4">
        <Button
          variant="secondary"
          className="h-[46px] flex-1"
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button className="h-[46px] flex-1" busy={busy} onClick={onConfirm}>
          Record prepayment · {incoming ? '+' : '-'}
          {abs} €
        </Button>
      </div>
    </Sheet>
  );
}

/** Incoming line, no invoices — the prepayment state from the routing matrix.
 *  Owner-debt repayment has no endpoint (appendix) and is not offered. */
export function IncomingOpen({
  tx,
  onPrepayment,
}: {
  tx: BankTransaction;
  onPrepayment: () => void;
}) {
  return (
    <>
      <div className="mx-3.5 mb-3 rounded-[13px] bg-ok-bg px-3.5 py-2.5 text-[12px] leading-[1.45] text-ok">
        <b className="mb-0.5 block text-[11px] uppercase tracking-wide">
          Incoming payment, no open invoices
        </b>
        Record it as a customer prepayment — it will offer itself as a match
        when the invoice appears.
      </div>
      <div className="sticky bottom-0 bg-gradient-to-t from-bg via-bg/95 to-transparent px-4 pb-3.5 pt-3">
        <Button className="h-[46px] w-full" onClick={onPrepayment}>
          Record prepayment · +{fmtCents(tx.amount)} €
        </Button>
      </div>
    </>
  );
}
