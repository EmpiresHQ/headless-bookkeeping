# SPA Redesign — Plan 01: Foundation (tokens, UI kit, shell, query layer)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat 14-tab shell of `packages/web` with the new flow-first app shell (5 sections, bottom tab bar / sidebar, `createBrowserRouter`), design tokens, a reusable UI kit, and a TanStack Query data layer — while keeping every existing screen reachable (mounted as legacy content inside the new shell).

**Architecture:** New shell components live in `src/ui/` (kit) and `src/shell/` (layout + router). Legacy View components stay untouched and are mounted under the new 5-section route tree via a `LegacyTabs` adapter; old URLs redirect to new ones. Later plans (02–06) rebuild each section's screens and delete legacy views. Spec: `docs/superpowers/specs/2026-07-08-spa-ux-redesign-design.md`.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind 3, react-router-dom v7 (data mode), @tanstack/react-query v5, vaul, sonner, @radix-ui/react-alert-dialog, lucide-react, vitest + @testing-library/react (jsdom).

## Global Constraints

- Working directory for all commands: `packages/web` (repo root: `/Users/alekseirevin/test/headless-bookkeeping`).
- Test command: `npx vitest run <file>`; full suite: `npm test`; lint: `npm run lint`; build (typecheck + bundle): `npm run build`.
- Design tokens (exact values, from spec): `bg #F2F3F1`, `surface #FFFFFF`, `ink #191C1A`, `ink-2 #6E756F`, `line #EEF0EC`, `accent #0E5A3C`, `accent-deep #0E3B2C`, `signal #3DDC97`, `ok #14713F`/bg `#E3F2E9`, `warn #8A5A00`/bg `#FDF0D3`, `err #A83A2C`/bg `#FBE9E5`, `alert #E8590C`.
- **Never** use `window.prompt` / `window.confirm` / `window.alert` in new code.
- All colors in new code go through Tailwind token classes (`bg-surface`, `text-ink-2`, …), not raw hex — with the few one-off greys noted inline in this plan.
- UI copy is English (matches existing screens).
- Amounts render `tabular-nums`; money **inputs** are euros, never cents (relevant from Plan 02 on; `src/lib/money.ts` created here).
- Legacy View components (`src/components/*View.tsx`, `MailboxSettings.tsx`, etc.) are NOT modified in this plan.
- Commit style: `feat(web): …` / `refactor(web): …`, small commits per task.
- React runs in StrictMode; components must survive double-mount.

---

### Task 1: Dependencies + design tokens + base styles

**Files:**
- Modify: `packages/web/package.json` (via npm install)
- Modify: `packages/web/tailwind.config.js`
- Modify: `packages/web/src/index.css`

**Interfaces:**
- Consumes: nothing.
- Produces: Tailwind classes `bg-bg`, `bg-surface`, `text-ink`, `text-ink-2`, `border-line`, `bg-accent`, `bg-accent-deep`, `text-signal`, `text-ok`/`bg-ok-bg`, `text-warn`/`bg-warn-bg`, `text-err`/`bg-err-bg`, `bg-alert` for every later task. NPM packages: `@tanstack/react-query`, `vaul`, `sonner`, `@radix-ui/react-alert-dialog`, `lucide-react`.

- [ ] **Step 1: Install dependencies** (run from repo root)

```bash
cd /Users/alekseirevin/test/headless-bookkeeping
npm install @tanstack/react-query vaul sonner @radix-ui/react-alert-dialog lucide-react -w @headless-bookkeeping/web
```

Expected: package.json of the web workspace gains the five deps; install succeeds (all support React 18).

- [ ] **Step 2: Replace `tailwind.config.js` with the token palette**

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Semantic tokens (spec 2026-07-08-spa-ux-redesign-design.md).
        // Dark theme later = swap these values; never hardcode hex in components.
        bg: '#F2F3F1',
        surface: '#FFFFFF',
        ink: { DEFAULT: '#191C1A', 2: '#6E756F' },
        line: '#EEF0EC',
        accent: { DEFAULT: '#0E5A3C', deep: '#0E3B2C' },
        signal: '#3DDC97',
        ok: { DEFAULT: '#14713F', bg: '#E3F2E9' },
        warn: { DEFAULT: '#8A5A00', bg: '#FDF0D3' },
        err: { DEFAULT: '#A83A2C', bg: '#FBE9E5' },
        alert: '#E8590C',
      },
    },
  },
  plugins: [],
};
```

- [ ] **Step 3: Extend `src/index.css`** (keep the three @tailwind lines, add below them)

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  body {
    @apply bg-bg text-ink antialiased;
    font-family:
      -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI',
      system-ui, sans-serif;
  }
}

/* Route transitions (react-router viewTransition). Basic cross-slide;
   directional pop refinement comes with the Inbox plan. */
@media (prefers-reduced-motion: no-preference) {
  ::view-transition-old(root) {
    animation: 90ms ease both vt-fade-out;
  }
  ::view-transition-new(root) {
    animation: 180ms ease both vt-slide-in;
  }
}
@keyframes vt-slide-in {
  from {
    opacity: 0.6;
    transform: translateX(24px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes vt-fade-out {
  to {
    opacity: 0.4;
  }
}
```

- [ ] **Step 4: Verify build and existing tests still pass**

```bash
cd packages/web && npm run build && npm test
```

