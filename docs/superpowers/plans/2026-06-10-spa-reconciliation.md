# Reconciliation in the Operator SPA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Give operators a UI to reconcile bank transactions: propose matches, review them in business-object terms, book the chosen ones, and disposition the rest as prepayment/personal — by extending `BankView`. Backed by three small backend additions: an enriched propose response, a per-transaction reconciliation-status read, and a bank-line over-allocation guard.

**Architecture:** Reconciliation already exists as a backend matching engine (`ReconciliationService`: propose → execute, atomic, FX). This work (a) makes `proposeMatches` return display-enriched proposals (business object + counterparty, `voucherId` carried but never displayed — ADR-0030), (b) adds `GET /api/bank-statements/:id/reconciliation` returning per-txn matched/remaining, (c) adds a bank-line over-allocation guard to `executeMatch` (symmetric to the existing voucher guard), and (d) extends `BankView` with the propose→book→disposition loop.

**Tech Stack:** NestJS 11, Kysely/better-sqlite3, Jest 30, TS strict (zero `any`/`as`), Node 24. Frontend: React + Vite + Vitest + Tailwind.

**Design decisions (resolved in /grill-me):**
- Scope = core loop (propose → select → book + prepayment/personal). Draw-down + manual FX deferred.
- ADR-0030: enrich proposal for display; `voucherId` rides opaque (client never shows it, only round-trips it to `/match`).
- Placement: extend `BankView` (rename tab label to "Bank").
- Match visibility: add a backend status read; UI shows Matched/Partial/Open badges and blocks over-allocation.
- Over-allocation: also add a server-side guard in `executeMatch`.
- `amount_matched` is in BASE currency; `bank_transaction.amount` is in the txn's currency — convert before comparing.

---

## Node environment

Every backend shell: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null;` from `/Users/alekseirevin/test/hb-recon`. Gates:
- Backend source: `npx tsc -p tsconfig.build.json --noEmit`
- Backend unit: `npm test`; e2e: `npm run test:e2e`
- Lint: `npm run lint`
- Frontend: `cd frontend && npm run build` (tsc+vite) and `npm test` (vitest)

---

## Task B1: Enrich `proposeMatches` with business-object display fields

**Files:**
- Modify: `src/reconciliation/reconciliation.types.ts` (add `MatchProposalView`)
- Modify: `src/reconciliation/reconciliation.service.ts` (post-pass enrichment; `proposeMatches` returns `MatchProposalView[]`)
- Modify: `src/reconciliation/reconciliation.controller.ts` (return type)
- Test: `src/reconciliation/reconciliation.service.spec.ts` (add enrichment cases)

The proposal builders are UNCHANGED. After `proposeMatches` collects `MatchProposal[]`, a private `enrichProposals()` resolves each distinct `voucherId` to its business object + counterparty + remaining, producing `MatchProposalView[]`. `voucherId` stays in the payload (the client round-trips it to `/match` but never renders it).

- [ ] **Step 1: Add the `MatchProposalView` type**

In `src/reconciliation/reconciliation.types.ts`, after `MatchProposal`:

```ts
/** The business object a matched voucher belongs to (operator-facing, ADR-0030). */
export type MatchObjectType = 'sales_invoice' | 'expense' | 'prepayment';

/**
 * A MatchProposal enriched for the operator UI: the underlying voucher is
 * described in BUSINESS-OBJECT terms (invoice / expense / prepayment) plus the
 * counterparty and the voucher's remaining balance. `voucherId` is retained for
 * the execute round-trip but is NEVER displayed (ADR-0001/0030).
 */
