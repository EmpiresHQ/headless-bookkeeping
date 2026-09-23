import { Link } from 'react-router-dom';
import type { MatchFacts } from '../api';
import { signedMoney } from '../lib/money';
import { KeyValue, ListGroup } from '../ui/List';

// Every row wraps (KeyValue never truncates): exact amounts, currencies and long
// references must stay fully readable at phone width, never truncated.
import { absoluteDateFromIso } from './format';
import { formatMoney, targetNoun } from './matchFacts';

const KIND_LABEL: Record<MatchFacts['target']['kind'], string> = {
  sales_invoice: 'Sales invoice',
  expense: 'Expense',
  prepayment: 'Advance',
  unidentified: 'Unidentified',
};

/** The hero of a bank-match approval: the bank line's own signed amount,
 *  in its own currency. */
export function matchHero(f: MatchFacts): { amount: string; subtitle: string } {
  const tx = f.bankTransaction;
  const who =
    tx.counterpartyDescriptor ?? tx.description ?? tx.reference ?? 'Bank line';
  return {
    amount: signedMoney(tx.amount, tx.currency),
    subtitle: `${absoluteDateFromIso(tx.transactionDate)} · ${who}`,
  };
}

/** What approving this match does, in business terms (activateMatch). */
export function matchMeaning(f: MatchFacts): string {
  const base = f.baseCurrency;
  const tx = f.bankTransaction;
  const fx =
    tx.sourceCurrency !== null && tx.sourceCurrency !== tx.currency
      ? ` The line was converted from ${tx.sourceCurrency}; any exchange difference is booked as realized FX.`
      : '';
  if (f.status === 'active')
    return 'This match is already active (it was confirmed in Bank). Approving only closes this request — nothing new is booked.';
  switch (f.target.kind) {
    case 'sales_invoice':
    case 'expense': {
      const side =
        f.target.kind === 'sales_invoice'
          ? 'bank against the receivable'
          : 'the payable against bank';
      return (
        `Approving confirms this bank line pays ${targetNoun(f)} with ` +
        `${formatMoney(f.amountMatched, base)} and books the settlement ` +
        `(${side}) immediately. Unmatch in Bank reverses it.${fx}`
      );
    }
    case 'prepayment':
      return (
        `Approving applies this bank line to ${targetNoun(f)}: its open ` +
        `balance falls by ${formatMoney(f.amountMatched, base)}. No settlement ` +
        `voucher is posted — the advance already booked its cash. Unmatch in ` +
        `Bank reverses it.${fx}`
      );
    default:
      return 'The matched object could not be identified.';
  }
}

/**
 * The exact pair behind a reconciliation_match approval (issue #256): the
 * bank line, the business object it settles, and how this allocation sits
 * among the line's other matches. Units are explicit: the line in its own
 * currency (plus the original foreign amount), the document in ITS currency,
 * allocations in the base currency as persisted. Business links only — no
 * voucher ids.
 */
