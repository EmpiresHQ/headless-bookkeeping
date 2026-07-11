import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BUTTON_VARIANTS } from './Button';

type Variant = 'primary' | 'secondary';

// Subset of BUTTON_VARIANTS (LinkButton only ever renders primary/secondary,
// Button.tsx's Record<Variant, string> is the source of truth so the two
// never drift apart visually).
const VARIANTS: Record<Variant, string> = {
  primary: BUTTON_VARIANTS.primary,
  secondary: BUTTON_VARIANTS.secondary,
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