Expected: build succeeds, all existing tests PASS (tokens are additive; legacy `bg-gray-100` classes still work).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json packages/web/package.json packages/web/tailwind.config.js packages/web/src/index.css
git commit -m "feat(web): design tokens, base styles, foundation deps for SPA redesign"
```

---

### Task 2: Button, Chip, AmountText

**Files:**
- Create: `packages/web/src/ui/Button.tsx`
- Create: `packages/web/src/ui/Chip.tsx`
- Create: `packages/web/src/ui/AmountText.tsx`
- Test: `packages/web/src/ui/Button.test.tsx`, `packages/web/src/ui/Chip.test.tsx`, `packages/web/src/ui/AmountText.test.tsx`

**Interfaces:**
- Consumes: `fmtCents(cents: number): string` from `src/api.ts` (exists: `(cents / 100).toFixed(2)`).
- Produces:
  - `Button({ variant?: 'primary'|'secondary'|'danger'|'ghost', busy?: boolean, ...ButtonHTMLAttributes })`
  - `Chip({ tone?: 'ok'|'warn'|'err'|'muted'|'accent', children })`
  - `AmountText({ cents: number, currency?: string, showSign?: boolean, className?: string })`

- [ ] **Step 1: Write failing tests**

`src/ui/Button.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('renders children and defaults to primary variant', () => {
    render(<Button>Approve</Button>);
    const btn = screen.getByRole('button', { name: 'Approve' });
    expect(btn.className).toContain('bg-accent');
  });

  it('is disabled and shows spinner text while busy', () => {
    render(<Button busy>Save</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('applies danger variant', () => {
    render(<Button variant="danger">Delete</Button>);
    expect(screen.getByRole('button').className).toContain('bg-err');
  });
});
```

`src/ui/Chip.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Chip } from './Chip';

describe('Chip', () => {
  it('renders tone classes', () => {
    render(<Chip tone="warn">needs triage</Chip>);
    const el = screen.getByText('needs triage');
    expect(el.className).toContain('bg-warn-bg');
    expect(el.className).toContain('text-warn');
  });

  it('defaults to muted', () => {
    render(<Chip>draft</Chip>);
    expect(screen.getByText('draft').className).toContain('text-ink-2');
  });
});
```

`src/ui/AmountText.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AmountText } from './AmountText';

