import { fmtCents } from '../api';
import { currencyMark } from '../lib/money';

/** Money display: tabular digits, optional +sign/ok-color for inflows. */
export function AmountText({
  cents,
  currency = 'EUR',
  showSign = false,
  className = '',
}: {
  cents: number;
  currency?: string;
  showSign?: boolean;
  className?: string;
}) {
  const positive = showSign && cents > 0;
  return (
    <span
      className={`font-bold tabular-nums ${positive ? 'text-ok' : ''} ${className}`}
    >
      {positive ? '+' : ''}
      {fmtCents(cents)} {currencyMark(currency)}
    </span>
  );
}