export function MatchApprovalFacts({ facts }: { facts: MatchFacts }) {
  const base = facts.baseCurrency;
  const tx = facts.bankTransaction;
  const t = facts.target;
  const line = facts.line;
  // An ACTIVE match is already inside the remaining/line figures (they sum
  // active matches); a draft one is not yet.
  const active = facts.status === 'active';
  const partialLeft = active
    ? t.voucherRemaining
    : t.voucherRemaining - facts.amountMatched;

  const targetCurrency =
    t.kind === 'prepayment' ? (t.advance?.currency ?? null) : t.currency;
  // The allocation is the TARGET's amount at its booked rate; the line's
  // cash figures are cash. They are the same number only when the target is
  // in base currency. Nothing is converted here.
  const allocationIsCash = targetCurrency === base;
  // Actual unallocated cash on the line: only when the line's own amount IS
  // its base cash (a base-currency line the bank did not convert), against
  // the ACTIVE matches' persisted cash. Staged matches reserve nothing.
  const lineIsBaseCash = tx.currency === base && tx.sourceCurrency === null;
  const unallocatedNow = lineIsBaseCash
    ? Math.abs(tx.amount) - line.activeCashBase
    : null;
  // What would remain after approving THIS draft (only when its allocation
  // is cash in base); other staged matches are listed, not assumed approved.
  const unallocatedAfter =
    unallocatedNow !== null && !active && allocationIsCash
      ? unallocatedNow - facts.amountMatched
      : null;

  const objectLink =
    t.kind === 'sales_invoice' && t.objectId !== null
      ? `/books/invoices/${t.objectId}`
      : t.kind === 'expense' && t.objectId !== null
        ? `/books/expenses/${t.objectId}`
        : null;

  return (
    <>
      <ListGroup label="Bank line">
        <KeyValue k="Date" v={absoluteDateFromIso(tx.transactionDate)} />
        <KeyValue k="Amount" v={signedMoney(tx.amount, tx.currency)} />
        {tx.sourceAmount !== null && tx.sourceCurrency !== null && (
          <KeyValue
            k="Original amount"
            v={formatMoney(tx.sourceAmount, tx.sourceCurrency)}
          />
        )}
        {tx.description !== null && (
          <KeyValue k="Description" v={tx.description} />
        )}
        {(tx.counterpartyDescriptor ?? tx.counterpartyIban) !== null && (
          <KeyValue
            k="Counterparty"
            v={tx.counterpartyDescriptor ?? tx.counterpartyIban}
          />
        )}
        {tx.reference !== null && <KeyValue k="Reference" v={tx.reference} />}
      </ListGroup>

      <ListGroup label="Settles">
        <KeyValue
          k={KIND_LABEL[t.kind]}
          v={
            objectLink !== null ? (
              <Link to={objectLink} className="text-accent">
                {t.objectLabel} ›
              </Link>
            ) : (
              t.objectLabel
            )
          }
        />
        <KeyValue k="Counterparty" v={t.counterpartyName ?? '—'} />
        {t.grossAmount !== null && t.currency !== null && (
          <KeyValue
            k="Document total"
            v={formatMoney(t.grossAmount, t.currency)}
          />
        )}
        {t.kind === 'prepayment' && t.advance !== null && (
          <>
            <KeyValue
              k="Advance date"
              v={absoluteDateFromIso(t.advance.date)}
            />
            <KeyValue
              k={`Advance recorded (${base})`}
              v={formatMoney(t.advance.originalBaseAmount, base)}
            />
            {t.advance.currency !== base && (
              <KeyValue k="Advance currency" v={t.advance.currency} />
            )}
            {t.advance.fundingLine !== null && (
              <KeyValue
                k="Advance from line"
                v={`${absoluteDateFromIso(t.advance.fundingLine.transactionDate)} · ${
                  t.advance.fundingLine.description ??
                  t.advance.fundingLine.reference ??
                  '—'
                } · ${signedMoney(t.advance.fundingLine.amount, t.advance.fundingLine.currency)}`}
              />
            )}
          </>
        )}
        <KeyValue
          k={
            active
              ? `Still open on it (${base})`
              : `Open before this match (${base})`
          }
          v={formatMoney(t.voucherRemaining, base)}
        />
      </ListGroup>

      <ListGroup label="This match">
        <KeyValue
          k={`${active ? 'Settles' : 'Would settle'} (${base}${
            allocationIsCash ? '' : ', at the document’s booked rate'
          })`}
          v={formatMoney(facts.amountMatched, base)}
        />
        {t.kind !== 'prepayment' && (
          <KeyValue
            k={active ? 'Object after this match' : 'Object if approved'}
            v={
              partialLeft < 0
                ? `Exceeds the open amount by ${formatMoney(-partialLeft, base)}`
                : partialLeft > 0
                  ? `Partly settled — ${formatMoney(partialLeft, base)} stays open`
                  : 'Fully settled'
            }
          />
        )}
        {line.activeCashBase > 0 && (
          <KeyValue
            k={
              active
                ? `Line cash settled, incl. this match (${base})`
                : `Line cash already settled (${base})`
            }
            v={formatMoney(line.activeCashBase, base)}
          />
        )}
        {unallocatedNow !== null && (
          <KeyValue
            k={`Line cash unallocated now (${base})`}
            v={formatMoney(Math.max(0, unallocatedNow), base)}
          />
        )}
        {unallocatedAfter !== null && (
          <KeyValue
            k={`Line cash unallocated if approved (${base})`}
            v={formatMoney(Math.max(0, unallocatedAfter), base)}
          />
        )}
        {line.otherDraftCount > 0 && (
          <KeyValue
            k={`Other staged matches on this line — not settled (${base})`}
            v={`${line.otherDraftCount} · ${formatMoney(line.otherDraftAllocatedBase, base)}`}
          />
        )}
      </ListGroup>
    </>
  );
}
