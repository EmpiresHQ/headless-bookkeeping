# SPA Redesign — Plan 07: Tails — every deferred client finding from Plans 02–06 closed

> **⚠️ EXECUTOR ATTENTION — deviations from the superpowers TDD default, binding for every task:** this plan follows the Plan 02–06 conventions: complete code in every step (No Placeholders), each task = red → green → full suite → commit, `fireEvent` (never `userEvent`) for anything inside a vaul Drawer, typed fixtures, **never `git stash` in any form** (shared cross-worktree stash stack).

**Goal:** Close the consolidated client-side follow-up list the P02–P06 ledgers accumulated — nothing new is built, every task pays down a recorded debt. (1) The **money-sign idiom** is decided once: `signedEuros` (signs by its input's sign, U+2212/`+`) moves to `src/lib/money.ts` and every site that prefixes a literal `−`/`+` around a self-signing formatter sweeps onto it — the latent `−−` double-sign hazard (fmtCents self-signs since P06 Task 2) dies by construction, and the remaining raw `(x/100).toFixed(2)` € displays (the P04/P05 deferred "currency pass": VAT facts and toasts on ExpenseScreen/InvoiceScreen/CreditNoteScreen/DocumentScreen/ApprovalScreen/TriageDocScreen/ClassifyInvoiceSheet) route through `fmtCents`/`signedEuros`. (2) **PolicyScreen** stops lying about a negative ceiling (today: hint renders "Expenses above −5.00 € are held for approval" beside a silently disabled button) and its ingest select gets an optimistic local echo (no snap-back during the in-flight write). (3) **Entities polish**: the detail screen's bookings row states its count basis (entityStats counts posted+pending; the linked `/books` landing shows all statuses), the Team segment's empty state stops being generic and points at the ADR-0036 claimant dropdown (with the create sheet preselecting `employee`), and `useSeg` normalizes lingering legacy `?tab=` into `?seg=` on arrival (P04 Task 13 deferred polish). (4) The **test-hygiene batch**: CreateEntitySheet role-switch payload-leak pin, MailboxScreen's unrestored `window.location` getter spy, the alias Kind-select 3-option pin, CategoriesScreen's `as never` fixture. (5) **act()-warning eradication**: the 98 warnings measured at HEAD (all six confined to bank suites — TxScreen 61, TxMatched 16, StatementScreen 16, TxCandidates 4, TxCreateExpense 2, SupplierSheet 1) die at the source by swapping `vi.waitFor` (not act-aware — the P06 Task 13 discovery) for RTL `waitFor` and adding real settle points; TxScreen's order-coupled `mockResolvedValueOnce` chains are decoupled while in the file. **Zero act() warnings suite-wide becomes an enforced gate.** (6) The **sheet lifecycle migration**: the ten unmount-to-close call sites (`{open && <XSheet open …/>}`) move to keep-mounted + epoch-keyed remount-on-open via a shared `useSheet` hook — this closes the structural Radix/vaul aria-hidden focus-restoration race documented in `ui/Sheet.tsx` while PRESERVING the state-reset discipline the remount pattern was load-bearing for (per-sheet regression pins prove state cannot leak across open/close/reopen). (7) **Route-level code-split**: the 608 kB single chunk splits via `React.lazy` per screen with one `Suspense` boundary in the shell; TokenGate and the shell stay eager; the build gate is the disappearance of Vite's >500 kB warning. The server is NOT modified — every server-side item stays on the accumulated server list (Appendix A).

**Architecture:** No new surfaces. New shared helpers: `signedEuros` re-homed to `src/lib/money.ts` (display siblings of `eurosToCents`/`centsToEuroInput`), `useSheet` in `src/lib/useSheet.ts` (keep-mounted sheet state: `isOpen`/`payload`/`epoch`), a `?tab=`→`?seg=` normalize effect inside the existing `src/lib/useSeg.ts`, and lazy route elements in `src/shell/router.tsx` with the `Suspense` boundary around the `Outlet` in `src/shell/AppLayout.tsx`. Everything else is edits-in-place to screens, sheets, and their test files.

**Tech Stack:** React 18, TypeScript 5.5, Vite 5, Tailwind 3 (foundation tokens), react-router-dom v7 (data mode), @tanstack/react-query v5, vaul (Sheet), sonner (toasts), vitest + @testing-library/react (jsdom). No new dependencies.

## Client reality (verified at HEAD a359d6d — every mandate item re-checked, none fixed en route)

These facts were verified in this worktree on 2026-07-10 and BIND every task below. Where the ledger's file:line drifted, the drift is recorded.

1. **Suite state:** 463/463 tests green across 80 files; `npm run lint` and `npm run build` green; `npm run build` emits ONE app chunk: `dist/assets/index-*.js  608.16 kB │ gzip: 183.08 kB` plus Vite's `(!) Some chunks are larger than 500 kB` warning.
2. **Double-sign sites (7, live):** `fmtCents` self-signs with U+2212 (`src/api.ts:412`), yet these sites prefix a literal sign around a formatter output — a negative input would render `−−`:
   - `src/inbox/InboxScreen.tsx:120` — `−{fmtCents(monthTotalCents)} €` (ledger said :119)
   - `src/books/ExpensesSegment.tsx:141` — `` trailing={`−${fmtCents(g.totalCents)} € · ${g.count}`} ``
   - `src/books/ExpenseScreen.tsx:128` — `` toastOk(`Posted · −${(detail.gross_amount / 100).toFixed(2)} €`) `` (raw toFixed variant)
   - `src/books/create.tsx:213` — `` `Create expense · −${centsToEuroInput(m.grossParsed)} €` `` (centsToEuroInput variant)
   - `src/reports/LockSheet.tsx:61` — `` `${who} · −${fmtCents(e.gross_amount)} € — ${suffix}` `` (and the sibling `+${fmtCents(inv.gross_amount)} €` at :68)
   - `src/reports/sections.tsx:208` — `` trailing={`−${fmtCents(purchasesTotal)} € · ${purchases.length}`} `` (ledger said :203; the sibling Sales header at :182 carries the `+` twin)
   - `src/settings/EntityScreen.tsx:156` — `` `−${fmtCents(stats.totalCents)} €` `` / `` `+${fmtCents(stats.totalCents)} €` `` ternary (ledger said :144)
   `AmountText` (`src/ui/AmountText.tsx`) is safe by construction (only a conditional `+` when `cents > 0`) and is NOT swept.
3. **Currency-pass sites (raw `(x/100).toFixed(2)` € displays, live):** `src/inbox/TriageDocScreen.tsx:200-201`, `src/inbox/ApprovalScreen.tsx:207-208,254`, `src/inbox/ClassifyInvoiceSheet.tsx:281`, `src/books/ExpenseScreen.tsx:128,186`, `src/books/DocumentScreen.tsx:52` (twice in one string), `src/books/InvoiceScreen.tsx:101,159`, `src/books/CreditNoteScreen.tsx:83`. The `confidence.toFixed(2)` sites (`TriageDocScreen.tsx:219`, `ApprovalScreen.tsx:219`, `ExpenseScreen.tsx:198`, `DocumentScreen.tsx:58`) are NOT money and stay. `signedEuros` lives at `src/inbox/format.ts:27-33` with four production consumers (ClassifyExpenseSheet:18, ResolveSupplierSheet:16, TriageDocScreen:30, ApprovalScreen:26-28) — books/reports/settings importing `../inbox/format` for it would be a cross-section smell, hence the re-home.
4. **PolicyScreen (live, both):** `src/settings/PolicyScreen.tsx` — the ceiling `error` prop only fires on `ceilingCents === null` (:190); a negative parse (eurosToCents accepts `-?`) renders the hint `Expenses above −5.00 € are held for approval` while `valid` (:155) silently disables Save; `save()` (:157) rechecks only `ceilingCents === null || !confidenceOk` — no `>= 0`. The ingest select (:95-99) is controlled by `value={current}` straight from the cache — picking a value renders the OLD value until the invalidation refetch lands (snap-back), `disabled={busy}` the only signal.
5. **Entities (live, all three):** `src/settings/EntityScreen.tsx:143-160` — the bookings ListRow (`Expenses · N` → `/books?seg=expenses&q=…`) counts `status !== 'draft'` (`entityStats`, `src/queries/settings.ts:170-193`) while the landing shows every status (no single `?status=` value expresses posted+pending — `STATUS_FILTERS` are single-valued). `src/settings/EntitiesScreen.tsx:78-93` — the Team-segment empty state renders the generic "Nothing matches / Try another segment or search term.". `src/lib/useSeg.ts` reads `?tab=` as an alias but deletes it only on WRITE — `/books?tab=expenses` lingers in the address bar until the first segment switch (P04 Task 13 deferred).
6. **Test hygiene (live, all four):** `src/settings/CreateEntitySheet.test.tsx` has supplier and employee payload tests but NO role-switch leak pin (the component is structurally safe — payload CONDITIONED on role, `CreateEntitySheet.tsx:60-76` — but unpinned; it also carries a duplicated `aria-label="Name"` JSX attribute on the Name input). `src/settings/MailboxScreen.test.tsx:146` installs `vi.spyOn(window, 'location', 'get')` with no `afterEach` restore (file has only `beforeEach(vi.clearAllMocks)` — the getter spy outlives its test). `src/settings/EntityScreen.test.tsx` exercises the alias Kind select but never pins its option set (server accepts exactly `iban|merchant_descriptor|name_alias` — `KINDS`, `src/settings/AddAliasSheet.tsx:10`). `src/settings/CategoriesScreen.test.tsx:31` mocks `getOrganization` with `{ country: 'EE' } as never`.
7. **act() warnings (measured, not estimated):** full-suite run at HEAD logs **98** `not wrapped in act(...)` warnings (ledger estimated ~116); per-suite runs: TxScreen.test.tsx **61**, TxMatched **16**, StatementScreen **16**, TxCandidates **4**, TxCreateExpense **2**, SupplierSheet **1** — and **no other suite emits any** (the OrgView repeat offender died with the legacy deletion). Every one of the six files uses `vi.waitFor` (7/3/7/5/2/4 occurrences respectively) — the P06 Task 13 discovery: `vi.waitFor` polls outside React's act-aware scheduler, so every state update that lands during the poll logs. `TxScreen.test.tsx` additionally chains order-coupled `mockResolvedValueOnce` on `getMatchCandidates`/`listBankTransactions` (:238, :287-301) — an extra retry/refetch silently shifts every subsequent response (P06 Task 2 note).
8. **Unmount-to-close sheet sites (10, not the ledger's ~8):** the pattern `{flag && <XSheet open …/>}` races Radix's focus restoration against the overlay's aria-hidden (documented residual gap, `src/ui/Sheet.tsx:28-41`; strategies offered there: migrate off parent-unmounts-to-close, or neutralize trigger focusability): `src/settings/MailboxScreen.tsx:235` (AddImapSheet), `src/settings/EntitiesScreen.tsx:105-107` (CreateEntitySheet), `src/settings/EntityScreen.tsx:237-252` (EditEntitySheet + AddAliasSheet, both `key={entity.id}`), `src/books/BooksScreen.tsx:86-94` (NewExpenseSheet, NewInvoiceSheet, UploadSheet), `src/reports/sections.tsx:77-85` (FixInvoiceNumberSheet, `key={fixing.id}`), `src/reports/SubmissionsScreen.tsx:281-288` (AddEventSheet), `src/reports/PeriodScreen.tsx:263-272` (LockSheet). Everything else already keeps sheets mounted with `open` flags (TriageDocScreen with `key={…-attempt}` nonces, ApprovalScreen's RejectSheet `key={approvalId}`, TxScreen, CorrectSheet callers, CreateMenu, SupplierSheet) — those are the model, not the patient. Internal dismiss guards (`busy && !o` refusals in CreateEntitySheet/AddAliasSheet/LockSheet et al., the P05 fix wave) live INSIDE the sheet components and are untouched by a parent-side migration.
9. **Router:** `src/shell/router.tsx` imports all 22 screens statically; `src/shell/AppLayout.tsx:21` renders the `Outlet`; `src/shell/router.test.tsx` (24 tests) mounts `buildRoutes()` and already awaits screen content via `findBy*` everywhere it lands on a lazy-able screen (TokenGate assertion at :141 is eager). Screen unit tests mount their components DIRECTLY — `React.lazy` in the router cannot affect them.
10. **Zero-amount sign behavior change (deliberate, disclosed):** `signedEuros(0)` renders unsigned `0.00 €`; the swept sites previously rendered `−0.00 €` for a zero total (P03 Task 7 noted the InboxScreen hero case). No test pins the zero rendering (verified: the only `−…` pins are non-zero amounts and produce byte-identical output under `signedEuros`).

## Global Constraints

- Working directory for all commands: `packages/web` (repo root: `/Users/alekseirevin/test/headless-bookkeeping.spa-redesign-foundation`).
- Test command: `npx vitest run <file>`; full suite: `npm test`; lint: `npm run lint` (check-only; `npm run lint:fix` to apply); build (typecheck + bundle): `npm run build`. Every task leaves the FULL suite green. **Never run `git stash` in any form** (shared cross-worktree stash stack).
- **act() rule (this plan makes it a gate):** warnings are fixed at the SOURCE — act-aware waiting (`waitFor`/`findBy*` from @testing-library/react) and real settle points. NEVER `vi.waitFor` in component tests, never manual `act()` wrappers around `fireEvent` as a bandaid, never mocking/filtering `console.error`. After Task 6, any suite emitting a warning is a regression (Task 9 enforces suite-wide zero via stderr).
- **Cache keys:** untouched. Entity/category/organization reads stay on the FROZEN `sharedKeys` (`src/queries/keys.ts`); no new query keys, no new polling, `refetchInterval` count stays exactly as at HEAD (bank import 1.5s, inbox lists 30s).
- **Colors through tokens** (P06 Task 2 set: `tint`/`fill`/`track`/`chevron`/`handle`/`ink-3`/`warn-deep`). The four sanctioned single-site hexes stay: `#4D534E` (TxDispositions.tsx), `#B7C4BA` (SupplierSheet.tsx), `#ECEEEA` (Sidebar.tsx), `#F5FAF6` (StatementScreen.tsx). No new raw hex anywhere in `src/`.
- **Money display:** integer cents → `fmtCents`/`AmountText`/`signedEuros` ONLY. After Task 1 a literal `−`/`+` prefixed to a formatter output is a defect; `(x/100).toFixed(2)` outside `src/lib/money.ts` and `src/api.ts` internals is a defect (both grep-gated). U+2212 for negatives comes from the helpers, never typed at call sites. Money inputs remain euros via `eurosToCents`/`centsToEuroInput`.
- **Sheet discipline (UPDATED by Task 7, binding from then on):** sheets stay MOUNTED; `open` flips visibility; internal state resets by REMOUNT-ON-OPEN via an epoch key (`useSheet`), plus the payload object's id in the key where the sheet is object-bound. The old `{flag && <Sheet open/>}` unmount-to-close pattern is banned (it races Radix focus restoration — `ui/Sheet.tsx`). State must provably not leak across open/close/reopen — every migrated sheet carries a pin. Dismiss-while-pending guards inside sheet components are behavior, not style — do not weaken them.
- **Screen invariants (unchanged):** one primary button per state, outcome-stating labels; IDs are not data; reasons/errors are human sentences (server sentences verbatim in toasts); no voucher/account/debit/credit vocabulary; irreversible actions via ConfirmDialog (plan→confirm→receipt, never optimistic).
- UI copy is **English** (Russian in mockups is design annotation).
- Test mocking rule (Plans 03–06): modules import the REAL `fmtCents`/`signedEuros`, so tests mock the api module with the spread-importOriginal pattern (`vi.mock('../api', async (io) => ({ ...(await io<typeof import('../api')>()), <fn>: vi.fn() }))`), never a bare object literal. `fireEvent` (not `userEvent`) inside vaul Drawer tests. Typed fixtures (no `as never` where the real type is constructible).
- Commit style: `feat(web): …`/`chore(web): …`/`fix(web): …`/`test(web): …`, one commit per task. React StrictMode double-mount safe (the `useSeg` normalize effect and `useSheet` are idempotent by construction).
- The server is NOT modified. Anything requiring a server change goes to Appendix A's server list, not into a task.

---

### Task 1: Money-sign idiom — `signedEuros` re-homed to `lib/money`, double-sign sites and the raw-`toFixed` currency pass swept onto it

**Files:**
- Modify: `packages/web/src/lib/money.ts`, `packages/web/src/lib/money.test.ts`, `packages/web/src/inbox/format.ts`, `packages/web/src/inbox/format.test.ts`, `packages/web/src/api.format.test.ts`, `packages/web/src/inbox/{ClassifyExpenseSheet,ResolveSupplierSheet,TriageDocScreen,ApprovalScreen,ClassifyInvoiceSheet,InboxScreen}.tsx`, `packages/web/src/books/{ExpensesSegment,ExpenseScreen,DocumentScreen,InvoiceScreen,CreditNoteScreen,create}.tsx`, `packages/web/src/reports/{LockSheet,sections}.tsx`, `packages/web/src/settings/EntityScreen.tsx`

**Interfaces:**
- Produces: `signedEuros(cents: number): string` exported from `src/lib/money.ts` (deleted from `src/inbox/format.ts`). Behavior identical to today's implementation — signs by the INPUT's sign: negative → `−` (U+2212), positive → `+`, zero → unsigned; ` €` suffix included.
- **Idiom decision (binding app-wide):** a display with a SEMANTIC direction (outflow/inflow) passes the signed value to `signedEuros` — `signedEuros(-grossCents)` for outflows stored as positive magnitudes. Nobody ever prefixes a literal `−`/`+` to `fmtCents`/`centsToEuroInput`/`toFixed` output again: `fmtCents` self-signs, so the literal-prefix pattern renders `−−` the day a negative flows in, and `signedEuros` is immune by construction (it signs the value it is given, exactly once). `fmtCents` remains the UNSIGNED-context formatter (KeyValue facts, thresholds, `AmountText` internals).
- Deliberate behavior change, disclosed: zero totals render `0.00 €` (unsigned) instead of `−0.00 €` (Client reality #10 — nothing pins the old rendering).

- [ ] **Step 1: Write failing tests**

Append to `src/lib/money.test.ts` (the import is the red anchor — `signedEuros` does not exist in `lib/money` yet):

```ts
import { signedEuros } from './money';

describe('signedEuros — the app-wide signed-display idiom (Plan 07 Task 1)', () => {
  it('signs by the input sign: U+2212 minus, ASCII plus, zero unsigned', () => {
    expect(signedEuros(-4820)).toBe('−48.20 €');
    expect(signedEuros(4820)).toBe('+48.20 €');
    expect(signedEuros(0)).toBe('0.00 €');
  });

  it('cannot double-sign: negating an already-negative value yields a plus', () => {
    // The failure mode this idiom kills: a literal '−' prefixed to
    // fmtCents(negative) would render '−−48.20'. signedEuros signs exactly
    // once, whatever the caller passes.
    expect(signedEuros(-(-4820))).toBe('+48.20 €');
    expect(signedEuros(-0)).toBe('0.00 €');
  });
});
```

In `src/api.format.test.ts` change the `signedEuros` import from `'./inbox/format'` to `'./lib/money'` (assertions unchanged). In `src/inbox/format.test.ts` DELETE the `signedEuros` import and its `describe('signedEuros', …)` block (the pins now live beside the function).

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/lib/money.test.ts src/api.format.test.ts
```

Expected: FAIL — `'./money'` / `'./lib/money'` do not export `signedEuros`.

- [ ] **Step 3: Move the helper**

3a. Append to `src/lib/money.ts`:

```ts
/** Signed euro DISPLAY for hero amounts, group totals, and outcome-stating
 *  button labels/toasts. Signs by the INPUT's sign: negative → typographic
 *  minus U+2212, positive → '+', zero → unsigned. Callers showing an
 *  outflow stored as a positive magnitude pass the negation
 *  (`signedEuros(-grossCents)`). NEVER prefix a literal '−'/'+' around
 *  fmtCents/toFixed output instead — fmtCents self-signs, so that pattern
 *  renders '−−' the day a negative flows in (Plan 07 Task 1 decision). */
export function signedEuros(cents: number): string {
  const base = `${(Math.abs(cents) / 100).toFixed(2)} €`;
  if (cents < 0) return `−${base}`;
  if (cents > 0) return `+${base}`;
  return base;
}
```

3b. In `src/inbox/format.ts` DELETE the `signedEuros` function (and its comment). Update the four existing consumers to import from the new home (keep their `./format` imports for `absoluteDateFromIso`/`vatRatePct`):
- `src/inbox/ClassifyExpenseSheet.tsx:18`: `import { signedEuros } from './format';` → `import { signedEuros } from '../lib/money';`
- `src/inbox/ResolveSupplierSheet.tsx:16`: `import { absoluteDateFromIso, signedEuros } from './format';` → `import { absoluteDateFromIso } from './format';` + `import { signedEuros } from '../lib/money';`
- `src/inbox/TriageDocScreen.tsx:30`: `import { absoluteDateFromIso, signedEuros, vatRatePct } from './format';` → `import { absoluteDateFromIso, vatRatePct } from './format';` + `import { signedEuros } from '../lib/money';`
- `src/inbox/ApprovalScreen.tsx:26-28`: remove `signedEuros,` from the `'./format'` import list; add `import { signedEuros } from '../lib/money';`

- [ ] **Step 4: Sweep the double-sign sites (exact from → to, verified at HEAD)**

| File:line | From | To |
|---|---|---|
| `src/inbox/InboxScreen.tsx:120` | `−{fmtCents(monthTotalCents)} €` | `{signedEuros(-monthTotalCents)}` |
| `src/books/ExpensesSegment.tsx:141` | `` trailing={`−${fmtCents(g.totalCents)} € · ${g.count}`} `` | `` trailing={`${signedEuros(-g.totalCents)} · ${g.count}`} `` |
| `src/books/ExpenseScreen.tsx:128` | `` toastOk(`Posted · −${(detail.gross_amount / 100).toFixed(2)} €`); `` | `` toastOk(`Posted · ${signedEuros(-detail.gross_amount)}`); `` |
| `src/books/create.tsx:213` | `` ? `Create expense · −${centsToEuroInput(m.grossParsed)} €` `` | `` ? `Create expense · ${signedEuros(-m.grossParsed)}` `` |
| `src/reports/LockSheet.tsx:61` | `` return `${who} · −${fmtCents(e.gross_amount)} € — ${suffix}`; `` | `` return `${who} · ${signedEuros(-e.gross_amount)} — ${suffix}`; `` |
| `src/reports/LockSheet.tsx:68` | `` return `${who} · +${fmtCents(inv.gross_amount)} € — ${suffix}`; `` | `` return `${who} · ${signedEuros(inv.gross_amount)} — ${suffix}`; `` |
| `src/reports/sections.tsx:182` | `` trailing={`+${fmtCents(salesTotal)} € · ${sales.length}`} `` | `` trailing={`${signedEuros(salesTotal)} · ${sales.length}`} `` |
| `src/reports/sections.tsx:208` | `` trailing={`−${fmtCents(purchasesTotal)} € · ${purchases.length}`} `` | `` trailing={`${signedEuros(-purchasesTotal)} · ${purchases.length}`} `` |
| `src/settings/EntityScreen.tsx:154-158` | the `entity.role === 'supplier' ? `−${fmtCents(…)} €` : `+${fmtCents(…)} €`` ternary | `{signedEuros(entity.role === 'supplier' ? -stats.totalCents : stats.totalCents)}` |

Import bookkeeping: add `import { signedEuros } from '../lib/money';` (or extend an existing `../lib/money` import) in each touched file; REMOVE `fmtCents` from the `../api` import where it just became unused (`InboxScreen.tsx`, `ExpensesSegment.tsx`, `EntityScreen.tsx` — lint enforces; `sections.tsx` keeps it for the `:75` threshold sentence, `LockSheet.tsx` for the `:86` `Math.abs` label, `create.tsx` keeps `centsToEuroInput` only if still used elsewhere in the file — remove if lint flags it).

- [ ] **Step 5: Sweep the currency-pass sites (raw `toFixed` money displays → fmtCents/signedEuros)**

| File:line | From | To |
|---|---|---|
| `src/inbox/TriageDocScreen.tsx:200` | `` `${(classification.result.vat_amount / 100).toFixed(2)} € (${vatRatePct(…)}%)` `` | `` `${fmtCents(classification.result.vat_amount)} € (${vatRatePct(…)}%)` `` (vatRatePct args unchanged) |
| `src/inbox/TriageDocScreen.tsx:201` | `` `${(classification.result.vat_amount / 100).toFixed(2)} €` `` | `` `${fmtCents(classification.result.vat_amount)} €` `` |
| `src/inbox/ApprovalScreen.tsx:207` | `` `${(e.vat_amount / 100).toFixed(2)} € (${vatRatePct(e.gross_amount, e.vat_amount)}%)` `` | `` `${fmtCents(e.vat_amount)} € (${vatRatePct(e.gross_amount, e.vat_amount)}%)` `` |
| `src/inbox/ApprovalScreen.tsx:208` | `` `${(e.vat_amount / 100).toFixed(2)} €` `` | `` `${fmtCents(e.vat_amount)} €` `` |
| `src/inbox/ApprovalScreen.tsx:254` | `` v={`${(inv.vat_amount / 100).toFixed(2)} €`} `` | `` v={`${fmtCents(inv.vat_amount)} €`} `` |
| `src/inbox/ClassifyInvoiceSheet.tsx:281` | `` ? `Record invoice · +${(grossCents / 100).toFixed(2)} €` `` | `` ? `Record invoice · ${signedEuros(grossCents)}` `` |
| `src/books/ExpenseScreen.tsx:186` | `` v={`${(detail.vat_amount / 100).toFixed(2)} €${rate != null ? ` (${rate}%)` : ''}`} `` | `` v={`${fmtCents(detail.vat_amount)} €${rate != null ? ` (${rate}%)` : ''}`} `` |
| `src/books/DocumentScreen.tsx:52` | `` v={`${(r.gross_amount / 100).toFixed(2)} € (VAT ${(r.vat_amount / 100).toFixed(2)} €)`} `` | `` v={`${fmtCents(r.gross_amount)} € (VAT ${fmtCents(r.vat_amount)} €)`} `` |
| `src/books/InvoiceScreen.tsx:101` | `` toastOk(`Posted · +${(inv.gross_amount / 100).toFixed(2)} €`); `` | `` toastOk(`Posted · ${signedEuros(inv.gross_amount)}`); `` |
| `src/books/InvoiceScreen.tsx:159` | `` v={`${(inv.vat_amount / 100).toFixed(2)} €${rate != null ? ` (${rate}%)` : ''}`} `` | `` v={`${fmtCents(inv.vat_amount)} €${rate != null ? ` (${rate}%)` : ''}`} `` |
| `src/books/CreditNoteScreen.tsx:83` | `` v={`${(n.vat_amount / 100).toFixed(2)} €`} `` | `` v={`${fmtCents(n.vat_amount)} €`} `` |

The `confidence.toFixed(2)` occurrences in the same files are NOT money — leave them. Add `fmtCents` to each file's `../api` import where missing (`TriageDocScreen`, `ApprovalScreen`, `DocumentScreen`, `CreditNoteScreen`, `InvoiceScreen`).

- [ ] **Step 6: Run the suite; grep-gates; repair only genuinely-drifted pins**

```bash
npx vitest run src/lib/money.test.ts src/inbox/format.test.ts src/api.format.test.ts && npm test
```

Expected: the swept sites emit byte-identical strings for every pinned amount (`signedEuros(-4820)` ≡ old `−${fmtCents(4820)} €`), so the pre-existing pins (`create.test.tsx:72`, `ExpensesSegment.test.tsx:106-140`, `ExpenseScreen.test.tsx:102,198`, `LockSheet.test.tsx:112`, `sections.test.tsx:242`, `EntityScreen.test.tsx:139`, InboxScreen pins) all stay green. If any test pinned a `−0.00 €`/`+0.00 €` zero rendering, update it to `0.00 €` and note it in the commit body (none found at HEAD). Then the gates:

```bash
# 1. No literal sign prefixed to a formatter — must print NOTHING outside tests:
grep -rnE '[−+][{$]*\{?(fmtCents|centsToEuroInput)' src --include='*.tsx' --include='*.ts' | grep -v '\.test\.'
# 2. No raw cents→euro toFixed money display — must print ONLY src/lib/money.ts and src/api.ts:
grep -rnE '/ ?100\)\.toFixed\(2\)' src --include='*.tsx' --include='*.ts' | grep -v '\.test\.'
npm run lint && npm run build
```

- [ ] **Step 7: Commit**

```bash
git add -A packages/web/src
git commit -m "fix(web): signedEuros is the app-wide signed-money idiom — double-sign hazard dead by construction, raw toFixed currency displays routed through fmtCents (P04-P06 deferred)"
```

---

### Task 2: PolicyScreen polish — negative-ceiling honesty, save() recheck, optimistic ingest echo

**Files:**
- Modify: `packages/web/src/settings/PolicyScreen.tsx`, `packages/web/src/settings/PolicyScreen.test.tsx`

- [ ] **Step 1: Write failing tests** — append to the `describe('PolicyScreen', …)` block in `src/settings/PolicyScreen.test.tsx`:

```tsx
  it('negative ceiling: honest error copy, no misleading hint, Save disabled', async () => {
    mount();
    await screen.findByLabelText('Auto-post ceiling (€)');
    fireEvent.change(screen.getByLabelText('Auto-post ceiling (€)'), {
      target: { value: '-5' },
    });
    // Today this renders the hint "Expenses above −5.00 € are held for
    // approval" beside a silently disabled button (P06 T11 deferred).
    expect(
      screen.getByText('The ceiling cannot be negative — enter 0 or more'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/are held for approval/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Save policy' })).toBeDisabled();
    expect(updatePolicyConfig).not.toHaveBeenCalled();
  });

  it('ingest select echoes the picked value during the in-flight write (no snap-back)', async () => {
    let resolveWrite!: (v: { key: string; value: string }) => void;
    vi.mocked(setSetting).mockImplementation(
      () =>
        new Promise((res) => {
          resolveWrite = res;
        }),
    );
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Ingest policy')).toHaveValue('quarantine'),
    );
    fireEvent.change(screen.getByLabelText('Ingest policy'), {
      target: { value: 'open' },
    });
    // While the PUT is in flight the select shows the operator's pick —
    // no snap-back to the cached value.
    expect(screen.getByLabelText('Ingest policy')).toHaveValue('open');
    // …and lands on refetched server truth once it settles.
    vi.mocked(getSettings).mockResolvedValue([
      { key: 'ingest_policy', value: 'open' },
    ]);
    resolveWrite({ key: 'ingest_policy', value: 'open' });
    expect(await screen.findByText('Ingest policy — open')).toBeInTheDocument();
    expect(screen.getByLabelText('Ingest policy')).toHaveValue('open');
  });

  it('failed ingest write reverts the select to server truth with the error toast', async () => {
    vi.mocked(setSetting).mockRejectedValue(
      new Error('Invalid value for setting ingest_policy'),
    );
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Ingest policy')).toHaveValue('quarantine'),
    );
    fireEvent.change(screen.getByLabelText('Ingest policy'), {
      target: { value: 'open' },
    });
    expect(
      await screen.findByText('Invalid value for setting ingest_policy'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Ingest policy')).toHaveValue('quarantine');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/settings/PolicyScreen.test.tsx
```

Expected: 3 new FAIL — no error copy on negative (hint renders instead); the select snaps back to `quarantine` immediately after the change event.

- [ ] **Step 3: Implement in `src/settings/PolicyScreen.tsx`**

3a. Replace `IngestPolicyGroup` with:

```tsx
function IngestPolicyGroup({ current }: { current: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  // Optimistic local echo (P06 T11 deferred): the select shows the picked
  // value during the in-flight write instead of snapping back to the cached
  // value until the refetch lands. Cleared in `finally`: on success the
  // AWAITED invalidate has already refreshed `current` to the echoed value;
  // on failure the select honestly reverts to server truth.
  const [echo, setEcho] = useState<string | null>(null);
  const onChange = async (value: string) => {
    setBusy(true);
    setEcho(value);
    try {
      await setSetting('ingest_policy', value);
      await invalidateAdminSettings(qc);
      toastOk(`Ingest policy — ${value}`);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setEcho(null);
    }
  };
  return (
    <>
      <GroupLabel>Intake</GroupLabel>
      <div className="mx-3.5 mb-3.5 rounded-2xl bg-surface p-4">
        <Field
          label="Ingest policy"
          hint="How intake treats documents from unknown senders"
        >
          <SelectInput
            aria-label="Ingest policy"
            value={echo ?? current}
            disabled={busy}
            onChange={(e) => void onChange(e.target.value)}
          >
            <option value="" disabled>
              (choose)
            </option>
            {INGEST_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </SelectInput>
        </Field>
      </div>
    </>
  );
}
```

3b. In `RiskGateForm`, after the `const ceilingCents = eurosToCents(ceiling);` line, add the error derivation and thread it into the Field (replacing the current `error`/`hint` props on the ceiling `Field`):

```tsx
  const ceilingError =
    ceilingCents === null
      ? 'Enter an amount like 50.00'
      : ceilingCents < 0
        ? 'The ceiling cannot be negative — enter 0 or more'
        : null;
```

```tsx
        <Field
          label="Auto-post ceiling (€)"
          error={ceilingError}
          hint={
            ceilingError === null && ceilingCents !== null
              ? `Expenses above ${fmtCents(ceilingCents)} € are held for approval`
              : undefined
          }
        >
```

3c. Harden `save()`'s first line (belt-and-braces with the disabled button — the P06 review's exact ask):

```tsx
    if (ceilingCents === null || ceilingCents < 0 || !confidenceOk) return;
```

(`valid` already contains `ceilingCents >= 0` — unchanged.)

- [ ] **Step 4: Run tests, full suite, lint, build**

```bash
npx vitest run src/settings/PolicyScreen.test.tsx && npm test && npm run lint && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/settings/PolicyScreen.tsx packages/web/src/settings/PolicyScreen.test.tsx
git commit -m "fix(web): PolicyScreen — negative-ceiling error copy + save() recheck, optimistic ingest-policy echo (P06 T11 deferred)"
```

---

### Task 3: URL + copy polish — `?tab=` normalize-on-mount, entity count-basis honesty, Team empty state

**Files:**
- Modify: `packages/web/src/lib/useSeg.ts`, `packages/web/src/lib/useSeg.test.tsx`, `packages/web/src/settings/EntityScreen.tsx`, `packages/web/src/settings/EntityScreen.test.tsx`, `packages/web/src/settings/EntitiesScreen.tsx`, `packages/web/src/settings/EntitiesScreen.test.tsx`, `packages/web/src/settings/CreateEntitySheet.tsx`

**Interfaces:**
- `useSeg` gains a run-on-arrival normalize: a URL carrying `?tab=` is rewritten (`replace`) to the `?seg=` form, preserving every other param — the P04 Task 13 "?tab lingers in the address bar" polish. Idempotent (second pass sees no `tab`), so StrictMode-safe. Reading behavior is unchanged.
- `CreateEntitySheet` gains an optional `defaultRole?: EntityRole` (default `'supplier'` — zero change for existing callers).
- **Count-basis decision (P06 T7 note, adjudicated here):** the stats BASIS stays non-draft (drafts are not bookings — counting them would fake the money number); the mismatch with the `/books` landing (which legitimately shows drafts for triage) is resolved by COPY — the row states its basis. Filtering the landing is impossible without a composite `?status=` value (Client reality #5) and changing the landing's default would hide drafts operators must see.

- [ ] **Step 1: Write failing tests**

Append to `src/lib/useSeg.test.tsx` (add `waitFor` to the `@testing-library/react` import):

```tsx
  it('normalizes a legacy ?tab= into ?seg= on arrival (nothing lingers)', async () => {
    mount('/x?tab=open&q=milk');
    await waitFor(() => {
      const search = new URLSearchParams(
        screen.getByTestId('search').textContent ?? '',
      );
      expect(search.get('seg')).toBe('open');
      expect(search.get('tab')).toBeNull();
      expect(search.get('q')).toBe('milk');
    });
    expect(screen.getByTestId('seg').textContent).toBe('open');
  });

  it('drops an unknown ?tab= without inventing a ?seg=', async () => {
    mount('/x?tab=bogus');
    await waitFor(() => {
      const search = new URLSearchParams(
        screen.getByTestId('search').textContent ?? '',
      );
      expect(search.get('tab')).toBeNull();
      expect(search.get('seg')).toBeNull();
    });
    expect(screen.getByTestId('seg').textContent).toBe('all');
  });
```

Append to `src/settings/EntityScreen.test.tsx` (inside the main describe, reusing its `mount()`/supplier fixture):

```tsx
  it('bookings row states its count basis (posted + pending, not drafts)', async () => {
    mount();
    await screen.findByText('Circle K Eesti AS');
    expect(
      screen.getByText('Posted and pending — drafts not counted'),
    ).toBeInTheDocument();
  });
```

Append to `src/settings/EntitiesScreen.test.tsx` (reusing its `mount(initial)` helper and `ROWS`):

```tsx
  it('Team-empty state explains the claimant dropdown and preselects the employee role', async () => {
    // Suppliers/customers only — no team members on this install.
    vi.mocked(getEntities).mockResolvedValue([ROWS[0], ROWS[1]]);
    mount('/settings/entities?seg=team');
    expect(await screen.findByText('No team members yet')).toBeInTheDocument();
    expect(screen.getByText(/claimant dropdown/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add employee' }));
    expect(await screen.findByLabelText('Role')).toHaveValue('employee');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/lib/useSeg.test.tsx src/settings/EntityScreen.test.tsx src/settings/EntitiesScreen.test.tsx
```

Expected: FAIL — `?tab=` survives in the search string; no basis subtitle; the team empty state renders the generic copy and no "Add employee" button.

- [ ] **Step 3: Implement**

3a. `src/lib/useSeg.ts` — add `import { useEffect } from 'react';` and, inside the hook after the `const seg = …` line:

```ts
  // Normalize a legacy ?tab= into ?seg= on ARRIVAL (P04 T13 deferred: the
  // alias was honored on read but lingered in the address bar until the
  // first segment switch). Idempotent — the second pass sees no ?tab= —
  // so StrictMode double-invoke and re-renders are safe.
  useEffect(() => {
    if (!params.has('tab')) return;
    const p = new URLSearchParams(params);
    const raw = p.get('tab');
    if (raw !== null && segments.includes(raw as T) && !p.has('seg'))
      p.set('seg', raw);
    p.delete('tab');
    setParams(p, { replace: true });
  }, [params, segments, setParams]);
```

3b. `src/settings/EntityScreen.tsx` — the bookings `ListRow` (Client reality #5) gains the basis subtitle:

```tsx
          <ListRow
            to={
              entity.role === 'supplier'
                ? `/books?seg=expenses&${bookingsQuery}`
                : `/books?seg=invoices&${bookingsQuery}`
            }
            title={`${stats.label} · ${stats.count}`}
            subtitle="Posted and pending — drafts not counted"
            trailing={
              <span className="whitespace-nowrap font-bold tabular-nums">
                {signedEuros(
                  entity.role === 'supplier'
                    ? -stats.totalCents
                    : stats.totalCents,
                )}
              </span>
            }
          />
```

(The `signedEuros` form is Task 1's — shown here merged so the two tasks compose.)

3c. `src/settings/CreateEntitySheet.tsx` — thread the default role:

```tsx
export function CreateEntitySheet({
  open,
  onClose,
  defaultRole = 'supplier',
}: {
  open: boolean;
  onClose: () => void;
  defaultRole?: EntityRole;
}) {
```

and `const [role, setRole] = useState<EntityRole>(defaultRole);`

3d. `src/settings/EntitiesScreen.tsx` — replace the `rows.length === 0` branch with a team-aware split:

```tsx
      ) : rows.length === 0 ? (
        seg === 'team' && q === '' ? (
          <EmptyState
            icon="👥"
            title="No team members yet"
            hint="Add an employee or director so they appear in the claimant dropdown when a receipt is uploaded for reimbursement (who paid — reimburse them)."
            action={
              <Button onClick={() => setCreateOpen(true)}>Add employee</Button>
            }
          />
        ) : (
          <EmptyState
            icon="👥"
            title={
              q !== '' || seg !== 'all' ? 'Nothing matches' : 'No entities yet'
            }
            hint={
              q !== '' || seg !== 'all'
                ? 'Try another segment or search term.'
                : 'Suppliers and customers are created automatically when documents and bank lines are booked; employees and directors (reimbursement claimants) are added here.'
            }
            action={
              <Button onClick={() => setCreateOpen(true)}>Add entity</Button>
            }
          />
        )
      ) : (
```

and pass the preselect to the sheet mount: `<CreateEntitySheet open onClose={() => setCreateOpen(false)} defaultRole={seg === 'team' ? 'employee' : 'supplier'} />` (Task 7 re-shapes this mount; the prop survives).

- [ ] **Step 4: Run tests, full suite, lint, build**

```bash
npx vitest run src/lib/useSeg.test.tsx src/settings/EntityScreen.test.tsx src/settings/EntitiesScreen.test.tsx && npm test && npm run lint && npm run build
```

Watch the two other `useSeg` consumers' suites (`InboxScreen`, `BooksScreen` — `BooksScreen.test.tsx:48` "accepts the legacy ?tab= alias" asserts the RENDERED segment, which normalization preserves). If any pin asserts a lingering `?tab=` in `location.search`, update it to the normalized `?seg=` form and say so in the commit body.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib packages/web/src/settings
git commit -m "fix(web): ?tab= normalizes to ?seg= on arrival; entity bookings row states its count basis; Team-empty state points at the claimant dropdown (P04/P06 deferred)"
```

---

### Task 4: Test-hygiene batch — role-switch payload pin, location-spy restore, Kind-select pin, typed fixtures

**Files:**
- Modify: `packages/web/src/settings/CreateEntitySheet.test.tsx`, `packages/web/src/settings/CreateEntitySheet.tsx` (one-line JSX cleanup), `packages/web/src/settings/MailboxScreen.test.tsx`, `packages/web/src/settings/EntityScreen.test.tsx`, `packages/web/src/settings/CategoriesScreen.test.tsx`

- [ ] **Step 1: The role-switch payload-leak pin** — append to `src/settings/CreateEntitySheet.test.tsx`:

```tsx
  it('typing a registration key, then switching role to employee, never leaks the key onto the wire', async () => {
    vi.mocked(onboardEntity).mockResolvedValue({
      id: 9,
      role: 'employee',
      country: 'EE',
      name: 'Mari Maasikas',
      goods_vs_services: null,
    } as Entity);
    mount();
    // Supplier form first: type a registration key…
    fireEvent.change(screen.getByLabelText('Registration key'), {
      target: { value: 'EE100511246' },
    });
    // …then change your mind about the role.
    fireEvent.change(screen.getByLabelText('Role'), {
      target: { value: 'employee' },
    });
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Mari Maasikas' },
    });
    fireEvent.change(screen.getByLabelText('Country'), {
      target: { value: 'EE' },
    });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'mari@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add employee' }));
    // EXACT body: toHaveBeenCalledWith is deep-equal — a leaked
    // registrationKey (or stale tgUserId) key would fail this assert.
    await waitFor(() =>
      expect(onboardEntity).toHaveBeenCalledWith({
        role: 'employee',
        name: 'Mari Maasikas',
        country: 'EE',
        email: 'mari@example.com',
      }),
    );
  });
```

Add `type Entity` to the file's `../api` import; while in the file, replace the two `mockResolvedValue({ id: … } as never)` calls with typed fixtures of the same shape (`{ id: 31, role: 'supplier', country: 'EE', name: 'Circle K Eesti AS', goods_vs_services: 'goods' } as Entity` and the employee analogue) — the mandate's typed-fixture rule.

**Red-check by mutation (the pin is born green — prove it bites):** temporarily change `CreateEntitySheet.tsx`'s employee payload branch to spread the stale key (`…{ role, name: …, country: …, email: email.trim(), registrationKey: regKey.trim(), … }`), run the file, watch EXACTLY this test fail, revert. Record "mutation-verified" in the commit body.

- [ ] **Step 2: MailboxScreen spy restore** — in `src/settings/MailboxScreen.test.tsx` add `afterEach` to the vitest import and, next to the existing `beforeEach`:

```tsx
afterEach(() => {
  // The OAuth test installs a window.location GETTER spy — without restore
  // it outlives its test (P06 T9 deferred).
  vi.restoreAllMocks();
});
```

- [ ] **Step 3: Kind-select 3-option pin** — append to `src/settings/EntityScreen.test.tsx` (it already imports `within`):

```tsx
  it('alias Kind select offers exactly the three server-accepted kinds (types.ts:56-60)', async () => {
    mount();
    await screen.findByText('Circle K Eesti AS');
    fireEvent.click(screen.getByRole('button', { name: '＋ Add alias' }));
    const options = within(screen.getByLabelText('Kind')).getAllByRole('option');
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual([
      'iban',
      'merchant_descriptor',
      'name_alias',
    ]);
  });
```

- [ ] **Step 4: CategoriesScreen typed fixture** — in `src/settings/CategoriesScreen.test.tsx` replace the `as never` org mock:

```tsx
import { getCategories, getOrganization, type Organization } from '../api';

const ORG: Organization = {
  id: 1,
  country: 'EE',
  base_currency: null,
  vat_registered: true,
  org_type: 'company',
  created_at: 0,
  name: 'Acme OÜ',
  vat_registration_number: null,
  iban: null,
};
```

and in `beforeEach`: `vi.mocked(getOrganization).mockResolvedValue(ORG);`

- [ ] **Step 5: The one-line component cleanup** — `src/settings/CreateEntitySheet.tsx` carries a duplicated `aria-label="Name"` attribute on the Name `TextInput` (Client reality #6); delete the duplicate line.

- [ ] **Step 6: Run, verify, commit**

```bash
npx vitest run src/settings && npm test && npm run lint && npm run build
git add packages/web/src/settings
git commit -m "test(web): hygiene batch — role-switch payload-leak pin (mutation-verified), location-spy restore, alias-kind 3-option pin, typed org fixture (P06 deferred)"
```

---

### Task 5: act()-warning eradication I — TxScreen (61 warnings) + mock order-decoupling

**Files:**
- Modify: `packages/web/src/bank/TxScreen.test.tsx`

**The mechanism (binding for Tasks 5–6):** `vi.waitFor` polls outside React's act-aware scheduler — every state update landing during the poll logs `not wrapped in act(...)`. RTL's `waitFor`/`findBy*` wrap the waiting in `asyncWrapper`/act, so the same updates are silent AND properly flushed. The fix is always at the source: swap the waiter, and where a warning persists, the component stack in the warning names the update that has no settle point — add an awaited UI assertion for it (a `findBy…`/`waitFor(...)` on the real outcome). NEVER manual `act()` around `fireEvent`, never `console.error` filtering.

- [ ] **Step 1: Baseline (record the red)**

```bash
npx vitest run src/bank/TxScreen.test.tsx 2>&1 | grep -c 'not wrapped in act'
```

Expected: `61` (HEAD measurement).

- [ ] **Step 2: Swap the waiter** — replace all 7 `vi.waitFor(` occurrences with `waitFor(` and add `waitFor` to the `@testing-library/react` import. Assertions inside the callbacks are untouched.

- [ ] **Step 3: Decouple the order-coupled mocks** — the P06 Task 2 fragility: `mockResolvedValueOnce` chains on `api.getMatchCandidates`/`api.listBankTransactions` encode responses by CALL COUNT, so an extra React Query retry/refetch silently shifts every later response. Re-encode them as mutable fixtures **flipped inside the MUTATION mock whose real-world effect changes the read** — deterministic whatever the call count. Two rewrites (complete code):

3a. The bank-fee test — replace the `getMatchCandidates` once-chain with:

```ts
    // Order-decoupled: the candidate appears the moment the expense is
    // CREATED (the mutation that causes it), not on "the second call".
    const feeCandidate = {
      bankTransactionId: 9,
      lineRemaining: 800,
      candidates: [
        {
          voucherId: 80,
          objectType: 'expense',
          objectId: 60,
          objectLabel: 'Expense #60',
          counterpartyName: null,
          voucherRemaining: 800,
        },
      ],
    };
    let candidates: typeof feeCandidate = {
      bankTransactionId: 9,
      lineRemaining: 800,
      candidates: [],
    };
    vi.mocked(api.getMatchCandidates).mockImplementation(() =>
      Promise.resolve(candidates as never),
    );
    vi.mocked(api.createExpense).mockImplementation(async () => {
      candidates = feeCandidate; // the create is what makes it findable
      return { id: 60 } as never;
    });
```

(delete the old `vi.mocked(api.createExpense).mockResolvedValue(…)` and the `.mockResolvedValueOnce({ … candidates: [] }).mockResolvedValue({ … candidates: [voucher 80] })` chain; everything else in the test stays).

3b. The done-guard test (`'unmounts the create form on done …'`) — replace the `listBankTransactions` and `getMatchCandidates` chains with:

```ts
    // Phase-encoded mocks: the tx list resolves once (mount) and then hangs
    // (the invalidation refetch that must NOT be the thing that removes the
    // button); candidates flip on the mutations that cause them — fresh
    // expense appears on createExpense, disappears again when manualMatch
    // consumes it — so an extra refetch can never shift the script.
    const noCandidates = {
      bankTransactionId: 9,
      lineRemaining: 1860,
      candidates: [],
    };
    const freshExpense = {
      bankTransactionId: 9,
      lineRemaining: 1860,
      candidates: [
        {
          voucherId: 70,
          objectType: 'expense',
          objectId: 55,
          objectLabel: 'Expense #55',
          counterpartyName: null,
          voucherRemaining: 1860,
        },
      ],
    };
    let txListServed = false;
    vi.mocked(api.listBankTransactions)
      .mockReset()
      .mockImplementation(() => {
        if (!txListServed) {
          txListServed = true;
          return Promise.resolve([BASE_TX] as never);
        }
        return new Promise(() => {});
      });
    let candidates = noCandidates;
    vi.mocked(api.getMatchCandidates).mockImplementation(() =>
      Promise.resolve(candidates as never),
    );
    vi.mocked(api.createExpense).mockImplementation(async () => {
      candidates = freshExpense;
      return { id: 55 } as never;
    });
    vi.mocked(api.manualMatch).mockImplementation(async () => {
      candidates = noCandidates; // consumed — refetches route back to 'create'
      return { records: [{ id: 88 }], approvals: [{ id: 12, matchId: 88 }] };
    });
```

(the flow/assertions from `renderTx()` through `expect(api.createExpense).toHaveBeenCalledTimes(1)` stay byte-identical). Sweep the remaining `mockResolvedValueOnce` chain at the state-routing site (`:238` area) with the same pattern where it encodes phases; `mockRejectedValueOnce(...).mockResolvedValue(...)` in the retry test is genuinely once-semantic (first call fails, retry succeeds) and may stay.

- [ ] **Step 4: The zero gate — iterate until silent**

```bash
npx vitest run src/bank/TxScreen.test.tsx 2>&1 | tee /tmp/tx.log | grep -c 'not wrapped in act'
```

Must print `0` with all tests passing. For each residual warning: read its component stack in `/tmp/tx.log`, find the un-awaited update (typically a toast render, a busy-flag release, or an invalidation refetch landing after the last assertion), and add the missing awaited UI outcome at that point in the test. Do not proceed on any non-zero count.

- [ ] **Step 5: Full suite, commit**

```bash
npm test && npm run lint
git add packages/web/src/bank/TxScreen.test.tsx
git commit -m "test(web): TxScreen suite act()-silent — RTL waitFor + mutation-flipped mock fixtures replace order-coupled once-chains (P06 T2/T13 deferred)"
```

---

### Task 6: act()-warning eradication II — the five remaining bank suites

**Files:**
- Modify: `packages/web/src/bank/TxMatched.test.tsx` (16 warnings, 3 `vi.waitFor`), `packages/web/src/bank/StatementScreen.test.tsx` (16, 7), `packages/web/src/bank/TxCandidates.test.tsx` (4, 5), `packages/web/src/bank/TxCreateExpense.test.tsx` (2, 2), `packages/web/src/bank/SupplierSheet.test.tsx` (1, 4)

- [ ] **Step 1: Baseline per file (record the red)**

```bash
for f in src/bank/TxMatched.test.tsx src/bank/StatementScreen.test.tsx src/bank/TxCandidates.test.tsx src/bank/TxCreateExpense.test.tsx src/bank/SupplierSheet.test.tsx; do
  echo "$f: $(npx vitest run "$f" 2>&1 | grep -c 'not wrapped in act')"
done
```

Expected: `16 / 16 / 4 / 2 / 1`.

- [ ] **Step 2: Apply Task 5's recipe to each file** — swap every `vi.waitFor(` → RTL `waitFor(` (import it; StatementScreen already imports RTL `waitFor` — just retire the `vi.` calls), then per-file zero-gate:

```bash
npx vitest run <file> 2>&1 | grep -c 'not wrapped in act'   # must print 0
```

For residuals, same source-fix rule: the warning's component stack names the update; add the awaited UI outcome (e.g. TxMatched's undo-toast flush, StatementScreen's post-booking refetch — settle on the refetched row state, not on the mutation call). No mock re-scripting is expected in these five (the once-chain fragility was TxScreen-local); if one shows up, apply Task 5 Step 3's mutation-flip pattern.

- [ ] **Step 3: Suite-wide zero check, full suite, commit**

```bash
npm test 2>&1 | tee /tmp/suite.log | tail -5
grep -c 'not wrapped in act' /tmp/suite.log   # MUST print 0
npm run lint
git add packages/web/src/bank
git commit -m "test(web): bank suites act()-silent — zero act() warnings suite-wide (P06 T13 deferred, ~98 at HEAD)"
```

---

### Task 7: Sheet lifecycle — keep-mounted + epoch-key migration of the ten unmount-to-close sites (the aria-hidden focus race dies)

**Files:**
- Create: `packages/web/src/lib/useSheet.ts`, `packages/web/src/lib/useSheet.test.tsx`
- Modify: `packages/web/src/settings/EntitiesScreen.tsx`, `packages/web/src/settings/EntityScreen.tsx`, `packages/web/src/settings/MailboxScreen.tsx`, `packages/web/src/books/BooksScreen.tsx`, `packages/web/src/reports/sections.tsx`, `packages/web/src/reports/PeriodScreen.tsx`, `packages/web/src/reports/SubmissionsScreen.tsx`, `packages/web/src/ui/Sheet.tsx` (comment update only), plus the seven screens' test files (state-leak pins)

**Interfaces & strategy (the recorded decision):**
- **Chosen approach: keep-mounted + keyed reset** — of the two strategies documented in `ui/Sheet.tsx:28-41`, migrating off "parent unmounts to close" is the one that lets Radix/vaul run their designed close lifecycle (exit animation completes, `aria-hidden` lifts, THEN focus restores — plus our existing `onCloseAutoFocus` preventDefault and blur belts finally get to run on every close path). The alternative (neutralizing each trigger's focusability while its sheet is open) is per-call-site whack-a-mole and hurts keyboard users. REJECTED — Appendix A.
- **The state-reset discipline is preserved, not sacrificed:** remount-per-object was load-bearing against state leaks (P03 T13). The replacement is remount-per-OPEN: `useSheet` bumps an `epoch` on every `open()`, the sheet element is keyed `key={epoch}` (object-bound sheets: `key={`${payload.id}-${epoch}`}`), so internals reset on every open and can never leak across open/close/reopen or across objects. Bumping on OPEN (not close) means the exit animation is never cut.
- `useSheet<T>()` returns `{ isOpen, payload: T | null, epoch, open(payload?), close() }`; `payload` is RETAINED after close so the exit animation renders the same object it opened with; `close()` only flips `isOpen`.
- **Mounted-after-first-open gate:** every site renders its sheet behind `{x.epoch > 0 && …}` (object-bound sheets: `{x.payload !== null && …}` — equivalent). A sheet that was never opened stays OUT of the tree (its query hooks never run — no eager fetches on screens where it is never used, no new mock burden in screen tests); from the first open onward it stays mounted, so every CLOSE — the moment the aria-hidden race lives in — runs the full Radix/vaul lifecycle. The race only ever fired on close, so first-open gating gives up nothing.

- [ ] **Step 1: Write the hook + its test (red: module absent)**

`src/lib/useSheet.ts`:

```ts
import { useState } from 'react';

/**
 * Keep-mounted sheet state (Plan 07 Task 7). The sheet element stays in the
 * tree so Radix/vaul run their graceful close lifecycle — exit animation,
 * aria-hidden lifted, THEN focus restoration. The old `{flag && <Sheet
 * open/>}` unmount-to-close pattern raced these and logged "Blocked
 * aria-hidden on an element because its descendant retained focus"
 * (ui/Sheet.tsx residual-gap note — closed by this migration).
 *
 * State reset happens by REMOUNT-ON-OPEN instead of unmount-on-close:
 * `epoch` bumps on every open(); key the sheet element with it (plus the
 * payload's id where the sheet is object-bound) and internal state can
 * never leak across open/close/reopen or across objects — the P03 T13
 * discipline, preserved. `payload` is RETAINED after close() so the exit
 * animation renders the same object it opened with.
 */
export function useSheet<T = undefined>() {
  const [s, setS] = useState<{
    isOpen: boolean;
    epoch: number;
    payload: T | null;
  }>({ isOpen: false, epoch: 0, payload: null });
  return {
    isOpen: s.isOpen,
    epoch: s.epoch,
    payload: s.payload,
    open: (payload?: T) =>
      setS((prev) => ({
        isOpen: true,
        epoch: prev.epoch + 1,
        payload: (payload ?? null) as T | null,
      })),
    close: () =>
      setS((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev)),
  };
}
```

`src/lib/useSheet.test.tsx`:

```tsx
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSheet } from './useSheet';

describe('useSheet', () => {
  it('bumps the epoch on every open and retains the payload through close', () => {
    const { result } = renderHook(() => useSheet<number>());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.payload).toBeNull();

    act(() => result.current.open(7));
    expect(result.current.isOpen).toBe(true);
    expect(result.current.epoch).toBe(1);
    expect(result.current.payload).toBe(7);

    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
    // Retained — the exit animation renders the object it opened with.
    expect(result.current.payload).toBe(7);
    expect(result.current.epoch).toBe(1);

    act(() => result.current.open(9));
    expect(result.current.epoch).toBe(2); // remount-on-open key
    expect(result.current.payload).toBe(9);
  });

  it('close() is a no-op while already closed (StrictMode-safe identity)', () => {
    const { result } = renderHook(() => useSheet());
    act(() => result.current.close());
    expect(result.current.epoch).toBe(0);
    act(() => result.current.open());
    expect(result.current.isOpen).toBe(true);
    expect(result.current.payload).toBeNull();
  });
});
```

Run `npx vitest run src/lib/useSheet.test.tsx` → FAIL (module absent) → add the hook → PASS.

- [ ] **Step 2: Migrate the ten sites (complete replacements)**

2a. `src/settings/EntitiesScreen.tsx` — replace `const [createOpen, setCreateOpen] = useState(false);` with `const create = useSheet();` (import `useSheet` from `../lib/useSheet`; drop the now-unused `useState` import if lint flags). All `setCreateOpen(true)` → `create.open()`; the mount becomes:

```tsx
      {create.epoch > 0 && (
        <CreateEntitySheet
          key={create.epoch}
          open={create.isOpen}
          onClose={create.close}
          defaultRole={seg === 'team' ? 'employee' : 'supplier'}
        />
      )}
```

(Yes, this is still a `{… && <XSheet/>}` — but gated on `epoch > 0` (ever-opened), not on `isOpen`: once opened it never unmounts on close, which is the property the migration is about. Same shape at every site below.)

2b. `src/settings/EntityScreen.tsx` — `const edit = useSheet();` / `const alias = useSheet();` replace `editOpen`/`aliasOpen`; triggers call `edit.open()`/`alias.open()`; mounts:

```tsx
      {edit.epoch > 0 && (
        <EditEntitySheet
          key={`edit-${entity.id}-${edit.epoch}`}
          entity={entity}
          open={edit.isOpen}
          onClose={edit.close}
        />
      )}
      {alias.epoch > 0 && (
        <AddAliasSheet
          key={`alias-${entity.id}-${alias.epoch}`}
          entityId={entity.id}
          open={alias.isOpen}
          onClose={alias.close}
        />
      )}
```

2c. `src/settings/MailboxScreen.tsx` — `const imap = useSheet();` replaces `imapOpen`; trigger `imap.open()`; mount:

```tsx
      {imap.epoch > 0 && (
        <AddImapSheet key={imap.epoch} open={imap.isOpen} onClose={imap.close} />
      )}
```

2d. `src/books/BooksScreen.tsx` — replace `const [sheet, setSheet] = useState<CreateKind | null>(null);` with three hooks and a lookup (CreateMenu itself already keep-mounted — untouched):

```tsx
  const expenseSheet = useSheet();
  const invoiceSheet = useSheet();
  const uploadSheet = useSheet();
  const sheetOf = {
    expense: expenseSheet,
    invoice: invoiceSheet,
    upload: uploadSheet,
  } as const;
```

`onPick`: `onPick={(kind) => { setCreateOpen(false); sheetOf[kind].open(); }}`. Mounts (replacing the three conditional blocks and their "reset by REMOUNT" comment):

```tsx
      {/* Sheets reset by REMOUNT-ON-OPEN (epoch key) — mounted from first
          open so vaul runs its close lifecycle (Plan 07 Task 7). */}
      {expenseSheet.epoch > 0 && (
        <NewExpenseSheet
          key={`expense-${expenseSheet.epoch}`}
          open={expenseSheet.isOpen}
          onOpenChange={(o) => !o && expenseSheet.close()}
        />
      )}
      {invoiceSheet.epoch > 0 && (
        <NewInvoiceSheet
          key={`invoice-${invoiceSheet.epoch}`}
          open={invoiceSheet.isOpen}
          onOpenChange={(o) => !o && invoiceSheet.close()}
        />
      )}
      {uploadSheet.epoch > 0 && (
        <UploadSheet
          key={`upload-${uploadSheet.epoch}`}
          open={uploadSheet.isOpen}
          onOpenChange={(o) => !o && uploadSheet.close()}
        />
      )}
```

2e. `src/reports/sections.tsx` (InfGaps) — replace `const [fixing, setFixing] = useState<Expense | null>(null);` with `const fix = useSheet<Expense>();`; row `onClick={() => fix.open(e)}`; mount (the payload gate IS the first-open gate here — after the first open it stays mounted for the close lifecycle):

```tsx
      {fix.payload !== null && (
        <FixInvoiceNumberSheet
          key={`${fix.payload.id}-${fix.epoch}`}
          expense={fix.payload}
          supplierName={entityName(entities, fix.payload.supplier_id)}
          open={fix.isOpen}
          onOpenChange={(o) => !o && fix.close()}
        />
      )}
```

2f. `src/reports/PeriodScreen.tsx` — `const lock = useSheet();` replaces `lockOpen`; trigger `lock.open()` (the `Close period…` button); mount (same position):

```tsx
      {lock.epoch > 0 && (
        <LockSheet
          key={`${period.id}-${lock.epoch}`}
          period={period}
          netVatDueCents={
            kmdQ.data !== undefined ? kmdQ.data.net_vat_due : null
          }
          open={lock.isOpen}
          onOpenChange={(o) => !o && lock.close()}
        />
      )}
```

2g. `src/reports/SubmissionsScreen.tsx` — `const add = useSheet();` replaces `addOpen`; trigger `add.open()` (the `Record what happened…` button); mount:

```tsx
      {add.epoch > 0 && (
        <AddEventSheet
          key={`${period.id}-${add.epoch}`}
          periodId={period.id}
          open={add.isOpen}
          onOpenChange={(o) => !o && add.close()}
        />
      )}
```

2h. `src/ui/Sheet.tsx` — replace the "KNOWN RESIDUAL GAP … Documented, not fixed here (structural)." paragraph with:

```
  // RESIDUAL GAP CLOSED (Plan 07 Task 7): every sheet call site now keeps
  // its sheet MOUNTED (open flag + remount-on-open epoch key, lib/useSheet)
  // so Radix runs its graceful close lifecycle and focus restoration lands
  // AFTER aria-hidden lifts. The blur belts below remain as
  // defense-in-depth for direct open-prop flips.
```

- [ ] **Step 3: State-leak regression pins (one per migrated sheet — state does not survive open→close→reopen)**

The close gesture in jsdom: `fireEvent.keyDown(document, { key: 'Escape' })` (Radix DismissableLayer listens on document). Each pin ASSERTS the close landed (`waitFor` on the sheet content disappearing) before reopening — so if Escape ever fails to close under jsdom, the pin fails loudly rather than passing vacuously; in that case drive the close through the sheet's own `onOpenChange` affordance (overlay `pointerDown`) instead — never delete the closed-assertion. Complete code, placed in each screen's existing test file reusing its mount helper:

`src/settings/EntitiesScreen.test.tsx`:

```tsx
  it('create sheet resets across open/close/reopen (remount-on-open discipline)', async () => {
    mount();
    await screen.findByText('Circle K Eesti AS');
    fireEvent.click(screen.getByRole('button', { name: '＋ Add' }));
    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'Half-typed OÜ' },
    });
    fireEvent.change(screen.getByLabelText('Role'), {
      target: { value: 'employee' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Name')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '＋ Add' }));
    expect(await screen.findByLabelText('Name')).toHaveValue('');
    expect(screen.getByLabelText('Role')).toHaveValue('supplier');
  });
```

`src/settings/EntityScreen.test.tsx` (covers BOTH of its sheets):

```tsx
  it('alias and edit sheets reset across open/close/reopen', async () => {
    mount();
    await screen.findByText('Circle K Eesti AS');
    fireEvent.click(screen.getByRole('button', { name: '＋ Add alias' }));
    fireEvent.change(await screen.findByLabelText('Value'), {
      target: { value: 'HALF-TYPED' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Value')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '＋ Add alias' }));
    expect(await screen.findByLabelText('Value')).toHaveValue('');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Value')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'Scratch that' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Name')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByLabelText('Name')).toHaveValue(
      'Circle K Eesti AS',
    );
  });
```

`src/settings/MailboxScreen.test.tsx` (trigger verified at `MailboxScreen.tsx:211-213`):

```tsx
  it('IMAP sheet resets across open/close/reopen', async () => {
    mount();
    await screen.findByText('me@example.com');
    fireEvent.click(
      screen.getByRole('button', { name: 'Add IMAP mailbox…' }),
    );
    fireEvent.change(await screen.findByLabelText('IMAP host'), {
      target: { value: 'imap.half-typed.example' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByLabelText('IMAP host')).toBeNull(),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Add IMAP mailbox…' }),
    );
    expect(await screen.findByLabelText('IMAP host')).toHaveValue('');
  });
```

`src/books/BooksScreen.test.tsx`:

```tsx
  it('New expense sheet resets across open/close/reopen', async () => {
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Add to the books' }),
    );
    fireEvent.click(await screen.findByText('New expense'));
    fireEvent.change(await screen.findByLabelText('Gross (€)'), {
      target: { value: '48.20' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByLabelText('Gross (€)')).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add to the books' }));
    fireEvent.click(await screen.findByText('New expense'));
    expect(await screen.findByLabelText('Gross (€)')).toHaveValue('');
  });
```

`src/reports/sections.test.tsx` (mounts `<InfGapsSection period={PERIOD} />` exactly as the file's existing `'lists only real gap candidates…'` test does — the gap row is the `AS Merko Ehitus` button):

```tsx
  it('Fix-invoice-number sheet resets across open/close/reopen', async () => {
    mount(<InfGapsSection period={PERIOD} />);
    fireEvent.click(
      await screen.findByRole('button', { name: /AS Merko Ehitus/ }),
    );
    fireEvent.change(
      await screen.findByLabelText('Supplier invoice number'),
      { target: { value: 'INV-HALF' } },
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(
        screen.queryByLabelText('Supplier invoice number'),
      ).toBeNull(),
    );
    fireEvent.click(
      screen.getByRole('button', { name: /AS Merko Ehitus/ }),
    );
    expect(
      await screen.findByLabelText('Supplier invoice number'),
    ).toHaveValue('');
  });
```

(Cross-object reset is carried by the `${payload.id}-${epoch}` key — the Step 4 mutation check covers it.)

`src/reports/PeriodScreen.test.tsx` (reuse the exact `mountAt(6, …)` open-oldest arrangement from the file's existing `'the OLDEST open period offers "Close period…"'` test; the trigger label is `Close period…`, the confirm field's label is `` `Type ${period.name} to confirm` ``):

```tsx
  it('Lock sheet resets the typed confirmation across open/close/reopen', async () => {
    // …same mountAt(6, […]) arrangement as the existing Close-period test…
    fireEvent.click(
      await screen.findByRole('button', { name: 'Close period…' }),
    );
    fireEvent.change(await screen.findByLabelText(/to confirm/), {
      target: { value: 'half of the name' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByLabelText(/to confirm/)).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close period…' }));
    expect(await screen.findByLabelText(/to confirm/)).toHaveValue('');
  });
```

`src/reports/SubmissionsScreen.test.tsx` (trigger label verified: `Record what happened…`; the asserted reopen value is AddEventSheet's `useState` default `'submitted'`):

```tsx
  it('Add-event sheet resets across open/close/reopen', async () => {
    mountAt(6);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Record what happened…' }),
    );
    fireEvent.change(await screen.findByLabelText('What happened'), {
      target: { value: 'accepted' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByLabelText('What happened')).toBeNull(),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Record what happened…' }),
    );
    expect(await screen.findByLabelText('What happened')).toHaveValue(
      'submitted',
    );
  });
```

(`mountAt(6)` here means: whatever period-id/status arrangement the file's EXISTING add-event test uses to render the `Record what happened…` button — reuse it verbatim.)

- [ ] **Step 4: Red-check by mutation** — with the pins written and passing, temporarily remove the `key={…epoch}` from ONE site (e.g. CreateEntitySheet), run that suite, watch its reset pin FAIL (typed state survives the reopen), restore. Record in the commit body.

- [ ] **Step 5: Full suite, lint, build (existing sheet tests must survive unmodified except where they asserted UNMOUNT semantics)**

```bash
npm test 2>&1 | tee /tmp/suite.log | tail -5 && grep -c 'not wrapped in act' /tmp/suite.log && npm run lint && npm run build
```

`grep` must print `0` (Task 6's gate holds — keep-mounted must not reintroduce warnings). If a pre-existing test asserted a sheet's ABSENCE from the DOM after close, vaul's Presence still unmounts the Drawer content when `open=false`, so those assertions hold — investigate any failure rather than loosening it.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src
git commit -m "fix(web): sheets keep-mounted with remount-on-open epoch keys (useSheet) — Radix aria-hidden focus race closed, state-reset discipline pinned per sheet (P06 T14 structural residual)"
```

---

### Task 8: Route-level code-split — React.lazy per screen, one Suspense boundary in the shell

**Files:**
- Modify: `packages/web/src/shell/router.tsx`, `packages/web/src/shell/AppLayout.tsx`, `packages/web/src/shell/router.test.tsx` (only if a sync assertion surfaces)

**Interfaces & decisions:**
- **`React.lazy` + shell-level `Suspense`, NOT react-router `route.lazy`** — with `route.lazy`, the data router delays INITIALIZATION on the first match and `RouterProvider` renders its `fallbackElement` (default null) for the whole tree, blanking the eager shell on first paint. `React.lazy` elements suspend INSIDE the mounted shell: TokenGate, Root, AppLayout, Sidebar/TabBar stay eager and painted; only the screen area shows the fallback. (Appendix A records the rejection.)
- Granularity: per SCREEN (22 lazy consts) — Rollup emits one chunk per dynamic import and hoists shared section modules (`queries/*`, kit) into shared chunks automatically; no `manualChunks` speculation up front.
- Redirect components (`RedirectMergingSearch`, `RootRedirect`) and route-table structure stay eager and byte-identical.
- Screen unit tests import screens directly — untouched by construction. `router.test.tsx` already awaits screen content via `findBy*` (Client reality #9).

- [ ] **Step 1: Red anchor**

```bash
npm run build 2>&1 | grep -E 'index-.*kB|larger than 500'
```

Expected (the red): one `index-*.js` ≈ 608 kB and the `(!) Some chunks are larger than 500 kB` warning.

- [ ] **Step 2: `src/shell/router.tsx`** — replace the 22 static screen imports with lazy consts (complete block; `Root` stays a static import):

```tsx
import { lazy } from 'react';
import {
  Navigate,
  createBrowserRouter,
  useLocation,
  type RouteObject,
} from 'react-router-dom';
import { Root } from './Root';

/* Route-level code-split (Plan 07 Task 8): every screen is its own chunk;
 * the shell (Root/TokenGate/AppLayout) stays eager so first paint and the
 * sign-in surface never wait on a screen chunk. The Suspense boundary
 * lives in AppLayout around the Outlet. The explicit
 * `.then((m) => ({ default: m.X }))` shape is deliberate — named exports
 * stay named, and tsc verifies each screen still exports its name. */
const InboxScreen = lazy(() =>
  import('../inbox/InboxScreen').then((m) => ({ default: m.InboxScreen })),
);
const TriageDocScreen = lazy(() =>
  import('../inbox/TriageDocScreen').then((m) => ({ default: m.TriageDocScreen })),
);
const ApprovalScreen = lazy(() =>
  import('../inbox/ApprovalScreen').then((m) => ({ default: m.ApprovalScreen })),
);
const BooksScreen = lazy(() =>
  import('../books/BooksScreen').then((m) => ({ default: m.BooksScreen })),
);
const ExpenseScreen = lazy(() =>
  import('../books/ExpenseScreen').then((m) => ({ default: m.ExpenseScreen })),
);
const InvoiceScreen = lazy(() =>
  import('../books/InvoiceScreen').then((m) => ({ default: m.InvoiceScreen })),
);
const DocumentScreen = lazy(() =>
  import('../books/DocumentScreen').then((m) => ({ default: m.DocumentScreen })),
);
const CreditNoteCreateScreen = lazy(() =>
  import('../books/CreditNoteCreateScreen').then((m) => ({
    default: m.CreditNoteCreateScreen,
  })),
);
const CreditNoteScreen = lazy(() =>
  import('../books/CreditNoteScreen').then((m) => ({ default: m.CreditNoteScreen })),
);
const StatementsScreen = lazy(() =>
  import('../bank/StatementsScreen').then((m) => ({ default: m.StatementsScreen })),
);
const ImportScreen = lazy(() =>
  import('../bank/ImportScreen').then((m) => ({ default: m.ImportScreen })),
);
const StatementScreen = lazy(() =>
  import('../bank/StatementScreen').then((m) => ({ default: m.StatementScreen })),
);
const TxScreen = lazy(() =>
  import('../bank/TxScreen').then((m) => ({ default: m.TxScreen })),
);
const ReportsScreen = lazy(() =>
  import('../reports/ReportsScreen').then((m) => ({ default: m.ReportsScreen })),
);
const PeriodScreen = lazy(() =>
  import('../reports/PeriodScreen').then((m) => ({ default: m.PeriodScreen })),
);
const SubmissionsScreen = lazy(() =>
  import('../reports/SubmissionsScreen').then((m) => ({
    default: m.SubmissionsScreen,
  })),
);
const SettingsScreen = lazy(() =>
  import('../settings/SettingsScreen').then((m) => ({ default: m.SettingsScreen })),
);
const OrganizationScreen = lazy(() =>
  import('../settings/OrganizationScreen').then((m) => ({
    default: m.OrganizationScreen,
  })),
);
const EntitiesScreen = lazy(() =>
  import('../settings/EntitiesScreen').then((m) => ({ default: m.EntitiesScreen })),
);
const EntityScreen = lazy(() =>
  import('../settings/EntityScreen').then((m) => ({ default: m.EntityScreen })),
);
const CategoriesScreen = lazy(() =>
  import('../settings/CategoriesScreen').then((m) => ({
    default: m.CategoriesScreen,
  })),
);
const EnrollScreen = lazy(() =>
  import('../settings/EnrollScreen').then((m) => ({ default: m.EnrollScreen })),
);
const MailboxScreen = lazy(() =>
  import('../settings/MailboxScreen').then((m) => ({ default: m.MailboxScreen })),
);
const TelegramScreen = lazy(() =>
  import('../settings/TelegramScreen').then((m) => ({ default: m.TelegramScreen })),
);
const LlmScreen = lazy(() =>
  import('../settings/LlmScreen').then((m) => ({ default: m.LlmScreen })),
);
const PolicyScreen = lazy(() =>
  import('../settings/PolicyScreen').then((m) => ({ default: m.PolicyScreen })),
);
```

(`LEGACY_REDIRECTS`, `RedirectMergingSearch`, `RootRedirect`, and `buildRoutes()`'s route table are byte-identical — the elements now reference the lazy consts.)

- [ ] **Step 3: `src/shell/AppLayout.tsx`** — wrap the Outlet in the single Suspense boundary:

```tsx
import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { SkeletonRows } from '../ui/Feedback';
```

```tsx
      <div className="pb-24 lg:pb-6 lg:pl-56">
        <Suspense
          fallback={
            <div className="mx-auto max-w-3xl pt-6">
              <SkeletonRows count={4} />
            </div>
          }
        >
          <Outlet context={{ onSignOut } satisfies ShellOutletContext} />
        </Suspense>
      </div>
```

- [ ] **Step 4: Verify — suite, then the build gate**

```bash
npm test && npm run lint
npm run build 2>&1 | tee /tmp/build.log
grep -c 'larger than 500' /tmp/build.log        # MUST print 0
ls dist/assets/*.js | wc -l                      # MUST be ≥ 10 (one chunk per screen + shared)
```

`router.test.tsx` runs against the lazy router — its `findBy*` waits absorb the chunk resolution (dynamic import in vitest is a microtask). If any assertion turns out to be sync-after-navigation, convert THAT assertion to `findBy*` — never add arbitrary waits. IF (and only if) the >500 kB warning survives because the vendor half of `index` alone exceeds it, add the minimal `build.rollupOptions.output.manualChunks = { vendor: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'] }` to `vite.config.ts` and re-verify — do not reach for this preemptively.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/shell packages/web/vite.config.ts
git commit -m "feat(web): route-level code-split — React.lazy per screen behind one shell Suspense boundary; 608kB single chunk gone (P06 deferred)"
```

---

### Task 9: Final verification — full gates + browser smoke of the sheet migration and the code-split

**Files:** none created (fix commits only if the smoke finds defects — each its own `fix(web):` commit, re-running every gate after).

- [ ] **Step 1: Automated gates (all four, in one sitting)**

```bash
cd packages/web
npm test 2>&1 | tee /tmp/final-suite.log | tail -5     # ALL tests pass (463 + this plan's additions; record the exact count)
grep -c 'not wrapped in act' /tmp/final-suite.log       # MUST print 0 — the suite-wide act() gate
npm run lint
npm run build 2>&1 | tee /tmp/final-build.log
grep -c 'larger than 500' /tmp/final-build.log          # MUST print 0
grep -rnE '[−+][{$]*\{?(fmtCents|centsToEuroInput)' src --include='*.tsx' --include='*.ts' | grep -v '\.test\.'   # nothing
grep -rnE '/ ?100\)\.toFixed\(2\)' src --include='*.tsx' --include='*.ts' | grep -v '\.test\.'                     # only lib/money.ts + api.ts
grep -rn '&& <[A-Za-z]*Sheet\|&& (' src --include='*.tsx' | grep -v '\.test\.' | grep -iE 'sheet'   # every hit must gate on .epoch > 0 or .payload !== null — an OPEN-flag gate (`x.isOpen && <…Sheet`) is the banned unmount-to-close pattern
```

- [ ] **Step 2: Browser smoke (real backend, real token — the Plan 02–06 recipe)** — build the SPA, start the backend on **PORT=3210** serving `dist` (same serve-static setup as Plan 06 Task 14), sign in with the GENUINE first-boot init token from the server boot log (never fabricate). Checklist, console open the whole time:
  1. **Sheet migration (the reason this task exists):** for EVERY migrated sheet — Entities `＋ Add`, entity detail `Edit` + `＋ Add alias`, Mailbox IMAP, Books `+` → all three create sheets, Reports period Lock, Submissions add-event, INF fix-number — open it, press **Escape**, and confirm the console logs NO `Blocked aria-hidden` warning (this was reproducible pre-migration on Escape-close — P06 Task 14); reopen and confirm the fields are pristine (state-reset); type-then-Escape-then-reopen on at least CreateEntitySheet and LockSheet.
  2. **Code-split:** Network tab — first load fetches the shell + one screen chunk; navigating Inbox → Books → Bank → Reports → Settings lazy-loads a new chunk per first visit (and none on revisit); deep-link + F5 on `/books/expenses/:id` and `/settings/policy` paints the shell instantly with the skeleton fallback, then the screen; the legacy redirects (`/expenses`, `/settings?tab=entities`) still land correctly.
  3. **Task 1–3 spot checks:** Inbox hero and Books group totals render `−…` exactly once; PolicyScreen: type `-5` in the ceiling → error copy, no hint, Save disabled; flip ingest policy → the select holds the pick with no flicker-back; entity detail shows the "Posted and pending" subtitle; Entities → Team on an install with no team members shows the claimant-dropdown empty state and "Add employee" opens with Role=Employee.
  4. `?tab=` normalize: open `/books?tab=invoices` — the Invoices segment is active AND the address bar reads `?seg=invoices` without a segment click.
- [ ] **Step 3: Self-review the whole branch diff** (`git diff a359d6d..HEAD --stat` + read every hunk) against this plan's Global Constraints — in particular: no weakened dismiss-while-pending guards, no new query keys/polling, no `vi.waitFor` reintroduced, no literal sign prefixes.
- [ ] **Step 4: Record the smoke results + final counts in the commit/PR body.** Any defect found → `fix(web):` commit with a pinned test, then re-run Step 1 in full.

---

## Appendix A — explicitly rejected / out-of-scope (with reasoning)

1. **Currency-code generalization beyond EUR** (P04/P05 currency-pass follow-on): OUT. The server exposes no FX rates and no per-document currency conversion; every amount this SPA renders is EUR integer cents today (`org.base_currency: null` = country-plugin default). `AmountText` already carries a `currency` prop for the day the server speaks otherwise; widening `fmtCents`/`signedEuros` signatures now would be speculative surface. → server list.
2. **react-router `route.lazy()`** as the code-split mechanism: REJECTED — the data router blocks initialization on the first match's lazy resolution and `RouterProvider` shows its `fallbackElement` for the WHOLE tree, blanking the eager shell (TokenGate included) on first paint. `React.lazy` + one shell-level Suspense keeps the shell painted and scopes the fallback to the screen area (Task 8).
3. **Per-trigger focus neutralization** (Sheet.tsx's documented alternative to the migration): REJECTED — it must be re-applied at every trigger forever (whack-a-mole), and making triggers unfocusable while a sheet is open degrades keyboard/screen-reader flows. Keep-mounted lets Radix run the lifecycle it was designed around (Task 7).
4. **Changing `entityStats` to count drafts** (the other half of the P06 T7 "either" suggestion): REJECTED — drafts are not bookings; inflating the count/total to match the landing would fake a money number to match a triage list. Copy alignment chosen (Task 3).
5. **Broader `as never` sweep** beyond the mandate-named sites: OUT of this plan. Remaining known sites (`SettingsScreen.test.tsx:52`, `EntityScreen.test.tsx:156/179/219`, `SupplierSheet.test.tsx:52/110`, `MailboxScreen.test.tsx:149` — a DOM `Location` stub that genuinely cannot be constructed) are load-bearing partial stubs; a typed-fixture pass over them is a rainy-day item, listed here so it stays visible.
6. **`?tab=` redirect at the Settings hub** — already handled at the hub level (P06); the Task 3 normalize covers the three `useSeg` consumers only, deliberately (the hub's `?tab=` is a route-level redirect, not segment state).
7. **Zero-amount rendering change** (`−0.00 €` → `0.00 €` at swept sites): NOT a defect — disclosed intentional improvement (Client reality #10); nothing pinned the old rendering.
8. **Server list (unchanged by this plan, carried verbatim):** [TOP] correction redirect re-dates `tax_point_date` + replacement posted row; needs-triage amounts/counterparty; GET /api/sales-invoices/:id; reconciliation policy_reason; enrollment error codes; `mailbox_initial_fetch_count` registry entry; alias list/delete; post-onboard email/tg identity editing; `auto_post_min_confidence` `.min(0).max(1)`; structured review flags; batch submission-state; INF rows as JSON; per-box KMD composition; amended-snapshot v2; migration-011 2024-Q1 seed removal; PeriodWarning object_type union tightening; partial prepayment; bank-fee disposition; VAT-rate exposure; owner-debt balance; bank-accounts picker endpoint; manual-classify claimant_id propagation (ADR-0036 hold); ADR-0012 delete guard for invoice-linked docs.

## Appendix B — mandate-item verification ledger (HEAD a359d6d, 2026-07-10)

| # | Ledger item | Status at HEAD | Drift vs ledger |
|---|---|---|---|
| 1 | Double-sign sweep (7 sites) | LIVE — Task 1 | Lines drifted: InboxScreen 119→120, sections 203→208 (plus `+` twin at 182), EntityScreen 144→156; ExpenseScreen:128 and create.tsx:213 are toFixed/centsToEuroInput variants of the same hazard; LockSheet has a `+` twin at :68 |
| 2 | PolicyScreen negative-ceiling copy + save recheck + ingest echo | LIVE — Task 2 | none |
| 3 | EntityScreen count-basis mismatch | LIVE — Task 3 (copy alignment; filter impossible via single `?status=`) | none |
| 4 | Team-empty copy | LIVE — Task 3 (+ `defaultRole` preselect) | none |
| 5 | Hardcoded €/toFixed currency pass | LIVE — Task 1 (11 display sites; confidence `.toFixed(2)` excluded — not money) | ledger's four named files confirmed + ApprovalScreen, TriageDocScreen, ClassifyInvoiceSheet |
| 6 | Role-switch payload-leak pin | MISSING pin (component structurally safe) — Task 4, mutation-verified | none |
| 7 | MailboxScreen location-spy restore | LIVE (no afterEach at all) — Task 4 | none |
| 8 | Kind-select 3-option pin; CategoriesScreen `as never` | Both LIVE — Task 4 | Kind select lives in AddAliasSheet, pinned via EntityScreen.test |
| 9 | act() eradication (~116) | LIVE — Tasks 5–6; **measured 98** full-suite (100 summed per-suite), ALL in six bank files; OrgView offender already dead with legacy | count estimate high by ~16; scope narrower (bank-only) than feared |
| — | "?tab lingers in URL" (P04 T13 note, verify-item) | STILL REPRODUCES (useSeg deletes `tab` on write only) — Task 3 | none |
| 10 | vaul unmount-to-close migration | LIVE — Task 7; **10 sites, not ~8** (list in Client reality #8); keep-mounted + epoch-key chosen | site count +2 |
| 11 | Route code-split (607KB) | LIVE — Task 8; measured 608.16 kB single chunk | +1 kB drift |

None of the mandate items had been fixed en route — all eleven land as tasks; nothing required an Appendix-only rejection beyond the scope carve-outs above.
