import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

/** Shared with LinkButton (a Link styled as this same kit Button) — keep
 *  primary/secondary here as the single source of truth so the two never
 *  drift apart visually. */
export const BUTTON_VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white',
  secondary: 'bg-fill text-ink',
  danger: 'bg-err text-white',
  ghost: 'bg-transparent text-accent',
};

const VARIANTS = BUTTON_VARIANTS;

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant;
    busy?: boolean;
  }
>(function Button(
  {
    variant = 'primary',
    busy = false,
    className = '',
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      className={`rounded-xl px-4 py-2.5 text-[15px] font-bold transition-opacity disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {busy ? '…' : children}
    </button>
  );
});