export interface MatchProposalView extends MatchProposal {
  /** What the matched voucher represents to an operator. */
  objectType: MatchObjectType;
  /** The business object's id (sales_invoice.id / expense.id), null for prepayment. */
  objectId: number | null;
  /** Human label: invoice number, "Expense #<id>", or "Prepayment". */
  objectLabel: string;
  /** Counterparty (customer/supplier) name, null when unresolved (e.g. prepayment). */
  counterpartyName: string | null;
  /** The voucher's remaining unmatched balance in BASE currency cents. */
  voucherRemaining: number;
}
```

- [ ] **Step 2: Write failing enrichment tests**

Add to `src/reconciliation/reconciliation.service.spec.ts` (inside the existing describe; reuse its DB/seed harness — read the file first to match its seeding helpers). Two cases:

```ts
  it('enriches an invoice-number proposal with sales_invoice label + customer name', async () => {
    // Seed: customer entity, a posted sales_invoice with invoice_number + voucher,
    // and an open incoming bank txn whose reference contains the invoice number.
    // (Use the spec's existing seed helpers.)
    const proposals = await service.proposeMatches(statementId);
    const p = proposals.find((x) => x.signal === 'invoice_number');
    expect(p).toBeDefined();
    expect(p!.objectType).toBe('sales_invoice');
    expect(p!.objectLabel).toContain('INV');
    expect(p!.counterpartyName).toBe('Acme Ltd');
    expect(p!.voucherRemaining).toBeGreaterThan(0);
    // voucherId still present (round-trips to /match) though never displayed.
    expect(typeof p!.voucherId).toBe('number');
  });

  it('enriches an AP (expense) counterparty proposal with supplier name', async () => {
    // Seed: supplier entity, a posted expense with voucher + AP line, an open
    // outgoing bank txn with counterparty_iban resolving to the supplier.
    const proposals = await service.proposeMatches(statementId);
    const p = proposals.find((x) => x.objectType === 'expense');
    expect(p).toBeDefined();
    expect(p!.counterpartyName).toBe('Supplier GmbH');
    expect(p!.objectLabel).toContain('Expense');
  });
```

Run: `npx jest src/reconciliation/reconciliation.service.spec.ts` → the new cases FAIL (proposals lack the fields).

- [ ] **Step 3: Implement the enrichment post-pass**

In `reconciliation.service.ts`:

1. Change `proposeMatches` return type to `Promise<MatchProposalView[]>` and, before returning, `return this.enrichProposals(allProposals);`.

2. Add the private helper (uses `EntitiesService.findById` for names; reverse-joins `sales_invoice`/`expense` by `voucher_id`; remaining via `outstandingVouchers`):

```ts
  /**
   * Enrich raw proposals into operator-facing views: resolve each distinct
   * voucherId to its business object (sales_invoice / expense / prepayment),
   * counterparty name, and remaining balance. voucherId is retained for the
   * execute round-trip but never rendered (ADR-0030).
   */
  private async enrichProposals(
    proposals: MatchProposal[],
  ): Promise<MatchProposalView[]> {
    const views: MatchProposalView[] = [];
    // Small per-voucher resolution (proposal sets are small); memoise by voucherId.
    const cache = new Map<
      number,
      {
        objectType: MatchObjectType;
        objectId: number | null;
        objectLabel: string;
        counterpartyName: string | null;
        voucherRemaining: number;
      }
    >();

    for (const p of proposals) {
      let info = cache.get(p.voucherId);
      if (!info) {
        info = await this.resolveVoucherDisplay(p.voucherId, p.matchType);
        cache.set(p.voucherId, info);
      }
      views.push({ ...p, ...info });
    }
    return views;
  }

  private async resolveVoucherDisplay(
    voucherId: number,
    matchType: MatchType,
  ): Promise<{
    objectType: MatchObjectType;
    objectId: number | null;
    objectLabel: string;
    counterpartyName: string | null;
    voucherRemaining: number;
  }> {
    // Prepayment vouchers carry no business object.
    if (matchType === 'prepayment') {
      const voucherRemaining =
        await this.outstandingVouchers.getRemainingPrepaymentBalance(voucherId);
      return {
        objectType: 'prepayment',
        objectId: null,
        objectLabel: 'Prepayment',
        counterpartyName: null,
        voucherRemaining,
      };
    }

    const voucherRemaining =
      await this.outstandingVouchers.getRemainingVoucherBalance(voucherId);

    const invoice = await this.db
      .selectFrom('sales_invoice')
      .select(['id', 'invoice_number', 'customer_id'])
      .where('voucher_id', '=', voucherId)
      .executeTakeFirst();
    if (invoice) {
      const name = await this.safeEntityName(invoice.customer_id);
      return {
        objectType: 'sales_invoice',
        objectId: invoice.id,
        objectLabel: invoice.invoice_number,
        counterpartyName: name,
        voucherRemaining,
      };
    }

    const expense = await this.db
      .selectFrom('expense')
      .select(['id', 'supplier_id'])
      .where('voucher_id', '=', voucherId)
      .executeTakeFirst();
    if (expense) {
      const name = await this.safeEntityName(expense.supplier_id);
      return {
        objectType: 'expense',
        objectId: expense.id,
        objectLabel: `Expense #${expense.id}`,
        counterpartyName: name,
        voucherRemaining,
      };
    }

    // Voucher with no recognised business object — degrade gracefully.
    return {
      objectType: 'prepayment',
      objectId: null,
      objectLabel: `Voucher settlement`,
      counterpartyName: null,
      voucherRemaining,
    };
  }

  /** Entity name by id, null when unset/unknown (never throws into the UI path). */
  private async safeEntityName(entityId: number | null): Promise<string | null> {
    if (entityId === null) return null;
    try {
      const entity = await this.entitiesService.findById(entityId);
      return entity.name;
    } catch {
      return null;
    }
  }
