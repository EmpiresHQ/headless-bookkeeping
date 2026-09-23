export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div role="tablist" className="flex rounded-[10px] bg-track p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          type="button"
          onClick={() => onChange(o.value)}
          // Square 44px-min button so its whole box is the hit area (a
          // rounded button loses its corners to the track); the rounded
          // selected pill is the inner span filling it (#273).
          className="flex min-h-11 flex-auto text-xs font-semibold leading-tight"
        >
          <span
            className={`flex min-w-11 flex-1 items-center justify-center rounded-lg px-1 py-1 text-center ${
              o.value === value ? 'bg-surface text-ink shadow-sm' : 'text-ink-2'
            }`}
          >
            {o.label}
          </span>
        </button>
      ))}
    </div>
  );
}
