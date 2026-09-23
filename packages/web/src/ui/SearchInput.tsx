export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  ...aria
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Put on the input itself (the wrapper only draws the glyph). */
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl bg-fill px-3 py-2">
      <span aria-hidden className="text-ink-2">
        ⌕
      </span>
      <input
        {...aria}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent text-[13px] outline-none placeholder:text-ink-2"
      />
    </div>
  );
}