```

Add `MatchObjectType`, `MatchProposalView` to the imports from `./reconciliation.types`. (`expense.supplier_id` / `sales_invoice.customer_id` may be nullable in the schema — `safeEntityName` already handles null. If `customer_id`/`supplier_id` column names differ, grep `src/database/migrations/006_create_expenses.ts` and the sales_invoice migration to confirm.)

- [ ] **Step 4: Update the controller return type**

In `reconciliation.controller.ts`, change `proposeMatches` to `Promise<MatchProposalView[]>` and import `MatchProposalView` instead of `MatchProposal` for that signature.

- [ ] **Step 5: Run gates**

```
npx tsc -p tsconfig.build.json --noEmit
npx jest src/reconciliation/reconciliation.service.spec.ts
```
Both pass.

- [ ] **Step 6: Commit**

```bash
git add src/reconciliation/reconciliation.types.ts src/reconciliation/reconciliation.service.ts src/reconciliation/reconciliation.controller.ts src/reconciliation/reconciliation.service.spec.ts
git commit -m "feat(reconciliation): enrich proposeMatches with business-object display fields"
```

---

## Task B2: Per-transaction reconciliation status read

**Files:**
- Modify: `src/reconciliation/reconciliation.types.ts` (add `ReconciliationStatusRow`)
- Modify: `src/reconciliation/reconciliation.service.ts` (`getStatementReconciliation`)
- Modify: `src/reconciliation/reconciliation.controller.ts` (`GET :id/reconciliation`)
- Test: `src/reconciliation/reconciliation.service.spec.ts`

Returns, per transaction in the statement: the bank-line base amount, the matched sum (base), the remaining, and a derived status. The UI uses this for badges and to cap booking.

- [ ] **Step 1: Add the type**

In `reconciliation.types.ts`:

```ts
/** Per-transaction reconciliation state for the operator UI. */
export interface ReconciliationStatusRow {
  bankTransactionId: number;
  /** |amount| converted to BASE currency cents (the matchable total). */
  amountBase: number;
  /** SUM(reconciliation_match.amount_matched) for this txn, BASE cents. */
  matchedSum: number;
  /** amountBase - matchedSum (>= 0). */
  remaining: number;
  /** Derived: 'matched' (remaining 0 & matched>0) | 'partial' | 'open'. */
  reconStatus: 'matched' | 'partial' | 'open';
}
```

- [ ] **Step 2: Write the failing test**

Add to the spec: seed a statement with one txn (EUR base), book a partial match, assert `getStatementReconciliation(statementId)` returns one row with `matchedSum` = the booked amount, `remaining` = amountBase − matched, `reconStatus` = 'partial'. (Reuse the spec's `executeMatch` path to create the match.)

```ts
  it('reports per-transaction matched/remaining and a derived status', async () => {
    // seed txn + voucher, book a partial match via service.executeMatch(...)
    const rows = await service.getStatementReconciliation(statementId);
    const row = rows.find((r) => r.bankTransactionId === txnId)!;
    expect(row.matchedSum).toBe(partialAmount);
    expect(row.remaining).toBe(row.amountBase - partialAmount);
    expect(row.reconStatus).toBe('partial');
  });
