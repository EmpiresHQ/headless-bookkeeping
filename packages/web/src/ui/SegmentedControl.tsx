import { useId } from 'react';

/**
 * A single choice among a few options: a list filter, a view, a treatment
 * (issue #288). Every caller swaps what is shown or chosen in place with no
 * tab panels, so this is a radio group, not a tablist: native radios sharing
 * one per-instance name give the arrow keys (next/previous checked, wrapping)
 * and "Tab enters on the checked option, then leaves" for free, and follow a
 * disabled ancestor fieldset. `label` names the group, so an option such as
 * "All" is announced with what it filters.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  /** While an operation on the listed rows is pending (issue #278). */
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex rounded-[10px] bg-track p-0.5"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          // Square 44px-min label so its whole box is the hit area (a
          // rounded one loses its corners to the track); the rounded
          // selected pill is the inner span filling it (#273).
          <label
            key={o.value}
            className="relative flex min-h-11 flex-auto text-xs font-semibold leading-tight"
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={on}
              disabled={disabled}
              // A disabled radio never changes in a browser; a dispatched
              // click (jsdom) still could, so the prop is checked too.
              onChange={() => {
                if (!disabled) onChange(o.value);
              }}
              // Enter on a radio would implicitly submit an enclosing form.
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault();
              }}
              className="peer sr-only"
            />
            {/* Forced colors drop the pill's background and paint a
                transparent border: the unchecked border is set to Canvas
                (system colors are kept) so it vanishes, and the checked
                option gets a Highlight border plus an underline, a cue that
                is not color alone. Neither changes the box. The focus ring
                is an outline, which forced colors paint in a system color. */}
            <span
              className={`flex min-w-11 flex-1 items-center justify-center rounded-lg border border-transparent p-[3px] text-center peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-0 peer-focus-visible:outline-accent peer-disabled:opacity-60 ${
                on
                  ? 'bg-surface text-ink shadow-sm forced-colors:border-[Highlight] forced-colors:underline forced-colors:decoration-2 forced-colors:underline-offset-2'
                  : 'text-ink-2 forced-colors:border-[Canvas]'
              }`}
            >
              {o.label}
            </span>
          </label>
        );
      })}
    </div>
  );
}
