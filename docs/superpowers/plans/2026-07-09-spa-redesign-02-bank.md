# SPA Redesign — Plan 02: Bank section rebuild (statements, import, statement screen, tx state machine, dispositions)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy 746-line `BankView` with the redesigned Bank section — the core of the whole redesign (~90% of operator time): statements list with unmatched badges, async import flow with a status stepper, the statement screen (segments, AI-proposals tier with bulk Book, color-coded line states), and the transaction screen state machine (matched G, candidates C with N:M live remainder, create-expense-from-line A/B with document policy, personal/fee/prepayment dispositions) — all on the EXISTING server API.

**Architecture:** New screens live in `packages/web/src/bank/`; typed TanStack Query hooks + composite reconciliation flows in `packages/web/src/queries/bank.ts`; two small additions to the transport layer `src/api.ts` (a wrapper for the existing `POST /api/expenses/:id/post` endpoint, and honest typing of the `approvals` array the match endpoint already returns). Routes `/bank`, `/bank/import`, `/bank/statements/:id`, `/bank/statements/:id/tx/:txId` replace the LegacyTabs Bank mount at the end; `BankView.tsx` + its test are deleted. The server is NOT modified. Spec: `docs/superpowers/specs/2026-07-08-spa-ux-redesign-design.md` (Bank subsection); canonical screen assets: `docs/superpowers/specs/assets/2026-07-09-tx-screen-states.html` (state matrix, pixel grid, invariants) and `docs/superpowers/specs/assets/2026-07-09-screens-data-redesign.html` §6/6★/6★b.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind 3 (foundation tokens), react-router-dom v7 (data mode), @tanstack/react-query v5, vaul (Sheet), sonner (toasts), @radix-ui/react-alert-dialog (ConfirmDialog), vitest + @testing-library/react (jsdom). All already installed by Plan 01 — no new dependencies.

## Reality of the server contract (read this before touching any task)

These facts were verified against `packages/server/src` and BIND every task below:

