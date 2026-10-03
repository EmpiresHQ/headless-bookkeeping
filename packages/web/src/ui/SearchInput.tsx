import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

/**
 * Every search needs a stable accessible name (issue #287): the placeholder
 * vanishes on typing and is only a hint, so the type demands an explicit
 * aria-label or aria-labelledby — naming cannot be forgotten by a caller.
 */
type SearchName =
  | { 'aria-label': string; 'aria-labelledby'?: string }
  | { 'aria-labelledby': string; 'aria-label'?: string };

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  ...aria
}: SearchName & {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  /** For focusing it from a form's error summary (issue #265). */
  id?: string;
  onBlur?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** While an operation on the listed rows is pending (issue #278). */
  disabled?: boolean;
}) {
  // The field shows its own text (issue #303). The list searches keep
  // `value` in ?q=, and the router commits that in a transition, so
  // between a key and that commit React would restore the field to the old
  // `value`: the next key lands on it and fast typing loses characters.
  // `sent` holds what was typed but not echoed back yet. An echo (even a
  // late, intermediate one) leaves the text alone; any other `value` —
  // Reset, Back, a caller clearing it — replaces it.
  const [text, setText] = useState(value);
  const sent = useRef<string[]>([]);
  useLayoutEffect(() => {
    const at = sent.current.indexOf(value);
    if (at >= 0 && value !== sent.current[sent.current.length - 1]) {
      sent.current = sent.current.slice(at + 1);
      return;
    }
    sent.current = [];
    setText(value);
  }, [value]);
  // The wrapper draws the keyboard focus ring (issue #287): an outline
  // never moves the box, inset so no clipping or scrolling parent (sheet
  // bodies, overflow-hidden groups) can cut it, and it survives forced
  // colors. The input's own outline is removed outright — Tailwind's
  // outline-none is a transparent outline that forced colors would paint
  // as a second ring. The aria props go on the input itself.
  return (
    <div className="flex items-center gap-2 rounded-xl bg-fill px-3 py-2 focus-within:outline focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-accent">
      <span aria-hidden className="text-ink-2">
        ⌕
      </span>
      <input
        {...aria}
        type="search"
        value={text}
        onChange={(e) => {
          const next = e.target.value;
          sent.current.push(next);
          setText(next);
          onChange(next);
        }}
        placeholder={placeholder}
        className="w-full bg-transparent text-[13px] [outline:none] placeholder:text-ink-2 disabled:opacity-60"
      />
    </div>
  );
}
