import type { ReactNode } from 'react';

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {icon != null && <div className="text-3xl">{icon}</div>}
      <p className="text-[15px] font-bold">{title}</p>
      {hint != null && <p className="text-[13px] text-ink-2">{hint}</p>}
      {action != null && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <div className="mx-3.5 mb-3.5 overflow-hidden rounded-2xl bg-surface">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          data-testid="skeleton-row"
          className="flex animate-pulse items-center gap-3 border-b border-line px-3.5 py-3 last:border-b-0"
        >
          <div className="h-9 w-9 flex-none rounded-xl bg-line" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-2/3 rounded bg-line" />
            <div className="h-3 w-1/3 rounded bg-line" />
          </div>
        </div>
      ))}
    </div>
  );
}