1. **"Book a match" is a two-step server flow.** `POST /api/bank-statements/:id/match` (both `executeMatches` and `manualMatch` in api.ts) stages `reconciliation_match` rows as **`draft`** and creates one **pending approval per match** (`object_type: 'reconciliation_match'`). Nothing settles until each approval is approved (`POST /api/approvals/:id/approve`), which activates the match. The operator is the approver, so the client composes *stage → approve* into one action ("approve-on-the-spot", the same pattern the spec blesses for personal). The over-allocation cap and over-match invariants are enforced server-side **at activation** — the client never duplicates cap math; it surfaces the server's 409 text.
2. **Expenses created via `POST /api/expenses` are `draft` and voucher-less** — a draft cannot be matched (match candidates are posted vouchers). The compose flow is `createExpense` → `POST /api/expenses/:id/post` (pipeline: Rules → Policy → **post or hold**). If Policy holds it (`hold-for-approval`), the expense is `pending` and CANNOT be matched yet — the client reports this honestly and leaves the line open.
3. **A posted expense cannot be deleted** (only drafts can). Therefore "Create & match" has NO true Undo — the receipt toast has no Undo button; recovery is Unmatch (G state) + correction flow (Books plan). Match-only actions (book proposals, manual match, confirm staged) ARE undoable: `DELETE /api/bank-statements/:id/matches/:matchId` works for both draft and active matches.
4. **`createPrepayment` books the FULL line amount** and requires the transaction status `open`; it cannot take a partial amount. The mockup's combined "Match 300 + prepayment 200" is NOT expressible — prepayment is offered ONLY when a line has zero matches, and a partial-match remainder simply stays open on the line (visible, never silently lost).
5. **`markPersonal`** posts a voucher directly (no approval round-trip), validates the line is an **outflow** and `open`, and returns the voucher (which the client ignores, ADR-0030). There is no owner-debt balance endpoint — the personal sheet explains consequences without the running balance.
6. **There is no bank-fee disposition endpoint** (the `bank_fee` tx status exists but nothing sets it over HTTP). Bank fee = create-expense-from-line with the plugin category key `'bank fee'` (exists in the Estonia + null plugins), VAT 0, no supplier.
7. **Bank transaction status stays `'open'` after matching** — reconciliation state comes from `GET .../reconciliation` (`open`/`partial`/`matched` per line). Status values `prepayment`/`personal`/`bank_fee`/`dividend` mark dispositions.
8. **The import workflow may auto-stage high-confidence draft matches** on a fresh statement — so the statement screen must render pre-existing `draft` matches ("Staged") with a Confirm action, not only fresh proposals.
9. `proposeMatches` is a POST but computes-and-returns without persisting — safe to call as a query.
10. `onboardEntity` REQUIRES `registrationKey` for suppliers — the inline supplier mini-create has a mandatory Reg. key field (the mockup's "fill it in from the first invoice" is not possible today).

## Global Constraints

- Working directory for all commands: `packages/web` (repo root: `/Users/alekseirevin/test/headless-bookkeeping.spa-redesign-foundation`).
- Test command: `npx vitest run <file>`; full suite: `npm test`; lint: `npm run lint`; build (typecheck + bundle): `npm run build`.
- **Routes (binding):** `/bank` (statements list), `/bank/import`, `/bank/statements/:id` (segment in `?seg=all`, default Unmatched), `/bank/statements/:id/tx/:txId`. Row navigation uses react-router `Link`/`navigate` with `viewTransition` (ListRow already does).
- **Colors through tokens** (`bg-surface`, `text-ink-2`, `text-ok`, `bg-warn-bg`, `border-line`, `bg-accent`, `bg-accent-deep`, …). Sanctioned one-offs (from the approved mockups, no token exists): matched-row tint `bg-[#F5FAF6]`, secondary-button grey `bg-[#E9EBE7]` (already used by the kit), checkbox border `#C2C7C1`. The matched left stripe uses the `ok` token via `shadow-[inset_3px_0_0_theme(colors.ok.DEFAULT)]`.
- **Pixel constants from the tx-screen asset** (apply to bespoke elements; kit components' own paddings are canonical where a kit component is used): hero amount 30px/800 tabular-nums (`text-[30px] font-extrabold tabular-nums`), hero subtitle 12.5px single-line ellipsis; action-bar buttons `h-[46px] rounded-xl`, bar padding `px-4 pt-3 pb-3.5`; section labels 11px/700 uppercase (kit `GroupLabel`); list rows min-h 52 (kit `ListRow`), KV rows min-h 40 (kit `KeyValue`); checkboxes/radios 22×22 visual with the WHOLE row as the ≥44px hit target; chevron column fixed.
- **Anti-overlap rules (binding):** amounts never wrap (`flex-none whitespace-nowrap tabular-nums` — `AmountText` provides the latter; wrap it in a `flex-none` container in custom rows); titles/subtitles are single-line `truncate`; left column `min-w-0 flex-1`, right column `flex-none`.
- **Screen invariants (from the asset):** exactly ONE primary button per state and its label states the outcome **with the amount** ("Create & match · −18.60 €", never "Submit"); the bank line's amount and date are FACTS — rendered, never editable; a line's remainder is never silently lost — it is always displayed with an explanation; nothing on these screens is irreversible without an explicit confirm step (delete statement → ConfirmDialog; personal/prepayment → explanation sheet with a confirm button; matches → Undo toast).
- UI copy is **English** (the Russian text in the mockups is design annotation, not copy): "Unmatched"/"All", "AI proposals", "Decide yourself", "Matched", "Create & match", "Confirm match", "Unmatch", "Record as personal", "Record prepayment", "Bank fee", "Receipt coming later", "No receipt".
- Money **inputs are euros** via `eurosToCents`/`centsToEuroInput` from `src/lib/money.ts`; the API speaks integer cents; display via `AmountText`/`fmtCents`.
- **Never** `window.prompt/confirm/alert`. Never render voucher/account/debit/credit words (ADR-0001/0030) — `voucherId` is a round-trip key only.
- `approved_by` for approve-on-the-spot calls is the literal `'operator'` (matches legacy usage).
- Query defaults come from `createQueryClient` (staleTime 15s); the ONLY `refetchInterval` polling is the import job (1.5s while running).
- Commit style: `feat(web): …`, one commit per task. React StrictMode double-mount safe.
- Legacy `BankView.tsx`/`BankView.test.tsx` are untouched until Task 12 deletes them; every intermediate task leaves the full suite green.

---

### Task 1: API transport additions — `postExpense`, honest `ExecuteMatchesResult`

**Files:**
- Modify: `packages/web/src/api.ts`
- Test: `packages/web/src/api.bank.test.ts` (new)

**Interfaces:**
- Consumes: existing `apiFetch`, `Expense`, `MatchProposalView`.
- Produces (all from `src/api.ts`):
  - `interface PolicyDecisionView { action: 'auto-post' | 'hold-for-approval'; reason: string }`
  - `postExpense(id: number): Promise<{ expense: Expense; policy: PolicyDecisionView }>` — wraps the existing `POST /api/expenses/:id/post` pipeline endpoint (the response also carries the posted voucher; deliberately left off the typed surface, ADR-0030).
  - `interface ExecuteMatchesResult { records: { id: number }[]; approvals: { id: number; matchId: number }[] }`
  - `executeMatches` and `manualMatch` return `Promise<ExecuteMatchesResult>` (type-only change — the server has always sent `approvals`).

- [ ] **Step 1: Write failing tests**

`src/api.bank.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setToken } from './auth';
import {
  executeMatches,
  manualMatch,
  postExpense,
  type MatchProposalView,
} from './api';

const PROPOSAL: MatchProposalView = {
  bankTransactionId: 9,
  voucherId: 70,
  matchType: 'exact',
  amountMatched: 1860,
  confidence: 'high',
  signal: 'counterparty',
  objectType: 'expense',
  objectId: 55,
  objectLabel: 'Expense #55',
  counterpartyName: 'Wolt Eesti OÜ',
  voucherRemaining: 1860,
};

describe('bank api additions', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('postExpense POSTs the pipeline endpoint and returns expense + policy', async () => {
    const body = JSON.stringify({
      expense: { id: 7, status: 'posted' },
      voucher: { id: 1 },
      policy: { action: 'auto-post', reason: 'all gates passed' },
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(body, { status: 201 }));
    const res = await postExpense(7);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/expenses/7/post');
    expect(init?.method).toBe('POST');
    expect(res.policy.action).toBe('auto-post');
    expect(res.expense.id).toBe(7);
  });

  it('executeMatches surfaces the approvals created alongside draft matches', async () => {
    const body = JSON.stringify({
      records: [{ id: 41 }],
      approvals: [{ id: 9, matchId: 41 }],
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { status: 201 }),
    );
    const res = await executeMatches(3, [PROPOSAL]);
    expect(res.records).toEqual([{ id: 41 }]);
    expect(res.approvals).toEqual([{ id: 9, matchId: 41 }]);
  });

  it('manualMatch surfaces approvals too and sends signal manual', async () => {
    const body = JSON.stringify({
      records: [{ id: 42 }],
      approvals: [{ id: 10, matchId: 42 }],
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(body, { status: 201 }));
    const res = await manualMatch(3, {
      bankTransactionId: 9,
      voucherId: 70,
      amountMatched: 1860,
      matchType: 'exact',
    });
    expect(res.approvals[0].matchId).toBe(42);
    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse(String(init?.body)) as {
      matches: { signal: string }[];
    };
    expect(sent.matches[0].signal).toBe('manual');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/api.bank.test.ts
```

Expected: FAIL — `postExpense` is not exported from `./api` (and the result typings don't expose `approvals`).

- [ ] **Step 3: Implement in `src/api.ts`**

Insert after the `correctInvoice` export (the expenses block):

```ts
// ── Expense posting pipeline (draft → Rules → Policy → post or hold) ───────
// The endpoint also returns the posted voucher; it stays off the typed surface
// on purpose (ADR-0001/ADR-0030 — the operator UI never consumes ledger data).
export interface PolicyDecisionView {
  action: 'auto-post' | 'hold-for-approval';
  reason: string;
}

export const postExpense = (id: number) =>
  apiFetch<{ expense: Expense; policy: PolicyDecisionView }>(
    `/api/expenses/${id}/post`,
    { method: 'POST' },
  );
```

Insert above `executeMatches` (reconciliation block):

```ts
// The match endpoint stages DRAFT matches and creates one pending approval per
// match (settlement happens at approval → activation). The client needs the
// approval ids to approve-on-the-spot, and the match ids to Undo.
export interface ExecuteMatchesResult {
  records: { id: number }[];
  approvals: { id: number; matchId: number }[];
}
```

Then change the two return types (only the generic parameter changes; bodies stay identical):

- In `executeMatches`: replace `apiFetch<{ records: { id: number }[] }>(` with `apiFetch<ExecuteMatchesResult>(`.
- In `manualMatch`: replace `apiFetch<{ records: { id: number }[] }>(` with `apiFetch<ExecuteMatchesResult>(`.

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/api.bank.test.ts && npm test
```

Expected: PASS (3 tests); full suite PASS (the legacy BankView only reads `.records`, still present).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api.ts packages/web/src/api.bank.test.ts
git commit -m "feat(web): bank API transport — expense posting pipeline wrapper, match approvals typing"
```

---

### Task 2: Bank formatting helpers + VAT-from-gross

**Files:**
- Create: `packages/web/src/bank/format.ts`
- Modify: `packages/web/src/lib/money.ts`
- Test: `packages/web/src/bank/format.test.ts`, extend `packages/web/src/lib/money.test.ts`

**Interfaces:**
- Produces:
  - `formatStatementPeriod(startDate: string, endDate: string): string` — `"2026-06-01","2026-06-30"` → `"Jun 2026"`; same-year cross-month → `"Apr – Jun 2026"`; cross-year → `"Dec 2025 – Jan 2026"`.
  - `formatTxDate(isoDate: string): string` — `"2026-06-27"` → `"27 Jun"`.
  - `txTitle(tx: { description: string | null; counterparty_descriptor: string | null; reference: string | null }): string` — first non-null of description/descriptor/reference, else `"Bank transaction"`.
  - `STANDARD_VAT_RATE_PCT = 22` (client-side degradation constant — no API exposes the country VAT rate; the VAT field stays editable).
  - `vatFromGross(grossCents: number, ratePct: number): number` in `src/lib/money.ts` — VAT portion inside a VAT-inclusive gross.

- [ ] **Step 1: Write failing tests**

`src/bank/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatStatementPeriod, formatTxDate, txTitle } from './format';

describe('formatStatementPeriod', () => {
  it('renders a single month', () => {
    expect(formatStatementPeriod('2026-06-01', '2026-06-30')).toBe('Jun 2026');
  });
  it('renders a same-year range', () => {
    expect(formatStatementPeriod('2026-04-01', '2026-06-30')).toBe(
      'Apr – Jun 2026',
    );
  });
  it('renders a cross-year range', () => {
    expect(formatStatementPeriod('2025-12-01', '2026-01-31')).toBe(
      'Dec 2025 – Jan 2026',
    );
  });
});

describe('formatTxDate', () => {
  it('renders day + short month', () => {
    expect(formatTxDate('2026-06-27')).toBe('27 Jun');
  });
});

describe('txTitle', () => {
  it('prefers description, then descriptor, then reference', () => {
    expect(
      txTitle({
        description: 'WOLT 220627',
        counterparty_descriptor: 'x',
        reference: 'y',
      }),
    ).toBe('WOLT 220627');
    expect(
      txTitle({
        description: null,
        counterparty_descriptor: 'CIRCLE K 4411',
        reference: 'y',
      }),
    ).toBe('CIRCLE K 4411');
    expect(
      txTitle({ description: null, counterparty_descriptor: null, reference: null }),
    ).toBe('Bank transaction');
  });
});
```

Append to `src/lib/money.test.ts`:

```ts
import { vatFromGross } from './money';

describe('vatFromGross', () => {
  it('extracts the VAT portion of a VAT-inclusive gross', () => {
    // 18.60 € gross at 22% → 3.35 € VAT (matches the mockup's Wolt line).
    expect(vatFromGross(1860, 22)).toBe(335);
  });
  it('is zero at rate 0', () => {
    expect(vatFromGross(1860, 0)).toBe(0);
  });
});
```

(Merge the import with the existing `./money` import line in that file — one import statement, three names: `centsToEuroInput, eurosToCents, vatFromGross`.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/bank/format.test.ts src/lib/money.test.ts
```

Expected: FAIL — `./format` not found; `vatFromGross` not exported.

- [ ] **Step 3: Implement**

`src/bank/format.ts`:

```ts
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

/** Statement title. BankStatement carries no account/currency fields (the
 *  ledger account id is deliberately hidden, ADR-0001), so the period IS the
 *  statement's display identity. */
export function formatStatementPeriod(
  startDate: string,
  endDate: string,
): string {
  const s = parts(startDate);
  const e = parts(endDate);
  if (s.y === e.y && s.m === e.m) return `${MONTHS[s.m - 1]} ${s.y}`;
  if (s.y === e.y) return `${MONTHS[s.m - 1]} – ${MONTHS[e.m - 1]} ${s.y}`;
  return `${MONTHS[s.m - 1]} ${s.y} – ${MONTHS[e.m - 1]} ${e.y}`;
}

/** Short list-date for a bank line: "27 Jun" (absolute — bank dates are facts). */
export function formatTxDate(isoDate: string): string {
  const p = parts(isoDate);
  return `${p.d} ${MONTHS[p.m - 1]}`;
}

/** The line's display title — IDs are not data; the description answers
 *  "what is this". */
export function txTitle(tx: {
  description: string | null;
  counterparty_descriptor: string | null;
  reference: string | null;
}): string {
  return (
    tx.description ?? tx.counterparty_descriptor ?? tx.reference ?? 'Bank transaction'
  );
}

/**
 * DEGRADATION (documented in the plan appendix): no endpoint exposes the
 * country plugin's VAT rate, so the create-from-line form prefigures VAT at
 * the Estonian standard rate. The field stays editable; "no receipt" forces 0.
 */
export const STANDARD_VAT_RATE_PCT = 22;
```

Append to `src/lib/money.ts`:

```ts
/** VAT portion inside a VAT-inclusive gross at an integer percent rate:
 *  vat = gross * r / (100 + r). Used to prefill VAT from a bank-line amount. */
export function vatFromGross(grossCents: number, ratePct: number): number {
  return Math.round((grossCents * ratePct) / (100 + ratePct));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/bank/format.test.ts src/lib/money.test.ts
```

Expected: PASS (format 5, money 7 total).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/bank packages/web/src/lib
git commit -m "feat(web): bank formatting + VAT-from-gross helpers"
```

---

### Task 3: Bank query layer + composite reconciliation flows

**Files:**
- Create: `packages/web/src/queries/bank.ts`
- Test: `packages/web/src/queries/bank.test.tsx`

**Interfaces:**
- Consumes (verify all exist in `src/api.ts` with these names): `listBankStatements`, `listBankTransactions`, `getReconciliationStatus`, `getStatementMatches`, `proposeMatches`, `getMatchCandidates`, `getBankImportStatus`, `executeMatches`, `manualMatch`, `unmatchMatch`, `approveApproval`, `getPendingApprovals`, `createExpense`, `postExpense`, `getCategories`, `getEntities`, `getOrganization`, plus types `BankImportJob`, `MatchProposalView`, `MatchCandidatesResult`, `Entity`, `Expense`.
- Produces (from `src/queries/bank.ts`):
  - `bankKeys` — key factory: `statements`, `statement(id)`, `transactions(id)`, `reconciliation(id)`, `matches(id)`, `proposals(id)`, `candidates(id, txId)`, `unmatchedCount(id)`, `importJob(jobId)`.
  - Hooks: `useBankStatements()`, `useBankTransactions(statementId)`, `useReconciliation(statementId)`, `useStatementMatches(statementId)`, `useMatchProposals(statementId)`, `useMatchCandidates(statementId, txId, enabled)`, `useImportJob(jobId: number | null)` (1.5s polling while `running`), `useUnmatchedCounts(statementIds: number[]): Map<number, number | undefined>`, `useCategories()`, `useSuppliers()`, `useOrganizationCountry()`.
  - `invalidateStatement(qc: QueryClient, statementId: number): Promise<void>` — invalidates everything under `bankKeys.statement(id)`.
  - Composite flows (plain async, unit-testable): `bookProposals(statementId, proposals): Promise<number[]>` (stage + approve each; returns match ids), `bookManualMatch(statementId, m): Promise<number>`, `confirmStagedMatch(matchId): Promise<void>`, `undoMatches(statementId, matchIds): Promise<void>`, `createExpenseFromLine(input: CreateFromLineInput): Promise<CreateFromLineResult>`.
  - `interface CreateFromLineInput { statementId: number; bankTransactionId: number; category: string; grossCents: number; vatCents: number; currency: string; taxPointDate: string; supplierId: number | null }`
  - `type CreateFromLineResult = { outcome: 'matched'; expenseId: number; matchId: number } | { outcome: 'held'; expenseId: number; reason: string }`

- [ ] **Step 1: Write failing tests**

`src/queries/bank.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  listBankStatements: vi.fn(),
  listBankTransactions: vi.fn(),
  getReconciliationStatus: vi.fn(),
  getStatementMatches: vi.fn(),
  proposeMatches: vi.fn(),
  getMatchCandidates: vi.fn(),
  getBankImportStatus: vi.fn(),
  executeMatches: vi.fn(),
  manualMatch: vi.fn(),
  unmatchMatch: vi.fn(),
  approveApproval: vi.fn(),
  getPendingApprovals: vi.fn(),
  createExpense: vi.fn(),
  postExpense: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getOrganization: vi.fn(),
}));

import * as api from '../api';
import {
  bookManualMatch,
  bookProposals,
  confirmStagedMatch,
  createExpenseFromLine,
  undoMatches,
  useImportJob,
} from './bank';

const PROPOSAL = {
  bankTransactionId: 9,
  voucherId: 70,
  matchType: 'exact' as const,
  amountMatched: 1860,
  confidence: 'high' as const,
  signal: 'counterparty' as const,
  objectType: 'expense' as const,
  objectId: 55,
  objectLabel: 'Expense #55',
  counterpartyName: 'Wolt Eesti OÜ',
  voucherRemaining: 1860,
};

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

describe('bookProposals', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stages the matches then approves each returned approval', async () => {
    const order: string[] = [];
    vi.mocked(api.executeMatches).mockImplementation(async () => {
      order.push('stage');
      return {
        records: [{ id: 41 }, { id: 42 }],
        approvals: [
          { id: 9, matchId: 41 },
          { id: 10, matchId: 42 },
        ],
      };
    });
    vi.mocked(api.approveApproval).mockImplementation(async (id) => {
      order.push(`approve-${id}`);
      return { approval: { id } } as never;
    });
    const matchIds = await bookProposals(3, [PROPOSAL, PROPOSAL]);
    expect(matchIds).toEqual([41, 42]);
    expect(order).toEqual(['stage', 'approve-9', 'approve-10']);
    expect(api.approveApproval).toHaveBeenCalledWith(9, 'operator');
  });
});

describe('bookManualMatch / undoMatches / confirmStagedMatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bookManualMatch stages one match and approves it', async () => {
    vi.mocked(api.manualMatch).mockResolvedValue({
      records: [{ id: 88 }],
      approvals: [{ id: 12, matchId: 88 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: { id: 12 },
    } as never);
    const matchId = await bookManualMatch(3, {
      bankTransactionId: 9,
      voucherId: 70,
      amountMatched: 1860,
      matchType: 'exact',
    });
    expect(matchId).toBe(88);
    expect(api.approveApproval).toHaveBeenCalledWith(12, 'operator');
  });

  it('undoMatches unmatches every id against the statement', async () => {
    vi.mocked(api.unmatchMatch).mockResolvedValue({});
    await undoMatches(3, [41, 42]);
    expect(api.unmatchMatch).toHaveBeenNthCalledWith(1, 3, 41);
    expect(api.unmatchMatch).toHaveBeenNthCalledWith(2, 3, 42);
  });

  it('confirmStagedMatch finds the pending reconciliation approval and approves it', async () => {
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      {
        id: 77,
        object_type: 'reconciliation_match',
        object_id: 41,
        status: 'pending',
        requested_by: 'system',
        approved_by: null,
        rejected_reason: null,
        policy_reason: null,
        superseded_by: null,
        created_at: 0,
        resolved_at: null,
      },
    ]);
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: { id: 77 },
    } as never);
    await confirmStagedMatch(41);
    expect(api.approveApproval).toHaveBeenCalledWith(77, 'operator');
  });

  it('confirmStagedMatch throws when no approval is pending for the match', async () => {
    vi.mocked(api.getPendingApprovals).mockResolvedValue([]);
    await expect(confirmStagedMatch(41)).rejects.toThrow(/no pending approval/i);
  });
});

describe('createExpenseFromLine', () => {
  beforeEach(() => vi.clearAllMocks());

  const INPUT = {
    statementId: 3,
    bankTransactionId: 9,
    category: 'meals',
    grossCents: 1860,
    vatCents: 335,
    currency: 'EUR',
    taxPointDate: '2026-06-27',
    supplierId: 12,
  };

  it('creates, posts, finds its own candidate, matches exact, approves', async () => {
    vi.mocked(api.createExpense).mockResolvedValue({ id: 55 } as never);
    vi.mocked(api.postExpense).mockResolvedValue({
      expense: { id: 55, status: 'posted' },
      policy: { action: 'auto-post', reason: 'ok' },
    } as never);
    vi.mocked(api.getMatchCandidates).mockResolvedValue({
      bankTransactionId: 9,
      lineRemaining: 1860,
      candidates: [
        {
          voucherId: 70,
          objectType: 'expense',
          objectId: 55,
          objectLabel: 'Expense #55',
          counterpartyName: 'Wolt Eesti OÜ',
          voucherRemaining: 1860,
        },
      ],
    });
    vi.mocked(api.manualMatch).mockResolvedValue({
      records: [{ id: 88 }],
      approvals: [{ id: 12, matchId: 88 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: { id: 12 },
    } as never);

    const res = await createExpenseFromLine(INPUT);
    expect(res).toEqual({ outcome: 'matched', expenseId: 55, matchId: 88 });
    expect(api.createExpense).toHaveBeenCalledWith({
      category: 'meals',
      gross_amount: 1860,
      vat_amount: 335,
      currency: 'EUR',
      tax_point_date: '2026-06-27',
      supplier_id: 12,
    });
    expect(api.manualMatch).toHaveBeenCalledWith(3, {
      bankTransactionId: 9,
      voucherId: 70,
      amountMatched: 1860,
      matchType: 'exact',
    });
  });

  it('returns held (and does NOT try to match) when policy holds the expense', async () => {
    vi.mocked(api.createExpense).mockResolvedValue({ id: 56 } as never);
    vi.mocked(api.postExpense).mockResolvedValue({
      expense: { id: 56, status: 'pending' },
      policy: {
        action: 'hold-for-approval',
        reason: 'amount 240.00 above ceiling 50.00',
      },
    } as never);
    const res = await createExpenseFromLine(INPUT);
    expect(res).toEqual({
      outcome: 'held',
      expenseId: 56,
      reason: 'amount 240.00 above ceiling 50.00',
    });
    expect(api.getMatchCandidates).not.toHaveBeenCalled();
    expect(api.manualMatch).not.toHaveBeenCalled();
  });
});

describe('useImportJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not fetch while jobId is null', () => {
    renderHook(() => useImportJob(null), { wrapper: makeWrapper() });
    expect(api.getBankImportStatus).not.toHaveBeenCalled();
  });

  it('fetches the job when an id is set', async () => {
    vi.mocked(api.getBankImportStatus).mockResolvedValue({
      id: 7,
      status: 'done',
      account_code: 'BANK_EUR',
      statement_id: 5,
      error: null,
    });
    const { result } = renderHook(() => useImportJob(7), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data?.status).toBe('done'));
    expect(api.getBankImportStatus).toHaveBeenCalledWith(7);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/queries/bank.test.tsx
```

Expected: FAIL — `./bank` not found.

- [ ] **Step 3: Implement**

`src/queries/bank.ts`:

```ts
import {
  useQueries,
  useQuery,
  type QueryClient,
} from '@tanstack/react-query';
import {
  approveApproval,
  createExpense,
  executeMatches,
  getBankImportStatus,
  getCategories,
  getEntities,
  getMatchCandidates,
  getOrganization,
  getPendingApprovals,
  getReconciliationStatus,
  getStatementMatches,
  listBankStatements,
  listBankTransactions,
  manualMatch,
  postExpense,
  proposeMatches,
  unmatchMatch,
  type MatchProposalView,
} from '../api';

/**
 * Bank data layer. Reads are TanStack Query hooks; the multi-call server
 * choreography (stage match → approve, create expense → post → match) lives
 * here as composite flows so screens stay declarative and the sequences are
 * unit-testable.
 */
export const bankKeys = {
  statements: ['bank', 'statements'] as const,
  statement: (id: number) => ['bank', 'statements', id] as const,
  transactions: (id: number) =>
    ['bank', 'statements', id, 'transactions'] as const,
  reconciliation: (id: number) =>
    ['bank', 'statements', id, 'reconciliation'] as const,
  matches: (id: number) => ['bank', 'statements', id, 'matches'] as const,
  proposals: (id: number) => ['bank', 'statements', id, 'proposals'] as const,
  candidates: (id: number, txId: number) =>
    ['bank', 'statements', id, 'candidates', txId] as const,
  unmatchedCount: (id: number) =>
    ['bank', 'statements', id, 'unmatched-count'] as const,
  importJob: (jobId: number) => ['bank', 'import', jobId] as const,
};

export const useBankStatements = () =>
  useQuery({ queryKey: bankKeys.statements, queryFn: listBankStatements });

export const useBankTransactions = (statementId: number) =>
  useQuery({
    queryKey: bankKeys.transactions(statementId),
    queryFn: () => listBankTransactions(statementId),
  });

export const useReconciliation = (statementId: number) =>
  useQuery({
    queryKey: bankKeys.reconciliation(statementId),
    queryFn: () => getReconciliationStatus(statementId),
  });

export const useStatementMatches = (statementId: number) =>
  useQuery({
    queryKey: bankKeys.matches(statementId),
    queryFn: () => getStatementMatches(statementId),
  });

/** proposeMatches is a POST but computes-and-returns without persisting —
 *  safe as a query (verified against ReconciliationService.proposeMatches). */
export const useMatchProposals = (statementId: number) =>
  useQuery({
    queryKey: bankKeys.proposals(statementId),
    queryFn: () => proposeMatches(statementId),
  });

export const useMatchCandidates = (
  statementId: number,
  txId: number,
  enabled = true,
) =>
  useQuery({
    queryKey: bankKeys.candidates(statementId, txId),
    queryFn: () => getMatchCandidates(statementId, txId),
    enabled,
  });

/** Import-job polling — the ONLY refetchInterval in the Bank section. */
export function useImportJob(jobId: number | null) {
  return useQuery({
    queryKey: bankKeys.importJob(jobId ?? -1),
    queryFn: () => getBankImportStatus(jobId as number),
    enabled: jobId !== null,
    refetchInterval: (query) =>
      query.state.data === undefined || query.state.data.status === 'running'
        ? 1500
        : false,
  });
}

/** Statements-list badge: unmatched = open lines not fully reconciled.
 *  Joins transactions (for disposition statuses) with reconciliation rows. */
async function fetchUnmatchedCount(statementId: number): Promise<number> {
  const [txns, recon] = await Promise.all([
    listBankTransactions(statementId),
    getReconciliationStatus(statementId),
  ]);
  const byTx = new Map(recon.map((r) => [r.bankTransactionId, r.reconStatus]));
  return txns.filter(
    (t) => t.status === 'open' && byTx.get(t.id) !== 'matched',
  ).length;
}

export const useUnmatchedCounts = (statementIds: number[]) =>
  useQueries({
    queries: statementIds.map((id) => ({
      queryKey: bankKeys.unmatchedCount(id),
      queryFn: () => fetchUnmatchedCount(id),
    })),
    combine: (results) =>
      new Map(statementIds.map((id, i) => [id, results[i].data])),
  });

export const useCategories = () =>
  useQuery({ queryKey: ['categories'], queryFn: getCategories });

export const useSuppliers = () =>
  useQuery({
    queryKey: ['entities'],
    queryFn: getEntities,
    select: (entities) => entities.filter((e) => e.role === 'supplier'),
  });

export const useOrganizationCountry = () =>
  useQuery({
    queryKey: ['organization'],
    queryFn: getOrganization,
    select: (org) => org.country,
  });

export function invalidateStatement(
  qc: QueryClient,
  statementId: number,
): Promise<void> {
  return qc.invalidateQueries({ queryKey: bankKeys.statement(statementId) });
}

// ── Composite flows ────────────────────────────────────────────────────────

const APPROVED_BY = 'operator';

/**
 * Book selected AI proposals: stage drafts (server creates one pending
 * approval per match), then approve each — the operator IS the approver.
 * The over-allocation cap is enforced server-side AT ACTIVATION; a 409 here
 * propagates to the caller with the server's message (no client cap math).
 * Returns the created match ids (for Undo via undoMatches).
 */
export async function bookProposals(
  statementId: number,
  proposals: MatchProposalView[],
): Promise<number[]> {
  const res = await executeMatches(statementId, proposals);
  for (const a of res.approvals) {
    await approveApproval(a.id, APPROVED_BY);
  }
  return res.approvals.map((a) => a.matchId);
}

/** Stage + approve a single manual match. Returns the match id (for Undo). */
export async function bookManualMatch(
  statementId: number,
  m: {
    bankTransactionId: number;
    voucherId: number;
    amountMatched: number;
    matchType: 'exact' | 'partial';
  },
): Promise<number> {
  const res = await manualMatch(statementId, m);
  for (const a of res.approvals) {
    await approveApproval(a.id, APPROVED_BY);
  }
  return res.approvals[0]?.matchId ?? res.records[0].id;
}

/**
 * Activate a match that is already staged as a draft (e.g. auto-staged by the
 * import workflow): find its pending approval and approve it.
 */
export async function confirmStagedMatch(matchId: number): Promise<void> {
  const pending = await getPendingApprovals();
  const approval = pending.find(
    (a) => a.object_type === 'reconciliation_match' && a.object_id === matchId,
  );
  if (!approval) {
    throw new Error(`No pending approval found for match ${matchId}`);
  }
  await approveApproval(approval.id, APPROVED_BY);
}

/** Undo booked matches — works for draft AND active (server reverses FX). */
export async function undoMatches(
  statementId: number,
  matchIds: number[],
): Promise<void> {
  for (const id of matchIds) {
    await unmatchMatch(statementId, id);
  }
}

export interface CreateFromLineInput {
  statementId: number;
  bankTransactionId: number;
  category: string;
  grossCents: number; // positive
  vatCents: number;
  currency: string;
  taxPointDate: string; // YYYY-MM-DD, from the line (a fact)
  supplierId: number | null;
}

export type CreateFromLineResult =
  | { outcome: 'matched'; expenseId: number; matchId: number }
  | { outcome: 'held'; expenseId: number; reason: string };

/**
 * The core inversion — "bank line → expense", composed client-side:
 * 1. createExpense (draft), 2. post via the pipeline (Rules → Policy),
 * 3. if held-for-approval: report honestly (a pending expense has no voucher
 *    and cannot be matched), 4. else find the fresh expense among the line's
 *    match candidates and stage+approve the match.
 * NOT undoable as a whole: the expense is POSTED (posted objects are
 * immutable; only the match part can be undone later via Unmatch).
 */
export async function createExpenseFromLine(
  input: CreateFromLineInput,
): Promise<CreateFromLineResult> {
  const expense = await createExpense({
    category: input.category,
    gross_amount: input.grossCents,
    vat_amount: input.vatCents,
    currency: input.currency,
    tax_point_date: input.taxPointDate,
    supplier_id: input.supplierId,
  });
  const posted = await postExpense(expense.id);
  if (posted.policy.action === 'hold-for-approval') {
    return {
      outcome: 'held',
      expenseId: expense.id,
      reason: posted.policy.reason,
    };
  }
  const res = await getMatchCandidates(
    input.statementId,
    input.bankTransactionId,
  );
  const candidate = res.candidates.find(
    (c) => c.objectType === 'expense' && c.objectId === expense.id,
  );
  if (!candidate) {
    throw new Error(
      'Expense was created and posted but did not appear among match candidates — match it manually.',
    );
  }
  const amount = Math.min(res.lineRemaining, candidate.voucherRemaining);
  const matchType =
    amount === candidate.voucherRemaining && amount === res.lineRemaining
      ? 'exact'
      : 'partial';
  const matchId = await bookManualMatch(input.statementId, {
    bankTransactionId: input.bankTransactionId,
    voucherId: candidate.voucherId,
    amountMatched: amount,
    matchType,
  });
  return { outcome: 'matched', expenseId: expense.id, matchId };
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/queries/bank.test.tsx && npm test
```

Expected: PASS (9 tests); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/queries
git commit -m "feat(web): bank query layer + composite reconciliation flows"
```

---

### Task 4: Statements list screen (`/bank`)

**Files:**
- Create: `packages/web/src/bank/StatementsScreen.tsx`
- Create: `packages/web/src/bank/LoadError.tsx` (shared query-error panel for all bank screens)
- Test: `packages/web/src/bank/StatementsScreen.test.tsx`

**Interfaces:**
- Consumes: `useBankStatements`, `useUnmatchedCounts` (queries/bank), `LargeTitleHeader` (shell/Headers), `ListGroup`/`ListRow` + `EmptyState`/`SkeletonRows` + `Chip` (ui), `relativeTime` (src/relativeTime.ts), `formatStatementPeriod` (bank/format).
- Produces:
  - `StatementsScreen(): JSX.Element` — list of statements, newest period first, each row navigating to `/bank/statements/:id`; unmatched badge per row; "Import" header action to `/bank/import`. Statement delete is NOT here — it lives on the statement screen header (Task 6) behind a ConfirmDialog.
  - `LoadError({ message, onRetry }: { message: string; onRetry: () => void }): JSX.Element`

- [ ] **Step 1: Write failing tests**

`src/bank/StatementsScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  listBankStatements: vi.fn(),
  listBankTransactions: vi.fn(),
  getReconciliationStatus: vi.fn(),
  getStatementMatches: vi.fn(),
  proposeMatches: vi.fn(),
  getMatchCandidates: vi.fn(),
  getBankImportStatus: vi.fn(),
  executeMatches: vi.fn(),
  manualMatch: vi.fn(),
  unmatchMatch: vi.fn(),
  approveApproval: vi.fn(),
  getPendingApprovals: vi.fn(),
  createExpense: vi.fn(),
  postExpense: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getOrganization: vi.fn(),
}));

import * as api from '../api';
import { StatementsScreen } from './StatementsScreen';

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/bank', element: <StatementsScreen /> },
      { path: '/bank/import', element: <p>import screen</p> },
      { path: '/bank/statements/:id', element: <p>statement screen</p> },
    ],
    { initialEntries: ['/bank'] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('StatementsScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listBankTransactions).mockResolvedValue([]);
    vi.mocked(api.getReconciliationStatus).mockResolvedValue([]);
  });

  it('lists statements as period rows linking to the statement screen', async () => {
    vi.mocked(api.listBankStatements).mockResolvedValue([
      { id: 3, start_date: '2026-06-01', end_date: '2026-06-30', uploaded_at: 1 },
    ]);
    renderScreen();
    const row = await screen.findByRole('link', { name: /Jun 2026/ });
    expect(row).toHaveAttribute('href', '/bank/statements/3');
  });

  it('shows the unmatched badge from the reconciliation join', async () => {
    vi.mocked(api.listBankStatements).mockResolvedValue([
      { id: 3, start_date: '2026-06-01', end_date: '2026-06-30', uploaded_at: 1 },
    ]);
    vi.mocked(api.listBankTransactions).mockResolvedValue([
      { id: 9, transaction_date: '2026-06-27', description: 'WOLT', amount: -1860, currency: 'EUR', counterparty_iban: null, counterparty_descriptor: null, reference: null, status: 'open' },
      { id: 10, transaction_date: '2026-06-24', description: 'ELISA', amount: -3500, currency: 'EUR', counterparty_iban: null, counterparty_descriptor: null, reference: null, status: 'open' },
    ]);
    vi.mocked(api.getReconciliationStatus).mockResolvedValue([
      { bankTransactionId: 9, amountBase: 1860, matchedSum: 0, remaining: 1860, reconStatus: 'open' },
      { bankTransactionId: 10, amountBase: 3500, matchedSum: 3500, remaining: 0, reconStatus: 'matched' },
    ]);
    renderScreen();
    expect(await screen.findByText('1 unmatched')).toBeInTheDocument();
  });

  it('shows a done chip when everything is reconciled', async () => {
    vi.mocked(api.listBankStatements).mockResolvedValue([
      { id: 3, start_date: '2026-06-01', end_date: '2026-06-30', uploaded_at: 1 },
    ]);
    renderScreen();
    expect(await screen.findByText('done ✓')).toBeInTheDocument();
  });

  it('shows an empty state with an import CTA when there are no statements', async () => {
    vi.mocked(api.listBankStatements).mockResolvedValue([]);
    renderScreen();
    expect(await screen.findByText('No statements yet')).toBeInTheDocument();
    expect(
      screen.getAllByRole('link', { name: /import/i }).length,
    ).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/bank/StatementsScreen.test.tsx
```

Expected: FAIL — `./StatementsScreen` not found.

- [ ] **Step 3: Implement**

`src/bank/LoadError.tsx`:

```tsx
import { Button } from '../ui/Button';

/** Explicit query-error state for bank screens: server text + retry. */
export function LoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="mx-3.5 mb-3.5 rounded-2xl bg-err-bg px-4 py-3.5">
      <p className="text-[13px] font-semibold text-err">{message}</p>
      <Button variant="secondary" className="mt-2" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
```

`src/bank/StatementsScreen.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { relativeTime } from '../relativeTime';
import {
  useBankStatements,
  useUnmatchedCounts,
} from '../queries/bank';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { ListGroup, ListRow } from '../ui/List';
import { LargeTitleHeader } from '../shell/Headers';
import { formatStatementPeriod } from './format';
import { LoadError } from './LoadError';

/** /bank — statements list. The row answers "which period, is there work
 *  left": period title + unmatched badge (IDs are not data). */
export function StatementsScreen() {
  const statementsQ = useBankStatements();
  const statements = statementsQ.data ?? [];
  // Newest period first.
  const sorted = [...statements].sort((a, b) =>
    b.start_date.localeCompare(a.start_date),
  );
  const counts = useUnmatchedCounts(sorted.map((s) => s.id));

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <LargeTitleHeader
        title="Bank"
        trailing={
          <Link
            to="/bank/import"
            viewTransition
            className="text-[15px] font-semibold text-accent"
          >
            Import
          </Link>
        }
      />
      {statementsQ.isPending && <SkeletonRows count={3} />}
      {statementsQ.isError && (
        <LoadError
          message={
            statementsQ.error instanceof Error
              ? statementsQ.error.message
              : 'Failed to load statements'
          }
          onRetry={() => void statementsQ.refetch()}
        />
      )}
      {statementsQ.isSuccess && sorted.length === 0 && (
        <EmptyState
          icon="🏦"
          title="No statements yet"
          hint="Import a bank statement to start reconciling."
          action={
            <Link
              to="/bank/import"
              viewTransition
              className="inline-block rounded-xl bg-accent px-4 py-2.5 text-[15px] font-bold text-white"
            >
              Import statement
            </Link>
          }
        />
      )}
      {sorted.length > 0 && (
        <ListGroup>
          {sorted.map((s) => {
            const count = counts.get(s.id);
            return (
              <ListRow
                key={s.id}
                to={`/bank/statements/${s.id}`}
                title={formatStatementPeriod(s.start_date, s.end_date)}
                subtitle={`Uploaded ${relativeTime(s.uploaded_at)}`}
                trailing={
                  count === undefined ? null : count > 0 ? (
                    <Chip tone="warn">{count} unmatched</Chip>
                  ) : (
                    <Chip tone="ok">done ✓</Chip>
                  )
                }
              />
            );
          })}
        </ListGroup>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/bank/StatementsScreen.test.tsx
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/bank
git commit -m "feat(web): bank statements list screen with unmatched badges"
```

---

### Task 5: Import flow screen (`/bank/import`)

**Files:**
- Create: `packages/web/src/bank/ImportScreen.tsx`
- Test: `packages/web/src/bank/ImportScreen.test.tsx`

**Interfaces:**
- Consumes: `importBankStatement(file, accountCode): Promise<{ jobId: number }>`, `useImportJob` (polls `getBankImportStatus`, statuses observed server-side: `running` | `done` | `failed`), `bankKeys` + `useQueryClient` (invalidate statements on done), `ScreenHeader`, `Field`/`TextInput`, `Button`, `ListGroup`.
- Produces: `ImportScreen(): JSX.Element` — file + account-code form → async job with a 3-step stepper (Upload → AI mapping & rules → Statement created), explicit failure state with the server's error and a re-upload CTA, success state linking to the created statement (ADR-0031: fresh inference per upload; format drift is not an event).
- Degradation note (binding): `BankImportJob` exposes only `status`/`error`/`statement_id` — no per-step progress. The stepper derives: `running` → step 1 done, step 2 active; `done` → all steps done; `failed` → step 2 failed.

- [ ] **Step 1: Write failing tests**

`src/bank/ImportScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  importBankStatement: vi.fn(),
  getBankImportStatus: vi.fn(),
  listBankStatements: vi.fn(),
  listBankTransactions: vi.fn(),
  getReconciliationStatus: vi.fn(),
  getStatementMatches: vi.fn(),
  proposeMatches: vi.fn(),
  getMatchCandidates: vi.fn(),
  executeMatches: vi.fn(),
  manualMatch: vi.fn(),
  unmatchMatch: vi.fn(),
  approveApproval: vi.fn(),
  getPendingApprovals: vi.fn(),
  createExpense: vi.fn(),
  postExpense: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getOrganization: vi.fn(),
}));

import * as api from '../api';
import { ImportScreen } from './ImportScreen';

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/bank/import', element: <ImportScreen /> },
      { path: '/bank', element: <p>bank list</p> },
      { path: '/bank/statements/:id', element: <p>statement screen</p> },
    ],
    { initialEntries: ['/bank/import'] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const pickFile = () => {
  const file = new File(['date;amount'], 'june.csv', { type: 'text/csv' });
  fireEvent.change(screen.getByLabelText('Statement file'), {
    target: { files: [file] },
  });
};

describe('ImportScreen', () => {
  beforeEach(() => vi.clearAllMocks());

  it('submits the file + account code and shows the done stepper with a statement link', async () => {
    vi.mocked(api.importBankStatement).mockResolvedValue({ jobId: 7 });
    // First (immediate) poll already returns done — no fake timers needed.
    vi.mocked(api.getBankImportStatus).mockResolvedValue({
      id: 7,
      status: 'done',
      account_code: 'BANK_EUR',
      statement_id: 5,
      error: null,
    });
    renderScreen();
    pickFile();
    fireEvent.click(screen.getByRole('button', { name: /import statement/i }));
    expect(await screen.findByText('Statement created')).toBeInTheDocument();
    const open = await screen.findByRole('link', { name: /open statement/i });
    expect(open).toHaveAttribute('href', '/bank/statements/5');
    expect(api.importBankStatement).toHaveBeenCalledWith(
      expect.any(File),
      'BANK_EUR',
    );
  });

  it('shows the explicit failure state with the server error and a try-again CTA', async () => {
    vi.mocked(api.importBankStatement).mockResolvedValue({ jobId: 8 });
    vi.mocked(api.getBankImportStatus).mockResolvedValue({
      id: 8,
      status: 'failed',
      account_code: 'BANK_EUR',
      statement_id: null,
      error: 'LLM mapping failed: unrecognizable columns',
    });
    renderScreen();
    pickFile();
    fireEvent.click(screen.getByRole('button', { name: /import statement/i }));
    expect(
      await screen.findByText('LLM mapping failed: unrecognizable columns'),
    ).toBeInTheDocument();
    // Try again returns to the upload form.
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByLabelText('Statement file')).toBeInTheDocument();
  });

  it('disables submit until a file is chosen', () => {
    renderScreen();
    expect(
      screen.getByRole('button', { name: /import statement/i }),
    ).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/bank/ImportScreen.test.tsx
```

Expected: FAIL — `./ImportScreen` not found.

- [ ] **Step 3: Implement**

`src/bank/ImportScreen.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { importBankStatement } from '../api';
import { bankKeys, useImportJob } from '../queries/bank';
import { Button } from '../ui/Button';
import { Field, TextInput } from '../ui/Form';
import { ScreenHeader } from '../shell/Headers';

type StepState = 'done' | 'active' | 'failed' | 'idle';

function Step({ state, label }: { state: StepState; label: string }) {
  const icon =
    state === 'done' ? '✓' : state === 'active' ? '…' : state === 'failed' ? '✕' : '·';
  const tone =
    state === 'done'
      ? 'bg-ok-bg text-ok'
      : state === 'active'
        ? 'bg-warn-bg text-warn'
        : state === 'failed'
          ? 'bg-err-bg text-err'
          : 'bg-line text-ink-2';
  return (
    <div className="flex items-center gap-3 border-b border-line px-3.5 py-3 last:border-b-0">
      <span
        aria-hidden
        className={`flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] text-[15px] font-bold ${tone}`}
      >
        {icon}
      </span>
      <span
        className={`text-[14.5px] font-semibold ${state === 'idle' ? 'text-ink-2' : ''}`}
      >
        {label}
      </span>
    </div>
  );
}

/** /bank/import — explicit async import flow (ADR-0031): upload → the server
 *  runs LLM column mapping + rules → statement created. Failure is a first-
 *  class state with the server's error and a re-upload CTA. */
export function ImportScreen() {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [accountCode, setAccountCode] = useState('BANK_EUR');
  const [jobId, setJobId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const jobQ = useImportJob(jobId);
  const job = jobQ.data;

  const onSubmit = async () => {
    if (!file) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { jobId: id } = await importBankStatement(file, accountCode);
      setJobId(id);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setJobId(null);
    setFile(null);
    setSubmitError(null);
  };

  // A finished import added a statement — refresh the list cache.
  const jobStatus = job?.status;
  useEffect(() => {
    if (jobStatus === 'done') {
      void qc.invalidateQueries({ queryKey: bankKeys.statements });
    }
  }, [jobStatus, qc]);

  const showForm = jobId === null;
  const mappingState: StepState =
    job === undefined
      ? 'active'
      : job.status === 'running'
        ? 'active'
        : job.status === 'failed'
          ? 'failed'
          : 'done';

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Import statement" backTo="/bank" />
      {showForm ? (
        <div className="mx-3.5 space-y-4 rounded-2xl bg-surface p-4">
          <Field
            label="Statement file"
            hint="CSV export from your bank — a fresh AI mapping runs on every upload."
          >
            <input
              type="file"
              aria-label="Statement file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm"
            />
          </Field>
          <Field label="Account code" hint="Ledger bank account, e.g. BANK_EUR">
            <TextInput
              value={accountCode}
              onChange={(e) => setAccountCode(e.target.value)}
            />
          </Field>
          {submitError != null && (
            <p className="text-[13px] font-semibold text-err">{submitError}</p>
          )}
          <Button
            className="h-[46px] w-full"
            disabled={file == null || accountCode.trim() === ''}
            busy={submitting}
            onClick={() => void onSubmit()}
          >
            Import statement
          </Button>
        </div>
      ) : (
        <>
          <div className="mx-3.5 overflow-hidden rounded-2xl bg-surface">
            <Step state="done" label="File uploaded" />
            <Step state={mappingState} label="AI mapping & rules" />
            <Step
              state={job?.status === 'done' ? 'done' : 'idle'}
              label="Statement created"
            />
          </div>
          {(job === undefined || job.status === 'running') && (
            <p className="px-6 pt-3 text-center text-[12.5px] text-ink-2">
              The AI infers the column mapping and rules run — this can take a
              minute. Leave this screen open.
            </p>
          )}
          {job?.status === 'failed' && (
            <div className="mx-3.5 mt-3 rounded-2xl bg-err-bg px-4 py-3.5">
              <p className="text-[13px] font-semibold text-err">
                {job.error ?? 'Import failed'}
              </p>
              <Button variant="secondary" className="mt-2" onClick={reset}>
                Try again
              </Button>
            </div>
          )}
          {job?.status === 'done' && job.statement_id !== null && (
            <div className="px-4 pt-4">
              <Link
                to={`/bank/statements/${job.statement_id}`}
                viewTransition
                className="block h-[46px] rounded-xl bg-accent text-center text-[14px] font-bold leading-[46px] text-white"
              >
                Open statement
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/bank/ImportScreen.test.tsx
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/bank
git commit -m "feat(web): bank import flow screen with status stepper and explicit failure"
```

---

### Task 6: Statement screen — line model, segments, sections, color coding

**Files:**
- Create: `packages/web/src/bank/statementModel.ts` (pure line/bucket model — testable without rendering)
- Create: `packages/web/src/bank/StatementScreen.tsx` (rendering; booking actions arrive in Task 7)
- Test: `packages/web/src/bank/statementModel.test.ts`, `packages/web/src/bank/StatementScreen.test.tsx`

**Interfaces:**
- Consumes: `useBankStatements`, `useBankTransactions`, `useReconciliation`, `useStatementMatches`, `useMatchProposals`, `invalidateStatement` (queries/bank); `deleteBankStatement`, `fmtCents`, types `BankTransaction`, `ReconciliationStatusRow`, `MatchRowView`, `MatchProposalView` (api); kit: `SegmentedControl`, `GroupLabel`, `ListRow`, `Chip`, `AmountText`, `EmptyState`, `SkeletonRows`, `ConfirmDialog`; `ScreenHeader`; `formatStatementPeriod`, `formatTxDate`, `txTitle`; `toastErr`, `toastOk`.
- Produces (from `statementModel.ts`):
  - `interface LineView { tx: BankTransaction; recon: ReconciliationStatusRow | undefined; active: MatchRowView[]; staged: MatchRowView[]; proposals: MatchProposalView[] }`
  - `buildLines(txns, recon, matches, proposals): LineView[]` (statement order preserved)
  - `type LineBucket = 'proposals' | 'decide' | 'done'`
  - `bucketOf(line: LineView): LineBucket` — disposition status or fully reconciled → `done`; has proposals or staged drafts → `proposals`; else `decide` (includes `partial`).
  - `proposalKey(p: MatchProposalView): string` — `"txId:voucherId"` (internal key, never displayed).
- Produces (from `StatementScreen.tsx`): `StatementScreen(): JSX.Element` — header = period title + err-toned "Delete" (ConfirmDialog → `deleteBankStatement` → back to `/bank`); `SegmentedControl` "Unmatched N | All M" persisted in `?seg=`; sections per bucket; matched rows get the green stripe + ✓ + dimmed text + object label subtitle; disposition rows get a muted chip (`personal`/`prepayment`/`bank fee`/`dividend`); every row navigates to the tx screen.

- [ ] **Step 1: Write failing model tests**

`src/bank/statementModel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type {
  BankTransaction,
  MatchProposalView,
  MatchRowView,
  ReconciliationStatusRow,
} from '../api';
import { bucketOf, buildLines } from './statementModel';

const tx = (over: Partial<BankTransaction>): BankTransaction => ({
  id: 1,
  transaction_date: '2026-06-27',
  description: 'WOLT 220627',
  amount: -1860,
  currency: 'EUR',
  counterparty_iban: null,
  counterparty_descriptor: null,
  reference: null,
  status: 'open',
  ...over,
});
const recon = (
  over: Partial<ReconciliationStatusRow>,
): ReconciliationStatusRow => ({
  bankTransactionId: 1,
  amountBase: 1860,
  matchedSum: 0,
  remaining: 1860,
  reconStatus: 'open',
  ...over,
});
const match = (over: Partial<MatchRowView>): MatchRowView => ({
  id: 41,
  bankTransactionId: 1,
  status: 'active',
  amountMatched: 1860,
  objectLabel: 'Expense #55',
  counterpartyName: null,
  ...over,
});
const proposal = (over: Partial<MatchProposalView>): MatchProposalView => ({
  bankTransactionId: 1,
  voucherId: 70,
  matchType: 'exact',
  amountMatched: 1860,
  confidence: 'high',
  signal: 'counterparty',
  objectType: 'expense',
  objectId: 55,
  objectLabel: 'Expense #55',
  counterpartyName: null,
  voucherRemaining: 1860,
  ...over,
});

describe('buildLines / bucketOf', () => {
  it('joins per-line data and preserves statement order', () => {
    const lines = buildLines(
      [tx({ id: 1 }), tx({ id: 2 })],
      [recon({ bankTransactionId: 2, reconStatus: 'matched' })],
      [match({ bankTransactionId: 2 })],
      [proposal({ bankTransactionId: 1 })],
    );
    expect(lines.map((l) => l.tx.id)).toEqual([1, 2]);
    expect(lines[0].proposals).toHaveLength(1);
    expect(lines[1].active).toHaveLength(1);
  });

  it('routes buckets: disposition and fully-matched are done', () => {
    expect(bucketOf(buildLines([tx({ status: 'personal' })], [], [], [])[0])).toBe('done');
    expect(
      bucketOf(
        buildLines([tx({})], [recon({ reconStatus: 'matched' })], [], [])[0],
      ),
    ).toBe('done');
  });

  it('routes buckets: proposals or staged drafts go to the proposals tier', () => {
    expect(bucketOf(buildLines([tx({})], [], [], [proposal({})])[0])).toBe(
      'proposals',
    );
    expect(
      bucketOf(buildLines([tx({})], [], [match({ status: 'draft' })], [])[0]),
    ).toBe('proposals');
  });

  it('routes buckets: open and partial lines are decide-yourself', () => {
    expect(bucketOf(buildLines([tx({})], [recon({})], [], [])[0])).toBe('decide');
    expect(
      bucketOf(
        buildLines(
          [tx({})],
          [recon({ reconStatus: 'partial', matchedSum: 860, remaining: 1000 })],
          [match({ amountMatched: 860 })],
          [],
        )[0],
      ),
    ).toBe('decide');
  });
});
```

- [ ] **Step 2: Write failing screen tests**

`src/bank/StatementScreen.test.tsx` (the api mock block is identical to Task 4's — same `vi.mock('../api', …)` factory listing all 18 functions; repeat it verbatim):

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  listBankStatements: vi.fn(),
  listBankTransactions: vi.fn(),
  getReconciliationStatus: vi.fn(),
  getStatementMatches: vi.fn(),
  proposeMatches: vi.fn(),
  getMatchCandidates: vi.fn(),
  getBankImportStatus: vi.fn(),
  executeMatches: vi.fn(),
  manualMatch: vi.fn(),
  unmatchMatch: vi.fn(),
  approveApproval: vi.fn(),
  getPendingApprovals: vi.fn(),
  createExpense: vi.fn(),
  postExpense: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getOrganization: vi.fn(),
  deleteBankStatement: vi.fn(),
  fmtCents: (cents: number) => (cents / 100).toFixed(2),
}));

import * as api from '../api';
import { StatementScreen } from './StatementScreen';

function renderAt(path = '/bank/statements/3') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/bank', element: <p>bank list</p> },
      { path: '/bank/statements/:id', element: <StatementScreen /> },
      { path: '/bank/statements/:id/tx/:txId', element: <p>tx screen</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const TXNS = [
  { id: 9, transaction_date: '2026-06-27', description: 'WOLT 220627', amount: -1860, currency: 'EUR', counterparty_iban: null, counterparty_descriptor: null, reference: null, status: 'open' },
  { id: 10, transaction_date: '2026-06-28', description: 'NORDIC CONSULT', amount: 120000, currency: 'EUR', counterparty_iban: null, counterparty_descriptor: null, reference: null, status: 'open' },
  { id: 11, transaction_date: '2026-06-24', description: 'ELISA arve 6/2026', amount: -3500, currency: 'EUR', counterparty_iban: null, counterparty_descriptor: null, reference: null, status: 'open' },
  { id: 12, transaction_date: '2026-06-20', description: 'OWNER LUNCH', amount: -900, currency: 'EUR', counterparty_iban: null, counterparty_descriptor: null, reference: null, status: 'personal' },
];

function mockStatementData() {
  vi.mocked(api.listBankStatements).mockResolvedValue([
    { id: 3, start_date: '2026-06-01', end_date: '2026-06-30', uploaded_at: 1 },
  ]);
  vi.mocked(api.listBankTransactions).mockResolvedValue(TXNS as never);
  vi.mocked(api.getReconciliationStatus).mockResolvedValue([
    { bankTransactionId: 9, amountBase: 1860, matchedSum: 0, remaining: 1860, reconStatus: 'open' },
    { bankTransactionId: 10, amountBase: 120000, matchedSum: 0, remaining: 120000, reconStatus: 'open' },
    { bankTransactionId: 11, amountBase: 3500, matchedSum: 3500, remaining: 0, reconStatus: 'matched' },
    { bankTransactionId: 12, amountBase: 900, matchedSum: 0, remaining: 900, reconStatus: 'open' },
  ]);
  vi.mocked(api.getStatementMatches).mockResolvedValue([
    { id: 41, bankTransactionId: 11, status: 'active', amountMatched: 3500, objectLabel: 'Expense #61', counterpartyName: 'Elisa Eesti AS' },
  ]);
  vi.mocked(api.proposeMatches).mockResolvedValue([
    { bankTransactionId: 10, voucherId: 71, matchType: 'exact', amountMatched: 120000, confidence: 'high', signal: 'invoice_number', objectType: 'sales_invoice', objectId: 18, objectLabel: 'Invoice 2026-018', counterpartyName: 'Nordic Consulting OÜ', voucherRemaining: 120000 },
  ]);
}

describe('StatementScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatementData();
  });

  it('shows the period title, segment counts, and the AI-proposals tier', async () => {
    renderAt();
    expect(await screen.findByText('Jun 2026')).toBeInTheDocument();
    expect(await screen.findByText('AI proposals')).toBeInTheDocument();
    expect(screen.getByText('Decide yourself')).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: 'Unmatched 2' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'All 4' })).toBeInTheDocument();
    // The proposal-backed line sits in the AI-proposals tier (Task 7 upgrades
    // its row to the selectable ProposalRow with object label + confidence).
    expect(screen.getByText('NORDIC CONSULT')).toBeInTheDocument();
    // Matched line is hidden in the default Unmatched segment.
    expect(screen.queryByText('ELISA arve 6/2026')).toBeNull();
  });

  it('shows matched (green ✓, object label) and disposition rows in the All segment', async () => {
    renderAt('/bank/statements/3?seg=all');
    expect(await screen.findByText('ELISA arve 6/2026')).toBeInTheDocument();
    expect(screen.getByText(/→ Expense #61/)).toBeInTheDocument();
    expect(screen.getByText('personal')).toBeInTheDocument();
    expect(screen.getByText('Matched')).toBeInTheDocument();
  });

  it('navigates to the tx screen when a decide row is clicked', async () => {
    const router = renderAt();
    fireEvent.click(await screen.findByText('WOLT 220627'));
    expect(router.state.location.pathname).toBe('/bank/statements/3/tx/9');
  });

  it('deletes the statement behind an explicit confirm and returns to /bank', async () => {
    vi.mocked(api.deleteBankStatement).mockResolvedValue({ deleted: 3 });
    const router = renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete statement' }),
    );
    await vi.waitFor(() =>
      expect(api.deleteBankStatement).toHaveBeenCalledWith(3),
    );
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe('/bank'),
    );
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run src/bank/statementModel.test.ts src/bank/StatementScreen.test.tsx
```

Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the model**

`src/bank/statementModel.ts`:

```ts
import type {
  BankTransaction,
  MatchProposalView,
  MatchRowView,
  ReconciliationStatusRow,
} from '../api';

/** Everything the statement screen knows about one bank line, joined. */
export interface LineView {
  tx: BankTransaction;
  recon: ReconciliationStatusRow | undefined;
  active: MatchRowView[];
  staged: MatchRowView[];
  proposals: MatchProposalView[];
}

/** Internal selection key for a proposal — voucherId is NEVER displayed. */
export const proposalKey = (p: MatchProposalView): string =>
  `${p.bankTransactionId}:${p.voucherId}`;

export function buildLines(
  txns: BankTransaction[],
  recon: ReconciliationStatusRow[],
  matches: MatchRowView[],
  proposals: MatchProposalView[],
): LineView[] {
  const reconByTx = new Map(recon.map((r) => [r.bankTransactionId, r]));
  return txns.map((tx) => ({
    tx,
    recon: reconByTx.get(tx.id),
    active: matches.filter(
      (m) => m.bankTransactionId === tx.id && m.status === 'active',
    ),
    staged: matches.filter(
      (m) => m.bankTransactionId === tx.id && m.status === 'draft',
    ),
    proposals: proposals.filter((p) => p.bankTransactionId === tx.id),
  }));
}

/**
 * Statement-screen tiers (from the §6 mockup): AI proposals (incl. drafts the
 * import auto-staged) / decide yourself / done (matched or disposed).
 * A partially matched line stays in "decide" — its remainder is visible work.
 */
export type LineBucket = 'proposals' | 'decide' | 'done';

export function bucketOf(line: LineView): LineBucket {
  if (line.tx.status !== 'open') return 'done';
  if (line.recon?.reconStatus === 'matched') return 'done';
  if (line.proposals.length > 0 || line.staged.length > 0) return 'proposals';
  return 'decide';
}
```

- [ ] **Step 5: Implement the screen**

`src/bank/StatementScreen.tsx` (Task 7 adds selection + booking; this task renders with an empty selection and no Book bar):

```tsx
import { useMemo, useState } from 'react';
import {
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { deleteBankStatement, fmtCents } from '../api';
import {
  bankKeys,
  useBankStatements,
  useBankTransactions,
  useMatchProposals,
  useReconciliation,
  useStatementMatches,
} from '../queries/bank';
import { AmountText } from '../ui/AmountText';
import { Chip } from '../ui/Chip';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { GroupLabel } from '../ui/List';
import { SegmentedControl } from '../ui/SegmentedControl';
import { toastErr } from '../ui/toast';
import { ScreenHeader } from '../shell/Headers';
import { formatStatementPeriod, formatTxDate, txTitle } from './format';
import { LoadError } from './LoadError';
import { bucketOf, buildLines, type LineView } from './statementModel';

const DISPOSITION_LABEL: Record<string, string> = {
  personal: 'personal',
  prepayment: 'prepayment',
  bank_fee: 'bank fee',
  dividend: 'dividend',
};

/** Line amount + date, right-aligned, never wrapping. */
function LineTrailing({ line, muted }: { line: LineView; muted?: boolean }) {
  return (
    <div className="flex-none text-right">
      <AmountText
        cents={line.tx.amount}
        currency={line.tx.currency}
        showSign={!muted}
        className={`block text-[14px] ${muted ? 'text-ink-2' : ''}`}
      />
      <div className="text-[12px] text-ink-2">
        {formatTxDate(line.tx.transaction_date)}
      </div>
    </div>
  );
}

/** "Decide yourself" row — plain navigation row. */
function DecideRow({ line, onOpen }: { line: LineView; onOpen: () => void }) {
  const partial = line.recon?.reconStatus === 'partial';
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 border-b border-line px-3.5 py-3 text-left last:border-b-0"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-semibold">
          {txTitle(line.tx)}
        </div>
        <div className="truncate text-[12.5px] text-ink-2">
          {partial
            ? `Partially matched · ${fmtCents(line.recon?.remaining ?? 0)} € left`
            : 'No candidates — decide'}
        </div>
      </div>
      <LineTrailing line={line} />
      <span aria-hidden className="flex-none text-base text-[#C2C7C1]">
        ›
      </span>
    </button>
  );
}

/** Done row — matched (green stripe + ✓ + dimmed) or a disposition chip. */
function DoneRow({ line, onOpen }: { line: LineView; onOpen: () => void }) {
  const disposed = line.tx.status !== 'open';
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full items-center gap-3 border-b border-line px-3.5 py-3 text-left last:border-b-0 ${
        disposed
          ? ''
          : 'bg-[#F5FAF6] shadow-[inset_3px_0_0_theme(colors.ok.DEFAULT)]'
      }`}
    >
      {!disposed && (
        <span
          aria-hidden
          className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] bg-ok-bg font-extrabold text-ok"
        >
          ✓
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-semibold text-ink-2">
          {txTitle(line.tx)}
        </div>
        {disposed ? (
          <div className="mt-0.5">
            <Chip>{DISPOSITION_LABEL[line.tx.status] ?? line.tx.status}</Chip>
          </div>
        ) : (
          <div className="truncate text-[12.5px] text-ink-2">
            → {line.active.map((m) => m.objectLabel).join(' · ')}
          </div>
        )}
      </div>
      <LineTrailing line={line} muted />
    </button>
  );
}

export function StatementScreen() {
  const params = useParams();
  const statementId = Number(params.id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const seg = searchParams.get('seg') === 'all' ? 'all' : 'unmatched';

  const statementsQ = useBankStatements();
  const txQ = useBankTransactions(statementId);
  const reconQ = useReconciliation(statementId);
  const matchesQ = useStatementMatches(statementId);
  const proposalsQ = useMatchProposals(statementId);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const statement = statementsQ.data?.find((s) => s.id === statementId);
  const lines = useMemo(
    () =>
      buildLines(
        txQ.data ?? [],
        reconQ.data ?? [],
        matchesQ.data ?? [],
        proposalsQ.data ?? [],
      ),
    [txQ.data, reconQ.data, matchesQ.data, proposalsQ.data],
  );
  const loading = txQ.isPending || reconQ.isPending || matchesQ.isPending;

  const proposalLines = lines.filter((l) => bucketOf(l) === 'proposals');
  const decideLines = lines.filter((l) => bucketOf(l) === 'decide');
  const doneLines = lines.filter((l) => bucketOf(l) === 'done');
  const unmatchedCount = proposalLines.length + decideLines.length;

  const openTx = (txId: number) =>
    navigate(`/bank/statements/${statementId}/tx/${txId}`);

  const onDelete = async () => {
    setDeleting(true);
    try {
      await deleteBankStatement(statementId);
      await qc.invalidateQueries({ queryKey: bankKeys.statements });
      navigate('/bank');
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl pb-28">
      <ScreenHeader
        title={
          statement
            ? formatStatementPeriod(statement.start_date, statement.end_date)
            : 'Statement'
        }
        backTo="/bank"
        trailing={
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            className="text-[13px] font-semibold text-err"
          >
            Delete
          </button>
        }
      />
      <div className="px-4 pb-3">
        <SegmentedControl
          options={[
            { value: 'unmatched', label: `Unmatched ${unmatchedCount}` },
            { value: 'all', label: `All ${lines.length}` },
          ]}
          value={seg}
          onChange={(v) =>
            setSearchParams(v === 'all' ? { seg: 'all' } : {}, {
              replace: true,
            })
          }
        />
      </div>

      {loading && <SkeletonRows count={5} />}
      {txQ.isError && (
        <LoadError
          message={
            txQ.error instanceof Error
              ? txQ.error.message
              : 'Failed to load transactions'
          }
          onRetry={() => void txQ.refetch()}
        />
      )}

      {!loading && !txQ.isError && (
        <>
          {proposalLines.length > 0 && (
            <>
              <GroupLabel>AI proposals</GroupLabel>
              <div className="mx-3.5 mb-3.5 overflow-hidden rounded-2xl bg-surface">
                {proposalLines.map((line) => (
                  // Task 7 replaces this row with the selectable ProposalRow.
                  <DecideRow
                    key={line.tx.id}
                    line={line}
                    onOpen={() => openTx(line.tx.id)}
                  />
                ))}
              </div>
            </>
          )}
          {decideLines.length > 0 && (
            <>
              <GroupLabel>Decide yourself</GroupLabel>
              <div className="mx-3.5 mb-3.5 overflow-hidden rounded-2xl bg-surface">
                {decideLines.map((line) => (
                  <DecideRow
                    key={line.tx.id}
                    line={line}
                    onOpen={() => openTx(line.tx.id)}
                  />
                ))}
              </div>
            </>
          )}
          {unmatchedCount === 0 && (
            <EmptyState
              icon="✓"
              title="All lines reconciled"
              hint="Switch to All to review matched lines."
            />
          )}
          {seg === 'all' && doneLines.length > 0 && (
            <>
              <GroupLabel>Matched</GroupLabel>
              <div className="mx-3.5 mb-3.5 overflow-hidden rounded-2xl bg-surface">
                {doneLines.map((line) => (
                  <DoneRow
                    key={line.tx.id}
                    line={line}
                    onOpen={() => openTx(line.tx.id)}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete statement?"
        body={`Deletes the statement and its ${lines.length} transactions. This cannot be undone.`}
        confirmLabel="Delete statement"
        destructive
        busy={deleting}
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}
```

Note: the "Task 7 replaces this row" comment marks the ONE intentional intermediate state in this plan — the proposals tier renders as plain rows until Task 7 adds selection. The section itself, buckets, color coding and delete are final here.

- [ ] **Step 6: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/bank/statementModel.test.ts src/bank/StatementScreen.test.tsx && npm test
```

Expected: PASS (model 4, screen 4); full suite PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/bank
git commit -m "feat(web): statement screen — segments, tiers, color-coded lines, guarded delete"
```

---

### Task 7: Statement screen — proposal selection, bulk Book, staged confirm, Undo

**Files:**
- Modify: `packages/web/src/bank/StatementScreen.tsx`
- Test: extend `packages/web/src/bank/StatementScreen.test.tsx`

**Interfaces:**
- Consumes: `bookProposals`, `confirmStagedMatch`, `undoMatches`, `invalidateStatement` (queries/bank), `proposalKey` (statementModel), `toastUndo`/`toastOk`/`toastErr`, `Button`, `AppToaster` (in tests).
- Produces (inside `StatementScreen.tsx`):
  - `ProposalRow({ line, selectedKeys, onToggle, onOpen, onConfirmStaged, confirmingId })` — checkbox (22px visual, whole left zone tappable, `role="checkbox"` + `aria-checked`) per proposal; high-confidence proposals pre-selected on load; staged drafts render with a `staged` chip and a per-row "Confirm" button.
  - Sticky Book bar (`bg-accent-deep`, h 46, rounded-[13px]): label `Book N matches` + net amount of the selected lines; on click → `bookProposals` → invalidate → `toastUndo('Booked N matches', undo)`; server 409 (cap, enforced at activation) → `toastErr(serverMessage)` + invalidate (partially activated bookings become visible as staged/active — nothing is hidden).

- [ ] **Step 1: Extend the tests** (append to `src/bank/StatementScreen.test.tsx`; also add `AppToaster` to the render tree: change `renderAt` to render `<><RouterProvider router={router} /><AppToaster /></>` inside the provider, and import `AppToaster` from `../ui/toast`)

```tsx
describe('StatementScreen booking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatementData();
  });

  it('pre-selects high-confidence proposals and books them with an Undo toast', async () => {
    vi.mocked(api.executeMatches).mockResolvedValue({
      records: [{ id: 91 }],
      approvals: [{ id: 12, matchId: 91 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: { id: 12 },
    } as never);
    renderAt();
    // The single high-confidence proposal arrives pre-selected, with the
    // object label + confidence chip in the subtitle.
    const box = await screen.findByRole('checkbox', {
      name: /select match invoice 2026-018/i,
    });
    expect(box).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Invoice 2026-018/)).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
    const bookBtn = screen.getByRole('button', { name: /book 1 match/i });
    fireEvent.click(bookBtn);
    await vi.waitFor(() => expect(api.executeMatches).toHaveBeenCalledOnce());
    expect(api.approveApproval).toHaveBeenCalledWith(12, 'operator');
    expect(await screen.findByText('Booked 1 match')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Undo' }),
    ).toBeInTheDocument();
  });

  it('undo unmatches the booked matches', async () => {
    vi.mocked(api.executeMatches).mockResolvedValue({
      records: [{ id: 91 }],
      approvals: [{ id: 12, matchId: 91 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: { id: 12 },
    } as never);
    vi.mocked(api.unmatchMatch).mockResolvedValue({});
    renderAt();
    await screen.findByRole('checkbox', {
      name: /select match invoice 2026-018/i,
    });
    fireEvent.click(screen.getByRole('button', { name: /book 1 match/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await vi.waitFor(() =>
      expect(api.unmatchMatch).toHaveBeenCalledWith(3, 91),
    );
  });

  it('deselecting the proposal hides the Book bar', async () => {
    renderAt();
    const box = await screen.findByRole('checkbox', {
      name: /select match invoice 2026-018/i,
    });
    fireEvent.click(box);
    expect(box).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('button', { name: /book/i })).toBeNull();
  });

  it('surfaces the server cap error text on booking failure', async () => {
    vi.mocked(api.executeMatches).mockRejectedValue(
      new Error('Match of 1200 would over-allocate bank line 10'),
    );
    renderAt();
    await screen.findByRole('checkbox', {
      name: /select match invoice 2026-018/i,
    });
    fireEvent.click(screen.getByRole('button', { name: /book 1 match/i }));
    expect(
      await screen.findByText(/would over-allocate bank line 10/),
    ).toBeInTheDocument();
  });

  it('renders a staged draft with a Confirm action that approves its approval', async () => {
    vi.mocked(api.getStatementMatches).mockResolvedValue([
      { id: 41, bankTransactionId: 11, status: 'active', amountMatched: 3500, objectLabel: 'Expense #61', counterpartyName: 'Elisa Eesti AS' },
      { id: 50, bankTransactionId: 9, status: 'draft', amountMatched: 1860, objectLabel: 'Expense #70', counterpartyName: null },
    ]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      { id: 88, object_type: 'reconciliation_match', object_id: 50, status: 'pending', requested_by: 'system', approved_by: null, rejected_reason: null, policy_reason: null, superseded_by: null, created_at: 0, resolved_at: null },
    ]);
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: { id: 88 },
    } as never);
    renderAt();
    expect(await screen.findByText('staged')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));
    await vi.waitFor(() =>
      expect(api.approveApproval).toHaveBeenCalledWith(88, 'operator'),
    );
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
npx vitest run src/bank/StatementScreen.test.tsx
```

Expected: FAIL — no checkbox role, no Book button (Task 6 renders proposals as plain rows).

- [ ] **Step 3: Implement in `src/bank/StatementScreen.tsx`**

Add imports:

```tsx
import { useEffect } from 'react'; // merge into the existing react import
import {
  bookProposals,
  confirmStagedMatch,
  invalidateStatement,
  undoMatches,
} from '../queries/bank'; // merge into the existing ../queries/bank import
import { Button } from '../ui/Button';
import { toastUndo } from '../ui/toast'; // merge with toastErr
import { proposalKey } from './statementModel'; // merge with bucketOf/buildLines
import type { MatchProposalView, MatchRowView } from '../api'; // merge
```

Add the `ProposalRow` component (below `DecideRow`):

```tsx
function ProposalRow({
  line,
  selected,
  onToggle,
  onOpen,
  onConfirmStaged,
  confirmBusy,
}: {
  line: LineView;
  selected: Set<string>;
  onToggle: (p: MatchProposalView) => void;
  onOpen: () => void;
  onConfirmStaged: (m: MatchRowView) => void;
  confirmBusy: boolean;
}) {
  return (
    <div className="border-b border-line last:border-b-0">
      {line.proposals.map((p) => {
        const key = proposalKey(p);
        const on = selected.has(key);
        return (
          <div key={key} className="flex w-full items-center gap-3 px-3.5 py-3">
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={`Select match ${p.objectLabel}`}
              onClick={() => onToggle(p)}
              className={`flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[7px] border-2 text-[13px] font-bold ${
                on
                  ? 'border-accent bg-accent text-white'
                  : 'border-[#C2C7C1] text-transparent'
              }`}
            >
              ✓
            </button>
            <button
              type="button"
              onClick={onOpen}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14.5px] font-semibold">
                  {txTitle(line.tx)}
                </div>
                <div className="truncate text-[12.5px] text-ink-2">
                  → {p.objectLabel} <Chip tone="warn">{p.confidence}</Chip>
                </div>
              </div>
              <LineTrailing line={line} />
            </button>
          </div>
        );
      })}
      {line.staged.map((m) => (
        <div key={m.id} className="flex w-full items-center gap-3 px-3.5 py-3">
          <button
            type="button"
            onClick={onOpen}
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14.5px] font-semibold">
                {txTitle(line.tx)}
              </div>
              <div className="truncate text-[12.5px] text-ink-2">
                → {m.objectLabel} <Chip tone="warn">staged</Chip>
              </div>
            </div>
            <LineTrailing line={line} />
          </button>
          <Button
            variant="secondary"
            className="flex-none px-3 py-1.5 text-[12px]"
            busy={confirmBusy}
            onClick={() => onConfirmStaged(m)}
          >
            Confirm
          </Button>
        </div>
      ))}
    </div>
  );
}
```

Inside `StatementScreen`, add state + handlers (after the `deleting` state):

```tsx
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [booking, setBooking] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);

  // Pre-select high-confidence proposals whenever a fresh proposal set lands.
  useEffect(() => {
    if (proposalsQ.data) {
      setSelected(
        new Set(
          proposalsQ.data
            .filter((p) => p.confidence === 'high')
            .map(proposalKey),
        ),
      );
    }
  }, [proposalsQ.data]);

  const toggleProposal = (p: MatchProposalView) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const key = proposalKey(p);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const chosen = (proposalsQ.data ?? []).filter((p) =>
    selected.has(proposalKey(p)),
  );
  const txById = new Map(lines.map((l) => [l.tx.id, l.tx]));
  const netCents = chosen.reduce((sum, p) => {
    const tx = txById.get(p.bankTransactionId);
    return sum + (tx && tx.amount < 0 ? -p.amountMatched : p.amountMatched);
  }, 0);

  const onBook = async () => {
    setBooking(true);
    try {
      const matchIds = await bookProposals(statementId, chosen);
      await invalidateStatement(qc, statementId);
      const label = `Booked ${matchIds.length} ${matchIds.length === 1 ? 'match' : 'matches'}`;
      toastUndo(label, () => {
        void undoMatches(statementId, matchIds)
          .then(() => invalidateStatement(qc, statementId))
          .catch((e) =>
            toastErr(e instanceof Error ? e.message : String(e)),
          );
      });
    } catch (e) {
      // Server-enforced cap / over-match — show the server's words, then
      // refresh so partially staged/active state is visible, never hidden.
      toastErr(e instanceof Error ? e.message : String(e));
      await invalidateStatement(qc, statementId);
    } finally {
      setBooking(false);
    }
  };

  const onConfirmStaged = async (m: MatchRowView) => {
    setConfirmBusy(true);
    try {
      await confirmStagedMatch(m.id);
      await invalidateStatement(qc, statementId);
      toastUndo(`Confirmed · ${m.objectLabel}`, () => {
        void undoMatches(statementId, [m.id])
          .then(() => invalidateStatement(qc, statementId))
          .catch((e) =>
            toastErr(e instanceof Error ? e.message : String(e)),
          );
      });
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setConfirmBusy(false);
    }
  };
```

Replace the proposals-tier block from Task 6 (the `DecideRow` placeholder inside the "AI proposals" group) with:

```tsx
          {proposalLines.length > 0 && (
            <>
              <GroupLabel>AI proposals</GroupLabel>
              <div className="mx-3.5 mb-3.5 overflow-hidden rounded-2xl bg-surface">
                {proposalLines.map((line) => (
                  <ProposalRow
                    key={line.tx.id}
                    line={line}
                    selected={selected}
                    onToggle={toggleProposal}
                    onOpen={() => openTx(line.tx.id)}
                    onConfirmStaged={(m) => void onConfirmStaged(m)}
                    confirmBusy={confirmBusy}
                  />
                ))}
              </div>
              {chosen.length > 0 && (
                <div className="mx-3.5 mb-3.5">
                  <button
                    type="button"
                    disabled={booking}
                    onClick={() => void onBook()}
                    className="flex h-[46px] w-full items-center justify-between rounded-[13px] bg-accent-deep px-4 text-[13.5px] font-bold text-white disabled:opacity-60"
                  >
                    <span>
                      Book {chosen.length}{' '}
                      {chosen.length === 1 ? 'match' : 'matches'}
                    </span>
                    <span className="text-[10.5px] font-medium opacity-70">
                      {netCents > 0 ? '+' : ''}
                      {fmtCents(netCents)} € net
                    </span>
                  </button>
                </div>
              )}
            </>
          )}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/bank/StatementScreen.test.tsx && npm test
```

Expected: PASS (9 tests in the file); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/bank
git commit -m "feat(web): statement screen — proposal selection, bulk book with approve-on-the-spot, undo"
```

---

### Task 8: Tx state routing + matched state (G)

**Files:**
- Create: `packages/web/src/bank/txState.ts`
- Create: `packages/web/src/bank/TxMatched.tsx`
- Test: `packages/web/src/bank/txState.test.ts`, `packages/web/src/bank/TxMatched.test.tsx`

**Interfaces:**
- Consumes: types `BankTransaction`, `MatchRowView`, `MatchCandidatesResult`, `ReconciliationStatusRow` (api); `undoMatches`, `confirmStagedMatch` (queries/bank); kit `Button`, `Chip`, `GroupLabel`, `KeyValue`; `toastOk`, `toastErr`, `toastUndo`; `fmtCents`.
- Produces:
  - `type TxState = { kind: 'loading' } | { kind: 'disposed'; status: string } | { kind: 'matched'; active: MatchRowView[]; staged: MatchRowView[] } | { kind: 'candidates'; result: MatchCandidatesResult } | { kind: 'incoming-open' } | { kind: 'create' }`
  - `routeTxState({ tx, matches, candidates }): TxState` — the state routing matrix, first match wins: disposition status → `disposed`; any match rows → `matched` (G; staged drafts get a Confirm primary); candidates present → `candidates` (C); incoming → `incoming-open` (prepayment emphasis); else `create` (A/B).
  - `TxMatched({ statementId, tx, active, staged, recon, onChanged }): JSX.Element` — "Matched with" rows, coverage KV from the recon row, Unmatch (secondary, removes ALL this line's matches, `toastOk`), Confirm match (primary when staged drafts exist → `confirmStagedMatch` each + `toastUndo`).

- [ ] **Step 1: Write failing tests**

`src/bank/txState.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { BankTransaction, MatchRowView } from '../api';
import { routeTxState } from './txState';

const tx = (over: Partial<BankTransaction>): BankTransaction => ({
  id: 9,
  transaction_date: '2026-06-27',
  description: 'WOLT 220627',
  amount: -1860,
  currency: 'EUR',
  counterparty_iban: null,
  counterparty_descriptor: null,
  reference: null,
  status: 'open',
  ...over,
});
const match = (over: Partial<MatchRowView>): MatchRowView => ({
  id: 41,
  bankTransactionId: 9,
  status: 'active',
  amountMatched: 1860,
  objectLabel: 'Expense #55',
  counterpartyName: null,
  ...over,
});
const CANDS = {
  bankTransactionId: 9,
  lineRemaining: 1860,
  candidates: [
    {
      voucherId: 70,
      objectType: 'expense' as const,
      objectId: 55,
      objectLabel: 'Expense #55',
      counterpartyName: null,
      voucherRemaining: 1860,
    },
  ],
};

describe('routeTxState (first match wins)', () => {
  it('loading until tx and matches are known', () => {
    expect(routeTxState({ tx: undefined, matches: undefined, candidates: undefined }).kind).toBe('loading');
    expect(routeTxState({ tx: tx({}), matches: undefined, candidates: undefined }).kind).toBe('loading');
  });

  it('disposed for non-open statuses', () => {
    expect(
      routeTxState({ tx: tx({ status: 'personal' }), matches: [], candidates: undefined }),
    ).toEqual({ kind: 'disposed', status: 'personal' });
  });

  it('matched when any match rows exist, split active/staged', () => {
    const s = routeTxState({
      tx: tx({}),
      matches: [match({}), match({ id: 42, status: 'draft' })],
      candidates: undefined,
    });
    expect(s.kind).toBe('matched');
    if (s.kind === 'matched') {
      expect(s.active).toHaveLength(1);
      expect(s.staged).toHaveLength(1);
    }
  });

  it('waits for candidates before deciding the open-line states', () => {
    expect(
      routeTxState({ tx: tx({}), matches: [], candidates: undefined }).kind,
    ).toBe('loading');
  });

  it('candidates when the server found any', () => {
    const s = routeTxState({ tx: tx({}), matches: [], candidates: CANDS });
    expect(s.kind).toBe('candidates');
  });

  it('incoming-open for an incoming line without candidates', () => {
    expect(
      routeTxState({
        tx: tx({ amount: 50000 }),
        matches: [],
        candidates: { ...CANDS, candidates: [] },
      }).kind,
    ).toBe('incoming-open');
  });

  it('create for an outgoing line without candidates', () => {
    expect(
      routeTxState({
        tx: tx({}),
        matches: [],
        candidates: { ...CANDS, candidates: [] },
      }).kind,
    ).toBe('create');
  });

  it('ignores other lines’ matches', () => {
    expect(
      routeTxState({
        tx: tx({}),
        matches: [match({ bankTransactionId: 999 })],
        candidates: { ...CANDS, candidates: [] },
      }).kind,
    ).toBe('create');
  });
});
```

`src/bank/TxMatched.test.tsx` (api mock block identical to Task 4's factory — repeat verbatim, plus `fmtCents`):

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  listBankStatements: vi.fn(),
  listBankTransactions: vi.fn(),
  getReconciliationStatus: vi.fn(),
  getStatementMatches: vi.fn(),
  proposeMatches: vi.fn(),
  getMatchCandidates: vi.fn(),
  getBankImportStatus: vi.fn(),
  executeMatches: vi.fn(),
  manualMatch: vi.fn(),
  unmatchMatch: vi.fn(),
  approveApproval: vi.fn(),
  getPendingApprovals: vi.fn(),
  createExpense: vi.fn(),
  postExpense: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getOrganization: vi.fn(),
  fmtCents: (cents: number) => (cents / 100).toFixed(2),
}));

import * as api from '../api';
import { AppToaster } from '../ui/toast';
import { TxMatched } from './TxMatched';

const TX = {
  id: 9,
  transaction_date: '2026-06-24',
  description: 'ELISA arve 6/2026',
  amount: -3500,
  currency: 'EUR',
  counterparty_iban: null,
  counterparty_descriptor: null,
  reference: null,
  status: 'open',
} as const;
const RECON = {
  bankTransactionId: 9,
  amountBase: 3500,
  matchedSum: 3500,
  remaining: 0,
  reconStatus: 'matched',
} as const;
const ACTIVE = {
  id: 41,
  bankTransactionId: 9,
  status: 'active',
  amountMatched: 3500,
  objectLabel: 'Expense #61',
  counterpartyName: 'Elisa Eesti AS',
} as const;

describe('TxMatched', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the match card with coverage and unmatches on demand', async () => {
    vi.mocked(api.unmatchMatch).mockResolvedValue({});
    const onChanged = vi.fn();
    render(
      <>
        <TxMatched
          statementId={3}
          tx={TX as never}
          active={[ACTIVE as never]}
          staged={[]}
          recon={RECON as never}
          onChanged={onChanged}
        />
        <AppToaster />
      </>,
    );
    expect(screen.getByText('Matched with')).toBeInTheDocument();
    expect(screen.getByText('Expense #61')).toBeInTheDocument();
    expect(screen.getByText('full · 35.00 of 35.00 €')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unmatch' }));
    await vi.waitFor(() =>
      expect(api.unmatchMatch).toHaveBeenCalledWith(3, 41),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it('offers Confirm match as primary for staged drafts', async () => {
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      { id: 88, object_type: 'reconciliation_match', object_id: 50, status: 'pending', requested_by: 'system', approved_by: null, rejected_reason: null, policy_reason: null, superseded_by: null, created_at: 0, resolved_at: null },
    ]);
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: { id: 88 },
    } as never);
    const onChanged = vi.fn();
    render(
      <>
        <TxMatched
          statementId={3}
          tx={TX as never}
          active={[]}
          staged={[{ ...ACTIVE, id: 50, status: 'draft' } as never]}
          recon={{ ...RECON, matchedSum: 0, remaining: 3500, reconStatus: 'open' } as never}
          onChanged={onChanged}
        />
        <AppToaster />
      </>,
    );
    expect(screen.getByText('staged')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm match' }));
    await vi.waitFor(() =>
      expect(api.approveApproval).toHaveBeenCalledWith(88, 'operator'),
    );
    expect(onChanged).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/bank/txState.test.ts src/bank/TxMatched.test.tsx
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/bank/txState.ts`:

```ts
import type {
  BankTransaction,
  MatchCandidatesResult,
  MatchRowView,
} from '../api';

/**
 * The tx-screen state machine (asset: 2026-07-09-tx-screen-states.html).
 * First match wins; alternatives stay reachable via the "Or" sheet.
 * Degradations vs the asset's 8-context matrix (documented in the appendix):
 * state D (recurring) is omitted (no detection API); A and B merge into one
 * `create` state (no alias-lookup API — the supplier picker covers both);
 * the fee heuristic has no server signal (fee lives in the "Or" sheet).
 */
export type TxState =
  | { kind: 'loading' }
  | { kind: 'disposed'; status: string }
  | { kind: 'matched'; active: MatchRowView[]; staged: MatchRowView[] }
  | { kind: 'candidates'; result: MatchCandidatesResult }
  | { kind: 'incoming-open' }
  | { kind: 'create' };

export function routeTxState(args: {
  tx: BankTransaction | undefined;
  matches: MatchRowView[] | undefined;
  candidates: MatchCandidatesResult | undefined;
}): TxState {
  const { tx, matches, candidates } = args;
  if (!tx || matches === undefined) return { kind: 'loading' };
  if (tx.status !== 'open') return { kind: 'disposed', status: tx.status };
  const mine = matches.filter((m) => m.bankTransactionId === tx.id);
  if (mine.length > 0) {
    return {
      kind: 'matched',
      active: mine.filter((m) => m.status === 'active'),
      staged: mine.filter((m) => m.status === 'draft'),
    };
  }
  if (candidates === undefined) return { kind: 'loading' };
  if (candidates.candidates.length > 0)
    return { kind: 'candidates', result: candidates };
  if (tx.amount > 0) return { kind: 'incoming-open' };
  return { kind: 'create' };
}
```

`src/bank/TxMatched.tsx`:

```tsx
import { useState } from 'react';
import {
  fmtCents,
  type BankTransaction,
  type MatchRowView,
  type ReconciliationStatusRow,
} from '../api';
import { confirmStagedMatch, undoMatches } from '../queries/bank';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { GroupLabel, KeyValue } from '../ui/List';
import { toastErr, toastOk, toastUndo } from '../ui/toast';

/**
 * State G — the line is matched (or staged by the import's auto-proposer).
 * Facts card: what it is matched with + coverage. Unmatch is a visible
 * secondary action (ledger-neutral server-side); staged drafts get a
 * Confirm primary. Match provenance (when/by whom) is not exposed by the
 * API — deliberately omitted rather than invented.
 */
export function TxMatched({
  statementId,
  tx,
  active,
  staged,
  recon,
  onChanged,
}: {
  statementId: number;
  tx: BankTransaction;
  active: MatchRowView[];
  staged: MatchRowView[];
  recon: ReconciliationStatusRow | undefined;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const all = [...active, ...staged];

  const coverage =
    recon === undefined
      ? null
      : recon.remaining <= 0
        ? `full · ${fmtCents(recon.matchedSum)} of ${fmtCents(recon.amountBase)} €`
        : `partial · ${fmtCents(recon.matchedSum)} of ${fmtCents(recon.amountBase)} €`;

  const onUnmatch = async () => {
    setBusy(true);
    try {
      await undoMatches(statementId, all.map((m) => m.id));
      toastOk('Match removed — the line is unmatched again');
      onChanged();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onConfirm = async () => {
    setBusy(true);
    try {
      for (const m of staged) {
        await confirmStagedMatch(m.id);
      }
      toastUndo(`Confirmed · ${fmtCents(Math.abs(tx.amount))} €`, () => {
        void undoMatches(statementId, staged.map((m) => m.id))
          .then(onChanged)
          .catch((e) => toastErr(e instanceof Error ? e.message : String(e)));
      });
      onChanged();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <GroupLabel>Matched with</GroupLabel>
      <div className="mx-3.5 mb-3 overflow-hidden rounded-2xl bg-surface">
        {all.map((m) => (
          <div
            key={m.id}
            className="flex items-center gap-3 border-b border-line px-3.5 py-3 last:border-b-0"
          >
            <span
              aria-hidden
              className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] bg-ok-bg text-[15px]"
            >
              🧾
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14.5px] font-semibold">
                {m.objectLabel}
              </div>
              <div className="truncate text-[12.5px] text-ink-2">
                {m.counterpartyName ?? '—'}{' '}
                {m.status === 'draft' && <Chip tone="warn">staged</Chip>}
              </div>
            </div>
            <div className="flex-none text-right text-[14px] font-bold tabular-nums">
              {fmtCents(m.amountMatched)} €
            </div>
          </div>
        ))}
      </div>
      {coverage != null && (
        <>
          <GroupLabel>Match details</GroupLabel>
          <div className="mx-3.5 mb-3 overflow-hidden rounded-2xl bg-surface">
            <KeyValue k="Coverage" v={coverage} />
          </div>
        </>
      )}
      <div className="sticky bottom-0 flex gap-2.5 bg-gradient-to-t from-bg via-bg/95 to-transparent px-4 pb-3.5 pt-3">
        {staged.length > 0 && (
          <Button className="h-[46px] flex-1" busy={busy} onClick={() => void onConfirm()}>
            Confirm match
          </Button>
        )}
        <Button
          variant="secondary"
          className="h-[46px] flex-1"
          busy={busy}
          onClick={() => void onUnmatch()}
        >
          Unmatch
        </Button>
      </div>
      <p className="px-6 pb-2 text-center text-[10.5px] leading-[1.4] text-[#8A9089]">
        Unmatch returns the line to unmatched · the booked object is untouched
      </p>
    </>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/bank/txState.test.ts src/bank/TxMatched.test.tsx
```

Expected: PASS (8 + 2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/bank
git commit -m "feat(web): tx state routing + matched state with unmatch/confirm"
```

---

### Task 9: Tx candidates state (C) — N:M with live remainder

**Files:**
- Create: `packages/web/src/bank/TxCandidates.tsx`
- Test: `packages/web/src/bank/TxCandidates.test.tsx`

**Interfaces:**
- Consumes: `bookManualMatch`, `undoMatches` (queries/bank), `fmtCents`, types `BankTransaction`, `MatchCandidatesResult`, `MatchCandidateView`; kit `Button`, `GroupLabel`, `toast*`.
- Produces: `TxCandidates({ statementId, tx, result, preselectVoucherIds, onMatched }: { statementId: number; tx: BankTransaction; result: MatchCandidatesResult; preselectVoucherIds: number[]; onMatched: (matchIds: number[], totalCents: number) => void }): JSX.Element`
  - Checkbox rows per candidate (objectLabel · counterparty / `voucherRemaining` outstanding); rows whose voucherId is in `preselectVoucherIds` (high-confidence proposals for this line) start selected.
  - Live remainder math (display only — the cap is server-enforced): allocation runs in candidate order, each selected candidate gets `min(voucherRemaining, still-unallocated line remainder)`; the amber info bar shows the line remainder and says it STAYS OPEN (partial-remainder→prepayment is not expressible with the current API — full-line prepayment is only offered on a matchless line via the "Or" sheet, Task 11).
  - Primary: `Match {allocated} €` — disabled while nothing is selected or allocation is zero; on success calls `onMatched(matchIds, allocatedCents)` (parent toasts Undo with the total + navigates).

- [ ] **Step 1: Write failing tests**

`src/bank/TxCandidates.test.tsx` (same 18-function `vi.mock('../api', …)` factory as Task 4, plus `fmtCents` — repeat verbatim):

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  listBankStatements: vi.fn(),
  listBankTransactions: vi.fn(),
  getReconciliationStatus: vi.fn(),
  getStatementMatches: vi.fn(),
  proposeMatches: vi.fn(),
  getMatchCandidates: vi.fn(),
  getBankImportStatus: vi.fn(),
  executeMatches: vi.fn(),
  manualMatch: vi.fn(),
  unmatchMatch: vi.fn(),
  approveApproval: vi.fn(),
  getPendingApprovals: vi.fn(),
  createExpense: vi.fn(),
  postExpense: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getOrganization: vi.fn(),
  fmtCents: (cents: number) => (cents / 100).toFixed(2),
}));

import * as api from '../api';
import { TxCandidates } from './TxCandidates';

const TX = {
  id: 9,
  transaction_date: '2026-06-26',
  description: 'ETTEMAKS Baltic Trade',
  amount: 50000,
  currency: 'EUR',
  counterparty_iban: null,
  counterparty_descriptor: null,
  reference: null,
  status: 'open',
} as const;

const RESULT = {
  bankTransactionId: 9,
  lineRemaining: 50000,
  candidates: [
    { voucherId: 70, objectType: 'sales_invoice' as const, objectId: 14, objectLabel: 'Invoice 2026-014', counterpartyName: 'Baltic Trade OÜ', voucherRemaining: 30000 },
    { voucherId: 71, objectType: 'sales_invoice' as const, objectId: 11, objectLabel: 'Invoice 2026-011', counterpartyName: 'Baltic Trade OÜ', voucherRemaining: 20000 },
  ],
};

describe('TxCandidates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preselects proposal candidates and shows the live remainder', () => {
    render(
      <TxCandidates
        statementId={3}
        tx={TX as never}
        result={RESULT}
        preselectVoucherIds={[70]}
        onMatched={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('checkbox', { name: /invoice 2026-014/i }),
    ).toHaveAttribute('aria-checked', 'true');
    // 500 line − 300 selected → 200 remainder, stays open.
    expect(screen.getByText(/Line remainder · 200.00 €/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Match 300.00 €' }),
    ).toBeInTheDocument();
  });

  it('recomputes the button on every toggle and disables at zero selection', () => {
    render(
      <TxCandidates
        statementId={3}
        tx={TX as never}
        result={RESULT}
        preselectVoucherIds={[]}
        onMatched={vi.fn()}
      />,
    );
    const btn = screen.getByRole('button', { name: /^Match/ });
    expect(btn).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /invoice 2026-014/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /invoice 2026-011/i }));
    expect(
      screen.getByRole('button', { name: 'Match 500.00 €' }),
    ).toBeInTheDocument();
    // Full coverage → no remainder bar.
    expect(screen.queryByText(/Line remainder/)).toBeNull();
  });

  it('books one manual match per selected candidate with allocated amounts', async () => {
    vi.mocked(api.manualMatch)
      .mockResolvedValueOnce({ records: [{ id: 91 }], approvals: [{ id: 12, matchId: 91 }] })
      .mockResolvedValueOnce({ records: [{ id: 92 }], approvals: [{ id: 13, matchId: 92 }] });
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: {},
    } as never);
    const onMatched = vi.fn();
    render(
      <TxCandidates
        statementId={3}
        tx={TX as never}
        result={RESULT}
        preselectVoucherIds={[70, 71]}
        onMatched={onMatched}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Match 500.00 €' }));
    await vi.waitFor(() =>
      expect(onMatched).toHaveBeenCalledWith([91, 92], 50000),
    );
    expect(api.manualMatch).toHaveBeenNthCalledWith(1, 3, {
      bankTransactionId: 9,
      voucherId: 70,
      amountMatched: 30000,
      matchType: 'partial',
    });
    expect(api.manualMatch).toHaveBeenNthCalledWith(2, 3, {
      bankTransactionId: 9,
      voucherId: 71,
      amountMatched: 20000,
      matchType: 'partial',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/bank/TxCandidates.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/bank/TxCandidates.tsx`:

```tsx
import { useState } from 'react';
import {
  fmtCents,
  type BankTransaction,
  type MatchCandidateView,
  type MatchCandidatesResult,
} from '../api';
import { bookManualMatch } from '../queries/bank';
import { Button } from '../ui/Button';
import { GroupLabel } from '../ui/List';
import { toastErr } from '../ui/toast';

/**
 * State C — the server found open candidates; N:M with a live remainder.
 * The remainder is display math only (the server enforces caps at
 * activation). A partial remainder STAYS OPEN on the line — the API's
 * prepayment endpoint books whole lines only, so remainder→prepayment is
 * deferred to server work (see plan appendix).
 */
export function TxCandidates({
  statementId,
  tx,
  result,
  preselectVoucherIds,
  onMatched,
}: {
  statementId: number;
  tx: BankTransaction;
  result: MatchCandidatesResult;
  preselectVoucherIds: number[];
  onMatched: (matchIds: number[], totalCents: number) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(
    () =>
      new Set(
        preselectVoucherIds.filter((id) =>
          result.candidates.some((c) => c.voucherId === id),
        ),
      ),
  );
  const [busy, setBusy] = useState(false);

  // Allocation in candidate order: each selected candidate settles up to its
  // own outstanding, capped by what is left of the line.
  const allocations: { candidate: MatchCandidateView; amount: number }[] = [];
  let left = result.lineRemaining;
  for (const c of result.candidates) {
    if (!selected.has(c.voucherId) || left <= 0) continue;
    const amount = Math.min(c.voucherRemaining, left);
    allocations.push({ candidate: c, amount });
    left -= amount;
  }
  const allocated = result.lineRemaining - left;

  const toggle = (voucherId: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(voucherId)) next.delete(voucherId);
      else next.add(voucherId);
      return next;
    });

  const onBook = async () => {
    setBusy(true);
    const matchIds: number[] = [];
    try {
      for (const { candidate, amount } of allocations) {
        const matchType =
          amount === candidate.voucherRemaining &&
          amount === result.lineRemaining &&
          allocations.length === 1
            ? 'exact'
            : 'partial';
        matchIds.push(
          await bookManualMatch(statementId, {
            bankTransactionId: tx.id,
            voucherId: candidate.voucherId,
            amountMatched: amount,
            matchType,
          }),
        );
      }
      onMatched(matchIds, allocated);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      // Partial success is real: report what actually landed.
      if (matchIds.length > 0) {
        const landed = allocations
          .slice(0, matchIds.length)
          .reduce((sum, a) => sum + a.amount, 0);
        onMatched(matchIds, landed);
      }
    } finally {
      setBusy(false);
    }
  };

  const counterparty = result.candidates[0]?.counterpartyName;

  return (
    <>
      <GroupLabel>
        {counterparty ? `Open items · ${counterparty}` : 'Open items'}
      </GroupLabel>
      <div className="mx-3.5 mb-3 overflow-hidden rounded-2xl bg-surface">
        {result.candidates.map((c) => {
          const on = selected.has(c.voucherId);
          return (
            <button
              key={c.voucherId}
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={c.objectLabel}
              onClick={() => toggle(c.voucherId)}
              className="flex w-full items-center gap-3 border-b border-line px-3.5 py-3 text-left last:border-b-0"
            >
              <span
                aria-hidden
                className={`flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[7px] border-2 text-[13px] font-bold ${
                  on
                    ? 'border-accent bg-accent text-white'
                    : 'border-[#C2C7C1] text-transparent'
                }`}
              >
                ✓
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14.5px] font-semibold">
                  {c.objectLabel}
                </div>
                <div className="truncate text-[12.5px] text-ink-2">
                  outstanding {fmtCents(c.voucherRemaining)} €
                </div>
              </div>
              <div
                className={`flex-none text-[14px] font-bold tabular-nums ${on ? '' : 'text-ink-2'}`}
              >
                {fmtCents(c.voucherRemaining)}
              </div>
            </button>
          );
        })}
      </div>
      {allocated > 0 && left > 0 && (
        <div className="mx-3.5 mb-3 rounded-[13px] bg-warn-bg px-3.5 py-2.5 text-[12px] leading-[1.45] text-warn">
          <b className="mb-0.5 block text-[10.5px] uppercase tracking-wide">
            Line remainder · {fmtCents(left)} €
          </b>
          Stays open on this line — match more items now or later. (Recording a
          remainder as a prepayment needs server support; a matchless line can
          be recorded as a whole-line prepayment from the "Or" sheet.)
        </div>
      )}
      <div className="sticky bottom-0 bg-gradient-to-t from-bg via-bg/95 to-transparent px-4 pb-3.5 pt-3">
        <Button
          className="h-[46px] w-full"
          disabled={allocated <= 0}
          busy={busy}
          onClick={() => void onBook()}
        >
          Match {fmtCents(allocated)} €
        </Button>
      </div>
      <p className="px-6 pb-2 text-center text-[10.5px] leading-[1.4] text-[#8A9089]">
        N:M — the remainder is never lost: it stays visible on the line
      </p>
    </>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/bank/TxCandidates.test.tsx
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/bank
git commit -m "feat(web): tx candidates state — N:M matching with live remainder"
```

---

### Task 10: Tx create-expense-from-line (A/B) + document policy + supplier picker

**Files:**
- Create: `packages/web/src/bank/SupplierSheet.tsx`
- Create: `packages/web/src/bank/TxCreateExpense.tsx`
- Test: `packages/web/src/bank/SupplierSheet.test.tsx`, `packages/web/src/bank/TxCreateExpense.test.tsx`

**Interfaces:**
- Consumes: `useSuppliers`, `useCategories`, `useOrganizationCountry`, `createExpenseFromLine`, `type CreateFromLineResult` (queries/bank); `onboardEntity`, `addEntityAlias`, types `Entity` (api); `eurosToCents`, `centsToEuroInput`, `vatFromGross` (lib/money); `STANDARD_VAT_RATE_PCT`, `txTitle` (bank/format); kit `Sheet`, `SearchInput`, `Field`, `TextInput`, `SelectInput`, `Button`, `GroupLabel`, `KeyValue`; `toastErr`.
- Produces:
  - `SupplierSheet({ open, onOpenChange, tx, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; tx: BankTransaction; onPick: (e: Entity) => void })` — searchable supplier list (rule 8: object selection is never ID entry) + inline "New supplier" form (name prefilled from the line text, country from the org, Reg. key REQUIRED — the server rejects supplier onboarding without it). On create, the line's identifiers are written back as aliases best-effort (`iban` when present; `merchant_descriptor` from the descriptor, else `name_alias` from the description) — so the SERVER's own alias matching improves for next month (state B's "запомним навсегда").
  - `TxCreateExpense({ statementId, tx, onDone }: { statementId: number; tx: BankTransaction; onDone: (r: CreateFromLineResult) => void })` — the §6★ core-inversion form: supplier row (picker), category select, VAT (euros, prefilled `vatFromGross(|amount|, 22)`, editable), tax point = line date (a FACT, rendered not editable), document-policy radios (`Receipt coming later` — default, keeps computed VAT / `No receipt` — the line is the source, VAT forced 0, non-deductible), primary `Create & match · −18.60 €` (disabled until a category is chosen and VAT parses). Flow → `createExpenseFromLine`; `held` outcome is passed up (parent explains, no fake success).

- [ ] **Step 1: Write failing tests**

`src/bank/SupplierSheet.test.tsx` (same api mock factory as Task 4, plus `onboardEntity: vi.fn()` and `addEntityAlias: vi.fn()` — the factory in Task 4 already lists `getEntities`/`getOrganization`; add the two extra names):

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  listBankStatements: vi.fn(),
  listBankTransactions: vi.fn(),
  getReconciliationStatus: vi.fn(),
  getStatementMatches: vi.fn(),
  proposeMatches: vi.fn(),
  getMatchCandidates: vi.fn(),
  getBankImportStatus: vi.fn(),
  executeMatches: vi.fn(),
  manualMatch: vi.fn(),
  unmatchMatch: vi.fn(),
  approveApproval: vi.fn(),
  getPendingApprovals: vi.fn(),
  createExpense: vi.fn(),
  postExpense: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getOrganization: vi.fn(),
  onboardEntity: vi.fn(),
  addEntityAlias: vi.fn(),
  fmtCents: (cents: number) => (cents / 100).toFixed(2),
}));

import * as api from '../api';
import { SupplierSheet } from './SupplierSheet';

const TX = {
  id: 9,
  transaction_date: '2026-06-25',
  description: 'PARTNER GRUPP OU ARVE 4471',
  amount: -24000,
  currency: 'EUR',
  counterparty_iban: 'EE912200221012345678',
  counterparty_descriptor: null,
  reference: null,
  status: 'open',
} as const;

function renderSheet(onPick = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SupplierSheet open onOpenChange={vi.fn()} tx={TX as never} onPick={onPick} />
    </QueryClientProvider>,
  );
  return onPick;
}

describe('SupplierSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getEntities).mockResolvedValue([
      { id: 12, role: 'supplier', country: 'EE', name: 'Wolt Eesti OÜ', goods_vs_services: null },
      { id: 13, role: 'customer', country: 'EE', name: 'Nordic Consulting OÜ', goods_vs_services: null },
    ]);
    vi.mocked(api.getOrganization).mockResolvedValue({
      id: 1, country: 'EE', base_currency: 'EUR', vat_registered: true,
      org_type: 'company', created_at: 0, name: null,
      vat_registration_number: null, iban: null,
    });
  });

  it('lists only suppliers, filters by search, picks on tap', async () => {
    const onPick = renderSheet();
    expect(await screen.findByText('Wolt Eesti OÜ')).toBeInTheDocument();
    expect(screen.queryByText('Nordic Consulting OÜ')).toBeNull();
    fireEvent.click(screen.getByText('Wolt Eesti OÜ'));
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 12, name: 'Wolt Eesti OÜ' }),
    );
  });

  it('creates a new supplier (reg key required) and writes the line aliases back', async () => {
    vi.mocked(api.onboardEntity).mockResolvedValue({
      id: 40, role: 'supplier', country: 'EE', name: 'Partner Grupp OÜ', goods_vs_services: null,
    });
    vi.mocked(api.addEntityAlias).mockResolvedValue({} as never);
    const onPick = renderSheet();
    fireEvent.click(await screen.findByRole('button', { name: /new supplier/i }));
    // Name is prefilled from the line text.
    expect(screen.getByLabelText('Name')).toHaveValue(
      'PARTNER GRUPP OU ARVE 4471',
    );
    const create = screen.getByRole('button', { name: /create supplier/i });
    expect(create).toBeDisabled(); // reg key required by the server
    fireEvent.change(screen.getByLabelText('Reg. key'), {
      target: { value: 'EE102030405' },
    });
    fireEvent.click(create);
    await vi.waitFor(() =>
      expect(api.onboardEntity).toHaveBeenCalledWith({
        role: 'supplier',
        country: 'EE',
        name: 'PARTNER GRUPP OU ARVE 4471',
        registrationKey: 'EE102030405',
      }),
    );
    // IBAN alias + name alias from the line → the server matcher learns.
    await vi.waitFor(() =>
      expect(api.addEntityAlias).toHaveBeenCalledWith(40, {
        kind: 'iban',
        value: 'EE912200221012345678',
      }),
    );
    expect(api.addEntityAlias).toHaveBeenCalledWith(40, {
      kind: 'name_alias',
      value: 'PARTNER GRUPP OU ARVE 4471',
    });
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 40 }),
    );
  });
});
```

`src/bank/TxCreateExpense.test.tsx` (same api mock factory as SupplierSheet's — repeat verbatim):

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  listBankStatements: vi.fn(),
  listBankTransactions: vi.fn(),
  getReconciliationStatus: vi.fn(),
  getStatementMatches: vi.fn(),
  proposeMatches: vi.fn(),
  getMatchCandidates: vi.fn(),
  getBankImportStatus: vi.fn(),
  executeMatches: vi.fn(),
  manualMatch: vi.fn(),
  unmatchMatch: vi.fn(),
  approveApproval: vi.fn(),
  getPendingApprovals: vi.fn(),
  createExpense: vi.fn(),
  postExpense: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getOrganization: vi.fn(),
  onboardEntity: vi.fn(),
  addEntityAlias: vi.fn(),
  fmtCents: (cents: number) => (cents / 100).toFixed(2),
}));

import * as api from '../api';
import { TxCreateExpense } from './TxCreateExpense';

const TX = {
  id: 9,
  transaction_date: '2026-06-27',
  description: 'WOLT 220627',
  amount: -1860,
  currency: 'EUR',
  counterparty_iban: null,
  counterparty_descriptor: null,
  reference: null,
  status: 'open',
} as const;

function renderForm(onDone = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TxCreateExpense statementId={3} tx={TX as never} onDone={onDone} />
    </QueryClientProvider>,
  );
  return onDone;
}

describe('TxCreateExpense', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getCategories).mockResolvedValue([
      { key: 'meals', label: 'Meals', accountCode: 'EXPENSE_MEALS' },
      { key: 'bank fee', label: 'Bank Fee', accountCode: 'EXPENSE_BANK_FEE' },
    ]);
    vi.mocked(api.getEntities).mockResolvedValue([]);
    vi.mocked(api.getOrganization).mockResolvedValue({
      id: 1, country: 'EE', base_currency: 'EUR', vat_registered: true,
      org_type: 'company', created_at: 0, name: null,
      vat_registration_number: null, iban: null,
    });
  });

  it('prefills VAT at 22% of gross and states the outcome on the button', async () => {
    renderForm();
    // 18.60 gross → 3.35 VAT.
    expect(await screen.findByLabelText('VAT (EUR)')).toHaveValue('3.35');
    expect(screen.getByText('27.06.2026 · from the line')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create & match · -18.60 €' }),
    ).toBeDisabled(); // no category chosen yet
  });

  it('forces VAT to 0 when "No receipt" is chosen', async () => {
    renderForm();
    fireEvent.click(await screen.findByText('No receipt'));
    expect(screen.getByLabelText('VAT (EUR)')).toHaveValue('0.00');
    expect(screen.getByLabelText('VAT (EUR)')).toBeDisabled();
  });

  it('submits the composed flow with the chosen category and VAT', async () => {
    vi.mocked(api.createExpense).mockResolvedValue({ id: 55 } as never);
    vi.mocked(api.postExpense).mockResolvedValue({
      expense: { id: 55, status: 'posted' },
      policy: { action: 'auto-post', reason: 'ok' },
    } as never);
    vi.mocked(api.getMatchCandidates).mockResolvedValue({
      bankTransactionId: 9,
      lineRemaining: 1860,
      candidates: [
        { voucherId: 70, objectType: 'expense', objectId: 55, objectLabel: 'Expense #55', counterpartyName: null, voucherRemaining: 1860 },
      ],
    });
    vi.mocked(api.manualMatch).mockResolvedValue({
      records: [{ id: 88 }],
      approvals: [{ id: 12, matchId: 88 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: {},
    } as never);
    const onDone = renderForm();
    fireEvent.change(await screen.findByLabelText('Category'), {
      target: { value: 'meals' },
    });
    fireEvent.click(screen.getByText('No receipt'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Create & match · -18.60 €' }),
    );
    await vi.waitFor(() =>
      expect(onDone).toHaveBeenCalledWith({
        outcome: 'matched',
        expenseId: 55,
        matchId: 88,
      }),
    );
    expect(api.createExpense).toHaveBeenCalledWith({
      category: 'meals',
      gross_amount: 1860,
      vat_amount: 0, // no receipt → no deductible input VAT
      currency: 'EUR',
      tax_point_date: '2026-06-27',
      supplier_id: null,
    });
  });

  it('passes the held outcome up when policy holds the expense', async () => {
    vi.mocked(api.createExpense).mockResolvedValue({ id: 56 } as never);
    vi.mocked(api.postExpense).mockResolvedValue({
      expense: { id: 56, status: 'pending' },
      policy: { action: 'hold-for-approval', reason: 'over ceiling' },
    } as never);
    const onDone = renderForm();
    fireEvent.change(await screen.findByLabelText('Category'), {
      target: { value: 'meals' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Create & match · -18.60 €' }),
    );
    await vi.waitFor(() =>
      expect(onDone).toHaveBeenCalledWith({
        outcome: 'held',
        expenseId: 56,
        reason: 'over ceiling',
      }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/bank/SupplierSheet.test.tsx src/bank/TxCreateExpense.test.tsx
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/bank/SupplierSheet.tsx`:

```tsx
import { useState } from 'react';
import {
  addEntityAlias,
  onboardEntity,
  type BankTransaction,
  type Entity,
} from '../api';
import { useOrganizationCountry, useSuppliers } from '../queries/bank';
import { Button } from '../ui/Button';
import { Field, TextInput } from '../ui/Form';
import { SearchInput } from '../ui/SearchInput';
import { Sheet } from '../ui/Sheet';
import { toastErr } from '../ui/toast';

/**
 * Supplier selection for create-from-line. No alias-lookup endpoint exists
 * (server gap) — the operator picks or creates the supplier here; on create,
 * the line's IBAN/descriptor/description are written back as aliases so the
 * server-side matcher recognizes this counterparty next time.
 */
export function SupplierSheet({
  open,
  onOpenChange,
  tx,
  onPick,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tx: BankTransaction;
  onPick: (e: Entity) => void;
}) {
  const suppliersQ = useSuppliers();
  const countryQ = useOrganizationCountry();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(
    tx.counterparty_descriptor ?? tx.description ?? '',
  );
  const [country, setCountry] = useState('');
  const [regKey, setRegKey] = useState('');
  const [busy, setBusy] = useState(false);

  const effCountry = country !== '' ? country : (countryQ.data ?? 'EE');
  const filtered = (suppliersQ.data ?? []).filter((e) =>
    e.name.toLowerCase().includes(q.toLowerCase()),
  );

  const onCreate = async () => {
    setBusy(true);
    try {
      const entity = await onboardEntity({
        role: 'supplier',
        country: effCountry,
        name: name.trim(),
        registrationKey: regKey.trim(),
      });
      // Best-effort alias write-back — a failed alias must not lose the pick.
      try {
        if (tx.counterparty_iban) {
          await addEntityAlias(entity.id, {
            kind: 'iban',
            value: tx.counterparty_iban,
          });
        }
        const aliasText = tx.counterparty_descriptor ?? tx.description;
        if (aliasText) {
          await addEntityAlias(entity.id, {
            kind: tx.counterparty_descriptor ? 'merchant_descriptor' : 'name_alias',
            value: aliasText,
          });
        }
      } catch {
        // Alias write-back is advisory; the supplier itself was created.
      }
      onPick(entity);
      onOpenChange(false);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Supplier">
      <div className="space-y-3 px-4 pb-4">
        {!creating && (
          <>
            <SearchInput value={q} onChange={setQ} placeholder="Search suppliers…" />
            <div className="overflow-hidden rounded-2xl bg-surface">
              {filtered.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => {
                    onPick(e);
                    onOpenChange(false);
                  }}
                  className="flex w-full items-center gap-3 border-b border-line px-3.5 py-3 text-left last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14.5px] font-semibold">
                      {e.name}
                    </div>
                    <div className="truncate text-[12.5px] text-ink-2">
                      {e.country}
                    </div>
                  </div>
                </button>
              ))}
              {suppliersQ.isSuccess && filtered.length === 0 && (
                <p className="px-3.5 py-3 text-[13px] text-ink-2">
                  No suppliers match.
                </p>
              )}
            </div>
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => setCreating(true)}
            >
              New supplier — remembered forever
            </Button>
          </>
        )}
        {creating && (
          <div className="space-y-3 rounded-2xl border-[1.5px] border-dashed border-[#B7C4BA] bg-surface p-4">
            <Field label="Name" hint="Prefilled from the statement line">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Country" hint="ISO code, e.g. EE">
              <TextInput
                value={effCountry}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
                maxLength={2}
              />
            </Field>
            <Field
              label="Reg. key"
              hint="Registry / VAT number — required to onboard a supplier"
            >
              <TextInput
                value={regKey}
                onChange={(e) => setRegKey(e.target.value)}
              />
            </Field>
            <Button
              className="w-full"
              disabled={name.trim() === '' || regKey.trim() === '' || effCountry.trim() === ''}
              busy={busy}
              onClick={() => void onCreate()}
            >
              Create supplier
            </Button>
            <p className="text-center text-[11px] text-ink-2">
              The line text becomes this supplier's alias — next month the
              server recognizes it by itself.
            </p>
          </div>
        )}
      </div>
    </Sheet>
  );
}
```

`src/bank/TxCreateExpense.tsx`:

```tsx
import { useState } from 'react';
import { fmtCents, type BankTransaction, type Entity } from '../api';
import {
  createExpenseFromLine,
  useCategories,
  type CreateFromLineResult,
} from '../queries/bank';
import { centsToEuroInput, eurosToCents, vatFromGross } from '../lib/money';
import { Button } from '../ui/Button';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { GroupLabel, KeyValue } from '../ui/List';
import { toastErr } from '../ui/toast';
import { STANDARD_VAT_RATE_PCT } from './format';
import { SupplierSheet } from './SupplierSheet';

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/**
 * States A/B — the core inversion: the expense is created FROM the line.
 * Everything the line knows is a prefilled fact (amount, date); VAT is
 * prefigured at the standard rate (editable — no rate endpoint exists);
 * document policy: "receipt later" keeps VAT, "no receipt" → the line is the
 * source record and VAT is 0 (non-deductible without an invoice — the form
 * knows this rule, §6★).
 */
export function TxCreateExpense({
  statementId,
  tx,
  onDone,
}: {
  statementId: number;
  tx: BankTransaction;
  onDone: (r: CreateFromLineResult) => void;
}) {
  const absCents = Math.abs(tx.amount);
  const categoriesQ = useCategories();
  const [category, setCategory] = useState('');
  const [supplier, setSupplier] = useState<Entity | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [docPolicy, setDocPolicy] = useState<'later' | 'none'>('later');
  const [vatInput, setVatInput] = useState(() =>
    centsToEuroInput(vatFromGross(absCents, STANDARD_VAT_RATE_PCT)),
  );
  const [busy, setBusy] = useState(false);

  const vatCents = docPolicy === 'none' ? 0 : eurosToCents(vatInput);
  const valid =
    category !== '' && vatCents !== null && vatCents >= 0 && vatCents <= absCents;

  const onSubmit = async () => {
    if (vatCents === null) return;
    setBusy(true);
    try {
      const result = await createExpenseFromLine({
        statementId,
        bankTransactionId: tx.id,
        category,
        grossCents: absCents,
        vatCents,
        currency: tx.currency,
        taxPointDate: tx.transaction_date,
        supplierId: supplier?.id ?? null,
      });
      onDone(result);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <GroupLabel>Create expense from line</GroupLabel>
      <div className="mx-3.5 mb-3 overflow-hidden rounded-2xl bg-surface">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="flex w-full items-center justify-between gap-3 border-b border-line px-3.5 py-2.5 text-left"
        >
          <span className="text-[13px] text-ink-2">Supplier</span>
          <span className="min-w-0 truncate text-[13px] font-semibold">
            {supplier ? supplier.name : 'Choose or create ›'}
          </span>
        </button>
        <div className="border-b border-line px-3.5 py-2.5">
          <Field label="Category">
            <SelectInput
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">Select category…</option>
              {(categoriesQ.data ?? []).map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </SelectInput>
          </Field>
        </div>
        <div className="border-b border-line px-3.5 py-2.5">
          <Field
            label="VAT (EUR)"
            hint={
              docPolicy === 'none'
                ? 'No receipt → input VAT is not deductible'
                : `auto ${STANDARD_VAT_RATE_PCT}% — edit if the receipt says otherwise`
            }
          >
            <TextInput
              inputMode="decimal"
              value={docPolicy === 'none' ? '0.00' : vatInput}
              disabled={docPolicy === 'none'}
              onChange={(e) => setVatInput(e.target.value)}
            />
          </Field>
        </div>
        <KeyValue k="Tax point" v={`${fmtDate(tx.transaction_date)} · from the line`} />
      </div>

      <GroupLabel>Document</GroupLabel>
      <div className="mx-3.5 mb-3 overflow-hidden rounded-2xl bg-surface">
        {(
          [
            {
              value: 'later' as const,
              icon: '📎',
              iconBg: 'bg-warn-bg',
              title: 'Receipt coming later',
              sub: 'Attach it in Books when it arrives',
            },
            {
              value: 'none' as const,
              icon: '🚫',
              iconBg: 'bg-line',
              title: 'No receipt',
              sub: 'The line is the source · VAT 0, not deductible',
            },
          ]
        ).map((opt) => {
          const on = docPolicy === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setDocPolicy(opt.value)}
              className="flex w-full items-center gap-3 border-b border-line px-3.5 py-3 text-left last:border-b-0"
            >
              <span
                aria-hidden
                className={`flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] text-[15px] ${opt.iconBg}`}
              >
                {opt.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold">
                  {opt.title}
                </div>
                <div className="truncate text-[12px] text-ink-2">{opt.sub}</div>
              </div>
              <span
                aria-hidden
                className={`h-[22px] w-[22px] flex-none rounded-full border-2 ${
                  on
                    ? 'border-accent bg-[radial-gradient(circle,theme(colors.accent.DEFAULT)_42%,transparent_48%)]'
                    : 'border-[#C2C7C1]'
                }`}
              />
            </button>
          );
        })}
      </div>

      <div className="sticky bottom-0 bg-gradient-to-t from-bg via-bg/95 to-transparent px-4 pb-3.5 pt-3">
        <Button
          className="h-[46px] w-full"
          disabled={!valid}
          busy={busy}
          onClick={() => void onSubmit()}
        >
          Create &amp; match · {fmtCents(tx.amount)} €
        </Button>
      </div>
      <p className="px-6 pb-2 text-center text-[10.5px] leading-[1.4] text-[#8A9089]">
        The amount and date come from the bank — they are facts, not fields
      </p>

      <SupplierSheet
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        tx={tx}
        onPick={setSupplier}
      />
    </>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/bank/SupplierSheet.test.tsx src/bank/TxCreateExpense.test.tsx && npm test
```

Expected: PASS (2 + 4 tests); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/bank
git commit -m "feat(web): create-expense-from-line with document policy and inline supplier onboarding"
```

---

### Task 11: Dispositions (Or-sheet, personal, bank fee, prepayment) + TxScreen composition

**Files:**
- Create: `packages/web/src/bank/TxDispositions.tsx` (OrRow, OtherSheet, PersonalSheet, PrepaymentSheet, IncomingOpen)
- Create: `packages/web/src/bank/TxScreen.tsx` (route component composing Tasks 8–11)
- Test: `packages/web/src/bank/TxScreen.test.tsx`

**Interfaces:**
- Consumes: `markPersonal`, `createPrepayment`, `fmtCents` (api); `routeTxState` (txState); `TxMatched`, `TxCandidates`, `TxCreateExpense`; `useBankTransactions`, `useReconciliation`, `useStatementMatches`, `useMatchCandidates`, `useMatchProposals`, `useCategories`, `invalidateStatement`, `undoMatches`, `createExpenseFromLine` (queries/bank); kit `Sheet`, `Button`, `AmountText`, `SkeletonRows`, `Chip`; `ScreenHeader`; `toastOk`/`toastErr`/`toastUndo`.
- Produces (from `TxDispositions.tsx`):
  - `OrRow({ onClick })` — the "Or" group: single row "Personal · Bank fee · Prepayment ›".
  - `OtherSheet({ open, onOpenChange, tx, hasMatches, feeAvailable, onPersonal, onFee, onPrepayment })` — options list; visibility rules bound to the verified server contract: **Personal** only for outflows with no matches (`markPersonal` 400s otherwise); **Bank fee** only for matchless outflows when the `'bank fee'` category exists (no fee endpoint — composed as create-expense with VAT 0, no supplier); **Prepayment** only for matchless non-zero lines (`createPrepayment` books the WHOLE line).
  - `PersonalSheet({ open, onOpenChange, tx, busy, onConfirm })` — §6★b: consequences in human words, NO chart of accounts, NO owner-debt balance (no endpoint — degradation), confirm button `Record as personal`. The sheet IS the explicit confirm step: `markPersonal` posts a voucher immediately and there is no undo endpoint.
  - `PrepaymentSheet({ open, onOpenChange, tx, busy, onConfirm })` — explains "records the WHOLE ±X € on account (customer/supplier prepayment); it can settle invoices later"; confirm `Record prepayment · ±X €`. Explicit confirm, no undo endpoint.
  - `IncomingOpen({ tx, onPrepayment })` — incoming line, no candidates: green info bar ("Incoming payment with no open invoices — record it as a customer prepayment; it will offer itself to future invoices") + primary `Record prepayment · +X €` (opens PrepaymentSheet). Owner-debt repayment is NOT offered (no endpoint — appendix).
- Produces (from `TxScreen.tsx`): `TxScreen(): JSX.Element` — reads `:id`/`:txId`, loads tx/recon/matches/candidates/proposals, renders: nav (`ScreenHeader`, title = `N unmatched` for open lines / `Matched` / disposition label), hero (30px amount — a fact, not tappable; subtitle `title · date`), then the routed state component; the Or-row shows for `candidates`/`create` states; after any terminal action → invalidate + `navigate` back to the statement:
  - matched via candidates → `toastUndo('Matched · X.XX €', undo)`;
  - create&match → `toastOk('Expense created & matched · −X.XX €')` (NO undo — the expense is posted, see appendix);
  - held → `toastOk('Expense created — held for approval: <reason>. Match it after approval.')`;
  - personal/prepayment/fee → `toastOk` receipts.

- [ ] **Step 1: Write failing tests**

`src/bank/TxScreen.test.tsx` (api mock factory = Task 10's, plus `markPersonal: vi.fn()`, `createPrepayment: vi.fn()`, `fmtCents`):

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  listBankStatements: vi.fn(),
  listBankTransactions: vi.fn(),
  getReconciliationStatus: vi.fn(),
  getStatementMatches: vi.fn(),
  proposeMatches: vi.fn(),
  getMatchCandidates: vi.fn(),
  getBankImportStatus: vi.fn(),
  executeMatches: vi.fn(),
  manualMatch: vi.fn(),
  unmatchMatch: vi.fn(),
  approveApproval: vi.fn(),
  getPendingApprovals: vi.fn(),
  createExpense: vi.fn(),
  postExpense: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getOrganization: vi.fn(),
  onboardEntity: vi.fn(),
  addEntityAlias: vi.fn(),
  markPersonal: vi.fn(),
  createPrepayment: vi.fn(),
  fmtCents: (cents: number) => (cents / 100).toFixed(2),
}));

import * as api from '../api';
import { AppToaster } from '../ui/toast';
import { TxScreen } from './TxScreen';

const BASE_TX = {
  id: 9,
  transaction_date: '2026-06-27',
  description: 'WOLT 220627',
  amount: -1860,
  currency: 'EUR',
  counterparty_iban: null,
  counterparty_descriptor: null,
  reference: null,
  status: 'open',
};

function mockLine(over: Partial<typeof BASE_TX> = {}, extra?: {
  matches?: unknown[];
  candidates?: unknown[];
  proposals?: unknown[];
}) {
  const tx = { ...BASE_TX, ...over };
  vi.mocked(api.listBankTransactions).mockResolvedValue([tx] as never);
  vi.mocked(api.getReconciliationStatus).mockResolvedValue([
    { bankTransactionId: 9, amountBase: Math.abs(tx.amount), matchedSum: 0, remaining: Math.abs(tx.amount), reconStatus: 'open' },
  ]);
  vi.mocked(api.getStatementMatches).mockResolvedValue(
    (extra?.matches ?? []) as never,
  );
  vi.mocked(api.getMatchCandidates).mockResolvedValue({
    bankTransactionId: 9,
    lineRemaining: Math.abs(tx.amount),
    candidates: (extra?.candidates ?? []) as never,
  });
  vi.mocked(api.proposeMatches).mockResolvedValue(
    (extra?.proposals ?? []) as never,
  );
  vi.mocked(api.getCategories).mockResolvedValue([
    { key: 'meals', label: 'Meals', accountCode: 'EXPENSE_MEALS' },
    { key: 'bank fee', label: 'Bank Fee', accountCode: 'EXPENSE_BANK_FEE' },
  ]);
  vi.mocked(api.getEntities).mockResolvedValue([]);
  vi.mocked(api.getOrganization).mockResolvedValue({
    id: 1, country: 'EE', base_currency: 'EUR', vat_registered: true,
    org_type: 'company', created_at: 0, name: null,
    vat_registration_number: null, iban: null,
  });
}

function renderTx() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/bank/statements/:id', element: <p>statement screen</p> },
      { path: '/bank/statements/:id/tx/:txId', element: <TxScreen /> },
    ],
    { initialEntries: ['/bank/statements/3/tx/9'] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
      <AppToaster />
    </QueryClientProvider>,
  );
  return router;
}

describe('TxScreen state composition', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the hero as a fact and the create state for an outgoing line with no candidates', async () => {
    mockLine();
    renderTx();
    expect(await screen.findByText('-18.60 €')).toBeInTheDocument();
    expect(
      await screen.findByText('Create expense from line'),
    ).toBeInTheDocument();
    expect(screen.getByText('1 unmatched')).toBeInTheDocument();
    // Alternatives are reachable but not the accent.
    expect(screen.getByText(/Personal · Bank fee · Prepayment/)).toBeInTheDocument();
  });

  it('renders the matched state (G) when the line has matches', async () => {
    mockLine({}, {
      matches: [
        { id: 41, bankTransactionId: 9, status: 'active', amountMatched: 1860, objectLabel: 'Expense #55', counterpartyName: 'Wolt Eesti OÜ' },
      ],
    });
    renderTx();
    expect(await screen.findByText('Matched with')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unmatch' })).toBeInTheDocument();
  });

  it('renders the candidates state (C) and returns to the statement with an Undo toast after matching', async () => {
    mockLine({ amount: 50000, description: 'ETTEMAKS Baltic Trade' }, {
      candidates: [
        { voucherId: 70, objectType: 'sales_invoice', objectId: 14, objectLabel: 'Invoice 2026-014', counterpartyName: 'Baltic Trade OÜ', voucherRemaining: 30000 },
      ],
      proposals: [
        { bankTransactionId: 9, voucherId: 70, matchType: 'partial', amountMatched: 30000, confidence: 'high', signal: 'counterparty', objectType: 'sales_invoice', objectId: 14, objectLabel: 'Invoice 2026-014', counterpartyName: 'Baltic Trade OÜ', voucherRemaining: 30000 },
      ],
    });
    vi.mocked(api.manualMatch).mockResolvedValue({
      records: [{ id: 91 }],
      approvals: [{ id: 12, matchId: 91 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({ approval: {} } as never);
    const router = renderTx();
    // Proposal-backed candidate is preselected → button ready.
    fireEvent.click(
      await screen.findByRole('button', { name: 'Match 300.00 €' }),
    );
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe('/bank/statements/3'),
    );
    expect(await screen.findByText('Matched · 300.00 €')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('renders the incoming-open state with a prepayment primary', async () => {
    mockLine({ amount: 50000, description: 'ETTEMAKS Baltic Trade' });
    renderTx();
    expect(
      await screen.findByRole('button', { name: 'Record prepayment · +500.00 €' }),
    ).toBeInTheDocument();
  });

  it('personal flows through the explanation sheet and calls markPersonal', async () => {
    mockLine();
    vi.mocked(api.markPersonal).mockResolvedValue({});
    const router = renderTx();
    fireEvent.click(await screen.findByText(/Personal · Bank fee · Prepayment/));
    fireEvent.click(await screen.findByText('Personal'));
    // The consequences sheet is the explicit confirm step.
    expect(
      await screen.findByText(/not a company expense/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Record as personal' }));
    await vi.waitFor(() => expect(api.markPersonal).toHaveBeenCalledWith(9));
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe('/bank/statements/3'),
    );
  });

  it('bank fee composes a VAT-0 bank-fee expense and matches it', async () => {
    mockLine({ amount: -800, description: 'SEB hooldustasu' });
    vi.mocked(api.createExpense).mockResolvedValue({ id: 60 } as never);
    vi.mocked(api.postExpense).mockResolvedValue({
      expense: { id: 60, status: 'posted' },
      policy: { action: 'auto-post', reason: 'ok' },
    } as never);
    vi.mocked(api.getMatchCandidates)
      .mockResolvedValueOnce({ bankTransactionId: 9, lineRemaining: 800, candidates: [] }) // state routing
      .mockResolvedValue({
        bankTransactionId: 9,
        lineRemaining: 800,
        candidates: [
          { voucherId: 80, objectType: 'expense', objectId: 60, objectLabel: 'Expense #60', counterpartyName: null, voucherRemaining: 800 },
        ],
      });
    vi.mocked(api.manualMatch).mockResolvedValue({
      records: [{ id: 95 }],
      approvals: [{ id: 15, matchId: 95 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({ approval: {} } as never);
    renderTx();
    fireEvent.click(await screen.findByText(/Personal · Bank fee · Prepayment/));
    fireEvent.click(await screen.findByText('Bank fee'));
    await vi.waitFor(() =>
      expect(api.createExpense).toHaveBeenCalledWith({
        category: 'bank fee',
        gross_amount: 800,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-06-27',
        supplier_id: null,
      }),
    );
  });

  it('renders the disposed state read-only', async () => {
    mockLine({ status: 'personal' });
    renderTx();
    expect(await screen.findByText('Recorded as personal')).toBeInTheDocument();
    expect(screen.queryByText('Create expense from line')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/bank/TxScreen.test.tsx
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/bank/TxDispositions.tsx`**

```tsx
import { fmtCents, type BankTransaction } from '../api';
import { Button } from '../ui/Button';
import { GroupLabel } from '../ui/List';
import { Sheet } from '../ui/Sheet';

/** The "Or" group — alternatives are always reachable, never the accent. */
export function OrRow({ onClick }: { onClick: () => void }) {
  return (
    <>
      <GroupLabel>Or</GroupLabel>
      <div className="mx-3.5 mb-3 overflow-hidden rounded-2xl bg-surface">
        <button
          type="button"
          onClick={onClick}
          className="flex min-h-[44px] w-full items-center gap-3 px-3.5 py-2.5 text-left"
        >
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[#4D534E]">
            Personal · Bank fee · Prepayment
          </span>
          <span aria-hidden className="flex-none text-base text-[#C2C7C1]">
            ›
          </span>
        </button>
      </div>
    </>
  );
}

/**
 * Disposition fan. Visibility is bound to the server contract:
 * personal → outflows only, open + matchless (endpoint 400s otherwise);
 * fee → composed create-expense (no fee endpoint), outflow + matchless;
 * prepayment → books the WHOLE line, so matchless lines only.
 */
export function OtherSheet({
  open,
  onOpenChange,
  tx,
  hasMatches,
  feeAvailable,
  busy,
  onPersonal,
  onFee,
  onPrepayment,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tx: BankTransaction;
  hasMatches: boolean;
  feeAvailable: boolean;
  busy: boolean;
  onPersonal: () => void;
  onFee: () => void;
  onPrepayment: () => void;
}) {
  const options: { label: string; sub: string; onPick: () => void }[] = [];
  if (tx.amount < 0 && !hasMatches) {
    options.push({
      label: 'Personal',
      sub: 'Not business — becomes your debt to the company',
      onPick: onPersonal,
    });
    if (feeAvailable) {
      options.push({
        label: 'Bank fee',
        sub: `Bank-fee expense, VAT 0 · ${fmtCents(tx.amount)} €`,
        onPick: onFee,
      });
    }
  }
  if (tx.amount !== 0 && !hasMatches) {
    options.push({
      label: 'Prepayment',
      sub: `Whole line on account · ${fmtCents(Math.abs(tx.amount))} €`,
      onPick: onPrepayment,
    });
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Other actions">
      <div className="px-4 pb-4">
        <div className="overflow-hidden rounded-2xl bg-surface">
          {options.map((o) => (
            <button
              key={o.label}
              type="button"
              disabled={busy}
              onClick={o.onPick}
              className="flex w-full items-center gap-3 border-b border-line px-3.5 py-3 text-left last:border-b-0 disabled:opacity-50"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14.5px] font-semibold">
                  {o.label}
                </div>
                <div className="truncate text-[12.5px] text-ink-2">{o.sub}</div>
              </div>
              <span aria-hidden className="flex-none text-base text-[#C2C7C1]">
                ›
              </span>
            </button>
          ))}
          {options.length === 0 && (
            <p className="px-3.5 py-3 text-[13px] text-ink-2">
              No dispositions apply — the line has matches or is incoming-only.
            </p>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/**
 * §6★b — personal NEVER shows a chart of accounts (ADR-0001/0017): the
 * country plugin resolves the account; the operator sees consequences in
 * human words. The owner-debt running balance is not exposed by any endpoint
 * (degradation, see appendix) — the sheet explains without the number.
 * This sheet IS the explicit confirm: markPersonal posts immediately and has
 * no undo endpoint.
 */
export function PersonalSheet({
  open,
  onOpenChange,
  tx,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tx: BankTransaction;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Personal spend">
      <p className="px-7 pb-2.5 text-center text-[12px] text-ink-2">
        {tx.description ?? 'Bank line'} · {fmtCents(tx.amount)} €
      </p>
      <div className="mx-4 mb-3 rounded-[13px] bg-warn-bg px-3.5 py-2.5 text-[12px] leading-[1.45] text-[#6D4A05]">
        <b className="mb-0.5 block text-[11px] uppercase tracking-wide">
          What happens
        </b>
        This is not a company expense: it will not enter the P&amp;L and no VAT
        is deducted. The amount is recorded as your debt to the company — repay
        it by transfer or settle it against a payout. The booking account is
        resolved automatically for your organization type.
      </div>
      <div className="flex gap-2.5 px-4 pb-4">
        <Button
          variant="secondary"
          className="h-[46px] flex-1"
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button className="h-[46px] flex-1" busy={busy} onClick={onConfirm}>
          Record as personal
        </Button>
      </div>
      <p className="px-6 pb-3 text-center text-[10.5px] text-[#8A9089]">
        One attributable tap — you are the approver; recorded in the audit log
      </p>
    </Sheet>
  );
}

/** Whole-line prepayment — explicit confirm (posts immediately, no undo). */
export function PrepaymentSheet({
  open,
  onOpenChange,
  tx,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tx: BankTransaction;
  busy: boolean;
  onConfirm: () => void;
}) {
  const incoming = tx.amount > 0;
  const abs = fmtCents(Math.abs(tx.amount));
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Record prepayment">
      <p className="px-7 pb-2.5 text-center text-[12px] text-ink-2">
        {tx.description ?? 'Bank line'} · {incoming ? '+' : '-'}
        {abs} €
      </p>
      <div className="mx-4 mb-3 rounded-[13px] bg-warn-bg px-3.5 py-2.5 text-[12px] leading-[1.45] text-[#6D4A05]">
        <b className="mb-0.5 block text-[11px] uppercase tracking-wide">
          What happens
        </b>
        Records the whole {abs} € as a{' '}
        {incoming ? 'customer prepayment (money received on account)' : 'supplier prepayment (money paid on account)'}
        . It can settle {incoming ? 'invoices' : 'bills'} later — future lines
        will offer it as a match candidate.
      </div>
      <div className="flex gap-2.5 px-4 pb-4">
        <Button
          variant="secondary"
          className="h-[46px] flex-1"
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button className="h-[46px] flex-1" busy={busy} onClick={onConfirm}>
          Record prepayment · {incoming ? '+' : '-'}
          {abs} €
        </Button>
      </div>
    </Sheet>
  );
}

/** Incoming line, no invoices — the prepayment state from the routing matrix.
 *  Owner-debt repayment has no endpoint (appendix) and is not offered. */
export function IncomingOpen({
  tx,
  onPrepayment,
}: {
  tx: BankTransaction;
  onPrepayment: () => void;
}) {
  return (
    <>
      <div className="mx-3.5 mb-3 rounded-[13px] bg-ok-bg px-3.5 py-2.5 text-[12px] leading-[1.45] text-ok">
        <b className="mb-0.5 block text-[11px] uppercase tracking-wide">
          Incoming payment, no open invoices
        </b>
        Record it as a customer prepayment — it will offer itself as a match
        when the invoice appears.
      </div>
      <div className="sticky bottom-0 bg-gradient-to-t from-bg via-bg/95 to-transparent px-4 pb-3.5 pt-3">
        <Button className="h-[46px] w-full" onClick={onPrepayment}>
          Record prepayment · +{fmtCents(tx.amount)} €
        </Button>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Implement `src/bank/TxScreen.tsx`**

```tsx
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { createPrepayment, fmtCents, markPersonal } from '../api';
import {
  createExpenseFromLine,
  invalidateStatement,
  undoMatches,
  useBankTransactions,
  useCategories,
  useMatchCandidates,
  useMatchProposals,
  useReconciliation,
  useStatementMatches,
  type CreateFromLineResult,
} from '../queries/bank';
import { AmountText } from '../ui/AmountText';
import { Chip } from '../ui/Chip';
import { SkeletonRows } from '../ui/Feedback';
import { toastErr, toastOk, toastUndo } from '../ui/toast';
import { ScreenHeader } from '../shell/Headers';
import { formatTxDate, txTitle } from './format';
import { routeTxState } from './txState';
import { TxCandidates } from './TxCandidates';
import { TxCreateExpense } from './TxCreateExpense';
import {
  IncomingOpen,
  OrRow,
  OtherSheet,
  PersonalSheet,
  PrepaymentSheet,
} from './TxDispositions';
import { TxMatched } from './TxMatched';

const DISPOSED_TITLE: Record<string, string> = {
  personal: 'Recorded as personal',
  prepayment: 'Recorded as prepayment',
  bank_fee: 'Recorded as bank fee',
  dividend: 'Recorded as dividend',
};

/** /bank/statements/:id/tx/:txId — the 90%-of-time screen. It reads the
 *  line's context and opens on the right action (routing matrix, Task 8). */
export function TxScreen() {
  const params = useParams();
  const statementId = Number(params.id);
  const txId = Number(params.txId);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const txQ = useBankTransactions(statementId);
  const reconQ = useReconciliation(statementId);
  const matchesQ = useStatementMatches(statementId);
  const proposalsQ = useMatchProposals(statementId);
  const categoriesQ = useCategories();

  const tx = txQ.data?.find((t) => t.id === txId);
  const candQ = useMatchCandidates(
    statementId,
    txId,
    tx !== undefined && tx.status === 'open',
  );

  const state = routeTxState({
    tx,
    matches: matchesQ.data,
    candidates: candQ.data,
  });
  const recon = reconQ.data?.find((r) => r.bankTransactionId === txId);
  const unmatchedCount = useMemo(() => {
    const byTx = new Map(
      (reconQ.data ?? []).map((r) => [r.bankTransactionId, r.reconStatus]),
    );
    return (txQ.data ?? []).filter(
      (t) => t.status === 'open' && byTx.get(t.id) !== 'matched',
    ).length;
  }, [txQ.data, reconQ.data]);

  const [otherOpen, setOtherOpen] = useState(false);
  const [personalOpen, setPersonalOpen] = useState(false);
  const [prepayOpen, setPrepayOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const preselect = useMemo(
    () =>
      (proposalsQ.data ?? [])
        .filter((p) => p.bankTransactionId === txId && p.confidence === 'high')
        .map((p) => p.voucherId),
    [proposalsQ.data, txId],
  );
  const feeCategory = (categoriesQ.data ?? []).find(
    (c) => c.key === 'bank fee',
  );

  const backToStatement = async () => {
    await invalidateStatement(qc, statementId);
    navigate(`/bank/statements/${statementId}`);
  };

  const onMatched = (matchIds: number[], totalCents: number) => {
    const total = fmtCents(totalCents);
    void backToStatement().then(() => {
      toastUndo(`Matched · ${total} €`, () => {
        void undoMatches(statementId, matchIds)
          .then(() => invalidateStatement(qc, statementId))
          .catch((e) => toastErr(e instanceof Error ? e.message : String(e)));
      });
    });
  };

  const onCreateDone = (r: CreateFromLineResult) => {
    if (r.outcome === 'matched') {
      // The expense is POSTED — deleting it is not legal, so no Undo lie.
      toastOk(`Expense created & matched · ${fmtCents(tx?.amount ?? 0)} €`);
    } else {
      toastOk(
        `Expense created — held for approval: ${r.reason}. Match it after approval.`,
      );
    }
    void backToStatement();
  };

  const onPersonal = async () => {
    setBusy(true);
    try {
      await markPersonal(txId);
      toastOk('Recorded as personal');
      await backToStatement();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setPersonalOpen(false);
    }
  };

  const onPrepayment = async () => {
    setBusy(true);
    try {
      await createPrepayment(txId);
      toastOk('Recorded as prepayment');
      await backToStatement();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setPrepayOpen(false);
    }
  };

  const onFee = async () => {
    if (!tx || !feeCategory) return;
    setBusy(true);
    try {
      const r = await createExpenseFromLine({
        statementId,
        bankTransactionId: txId,
        category: feeCategory.key,
        grossCents: Math.abs(tx.amount),
        vatCents: 0, // financial services — no input VAT
        currency: tx.currency,
        taxPointDate: tx.transaction_date,
        supplierId: null,
      });
      setOtherOpen(false);
      if (r.outcome === 'matched') {
        toastOk(`Bank fee recorded · ${fmtCents(tx.amount)} €`);
      } else {
        toastOk(`Bank fee held for approval: ${r.reason}`);
      }
      await backToStatement();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const title =
    state.kind === 'matched'
      ? 'Matched'
      : state.kind === 'disposed'
        ? (DISPOSED_TITLE[state.status] ?? state.status)
        : `${unmatchedCount} unmatched`;

  const showOr = state.kind === 'candidates' || state.kind === 'create';

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title={title} backTo={`/bank/statements/${statementId}`} />
      {tx === undefined ? (
        <SkeletonRows count={3} />
      ) : (
        <>
          <div className="px-5 pb-3 pt-1.5 text-center">
            {/* The amount is a fact from the bank — not tappable, not a field. */}
            <AmountText
              cents={tx.amount}
              currency={tx.currency}
              showSign
              className="block text-[30px] font-extrabold leading-[1.15] tracking-tight"
            />
            <p className="truncate text-[12.5px] text-ink-2">
              {txTitle(tx)} · {formatTxDate(tx.transaction_date)}
            </p>
            {state.kind === 'matched' && (
              <div className="mt-1.5">
                <Chip tone="ok">matched ✓</Chip>
              </div>
            )}
          </div>

          {state.kind === 'loading' && <SkeletonRows count={3} />}
          {state.kind === 'disposed' && (
            <div className="mx-3.5 mb-3 rounded-2xl bg-surface px-3.5 py-3 text-center text-[13px] text-ink-2">
              This line is settled as a disposition. No further action is
              available here.
            </div>
          )}
          {state.kind === 'matched' && (
            <TxMatched
              statementId={statementId}
              tx={tx}
              active={state.active}
              staged={state.staged}
              recon={recon}
              onChanged={() => void invalidateStatement(qc, statementId)}
            />
          )}
          {state.kind === 'candidates' && (
            <TxCandidates
              statementId={statementId}
              tx={tx}
              result={state.result}
              preselectVoucherIds={preselect}
              onMatched={onMatched}
            />
          )}
          {state.kind === 'create' && (
            <TxCreateExpense
              statementId={statementId}
              tx={tx}
              onDone={onCreateDone}
            />
          )}
          {state.kind === 'incoming-open' && (
            <IncomingOpen tx={tx} onPrepayment={() => setPrepayOpen(true)} />
          )}

          {showOr && <OrRow onClick={() => setOtherOpen(true)} />}

          <OtherSheet
            open={otherOpen}
            onOpenChange={setOtherOpen}
            tx={tx}
            hasMatches={state.kind === 'matched'}
            feeAvailable={feeCategory !== undefined}
            busy={busy}
            onPersonal={() => {
              setOtherOpen(false);
              setPersonalOpen(true);
            }}
            onFee={() => void onFee()}
            onPrepayment={() => {
              setOtherOpen(false);
              setPrepayOpen(true);
            }}
          />
          <PersonalSheet
            open={personalOpen}
            onOpenChange={setPersonalOpen}
            tx={tx}
            busy={busy}
            onConfirm={() => void onPersonal()}
          />
          <PrepaymentSheet
            open={prepayOpen}
            onOpenChange={setPrepayOpen}
            tx={tx}
            busy={busy}
            onConfirm={() => void onPrepayment()}
          />
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/bank/TxScreen.test.tsx && npm test
```

Expected: PASS (7 tests); full suite PASS. (If vaul's Sheet needs jsdom pointer stubs, they are already in `src/test-setup.ts` from Plan 01.)

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/bank
git commit -m "feat(web): tx dispositions (personal/fee/prepayment) + tx screen composition"
```

---

### Task 12: Mount the Bank routes, delete legacy BankView

**Files:**
- Modify: `packages/web/src/shell/router.tsx`
- Modify: `packages/web/src/shell/router.test.tsx`
- Delete: `packages/web/src/components/BankView.tsx`, `packages/web/src/components/BankView.test.tsx`

**Interfaces:**
- Consumes: `StatementsScreen`, `ImportScreen`, `StatementScreen`, `TxScreen` (bank/).
- Produces: `/bank` route tree replacing the LegacyTabs Bank mount. Old `/bank?tab=bank` keeps working (same path; the unknown `tab` param is simply ignored by `StatementsScreen`).

- [ ] **Step 1: Extend the router test** (append to `src/shell/router.test.tsx` inside the existing `describe('router', …)`; also add the imports shown):

```tsx
// Add to the imports at the top of the file:
import { vi } from 'vitest'; // merge with the existing vitest import

// Append inside describe('router', ...):
  it('renders the new Bank statements screen at /bank', async () => {
    setToken('test-token');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('[]', { status: 200 }),
    );
    renderAt('/bank');
    expect(
      await screen.findByRole('heading', { name: 'Bank' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Import' })).toHaveAttribute(
      'href',
      '/bank/import',
    );
    vi.restoreAllMocks();
  });
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/shell/router.test.tsx
```

Expected: FAIL — `/bank` still renders the LegacyTabs title (no Import link).

- [ ] **Step 3: Swap the routes in `src/shell/router.tsx`**

Remove the import `import { BankView } from '../components/BankView';` and add:

```tsx
import { ImportScreen } from '../bank/ImportScreen';
import { StatementScreen } from '../bank/StatementScreen';
import { StatementsScreen } from '../bank/StatementsScreen';
import { TxScreen } from '../bank/TxScreen';
```

Replace the `/bank` LegacyTabs route object:

```tsx
        {
          path: '/bank',
          element: (
            <LegacyTabs
              title="Bank"
              tabs={[{ key: 'bank', label: 'Bank', El: BankView }]}
            />
          ),
        },
```

with the new route tree:

```tsx
        { path: '/bank', element: <StatementsScreen /> },
        { path: '/bank/import', element: <ImportScreen /> },
        { path: '/bank/statements/:id', element: <StatementScreen /> },
        { path: '/bank/statements/:id/tx/:txId', element: <TxScreen /> },
```

- [ ] **Step 4: Delete the legacy view**

```bash
git rm packages/web/src/components/BankView.tsx packages/web/src/components/BankView.test.tsx
grep -rn "BankView" src/ || echo "no BankView references left"
```

Expected: grep prints `no BankView references left`.

- [ ] **Step 5: Run the router test, then the full suite**

```bash
npx vitest run src/shell/router.test.tsx && npm test
```

Expected: router tests PASS (incl. the new Bank assertion); full suite PASS with the BankView tests gone.

- [ ] **Step 6: Commit**

```bash
git add -A packages/web/src
git commit -m "feat(web): mount redesigned Bank routes, delete legacy BankView"
```

---

### Task 13: Final verification + browser smoke

**Files:** none new; fixes only if verification fails.

- [ ] **Step 1: Full suite, lint, build**

```bash
npm test && npm run lint && npm run build
```

Expected: all tests PASS, no lint errors, `tsc -b` + vite build succeed.

- [ ] **Step 2: Manual browser smoke** (`npm run dev`, against a dev server with seeded data; resize between ~390px and ≥1024px — every check on BOTH widths)

Statements + import:
- `/bank` lists statements with period titles + unmatched badges; `done ✓` chip on a fully reconciled statement; empty DB shows the import CTA.
- `/bank/import`: choosing a CSV + account code enables the button; while running the stepper shows "AI mapping & rules" active; a bad file reaches the explicit failure box with the server's error and "Try again" resets; success shows "Open statement" leading into the statement.
- Old URL `/bank?tab=bank` still lands on the statements list.

Statement screen:
- Default segment "Unmatched N"; "All M" shows matched rows with the green 3px stripe + ✓ + dimmed text + `→ object` subtitle, and disposition rows with muted chips.
- AI-proposals tier: high-confidence rows pre-checked; the dark Book bar shows count + net; Book → rows move to Matched, toast "Booked N matches" with Undo; Undo returns them.
- A statement freshly imported with auto-staged drafts shows `staged` chips with per-row Confirm.
- Delete (header) → ConfirmDialog → back to `/bank`.

Tx screen — click through EVERY state:
- **G (matched):** hero dimmed context, "Matched with" card, coverage KV, Unmatch returns the line to unmatched.
- **C (candidates):** checkboxes with outstanding amounts; toggling recomputes "Match X €"; partial selection shows the amber "Line remainder … stays open" bar; matching returns to the statement with "Matched · X €" + Undo (J state).
- **A/B (create):** outgoing line without candidates opens on "Create expense from line"; VAT prefilled at 22%; picking "No receipt" locks VAT to 0.00; supplier sheet searches, and "New supplier" requires the Reg. key; Create & match → receipt toast (no Undo — by design), line turns matched.
- **Held path:** set the policy ceiling low (Settings → policy) and create an above-ceiling expense → toast explains it is held for approval; the line stays unmatched.
- **Incoming-open:** incoming line without invoices shows the green info bar + "Record prepayment · +X €" → confirm sheet → line shows the `prepayment` chip.
- **Personal:** Or-sheet → Personal → consequences sheet (no accounts, no balance) → "Record as personal" → line shows the `personal` chip; verify Personal is absent on incoming lines and matched lines.
- **Bank fee:** Or-sheet → Bank fee on a small outgoing line → one tap creates + matches the VAT-0 expense.
- **Disposed:** reopening a personal/prepayment line shows the read-only disposition card.
- Deep-link an unmatched tx URL and F5 — the state machine re-routes correctly.

- [ ] **Step 3: Commit any smoke fixes**

```bash
git add -A packages/web && git commit -m "fix(web): bank smoke fixes"
```

(Skip if nothing needed fixing.)

---

## Appendix A — Server gaps & degradation (binding for this plan)

Every gap below is a SERVER gap this client-only plan degrades around. The client behavior is the contract; the server work is queued for a later dedicated step (per the spec's "Delivery shape" item 2).

| # | Spec/mockup expectation | Server reality (verified) | Client degradation in this plan |
|---|---|---|---|
| 1 | State A: counterparty auto-resolved from the line via aliases | No alias-lookup-by-string endpoint | States A and B merge into one `create` state with a searchable supplier picker + inline create; on create the line's IBAN/descriptor/description are written back as aliases (`addEntityAlias`) so the server's OWN matcher improves next month |
| 2 | State D: "same as last month" recurring repeat | No recurring-detection endpoint | State D omitted entirely; recurring lines fall through to `create` |
| 3 | "Ждут документ" queue + late-document auto-attach; 📎 marker on rows | No waiting-for-document marker or auto-attach | The document-policy toggle affects ONLY the created expense's VAT: "Receipt coming later" keeps computed VAT; "No receipt" forces VAT 0 (non-deductible). No queue, no 📎 marker — Books plan + server work |
| 4 | Category prefilled from classification memory ("Meals · 8 of 9") | No per-supplier memory endpoint | Plain category select, no prefill or frequency hint |
| 5 | VAT auto-computed "by country rate" | No endpoint exposes the plugin's VAT rate | Client constant `STANDARD_VAT_RATE_PCT = 22` prefills; the field stays editable; VAT 0 forced for no-receipt |
| 6 | Personal sheet shows live owner-debt balance ("217.80 → 236.40") | `markPersonal` returns only the voucher; no balance endpoint | Sheet explains consequences in words, without the running balance |
| 7 | Incoming line offers "close owner's debt" repayment | No owner-debt-repayment disposition endpoint | Not offered; incoming-open state offers customer prepayment only |
| 8 | One-tap "Bank fee" disposition (`bank_fee` status) | No fee endpoint sets that status | Fee = create-expense with plugin category `'bank fee'`, VAT 0, no supplier, then match. The line ends up MATCHED to a fee expense (status stays `open`), not `bank_fee`-chipped |
| 9 | State C: "Match 300 + prepayment 200" combined button | `createPrepayment` books the WHOLE line and requires `open` + matchless | Combined action removed; a partial remainder stays open and visible on the line; whole-line prepayment offered only on matchless lines via the Or-sheet |
| 10 | "Create & match" undoable 5s (draft expense deletable) | The pipeline POSTS the expense (immutable); only drafts are deletable | Create&match shows a receipt toast WITHOUT Undo; recovery = Unmatch + correction flow (Books plan). Match-only actions keep full Undo |
| 11 | G shows match provenance (when, how, confidence, who) | `MatchRowView` has no timestamps/signal/actor | G shows what-it-matched + coverage only |
| 12 | Matched row links to the object ("→ Expense · Elisa ›") | `MatchRowView` lacks `objectType`/`objectId`; Books detail routes don't exist yet | Object label shown as text, not a navigation (cross-link lands with the Books plan + a server field addition) |
| 13 | Numeric AI confidence chip ("0.91") | API returns categorical `high/medium/low` | Chips show the categorical word |
| 14 | Statement titled "Июнь · EUR" (account + currency) | `BankStatement` exposes only the period + upload time | Titles are period-only ("Jun 2026") |
| 15 | Policy guardrail: no-doc expenses above threshold go to approval | Policy holds by amount ceiling / unknown supplier (not by doc policy) | The held path is surfaced honestly ("held for approval: <reason>"); doc-policy-specific gating is server work |

## Appendix B — Follow-ups for later plans

- **Books plan:** "Ждут документ" queue + auto-attach suggestion (server: waiting-doc marker, match-by-supplier+amount±date); expense detail route so matched lines can link to their object (server: add `objectType`/`objectId` to `MatchRowView`); correction flow as the recovery path for wrongly created from-line expenses.
- **Server step (spec delivery-shape item 2):** alias lookup by counterparty string (turns the merged create state back into distinct A/B with prefill); recurring detection (state D); partial-amount prepayment (restores the C-state combined button); owner-debt balance + repayment disposition; bank-fee disposition endpoint; classification-memory hint; VAT-rate exposure.
- **Desktop power features (deferred, from the asset's gesture spec):** two-pane list+tx layout, j/k row navigation, Enter/e/p/f/m/u hotkeys, 1…9 candidate toggles, Space document peek; mobile swipe actions (right = primary, left = more) and long-press multi-select bulk create — these need the `motion` gesture layer and are UX sugar on top of the routes built here.
- **Inbox plan:** held-for-approval expenses created from lines appear in the approvals queue; after approval the line can be matched — consider a "match now" affordance on the approval receipt.

## Appendix C — Spec coverage map (self-review)

Asset routing matrix (8 contexts) → this plan: already-matched → G (Task 8) ✅; AI proposal ≥0.85 → high-confidence preselect in statement tier (Task 7) + candidate preselect (Task 9) ✅ (categorical confidence, gap 13); candidates exist → C (Task 9) ✅ (remainder degradation, gap 9); recurring → ❌ omitted (gap 2); alias hit → merged create (Task 10, gap 1); unknown counterparty → create + inline supplier (Task 10) ✅; incoming no invoices → incoming-open (Task 11) ✅ (owner-debt repayment gap 7); fee heuristic → Or-sheet fee action (Task 11, gap 8 — no heuristic emphasis). Mock states: A/B (Task 10), C (Task 9), D (gap 2), G (Task 8), J = post-action return with Undo toast + updated sections (Tasks 7/11) ✅. Statement screen §6: two tiers ✅, bulk Book with server-side cap ✅, color coding ✅, default Unmatched segment ✅, import stepper ✅ (ADR-0031), statements badge ✅. §6★ document policy incl. VAT-0-no-receipt ✅ (queue gap 3). §6★b personal without chart of accounts ✅ (balance gap 6). Global data rules: IDs never shown ✅; reasons with numbers where the server provides them (policy hold reason, cap 409 text) ✅; euro inputs ✅; amounts tabular/right/no-wrap ✅; irreversible-action confirms ✅.
