import type { ReactNode } from 'react';

type Tone = 'ok' | 'warn' | 'err' | 'muted' | 'accent';

const TONES: Record<Tone, string> = {
  ok: 'bg-ok-bg text-ok',
  warn: 'bg-warn-bg text-warn',
  err: 'bg-err-bg text-err',
  muted: 'bg-line text-ink-2',
  accent: 'bg-[#E3EFE8] text-accent',
};

export function Chip({
  tone = 'muted',
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}
