import { fmtCents } from '../api';

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
  const suffix = currency === 'EUR' ? '€' : currency;
  return (
    <span
      className={`font-bold tabular-nums ${positive ? 'text-ok' : ''} ${className}`}
    >
      {positive ? '+' : ''}
      {fmtCents(cents)} {suffix}
    </span>
  );
}
