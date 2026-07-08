import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white',
  secondary: 'bg-[#E9EBE7] text-ink',
  danger: 'bg-err text-white',
  ghost: 'bg-transparent text-accent',
};

export function Button({
  variant = 'primary',
  busy = false,
  className = '',
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  busy?: boolean;
}) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      className={`rounded-xl px-4 py-2.5 text-[15px] font-bold transition-opacity disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {busy ? '…' : children}
    </button>
  );
}