```

Run → FAIL (method missing).

- [ ] **Step 3: Implement `getStatementReconciliation`**

```ts
  /**
   * Per-transaction reconciliation state for a statement: the matchable base
   * amount, how much is already matched, and the remaining. Drives the operator
   * UI's badges and over-allocation cap. matched sums are BASE cents (matching
   * amount_matched), so the bank line's own amount is converted to base too.
   */
  async getStatementReconciliation(
    statementId: number,
  ): Promise<ReconciliationStatusRow[]> {
    const transactions =
      await this.transactionRepo.findByStatementId(statementId);

    const rows: ReconciliationStatusRow[] = [];
    for (const txn of transactions) {
      const { baseAmount: amountBase } = await this.currencyService.toBase(
        Math.abs(txn.amount),
        txn.currency,
        txn.transaction_date,
      );

      const matched = await this.db
        .selectFrom('reconciliation_match')
        .select((eb) => eb.fn.sum('amount_matched').as('sum'))
        .where('bank_transaction_id', '=', txn.id)
        .executeTakeFirst();
      const matchedSum = Number(matched?.sum ?? 0);
      const remaining = Math.max(0, amountBase - matchedSum);
      const reconStatus: ReconciliationStatusRow['reconStatus'] =
        matchedSum <= 0 ? 'open' : remaining <= 0 ? 'matched' : 'partial';

      rows.push({
        bankTransactionId: txn.id,
        amountBase,
        matchedSum,
        remaining,
        reconStatus,
      });
    }
    return rows;
  }
