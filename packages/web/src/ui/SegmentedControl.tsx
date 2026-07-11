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
          className={`flex-1 whitespace-nowrap rounded-lg py-1.5 text-xs font-semibold ${
            o.value === value ? 'bg-surface text-ink shadow-sm' : 'text-ink-2'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