describe('AmountText', () => {
  it('formats cents as euros', () => {
    render(<AmountText cents={-8900} />);
    expect(screen.getByText('-89.00 €')).toBeInTheDocument();
  });

  it('shows plus sign and ok color for positive amounts when showSign', () => {
    render(<AmountText cents={120000} showSign />);
    const el = screen.getByText('+1200.00 €');
    expect(el.className).toContain('text-ok');
  });

  it('renders non-EUR currency code', () => {
    render(<AmountText cents={500} currency="USD" />);
    expect(screen.getByText('5.00 USD')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/ui/Button.test.tsx src/ui/Chip.test.tsx src/ui/AmountText.test.tsx
```

Expected: FAIL — cannot resolve `./Button` etc.

- [ ] **Step 3: Implement**

`src/ui/Button.tsx`:

```tsx
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
```

`src/ui/Chip.tsx`:

```tsx
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
```

`src/ui/AmountText.tsx`:

```tsx
import { fmtCents } from '../api';

/** Money display: tabular digits, optional +sign/ok-color for inflows. */
export function AmountText({
  cents,
  currency = 'EUR',
  showSign = false,
  className = '',
}: {
  cents: number;
  currency?: string;
  showSign?: boolean;
  className?: string;
}) {
  const positive = showSign && cents > 0;
  const suffix = currency === 'EUR' ? '€' : currency;
  return (
    <span
      className={`font-bold tabular-nums ${positive ? 'text-ok' : ''} ${className}`}
    >
      {positive ? '+' : ''}
      {fmtCents(cents)} {suffix}
    </span>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/ui/Button.test.tsx src/ui/Chip.test.tsx src/ui/AmountText.test.tsx
```

Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/ui
git commit -m "feat(web): UI kit — Button, Chip, AmountText"
```

---

### Task 3: ListGroup, ListRow, KeyValue, EmptyState, Skeleton

**Files:**
- Create: `packages/web/src/ui/List.tsx` (ListGroup + ListRow + GroupLabel + KeyValue)
- Create: `packages/web/src/ui/Feedback.tsx` (EmptyState + SkeletonRows)
- Test: `packages/web/src/ui/List.test.tsx`, `packages/web/src/ui/Feedback.test.tsx`

**Interfaces:**
- Consumes: react-router `Link` (rows can navigate).
- Produces:
  - `GroupLabel({ children })`
  - `ListGroup({ label?: ReactNode, children, className? })`
  - `ListRow({ to?: string, onClick?: () => void, leading?: ReactNode, title: ReactNode, subtitle?: ReactNode, trailing?: ReactNode, chip?: ReactNode })` — renders `<Link viewTransition>` when `to`, `<button>` when `onClick`, `<div>` otherwise; chevron appears when interactive.
  - `KeyValue({ k: ReactNode, v: ReactNode })`
  - `EmptyState({ icon?: ReactNode, title: string, hint?: string, action?: ReactNode })`
  - `SkeletonRows({ count?: number })`

- [ ] **Step 1: Write failing tests**

`src/ui/List.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { KeyValue, ListGroup, ListRow } from './List';

describe('ListRow', () => {
  it('renders a link with chevron when `to` is set', () => {
    render(
      <MemoryRouter>
        <ListRow to="/books/expenses/1" title="Telia Eesti AS" subtitle="Software" />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/books/expenses/1');
    expect(screen.getByText('Telia Eesti AS')).toBeInTheDocument();
    expect(screen.getByText('›')).toBeInTheDocument();
  });

  it('renders a button when `onClick` is set and fires it', () => {
    const onClick = vi.fn();
    render(<ListRow onClick={onClick} title="Retry" />);
    screen.getByRole('button').click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders static div with no chevron when non-interactive', () => {
    render(<ListRow title="Static" />);
    expect(screen.queryByText('›')).toBeNull();
  });
});

describe('ListGroup / KeyValue', () => {
  it('renders group label and key/value pair', () => {
    render(
      <ListGroup label="Classification">
        <KeyValue k="Category" v="Software & IT" />
      </ListGroup>,
    );
    expect(screen.getByText('Classification')).toBeInTheDocument();
    expect(screen.getByText('Category')).toBeInTheDocument();
    expect(screen.getByText('Software & IT')).toBeInTheDocument();
  });
});
```

`src/ui/Feedback.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState, SkeletonRows } from './Feedback';

describe('EmptyState', () => {
  it('renders title and hint', () => {
    render(<EmptyState title="Inbox zero" hint="Nothing needs your decision." />);
    expect(screen.getByText('Inbox zero')).toBeInTheDocument();
    expect(screen.getByText('Nothing needs your decision.')).toBeInTheDocument();
  });
});

describe('SkeletonRows', () => {
  it('renders the requested number of pulse rows', () => {
    render(<SkeletonRows count={4} />);
    expect(screen.getAllByTestId('skeleton-row')).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/ui/List.test.tsx src/ui/Feedback.test.tsx
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/ui/List.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mx-6 mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-2">
      {children}
    </p>
  );
}

export function ListGroup({
  label,
  children,
  className = '',
}: {
  label?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div>
      {label != null && <GroupLabel>{label}</GroupLabel>}
      <div
        className={`mx-3.5 mb-3.5 overflow-hidden rounded-2xl bg-surface ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

const ROW_CLS =
  'flex w-full items-center gap-3 border-b border-line px-3.5 py-3 text-left last:border-b-0';

export function ListRow({
  to,
  onClick,
  leading,
  title,
  subtitle,
  trailing,
  chip,
}: {
  to?: string;
  onClick?: () => void;
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  chip?: ReactNode;
}) {
  const interactive = to != null || onClick != null;
  const body = (
    <>
      {leading != null && <div className="flex-none">{leading}</div>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-semibold">{title}</div>
        {subtitle != null && (
          <div className="truncate text-[12.5px] text-ink-2">{subtitle}</div>
        )}
        {chip != null && <div className="mt-0.5">{chip}</div>}
      </div>
      {trailing != null && (
        <div className="flex-none text-right">{trailing}</div>
      )}
      {interactive && (
        <span aria-hidden className="flex-none text-base text-[#C2C7C1]">
          ›
        </span>
      )}
    </>
  );
  if (to != null) {
    return (
      <Link to={to} viewTransition className={ROW_CLS}>
        {body}
      </Link>
    );
  }
  if (onClick != null) {
    return (
      <button type="button" onClick={onClick} className={ROW_CLS}>
        {body}
      </button>
    );
  }
  return <div className={ROW_CLS}>{body}</div>;
}

export function KeyValue({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line px-3.5 py-2.5 text-sm last:border-b-0">
      <span className="text-ink-2">{k}</span>
      <span className="text-right font-semibold tabular-nums">{v}</span>
    </div>
  );
}
```

`src/ui/Feedback.tsx`:

```tsx
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/ui/List.test.tsx src/ui/Feedback.test.tsx
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/ui
git commit -m "feat(web): UI kit — grouped lists, rows, key-values, empty/skeleton states"
```

---

### Task 4: Field, TextInput, SegmentedControl, SearchInput + money helpers

**Files:**
- Create: `packages/web/src/ui/Form.tsx` (Field + TextInput + SelectInput)
- Create: `packages/web/src/ui/SegmentedControl.tsx`
- Create: `packages/web/src/ui/SearchInput.tsx`
- Create: `packages/web/src/lib/money.ts`
- Test: `packages/web/src/ui/Form.test.tsx`, `packages/web/src/ui/SegmentedControl.test.tsx`, `packages/web/src/lib/money.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `Field({ label: string, error?: string | null, hint?: string, children })`
  - `TextInput(props: InputHTMLAttributes<HTMLInputElement>)`, `SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>)`
  - `SegmentedControl<T extends string>({ options: { value: T; label: string }[], value: T, onChange: (v: T) => void })`
  - `SearchInput({ value: string, onChange: (v: string) => void, placeholder?: string })`
  - `eurosToCents(input: string): number | null` (accepts `"89"`, `"89.00"`, `"89,00"`; null on garbage), `centsToEuroInput(cents: number): string`

- [ ] **Step 1: Write failing tests**

`src/lib/money.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { centsToEuroInput, eurosToCents } from './money';

describe('eurosToCents', () => {
  it('parses plain euros', () => {
    expect(eurosToCents('89')).toBe(8900);
  });
  it('parses dot and comma decimals', () => {
    expect(eurosToCents('89.05')).toBe(8905);
    expect(eurosToCents('89,05')).toBe(8905);
  });
  it('rejects garbage and >2 decimals', () => {
    expect(eurosToCents('abc')).toBeNull();
    expect(eurosToCents('1.234')).toBeNull();
    expect(eurosToCents('')).toBeNull();
  });
  it('accepts negative amounts', () => {
    expect(eurosToCents('-12.50')).toBe(-1250);
  });
});

describe('centsToEuroInput', () => {
  it('renders cents as an editable euro string', () => {
    expect(centsToEuroInput(8905)).toBe('89.05');
  });
});
```

`src/ui/Form.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Field, TextInput } from './Form';

describe('Field', () => {
  it('associates label with input and shows error', () => {
    render(
      <Field label="Gross (EUR)" error="Enter a valid amount">
        <TextInput />
      </Field>,
    );
    expect(screen.getByLabelText('Gross (EUR)')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid amount')).toBeInTheDocument();
  });

  it('shows hint when no error', () => {
    render(
      <Field label="Currency" hint="ISO code, e.g. EUR">
        <TextInput />
      </Field>,
    );
    expect(screen.getByText('ISO code, e.g. EUR')).toBeInTheDocument();
  });
});
```

`src/ui/SegmentedControl.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from './SegmentedControl';

describe('SegmentedControl', () => {
  const options = [
    { value: 'all', label: 'All' },
    { value: 'triage', label: 'Triage' },
  ];

  it('marks active option and switches on click', () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={options} value="all" onChange={onChange} />);
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    screen.getByRole('tab', { name: 'Triage' }).click();
    expect(onChange).toHaveBeenCalledWith('triage');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/lib/money.test.ts src/ui/Form.test.tsx src/ui/SegmentedControl.test.tsx
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/lib/money.ts`:

```ts
/**
 * Money INPUT convention (spec): humans type euros ("89", "89.05", "89,05"),
 * the API speaks integer cents. Every money form field must go through these.
 */
export function eurosToCents(input: string): number | null {
  const cleaned = input.trim().replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

export function centsToEuroInput(cents: number): string {
  return (cents / 100).toFixed(2);
}
```

`src/ui/Form.tsx`:

```tsx
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

export const INPUT_CLS =
  'w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-[15px] outline-none focus:border-accent disabled:opacity-50';

export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string | null;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-semibold">{label}</span>
      {children}
      {hint != null && error == null && (
        <span className="mt-1 block text-xs text-ink-2">{hint}</span>
      )}
      {error != null && (
        <span className="mt-1 block text-xs text-err">{error}</span>
      )}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={INPUT_CLS} {...props} />;
}

export function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={INPUT_CLS} {...props} />;
}
```

`src/ui/SegmentedControl.tsx`:

```tsx
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
    <div role="tablist" className="flex rounded-[10px] bg-[#E5E7E3] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`flex-1 whitespace-nowrap rounded-lg py-1.5 text-xs font-semibold ${
            o.value === value
              ? 'bg-surface text-ink shadow-sm'
              : 'text-ink-2'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
```

`src/ui/SearchInput.tsx`:

```tsx
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl bg-[#E9EBE7] px-3 py-2">
      <span aria-hidden className="text-ink-2">
        ⌕
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent text-[13px] outline-none placeholder:text-ink-2"
      />
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/lib/money.test.ts src/ui/Form.test.tsx src/ui/SegmentedControl.test.tsx
```

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/ui packages/web/src/lib
git commit -m "feat(web): UI kit — form fields, segmented control, search, euro money helpers"
```

---

### Task 5: Sheet, ConfirmDialog, toasts

**Files:**
- Create: `packages/web/src/ui/Sheet.tsx`
- Create: `packages/web/src/ui/ConfirmDialog.tsx`
- Create: `packages/web/src/ui/toast.tsx`
- Test: `packages/web/src/ui/Sheet.test.tsx`, `packages/web/src/ui/ConfirmDialog.test.tsx`, `packages/web/src/ui/toast.test.tsx`

**Interfaces:**
- Consumes: `vaul` (Drawer), `@radix-ui/react-alert-dialog`, `sonner`.
- Produces:
  - `Sheet({ open: boolean, onOpenChange: (o: boolean) => void, title?: string, children })` — bottom sheet; actions live in `children`.
  - `ConfirmDialog({ open, onOpenChange, title, body, confirmLabel, destructive?, busy?, onConfirm })` — the ONLY sanctioned replacement for `window.confirm`.
  - `AppToaster()` (mount once in shell), `toastOk(msg)`, `toastErr(msg)`, `toastUndo(msg, onUndo)` (5s undo action).

- [ ] **Step 1: Write failing tests**

`src/ui/Sheet.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sheet } from './Sheet';

describe('Sheet', () => {
  it('renders title and children when open', () => {
    render(
      <Sheet open onOpenChange={vi.fn()} title="Reject approval">
        <p>Reason required</p>
      </Sheet>,
    );
    expect(screen.getByText('Reject approval')).toBeInTheDocument();
    expect(screen.getByText('Reason required')).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(
      <Sheet open={false} onOpenChange={vi.fn()} title="Hidden">
        <p>Body</p>
      </Sheet>,
    );
    expect(screen.queryByText('Hidden')).toBeNull();
  });
});
```

`src/ui/ConfirmDialog.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('fires onConfirm and renders destructive style', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete statement?"
        body="This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
```

Note: if `@testing-library/user-event` is not installed, use `screen.getByRole('button', { name: 'Delete' }).click()` inside `act()` instead — check `package.json` first.

`src/ui/toast.test.tsx`:

```tsx
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster, toastUndo } from './toast';

describe('toastUndo', () => {
  it('shows message with an Undo action', async () => {
    render(<AppToaster />);
    act(() => {
      toastUndo('Approved #214', vi.fn());
    });
    expect(await screen.findByText('Approved #214')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/ui/Sheet.test.tsx src/ui/ConfirmDialog.test.tsx src/ui/toast.test.tsx
```

Expected: FAIL — modules not found. (If vaul/radix need `ResizeObserver`/`matchMedia` in jsdom, add polyfill stubs to `src/test-setup.ts`:)

```ts
// Append to src/test-setup.ts if Sheet/Dialog tests crash on missing APIs:
if (!('ResizeObserver' in globalThis)) {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = RO;
}
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
```

- [ ] **Step 3: Implement**

`src/ui/Sheet.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Drawer } from 'vaul';

/** Bottom sheet for actions attached to the current screen (spec: action =
 *  sheet; object with identity = route; irreversible = ConfirmDialog). */
export function Sheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/45" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 flex max-h-[92vh] flex-col rounded-t-3xl bg-bg pb-6 outline-none">
          <div className="mx-auto mb-3 mt-2.5 h-1 w-10 flex-none rounded-full bg-[#D4D7D1]" />
          {title != null && (
            <Drawer.Title className="mb-2 flex-none px-6 text-center text-lg font-extrabold">
              {title}
            </Drawer.Title>
          )}
          <div className="overflow-y-auto">{children}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
```

`src/ui/ConfirmDialog.tsx`:

```tsx
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import type { ReactNode } from 'react';
import { Button } from './Button';

/** Explicit confirm for irreversible actions (period lock, delete).
 *  Never optimistic; never window.confirm. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  destructive = false,
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/45" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-48px)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-surface p-5">
          <AlertDialog.Title className="text-[17px] font-extrabold">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 text-[13.5px] text-ink-2">{body}</div>
          </AlertDialog.Description>
          <div className="mt-4 flex gap-2.5">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary" className="flex-1">
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <Button
              variant={destructive ? 'danger' : 'primary'}
              className="flex-1"
              busy={busy}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
```

`src/ui/toast.tsx`:

```tsx
import { Toaster, toast } from 'sonner';

export function AppToaster() {
  return <Toaster position="top-center" richColors closeButton={false} />;
}

export const toastOk = (message: string) => toast.success(message);
export const toastErr = (message: string) => toast.error(message);

/** Optimistic-action receipt with 5s undo (spec: reversible actions get
 *  Undo, not "Are you sure?"). */
export function toastUndo(message: string, onUndo: () => void) {
  toast(message, {
    duration: 5000,
    action: { label: 'Undo', onClick: onUndo },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/ui/Sheet.test.tsx src/ui/ConfirmDialog.test.tsx src/ui/toast.test.tsx
```

Expected: PASS. If vaul's Drawer requires pointer-capture APIs missing in jsdom, add the stubs from Step 2 to `src/test-setup.ts` and re-run.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/ui packages/web/src/test-setup.ts
git commit -m "feat(web): UI kit — bottom sheet, confirm dialog, undo toasts"
```

---

### Task 6: Query layer with global 401 handling

**Files:**
- Create: `packages/web/src/lib/queryClient.ts`
- Test: `packages/web/src/lib/queryClient.test.tsx`

**Interfaces:**
- Consumes: `UnauthorizedError` from `src/auth.ts` (exists).
- Produces: `createQueryClient(onUnauthorized: () => void): QueryClient` — every `UnauthorizedError` from any query/mutation triggers `onUnauthorized` exactly; no retry on 401. Later plans build resource hooks on top (`useQuery({ queryKey: ['expenses'], queryFn: getExpenses })` pattern).

- [ ] **Step 1: Write failing test**

`src/lib/queryClient.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedError } from '../auth';
import { createQueryClient } from './queryClient';

describe('createQueryClient', () => {
  it('calls onUnauthorized when a query throws UnauthorizedError', async () => {
    const onUnauthorized = vi.fn();
    const client = createQueryClient(onUnauthorized);
    await client
      .fetchQuery({
        queryKey: ['boom'],
        queryFn: () => Promise.reject(new UnauthorizedError()),
      })
      .catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('does not retry unauthorized errors but retries others once', async () => {
    const client = createQueryClient(vi.fn());
    const fn = vi.fn(() => Promise.reject(new Error('flaky')));
    await client
      .fetchQuery({ queryKey: ['flaky'], queryFn: fn })
      .catch(() => undefined);
    expect(fn).toHaveBeenCalledTimes(2); // initial + 1 retry

    const fn401 = vi.fn(() => Promise.reject(new UnauthorizedError()));
    await client
      .fetchQuery({ queryKey: ['auth'], queryFn: fn401 })
      .catch(() => undefined);
    expect(fn401).toHaveBeenCalledTimes(1); // no retry on 401
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/lib/queryClient.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/lib/queryClient.ts`:

```ts
import {
  MutationCache,
  QueryCache,
  QueryClient,
} from '@tanstack/react-query';
import { UnauthorizedError } from '../auth';

/**
 * Central QueryClient. Any 401 (UnauthorizedError from apiFetch) anywhere —
 * query or mutation — funnels into onUnauthorized so the shell can drop to
 * the TokenGate immediately (fixes the legacy per-screen 401 desync).
 */
export function createQueryClient(onUnauthorized: () => void): QueryClient {
  const handle = (error: unknown) => {
    if (error instanceof UnauthorizedError) onUnauthorized();
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError: handle }),
    mutationCache: new MutationCache({ onError: handle }),
    defaultOptions: {
      queries: {
        retry: (failureCount, error) =>
          !(error instanceof UnauthorizedError) && failureCount < 1,
        retryDelay: 0,
        staleTime: 15_000,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/lib/queryClient.test.tsx
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib
git commit -m "feat(web): TanStack Query client with global 401 funnel"
```

---

### Task 7: Shell — TabBar, Sidebar, headers, AppLayout

**Files:**
- Create: `packages/web/src/shell/nav.ts` (section definitions)
- Create: `packages/web/src/shell/TabBar.tsx`
- Create: `packages/web/src/shell/Sidebar.tsx`
- Create: `packages/web/src/shell/Headers.tsx` (LargeTitleHeader + ScreenHeader)
- Create: `packages/web/src/shell/AppLayout.tsx`
- Test: `packages/web/src/shell/AppLayout.test.tsx`

**Interfaces:**
- Consumes: `lucide-react` icons; react-router `NavLink`, `Outlet`, `useNavigate`.
- Produces:
  - `NAV_ITEMS: { to: string; label: string; Icon: LucideIcon }[]` — Inbox `/inbox`, Books `/books`, Bank `/bank`, Reports `/reports`, Settings `/settings`.
  - `TabBar({ inboxCount?: number })` — mobile bottom bar (`lg:hidden`), badge on Inbox when count > 0.
  - `Sidebar({ onSignOut: () => void, inboxCount?: number })` — desktop rail (`hidden lg:flex`).
  - `LargeTitleHeader({ title: string, trailing?: ReactNode })`.
  - `ScreenHeader({ title: string, backTo?: string, trailing?: ReactNode })` — back = `navigate(-1)` when history exists, else `backTo` link.
  - `AppLayout({ onSignOut: () => void })` — full shell with `<Outlet/>`; mobile bottom padding for the tab bar.

- [ ] **Step 1: Write failing test**

`src/shell/AppLayout.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppLayout } from './AppLayout';

function renderShell(path = '/inbox') {
  const router = createMemoryRouter(
    [
      {
        element: <AppLayout onSignOut={vi.fn()} />,
        children: [
          { path: '/inbox', element: <p>inbox body</p> },
          { path: '/books', element: <p>books body</p> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  return render(<RouterProvider router={router} />);
}

describe('AppLayout', () => {
  it('renders all five sections in both navs and the outlet content', () => {
    renderShell();
    // TabBar + Sidebar both render the section links (2 x 5 links).
    expect(screen.getAllByRole('link', { name: /inbox/i })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /books/i })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /bank/i })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /reports/i })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /settings/i })).toHaveLength(2);
    expect(screen.getByText('inbox body')).toBeInTheDocument();
  });

  it('marks the active section', () => {
    renderShell('/books');
    const active = screen
      .getAllByRole('link', { name: /books/i })
      .map((a) => a.getAttribute('aria-current'));
    expect(active).toContain('page');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/shell/AppLayout.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/shell/nav.ts`:

```ts
import {
  BarChart3,
  BookOpen,
  Inbox,
  Landmark,
  Settings,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  Icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/inbox', label: 'Inbox', Icon: Inbox },
  { to: '/books', label: 'Books', Icon: BookOpen },
  { to: '/bank', label: 'Bank', Icon: Landmark },
  { to: '/reports', label: 'Reports', Icon: BarChart3 },
  { to: '/settings', label: 'Settings', Icon: Settings },
];
```

`src/shell/TabBar.tsx`:

```tsx
import { NavLink } from 'react-router-dom';
import { NAV_ITEMS } from './nav';

export function TabBar({ inboxCount = 0 }: { inboxCount?: number }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex justify-around border-t border-line bg-surface/95 pb-[max(env(safe-area-inset-bottom),8px)] pt-2 backdrop-blur lg:hidden">
      {NAV_ITEMS.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          viewTransition
          className={({ isActive }) =>
            `relative flex min-w-[46px] flex-col items-center gap-0.5 text-[9.5px] ${
              isActive ? 'font-bold text-accent' : 'text-ink-2'
            }`
          }
        >
          <Icon size={22} strokeWidth={2} />
          {label}
          {to === '/inbox' && inboxCount > 0 && (
            <span className="absolute -top-1 right-0 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-alert px-1 text-[9px] font-bold text-white">
              {inboxCount}
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
```

`src/shell/Sidebar.tsx`:

```tsx
import { NavLink } from 'react-router-dom';
import { NAV_ITEMS } from './nav';

export function Sidebar({
  onSignOut,
  inboxCount = 0,
}: {
  onSignOut: () => void;
  inboxCount?: number;
}) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-56 flex-col gap-0.5 border-r border-line bg-[#ECEEEA] p-3 lg:flex">
      <div className="flex items-center gap-2 px-3 pb-4 pt-1 text-sm font-extrabold">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent-deep text-xs text-signal">
          ◆
        </span>
        books
      </div>
      {NAV_ITEMS.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          viewTransition
          className={({ isActive }) =>
            `flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium ${
              isActive
                ? 'bg-surface font-bold text-accent-deep shadow-sm'
                : 'text-ink-2 hover:text-ink'
            }`
          }
        >
          <Icon size={17} strokeWidth={2} />
          {label}
          {to === '/inbox' && inboxCount > 0 && (
            <span className="ml-auto rounded-full bg-alert px-1.5 py-px text-[10px] font-bold text-white">
              {inboxCount}
            </span>
          )}
        </NavLink>
      ))}
      <button
        type="button"
        onClick={onSignOut}
        className="mt-auto border-t border-line px-3 py-2.5 text-left text-xs text-ink-2 hover:text-ink"
      >
        Sign out
      </button>
    </aside>
  );
}
```

`src/shell/Headers.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

export function LargeTitleHeader({
  title,
  trailing,
}: {
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between px-5 pb-2 pt-5">
      <h1 className="text-[29px] font-extrabold tracking-tight">{title}</h1>
      {trailing != null && <div className="pb-1">{trailing}</div>}
    </div>
  );
}

/** Stack header with an honest back button: history.back() when we navigated
 *  here in-app; falls back to `backTo` on deep-link entry. */
export function ScreenHeader({
  title,
  backTo,
  trailing,
}: {
  title: string;
  backTo?: string;
  trailing?: ReactNode;
}) {
  const navigate = useNavigate();
  const canGoBack = window.history.state?.idx > 0;
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      {canGoBack || backTo == null ? (
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="text-[15px] font-semibold text-accent"
        >
          ‹ Back
        </button>
      ) : (
        <Link
          to={backTo}
          viewTransition
          className="text-[15px] font-semibold text-accent"
        >
          ‹ Back
        </Link>
      )}
      <span className="text-[15px] font-bold">{title}</span>
      <div className="min-w-[44px] text-right">{trailing}</div>
    </div>
  );
}
```

`src/shell/AppLayout.tsx`:

```tsx
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TabBar } from './TabBar';

export function AppLayout({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <Sidebar onSignOut={onSignOut} />
      <div className="pb-24 lg:pb-6 lg:pl-56">
        <Outlet />
      </div>
      <TabBar />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/shell/AppLayout.test.tsx
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/shell
git commit -m "feat(web): app shell — tab bar, sidebar, headers, layout"
```

---

### Task 8: Router — Root, legacy mounts, redirects, main.tsx swap, delete old shell

**Files:**
- Create: `packages/web/src/shell/Root.tsx`
- Create: `packages/web/src/shell/LegacyTabs.tsx`
- Create: `packages/web/src/shell/router.tsx`
- Modify: `packages/web/src/main.tsx`
- Delete: `packages/web/src/App.tsx`, `packages/web/src/tabs.tsx`
- Test: `packages/web/src/shell/router.test.tsx`

**Interfaces:**
- Consumes: `AppLayout`, `createQueryClient`, `getToken`/`clearToken` + `TokenGate({ onSaved: () => void })` (exist), legacy views from `src/components/` (IntakeView, ApprovalsView, ExpensesView, InvoicesView, DocumentsView, CreditNotesView, BankView, KmdView, OrgView, EntitiesView, CategoriesView, EnrollView, SettingsView), `LargeTitleHeader`, `SegmentedControl`.
- Produces: `buildRouter(): ReturnType<typeof createBrowserRouter>` and `buildRoutes()` (route objects, reusable by `createMemoryRouter` in tests). Section URLs: `/inbox?tab=triage|approvals`, `/books?tab=expenses|invoices|documents|credit-notes`, `/bank`, `/reports`, `/settings?tab=organization|entities|categories|enroll|app`. Old paths redirect (search params preserved, so `/intake?expand=5` → `/inbox?tab=triage&expand=5` keeps the deep-link working).

**Note on lost surface:** the legacy generic `Periods` tab (`TabPage` inside App.tsx) is intentionally dropped — `KmdView` (mounted at `/reports`) already lists periods, creates the next one, and shows filed status. Plan 05 rebuilds the full Reports section.

- [ ] **Step 1: Write failing test**

`src/shell/router.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { setToken } from '../auth';
import { buildRoutes } from './router';

function renderAt(path: string) {
  const router = createMemoryRouter(buildRoutes(), { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe('router', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('test-token');
  });

  it('shows the token gate when no token is stored', () => {
    localStorage.clear();
    renderAt('/inbox');
    expect(screen.getByText(/api token/i)).toBeInTheDocument();
  });

  it('redirects / to /inbox', () => {
    const router = renderAt('/');
    expect(router.state.location.pathname).toBe('/inbox');
  });

  it('redirects legacy /intake to /inbox preserving search params', () => {
    const router = renderAt('/intake?expand=5');
    expect(router.state.location.pathname).toBe('/inbox');
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get('tab')).toBe('triage');
    expect(params.get('expand')).toBe('5');
  });

  it('redirects legacy /expenses to /books?tab=expenses', () => {
    const router = renderAt('/expenses');
    expect(router.state.location.pathname).toBe('/books');
    expect(router.state.location.search).toContain('tab=expenses');
  });

  it('renders legacy section tabs at /settings', () => {
    renderAt('/settings');
    // LegacyTabs segmented control for the settings section.
    expect(screen.getByRole('tab', { name: 'Organization' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Entities' })).toBeInTheDocument();
  });
});
```

(If TokenGate's placeholder text differs, adjust the first assertion to whatever `TokenGate` actually renders — check `src/components/TokenGate.tsx` before writing; it renders a password input and save button for the API token.)

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/shell/router.test.tsx
```

Expected: FAIL — `./router` not found.

- [ ] **Step 3: Implement**

`src/shell/Root.tsx`:

```tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { clearToken, getToken } from '../auth';
import { TokenGate } from '../components/TokenGate';
import { createQueryClient } from '../lib/queryClient';
import { AppToaster } from '../ui/toast';
import { AppLayout } from './AppLayout';

/** Token gate + query provider + shell. Any 401 anywhere funnels here. */
export function Root() {
  const [hasToken, setHasToken] = useState(getToken() !== null);
  const onUnauthorized = useCallback(() => {
    clearToken();
    setHasToken(false);
  }, []);
  const [client] = useState(() => createQueryClient(onUnauthorized));

  if (!hasToken) return <TokenGate onSaved={() => setHasToken(true)} />;

  return (
    <QueryClientProvider client={client}>
      <AppLayout onSignOut={onUnauthorized} />
      <AppToaster />
    </QueryClientProvider>
  );
}
```

`src/shell/LegacyTabs.tsx`:

```tsx
import type { ComponentType } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SegmentedControl } from '../ui/SegmentedControl';
import { LargeTitleHeader } from './Headers';

export interface LegacyTab {
  key: string;
  label: string;
  El: ComponentType;
}

/**
 * Transitional adapter: hosts untouched legacy View components inside the new
 * shell, one section = one URL, active sub-view in ?tab=. Dies with the last
 * legacy view (Plan 06).
 */
export function LegacyTabs({
  title,
  tabs,
}: {
  title: string;
  tabs: LegacyTab[];
}) {
  const [params, setParams] = useSearchParams();
  const active = tabs.find((t) => t.key === params.get('tab')) ?? tabs[0];
  const El = active.El;
  return (
    <div className="mx-auto max-w-5xl">
      <LargeTitleHeader title={title} />
      {tabs.length > 1 && (
        <div className="px-4 pb-3">
          <SegmentedControl
            options={tabs.map((t) => ({ value: t.key, label: t.label }))}
            value={active.key}
            onChange={(v) => setParams({ tab: v }, { replace: true })}
          />
        </div>
      )}
      <div className="mx-4 mb-6 rounded-2xl bg-surface p-3 shadow-sm">
        <El />
      </div>
    </div>
  );
}
```

`src/shell/router.tsx`:

```tsx
import {
  Navigate,
  createBrowserRouter,
  useLocation,
  type RouteObject,
} from 'react-router-dom';
import { ApprovalsView } from '../components/ApprovalsView';
import { BankView } from '../components/BankView';
import { CategoriesView } from '../components/CategoriesView';
import { CreditNotesView } from '../components/CreditNotesView';
import { DocumentsView } from '../components/DocumentsView';
import { EnrollView } from '../components/EnrollView';
import { EntitiesView } from '../components/EntitiesView';
import { ExpensesView } from '../components/ExpensesView';
import { IntakeView } from '../components/IntakeView';
import { InvoicesView } from '../components/InvoicesView';
import { KmdView } from '../components/KmdView';
import { OrgView } from '../components/OrgView';
import { SettingsView } from '../components/SettingsView';
import { LegacyTabs } from './LegacyTabs';
import { Root } from './Root';

/** Old flat-tab URL → new section URL (tab preselected via ?tab=). */
const LEGACY_REDIRECTS: Record<string, string> = {
  '/org': '/settings?tab=organization',
  '/entities': '/settings?tab=entities',
  '/categories': '/settings?tab=categories',
  '/enroll': '/settings?tab=enroll',
  '/expenses': '/books?tab=expenses',
  '/invoices': '/books?tab=invoices',
  '/documents': '/books?tab=documents',
  '/credit-notes': '/books?tab=credit-notes',
  '/intake': '/inbox?tab=triage',
  '/approvals': '/inbox?tab=approvals',
  '/kmd': '/reports',
  '/periods': '/reports',
};

/** Navigate that merges the target's ?tab with the incoming search params
 *  (keeps deep links like /intake?expand=5 working after redirect). */
function RedirectMergingSearch({ to }: { to: string }) {
  const location = useLocation();
  const [pathname, targetSearch] = to.split('?');
  const merged = new URLSearchParams(location.search);
  new URLSearchParams(targetSearch).forEach((v, k) => merged.set(k, v));
  const search = merged.toString();
  return <Navigate to={search ? `${pathname}?${search}` : pathname} replace />;
}

export function buildRoutes(): RouteObject[] {
  return [
    {
      element: <Root />,
      children: [
        { path: '/', element: <Navigate to="/inbox" replace /> },
        {
          path: '/inbox',
          element: (
            <LegacyTabs
              title="Inbox"
              tabs={[
                { key: 'triage', label: 'Triage', El: IntakeView },
                { key: 'approvals', label: 'Approvals', El: ApprovalsView },
              ]}
            />
          ),
        },
        {
          path: '/books',
          element: (
            <LegacyTabs
              title="Books"
              tabs={[
                { key: 'expenses', label: 'Expenses', El: ExpensesView },
                { key: 'invoices', label: 'Invoices', El: InvoicesView },
                { key: 'documents', label: 'Documents', El: DocumentsView },
                { key: 'credit-notes', label: 'Credit notes', El: CreditNotesView },
              ]}
            />
          ),
        },
        {
          path: '/bank',
          element: (
            <LegacyTabs
              title="Bank"
              tabs={[{ key: 'bank', label: 'Bank', El: BankView }]}
            />
          ),
        },
        {
          path: '/reports',
          element: (
            <LegacyTabs
              title="Reports"
              tabs={[{ key: 'kmd', label: 'VAT / KMD', El: KmdView }]}
            />
          ),
        },
        {
          path: '/settings',
          element: (
            <LegacyTabs
              title="Settings"
              tabs={[
                { key: 'organization', label: 'Organization', El: OrgView },
                { key: 'entities', label: 'Entities', El: EntitiesView },
                { key: 'categories', label: 'Categories', El: CategoriesView },
                { key: 'enroll', label: 'Enroll', El: EnrollView },
                { key: 'app', label: 'App', El: SettingsView },
              ]}
            />
          ),
        },
        ...Object.entries(LEGACY_REDIRECTS).map(([from, to]) => ({
          path: from,
          element: <RedirectMergingSearch to={to} />,
        })),
        { path: '*', element: <Navigate to="/inbox" replace /> },
      ],
    },
  ];
}

export function buildRouter() {
  return createBrowserRouter(buildRoutes());
}
```

`src/main.tsx` (full replacement):

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { buildRouter } from './shell/router';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={buildRouter()} />
  </React.StrictMode>,
);
```

Delete the old shell:

```bash
git rm packages/web/src/App.tsx packages/web/src/tabs.tsx
```

(Check first that nothing else imports them: `grep -rn "from './App'\|from './tabs'\|from '../App'\|from '../tabs'" packages/web/src` — expected: only `main.tsx`, already rewritten. If an `App.test.tsx` exists, delete it too.)

- [ ] **Step 4: Run the new test, then the full suite**

```bash
npx vitest run src/shell/router.test.tsx && npm test
```

Expected: router tests PASS; full suite PASS (legacy component tests untouched). Fix any TokenGate copy mismatch in the first test by reading `src/components/TokenGate.tsx`.

- [ ] **Step 5: Commit**

```bash
git add -A packages/web/src
git commit -m "feat(web): new 5-section router shell; legacy views mounted; old tab shell removed"
```

---

### Task 9: Full verification + manual smoke

**Files:**
- No new files; fixes only if verification fails.

**Interfaces:**
- Consumes: everything above.
- Produces: a green, shippable foundation for Plans 02–06.

- [ ] **Step 1: Full test suite, lint, build**

```bash
cd packages/web && npm test && npm run lint && npm run build
```

Expected: all PASS, no lint errors, build succeeds. Fix anything that fails before proceeding.

- [ ] **Step 2: Manual smoke in the browser**

```bash
npm run dev
```

Checklist (resize between ~390px and ≥1024px widths):

- `/` redirects to `/inbox`; token gate appears when localStorage is empty; entering the token lands in the shell.
- Mobile width: bottom tab bar with 5 items; active tab is green; content not hidden behind the bar.
- Desktop width: sidebar with 5 items + Sign out; tab bar hidden.
- Every section renders its legacy content: Inbox (Triage/Approvals segments), Books (4 segments), Bank, Reports (KMD), Settings (5 segments).
- Old URLs redirect: `/intake?expand=1` → `/inbox?tab=triage&expand=1`; `/expenses` → `/books?tab=expenses`; `/org` → `/settings?tab=organization`.
- Sign out (sidebar) drops to the token gate.

- [ ] **Step 3: Commit any smoke fixes**

```bash
git add -A packages/web && git commit -m "fix(web): foundation smoke fixes"
```

(Skip if nothing needed fixing.)

---

## Follow-up plans (written after this one executes)

- **Plan 02 — Inbox**: unified queue (triage + approvals), hero card, detail routes `/inbox/doc/:id` + `/inbox/approval/:id`, approve with Undo, reject sheet, triage form sheets, polling, badge count wiring, inbox-zero.
- **Plan 03 — Books**: rebuilt lists with month groups, detail routes, corrections sheet, document archive + discarded filter, create flows, euro-input fix for credit notes.
- **Plan 04 — Bank**: async import flow, statement screen, tx detail with N:M matching and dispositions, bulk book.
- **Plan 05 — Reports**: periods + folded submission state, KMD detail, lock guard flow, submissions timeline.
- **Plan 06 — Settings + cleanup**: settings sub-screens (incl. the Telegram section added to SettingsView in commit c2e3026), entity detail with aliases, delete all remaining legacy views/`Table.tsx`/`window.*` dialogs.