```

(Confirm `eb.fn.sum` is the Kysely idiom used elsewhere — grep `fn.sum`/`fn.count` in `src/`. The VAT report uses `db.fn.count`; mirror that style.)

- [ ] **Step 4: Add the controller route**

In `reconciliation.controller.ts`:

```ts
  /** Per-transaction reconciliation state for a statement (UI badges + caps). */
  @Get(':id/reconciliation')
  async getStatementReconciliation(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ReconciliationStatusRow[]> {
    return this.service.getStatementReconciliation(id);
  }
```

Add `Get` to the `@nestjs/common` import and `ReconciliationStatusRow` to the type import.

- [ ] **Step 5: Gates + commit**

```
npx tsc -p tsconfig.build.json --noEmit && npx jest src/reconciliation/reconciliation.service.spec.ts
git add src/reconciliation/reconciliation.types.ts src/reconciliation/reconciliation.service.ts src/reconciliation/reconciliation.controller.ts src/reconciliation/reconciliation.service.spec.ts
git commit -m "feat(reconciliation): add per-transaction status read (matched/remaining)"
```

---

## Task B3: Bank-line over-allocation guard in `executeMatch`

**Files:**
- Modify: `src/reconciliation/reconciliation.service.ts` (`executeMatch`)
- Test: `src/reconciliation/reconciliation.service.spec.ts`

Today `executeMatch` only guards the VOUCHER remaining. A bank line can be matched across vouchers beyond its own amount. Add a symmetric guard: the sum of `amount_matched` for a bank transaction (persisted + this batch) must not exceed the line's base amount.

- [ ] **Step 1: Write the failing test**

```ts
  it('rejects matches that over-allocate the bank line beyond its amount', async () => {
    // Seed one EUR bank txn of 100.00 and TWO open invoices of 100.00 each.
    // Propose/execute a 100.00 match against invoice A (ok), then attempt a
    // second 100.00 match of the SAME txn against invoice B → must throw.
    await service.executeMatch([proposalA]); // ok, fully allocates the line
    await expect(service.executeMatch([proposalB])).rejects.toThrow(
      /over-allocate|bank line|exceeds/i,
    );
  });
```

Run → FAIL (currently succeeds, over-allocating).

- [ ] **Step 2: Implement the guard**

In `executeMatch`, BEFORE the atomic block, precompute each distinct txn's base amount (currency conversion can't run meaningfully inside the better-sqlite3 sync transaction, and the line amount is immutable):

```ts
    // Precompute each bank line's matchable BASE amount (immutable; conversion
    // outside the atomic block). amount_matched is base cents, so the per-line
    // cap must be base too.
    const txnBaseAmount = new Map<number, number>();
    for (const txnId of txnIds) {
      const txn = txnMap.get(txnId)!;
      const { baseAmount } = await this.currencyService.toBase(
        Math.abs(txn.amount),
        txn.currency,
        txn.transaction_date,
      );
      txnBaseAmount.set(txnId, baseAmount);
    }
```

Inside the `db.transaction()` callback, alongside `batchMatchedByVoucher`, add `const batchMatchedByTxn = new Map<number, number>();` and, for each proposal AFTER the voucher guard passes (before/with the insert), check the bank-line cap:

```ts
        // ── Bank-line over-allocation guard (symmetric to the voucher guard) ──
        const persistedTxnMatched = await trx
          .selectFrom('reconciliation_match')
          .select((eb) => eb.fn.sum('amount_matched').as('sum'))
          .where('bank_transaction_id', '=', proposal.bankTransactionId)
          .executeTakeFirst();
        const txnAlreadyPersisted = Number(persistedTxnMatched?.sum ?? 0);
        const txnAlreadyBatch =
          batchMatchedByTxn.get(proposal.bankTransactionId) ?? 0;
        const lineCap = txnBaseAmount.get(proposal.bankTransactionId) ?? 0;
        if (
          txnAlreadyPersisted + txnAlreadyBatch + proposal.amountMatched >
          lineCap
        ) {
          throw new ConflictException(
            `Match of ${proposal.amountMatched} would over-allocate bank line ` +
              `${proposal.bankTransactionId}: only ` +
              `${lineCap - txnAlreadyPersisted - txnAlreadyBatch} of the line remains`,
          );
        }
```

After the successful insert, update the batch map:

```ts
        batchMatchedByTxn.set(
          proposal.bankTransactionId,
          txnAlreadyBatch + proposal.amountMatched,
        );
```

- [ ] **Step 3: Gates + commit**

```
npx tsc -p tsconfig.build.json --noEmit && npx jest src/reconciliation/reconciliation.service.spec.ts
git add src/reconciliation/reconciliation.service.ts src/reconciliation/reconciliation.service.spec.ts
git commit -m "fix(reconciliation): guard bank-line over-allocation in executeMatch"
```

---

## Task F1: Frontend API client — reconciliation calls + types

**Files:**
- Modify: `frontend/src/api.ts`

Add types mirroring the backend and the call helpers. `voucherId` is part of the proposal payload (round-tripped to `/match`) but the view never renders it.

- [ ] **Step 1: Add types + calls**

In `frontend/src/api.ts`, after the bank section:

```ts
// ── Reconciliation ────────────────────────────────────────────────────────
// Proposals describe vouchers in BUSINESS-OBJECT terms (ADR-0030); voucherId is
// carried for the /match round-trip only and is never rendered.
export interface MatchProposalView {
  bankTransactionId: number;
  voucherId: number;
  matchType: 'exact' | 'partial' | 'prepayment';
  amountMatched: number; // BASE cents
  confidence: 'high' | 'medium' | 'low';
  signal: 'invoice_number' | 'counterparty' | 'amount_date';
  objectType: 'sales_invoice' | 'expense' | 'prepayment';
  objectId: number | null;
  objectLabel: string;
  counterpartyName: string | null;
  voucherRemaining: number;
}

export interface ReconciliationStatusRow {
  bankTransactionId: number;
  amountBase: number;
  matchedSum: number;
  remaining: number;
  reconStatus: 'matched' | 'partial' | 'open';
}

export const proposeMatches = (statementId: number) =>
  apiFetch<MatchProposalView[]>(
    `/api/bank-statements/${statementId}/propose-matches`,
    { method: 'POST' },
  );

export const getReconciliationStatus = (statementId: number) =>
  apiFetch<ReconciliationStatusRow[]>(
    `/api/bank-statements/${statementId}/reconciliation`,
  );

// The execute endpoint accepts the base MatchProposal fields. Strip the display
// extras before sending; the server also returns ledger data we deliberately
// ignore (ADR-0030) — typed as the match count only.
export const executeMatches = (
  statementId: number,
  proposals: MatchProposalView[],
) =>
  apiFetch<{ records: { id: number }[] }>(
    `/api/bank-statements/${statementId}/match`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        matches: proposals.map((p) => ({
          bankTransactionId: p.bankTransactionId,
          voucherId: p.voucherId,
          matchType: p.matchType,
          amountMatched: p.amountMatched,
          confidence: p.confidence,
          signal: p.signal,
        })),
      }),
    },
  );

