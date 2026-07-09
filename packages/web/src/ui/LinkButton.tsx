import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

type Variant = 'primary' | 'secondary';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white',
  secondary: 'bg-[#E9EBE7] text-ink',
};

/** A route navigation styled as a kit Button (mirror of ui/Button styles).
 *  Use when a "button" is really a Link — never window.location, never a
 *  button+navigate pair. Always animates with viewTransition. */
export function LinkButton({
  to,
  variant = 'primary',
  className = '',
  children,
}: {
  to: string;
  variant?: Variant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      viewTransition
      className={`inline-block rounded-xl px-4 py-2.5 text-center text-[15px] font-bold ${VARIANTS[variant]} ${className}`}
    >
      {children}
    </Link>
  );
}