// Prepayment / Personal post ledger vouchers; the UI ignores the returned
// voucher (ADR-0030) and only needs success/failure.
export const createPrepayment = (bankTransactionId: number) =>
  apiFetch<unknown>(`/api/bank-transactions/${bankTransactionId}/prepayment`, {
    method: 'POST',
  });

export const markPersonal = (bankTransactionId: number) =>
  apiFetch<unknown>(`/api/bank-transactions/${bankTransactionId}/personal`, {
    method: 'POST',
  });
```

- [ ] **Step 2: Gate**

`cd frontend && npx tsc --noEmit` (or `npm run build`) — clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api.ts
git commit -m "feat(spa): reconciliation API client (propose/status/match/prepayment/personal)"
```

---

## Task F2: Extend `BankView` with the reconciliation loop

**Files:**
- Modify: `frontend/src/components/BankView.tsx`
- Modify: `frontend/src/components/BankView.test.tsx` (add reconciliation cases)
- Modify: `frontend/src/tabs.tsx` (rename bank tab label to "Bank")

When a statement is selected and its transactions load, also fetch reconciliation status. Each txn row shows a **match badge** (Open / Partial €X left / Matched). A **"Propose matches"** button loads proposals; proposals render grouped under their transaction with a checkbox, confidence badge, business label, counterparty, and amount. **"Book selected"** posts them, then refreshes status + clears proposals. Unmatched (open) txns show **Prepayment** / **Personal** buttons (Personal disabled for incoming/positive amounts). Selecting proposals beyond a line's `remaining` is blocked.

- [ ] **Step 1: Read the current `BankView.test.tsx`** to match its mocking style (it mocks `../api`). New cases will mock `proposeMatches`, `getReconciliationStatus`, `executeMatches`, `createPrepayment`, `markPersonal`.

- [ ] **Step 2: Write failing tests**

Add to `BankView.test.tsx` (mirror existing `vi.mock('../api')` setup):

```ts
  it('shows a match badge from reconciliation status', async () => {
    // mock listBankTransactions → one txn; getReconciliationStatus → partial
    // render, click View, assert a "left" / "Partial" badge appears
  });

  it('proposes matches and books a selected proposal', async () => {
    // mock proposeMatches → one MatchProposalView (objectLabel 'INV-1', counterparty 'Acme')
    // click "Propose matches"; assert the label + counterparty render (NOT voucherId)
    // check the proposal box, click "Book selected"; assert executeMatches called
    // with the proposal, and getReconciliationStatus refetched
  });

  it('dispositions an open outgoing txn as personal', async () => {
    // open outgoing txn; click "Personal"; confirm; assert markPersonal called
  });
```

Run: `cd frontend && npm test` → FAIL.

- [ ] **Step 3: Implement the extension**

Add state + effects in `BankView.tsx`:
- `const [recon, setRecon] = useState<ReconciliationStatusRow[]>([]);`
- `const [proposals, setProposals] = useState<MatchProposalView[]>([]);`
- `const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());` — proposal key = `${bankTransactionId}:${voucherId}`.
- In `viewTransactions`, after loading txns: `setProposals([]); setSelectedKeys(new Set()); void loadRecon(id);` where `loadRecon` calls `getReconciliationStatus` into `recon`.
- `onPropose`: `setProposals(await proposeMatches(selected))`.
- `onBook`: `await executeMatches(selected, [...selected proposals]); setProposals([]); setSelectedKeys(new Set()); await loadRecon(selected); await viewTransactions(selected)` (refresh). Wrap in try/catch → `setError` on `ConflictException` message.
- `onPrepayment(txnId)` / `onPersonal(txnId)`: `window.confirm`, call the api, then `loadRecon` + reload txns.
- Selection cap: when toggling a proposal on, sum selected `amountMatched` for that `bankTransactionId` and reject if it would exceed the txn's `remaining` (from `recon`); surface an inline note instead.

Render changes (in the transactions table):
- Add a **Match** column: look up `recon` by txn id → badge: `open` (gray "Open"), `partial` (amber "€{remaining/100} left"), `matched` (green "Matched"). Use `fmtCents(row.remaining)`.
- Add a "Propose matches" button above the table (calls `onPropose`), and a "Book selected (N)" button (disabled when none selected).
- Under each txn row (or in an expandable area), render that txn's proposals: checkbox (key-based), `confidence` pill (high=green/med=amber/low=gray), `objectLabel`, `counterpartyName ?? '—'`, `fmtCents(amountMatched)`. NEVER render `voucherId`.
- For each `open` txn with no proposals selected: **Prepayment** button always; **Personal** button disabled when `t.amount > 0`.

Keep all existing import/statement/delete UI intact. Use the existing Tailwind classes for consistency.

- [ ] **Step 4: Rename the tab label**

In `frontend/src/tabs.tsx`, `bankTab.label`: `'Bank import'` → `'Bank'`.

- [ ] **Step 5: Gates**

```
cd frontend && npm test && npm run build
```
Both pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/BankView.tsx frontend/src/components/BankView.test.tsx frontend/src/tabs.tsx
git commit -m "feat(spa): reconciliation in BankView — propose, book, prepayment/personal, match badges"
```

---

## Task G: Full gate

- [ ] Backend: `npx tsc -p tsconfig.build.json --noEmit` · `npm run lint` · `npm test` · `npm run test:e2e` — all green.
- [ ] Frontend: `cd frontend && npm test && npm run build` — green.
- [ ] If `npm run lint` re-wraps unrelated files (known cosmetic drift), `git checkout --` those before committing.

## Self-review
- `voucherId` never rendered in `BankView` (grep the component) — ADR-0030 honored on the surface.
- Over-allocation blocked both client-side (cap from status) and server-side (executeMatch guard).
- Backend proposal builders unchanged; enrichment is an isolated post-pass.
- `amount_matched` (base) vs `bank_transaction.amount` (txn ccy) reconciled via `currencyService.toBase` in both the status read and the guard.
