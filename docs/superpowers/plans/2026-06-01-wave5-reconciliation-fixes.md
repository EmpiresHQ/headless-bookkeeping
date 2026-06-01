# Wave 5 Reconciliation — Correctness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 9 confirmed correctness findings from the Wave 5 code review (FX sign, FX partial-match base, invoice-number AP branch, hardcoded bank account, personal-disposition sign, AR/AP balance netting, base-currency conversion in FX/draw-down/matching).

**Architecture:** Most fixes are local to four services (`fx-realized`, `reconciliation`, `personal-disposition`, `prepayment`). The cross-cutting theme is removing the implicit "bank account currency == base currency" assumption: amounts that hit the ledger must be converted to base via the country plugin's `getReferenceRate`, and the bank leg must use the *real* bank account resolved from the statement (not a hardcoded `BANK_EUR`). Tasks are ordered so that files are touched by **one task at a time** (no parallel edits to the same file) and clear bugs land before the multi-currency work.

**Tech Stack:** NestJS, TypeScript, Kysely (SQLite), Jest. In-memory SQLite per spec; migrations seed accounts; `voucher_sequence` seeded to avoid ID clashes.

**Ledger invariants (from `LedgerValidationService.validateVoucherLines`):**
- ≥2 lines; all amounts positive integers (cents); direction via `is_debit`.
- `base_amount === round(amount × fx_rate)` (±1 cent).
- Lines on a foreign-currency *account* must have matching `currency`.
- `sum(debit base_amount) === sum(credit base_amount)`.

**Base currency:** `CurrencyService.getBaseCurrency()` → org override or plugin default (`'EUR'`). Convert via `plugin.getReferenceRate(from, to, date)` (returns 1.0 for same currency; NullCountryPlugin throws on a real cross-currency pair — so cross-currency only works once a real plugin is registered, which is acceptable: the code path must be *correct*, even if the null plugin can't exercise it).

---

## DESIGN DECISIONS (accounting policy — confirm before executing Part B)

- **D1 (FX direction, #1):** `isIncoming = txn.amount >= 0`. Gain/loss: `isGain = isIncoming ? realized < 0 : realized > 0` where `realized = bookedBase − actualBase`. Incoming = AR settlement, outgoing = AP settlement.
- **D2 (FX partial base, #2):** Scale actual base to the matched portion of the voucher's full booked AR/AP base: `proportion = clamp(matchedAmount / fullBookedBase, 0..1)`, `actualBaseForMatch = round(fullActualBase × proportion)`. Assumes one bank line settles one voucher (documented limitation).
- **D3 (FX base conversion, #6):** `actualBase` must be expressed in **base currency**. `fullActualBase = round(|source_amount| × bankToBaseRate)` where `bankToBaseRate = getReferenceRate(source_currency, baseCurrency, date)` when the bank gave us a foreign `source_amount`; otherwise `round(|amount| × getReferenceRate(txn.currency, baseCurrency, date))`. The FX voucher books `FX_GAIN_LOSS` and the **base-currency bank account** (`BANK_EUR`/base) both in base currency, `fx_rate = 1.0`. Rationale: realized FX is a base-currency P&L figure; booking it against the base bank account keeps the foreign bank account's own currency clean.
- **D4 (resolve bank account, #4):** Resolve the bank leg account by joining `bank_transaction → bank_statement → account` (as `FXRealizedService` already does). Bank leg: `currency = txn.currency`, `fx_rate = getReferenceRate(txn.currency, base, date)`, `base_amount = round(amount × fx_rate)`. Non-bank leg booked in base currency, `fx_rate 1.0`.
- **D5 (personal-disposition sign, #5):** Personal dispositions are outflows only (per ADR-0017 / code comment). Validate `txn.amount < 0`; reject `amount >= 0` with `BadRequestException` (inflow personal accounting is out of scope, not silently mis-booked).
- **D6 (AR/AP balance, #7):** Net AR/AP lines by sign: `net = Σ(is_debit ? +base : −base)`, balance = `abs(net)`. Additionally exclude reconciliation contra/draw-down vouchers from candidate open items by only treating a voucher as an open AR/AP item when it is linked from `sales_invoice.voucher_id` / `expense.voucher_id` (origin invoice), not when it is a system draw-down voucher.
- **D7 (match currency normalization, #9):** Before comparing, convert the bank transaction amount to base: `absBase = round(|txn.amount| × getReferenceRate(txn.currency, base, date))` and compare against `remainingBalance` (already base). `amountMatched` is in base.

---

# PART A — Unambiguous correctness bugs

### Task 1: FX realized sign by settlement direction (#1)

**Files:**
- Modify: `src/reconciliation/fx-realized.service.ts` (computeAndPost, ~lines 108–161)
- Test: `src/reconciliation/fx-realized.service.spec.ts`

- [ ] **Step 1: Write the failing test** — add to the existing describe block. Seed an AP (expense) voucher booked at base 70000 from a foreign supplier payment where the bank actually paid more base (actualBase 71400 → a LOSS), settle it via an *outgoing* bank transaction (`amount` negative), call `computeAndPost(voucherId, txnId, 70000)`, and assert the posted voucher debits `FX_GAIN_LOSS` and credits the bank (loss), not the reverse.

```typescript
it('posts a LOSS (Dr FX_GAIN_LOSS / Cr bank) for an outgoing AP settlement where actual base exceeds booked', async () => {
  // foreign supplier paid: source 10000 USD @ 7.14 => actualBase 71400; booked 70000 => loss 1400
  const { txnId, voucherId } = await seedOutgoingForeignApSettlement({
    bookedBase: 70000,
    sourceAmount: 10000,
    fxRate: 7.14,
  });
  const result = await fxRealizedService.computeAndPost(voucherId, txnId, 70000);
  expect(result.status).toBe('posted');
  const lines = result.voucher!.lines;
  const fx = lines.find((l) => l.account_id === fxGainLossAccountId)!;
  const bank = lines.find((l) => l.account_id === baseBankAccountId)!;
  expect(fx.is_debit).toBe(true);   // loss => FX_GAIN_LOSS debited
  expect(bank.is_debit).toBe(false);
  expect(fx.base_amount).toBe(1400);
});
```

Add a helper `seedOutgoingForeignApSettlement` mirroring the existing incoming/AR seed helpers but with a negative `bank_transaction.amount` and an expense-backed AP voucher (Cr AP). Resolve `fxGainLossAccountId` and `baseBankAccountId` via `AccountService.getAccountsByCodes(['FX_GAIN_LOSS','BANK_EUR'])` in `beforeEach`.

- [ ] **Step 2: Run test, verify it FAILS** — `npx jest src/reconciliation/fx-realized.service.spec.ts -t 'outgoing AP settlement'`. Expected: currently posts a GAIN (fx.is_debit === false), assertion fails.

- [ ] **Step 3: Implement** — in `computeAndPost`, after fetching `txn`, derive direction and fix the gain test:

```typescript
const isIncoming = txn.amount >= 0;
// realized = bookedBase - actualBase (computed below)
...
const isGain = isIncoming ? realized < 0 : realized > 0;
```

Replace the existing `const isGain = realized < 0;` with the direction-aware version. Update the docstring formula block to state the direction rule.

- [ ] **Step 4: Run test, verify it PASSES** — same command. Also run the full file: `npx jest src/reconciliation/fx-realized.service.spec.ts`. Existing AR tests must still pass.

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/fx-realized.service.ts src/reconciliation/fx-realized.service.spec.ts
git commit -m "fix(fx): direction-aware realized-FX sign for AP settlements"
```

---

### Task 2: Remove bogus invoice-number AP scan (#3)

**Files:**
- Modify: `src/reconciliation/reconciliation.service.ts` (matchByInvoiceNumbers, ~lines 242–276)
- Test: `src/reconciliation/reconciliation.service.spec.ts`

- [ ] **Step 1: Write the failing test** — seed two posted expenses with the SAME gross amount, neither linked to any invoice number, then run an outgoing transaction whose reference contains invoice-like tokens. Assert NO proposal has `signal: 'invoice_number'` (matches should only come from counterparty/amount signals).

```typescript
it('does not emit invoice_number proposals for outgoing/AP transactions (expense has no invoice_number)', async () => {
  await seedPostedExpenseVoucher({ gross: 12300 });
  await seedPostedExpenseVoucher({ gross: 12300 });
  const proposals = await reconciliationService.proposeMatchesForTransaction(
    await seedOutgoingTxn({ amount: -12300, reference: 'INV-1 INV-2' }),
  );
  expect(proposals.filter((p) => p.signal === 'invoice_number')).toHaveLength(0);
});
```

- [ ] **Step 2: Run test, verify it FAILS** — `npx jest src/reconciliation/reconciliation.service.spec.ts -t 'invoice_number proposals for outgoing'`. Expected: currently emits duplicated high-confidence invoice_number proposals.

- [ ] **Step 3: Implement** — in `matchByInvoiceNumbers`, delete the entire `else` (outgoing/AP) branch body that scans all expenses. Replace with a short comment: outgoing payments have no invoice-number key (expense has no `invoice_number` column), so the invoice-number signal applies to incoming/AR only; outgoing relies on counterparty + amount-and-date signals. The `for (const invNum ...)` loop now only handles the `isIncoming` case.

- [ ] **Step 4: Run test, verify it PASSES** — same `-t` command, then full file `npx jest src/reconciliation/reconciliation.service.spec.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/reconciliation.service.ts src/reconciliation/reconciliation.service.spec.ts
git commit -m "fix(reconciliation): drop bogus amount-only invoice_number matching for AP"
```

---

### Task 3: Personal-disposition outflow-only validation (#5)

**Files:**
- Modify: `src/reconciliation/personal-disposition.service.ts` (markAsPersonal, after status check ~line 56)
- Test: `src/reconciliation/personal-disposition.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('rejects an incoming (positive-amount) transaction — personal dispositions are outflows only', async () => {
  const txnId = await seedOpenTxn({ amount: 50000 }); // incoming
  await expect(service.markAsPersonal(txnId)).rejects.toThrow(BadRequestException);
});
```

- [ ] **Step 2: Run test, verify it FAILS** — `npx jest src/reconciliation/personal-disposition.service.spec.ts -t 'outflows only'`. Expected: currently books Dr disposition / Cr bank using abs(amount) and resolves successfully.

- [ ] **Step 3: Implement** — after the `status !== 'open'` check, add:

```typescript
// ADR-0017: personal dispositions are outflows (money leaving the business).
if (txn.amount >= 0) {
  throw new BadRequestException(
    `Transaction ${transactionId} is not an outflow (amount: ${txn.amount}); ` +
      `personal dispositions only apply to money leaving the business`,
  );
}
```

- [ ] **Step 4: Run test, verify it PASSES** — same `-t`, then full file. Existing outflow tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/personal-disposition.service.ts src/reconciliation/personal-disposition.service.spec.ts
git commit -m "fix(personal-disposition): reject non-outflow transactions"
```

---

### Task 4: Net AR/AP lines by sign + exclude contra vouchers (#7)

**Files:**
- Modify: `src/reconciliation/reconciliation.service.ts` (getRemainingVoucherBalance ~lines 626–642; candidate-voucher queries to filter to origin invoices)
- Test: `src/reconciliation/reconciliation.service.spec.ts`

- [ ] **Step 1: Write the failing test** — build a voucher carrying BOTH an AR debit and an AP credit of equal base (a contra/reclass), assert `getRemainingVoucherBalance` returns 0 (they net), not the doubled sum. (Use a tiny test accessor: call through the public match path, or expose the calc via a thin public method if needed — prefer testing through `proposeMatchesForTransaction` against such a voucher and asserting it is not proposed.)

```typescript
it('nets AR and AP lines on the same voucher to zero remaining balance', async () => {
  const voucherId = await seedVoucherWithArAndApLegs({ base: 10000 });
  const remaining = await reconciliationService.getRemainingVoucherBalanceForTest(voucherId);
  expect(remaining).toBe(0);
});
```

- [ ] **Step 2: Run test, verify it FAILS** — `npx jest src/reconciliation/reconciliation.service.spec.ts -t 'nets AR and AP'`. Expected: returns 20000 (summed) instead of 0.

- [ ] **Step 3: Implement** — change `getRemainingVoucherBalance` to net by `is_debit`:

```typescript
const lines = await this.db
  .selectFrom('voucher_line')
  .innerJoin('account', 'account.id', 'voucher_line.account_id')
  .select(['voucher_line.base_amount as base_amount', 'voucher_line.is_debit as is_debit'])
  .where('voucher_line.voucher_id', '=', voucherId)
  .where('account.code', 'in', ['AR', 'AP'])
  .execute();
const net = lines.reduce(
  (acc, l) => acc + (l.is_debit ? l.base_amount : -l.base_amount),
  0,
);
const totalBase = Math.abs(net);
if (totalBase === 0) return 0;
```

Add a test-only public wrapper `getRemainingVoucherBalanceForTest(id)` that delegates to the private method (or change the private method to public if the codebase tolerates it — match existing convention).

- [ ] **Step 4: Run test, verify it PASSES** — same `-t`, then full file.

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/reconciliation.service.ts src/reconciliation/reconciliation.service.spec.ts
git commit -m "fix(reconciliation): net AR/AP legs when computing remaining balance"
```

---

# PART B — Multi-currency accounting (confirm D2/D3/D4/D7 first)

### Task 5: Resolve real bank account + base conversion in personal-disposition (#4 part 1)

**Files:**
- Modify: `src/reconciliation/personal-disposition.service.ts`
- Test: `src/reconciliation/personal-disposition.service.spec.ts`

- [ ] **Step 1: Write the failing test** — seed an outflow on a **USD** bank statement (account `BANK_USD`), org base EUR, and assert the bank leg uses `BANK_USD` (not `BANK_EUR`), `currency==='USD'`, and `base_amount === round(amount × rate)` with the disposition leg in base. Use a real plugin stub providing `getReferenceRate('USD','EUR',date)=0.9` via the test module (override `PluginLoader` or inject a fake plugin), since NullCountryPlugin throws on cross-currency.

- [ ] **Step 2: Run test, verify it FAILS** — bank leg currently hardcodes `BANK_EUR`.

- [ ] **Step 3: Implement** — inject `BankStatementService`/a join helper + `CurrencyService` + `PluginLoader` + `OrganizationService`. Add a private `resolveBankAccountCode(statementId)` (join statement→account). Compute `base = await currencyService.getBaseCurrency()`, `rate = plugin.getReferenceRate(txn.currency, base, txn.transaction_date)`, `baseAmount = Math.round(absAmount × rate)`. Bank leg: `account_code = resolvedBankCode, currency: txn.currency, amount: absAmount, base_amount: baseAmount, fx_rate: rate`. Disposition leg: `currency: base, amount: baseAmount, base_amount: baseAmount, fx_rate: 1.0`. Remove the hardcoded `BANK_EUR` const.

- [ ] **Step 4: Run test, verify it PASSES** — full file. Same-currency (EUR) tests still pass (rate 1.0, BANK_EUR resolved).

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/personal-disposition.service.ts src/reconciliation/personal-disposition.service.spec.ts
git commit -m "fix(personal-disposition): resolve real bank account and convert to base currency"
```

---

### Task 6: Resolve real bank account + base conversion in prepayment create (#4 part 2)

**Files:**
- Modify: `src/reconciliation/prepayment.service.ts` (createCustomerPrepayment, createSupplierPrepayment)
- Test: `src/reconciliation/prepayment.service.spec.ts`

- [ ] **Step 1: Write the failing test** — create a customer prepayment from a USD bank transaction; assert bank leg account `BANK_USD`, `currency 'USD'`, `base_amount === round(amount × rate)`, prepayment leg in base.

- [ ] **Step 2: Run test, verify it FAILS** — currently `BANK_EUR` hardcoded.

- [ ] **Step 3: Implement** — same pattern as Task 5: resolve bank account from the transaction's statement, convert via plugin/currency service. Extract a shared private `buildBankLeg(txn, isDebit)` and `baseLeg(...)` if it reduces duplication (DRY across the two create methods). Remove hardcoded `BANK_EUR`.

- [ ] **Step 4: Run test, verify it PASSES** — full file.

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/prepayment.service.ts src/reconciliation/prepayment.service.spec.ts
git commit -m "fix(prepayment): resolve real bank account and convert to base on create"
```

---

### Task 7: Cross-currency draw-down (#8)

**Files:**
- Modify: `src/reconciliation/prepayment.service.ts` (drawDownPrepayment ~lines 259–312)
- Test: `src/reconciliation/prepayment.service.spec.ts`

- [ ] **Step 1: Write the failing test** — EUR prepayment drawn down against a USD AR invoice; assert the AR relief line is in the invoice's currency/base (not forced to the prepayment currency at fx 1.0) and the voucher balances in base. Document expected realized-FX behaviour (if drawdown crosses currencies, expect a non-zero FX recognition or an explicit no-op per D-decision).

- [ ] **Step 2: Run test, verify it FAILS** — currently both legs use `prepaymentBalance.currency` at fx 1.0.

- [ ] **Step 3: Implement** — relief leg (AR/AP) uses the invoice's currency and the invoice line's base; prepayment leg uses the prepayment currency/base; reconcile the base difference to `FX_GAIN_LOSS` if they differ (reuse the realized-FX posting helper or post a third FX line so the voucher still balances in base). Keep same-currency path unchanged.

- [ ] **Step 4: Run test, verify it PASSES** — full file.

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/prepayment.service.ts src/reconciliation/prepayment.service.spec.ts
git commit -m "fix(prepayment): honour invoice currency and realized FX on cross-currency draw-down"
```

---

### Task 8: FX realized — base conversion + partial-match scaling (#2, #6)

**Files:**
- Modify: `src/reconciliation/fx-realized.service.ts` (computeAndPost), `src/reconciliation/reconciliation.service.ts` (executeMatch call site if signature changes)
- Test: `src/reconciliation/fx-realized.service.spec.ts`

- [ ] **Step 1: Write the failing tests** — (a) partial match: voucher booked 70000 base, matched 30000, foreign line 10000 USD @ 7.14 → assert posted FX `base_amount ≈ 600` (proportional), not 41400; (b) base conversion: foreign bank account (`source_currency` USD, base EUR) → assert `actualBase` is in base via `getReferenceRate`, and the FX voucher books `FX_GAIN_LOSS` + base bank account in base currency.

- [ ] **Step 2: Run tests, verify they FAIL** — current code yields 41400 and assumes txn.currency == base.

- [ ] **Step 3: Implement** — per D2 & D3: add `getFullBookedBase(voucherId)` (sum of AR/AP base, netted), compute `proportion = Math.min(1, matchedAmount / fullBookedBase)`, `fullActualBase = round(|source_amount| × getReferenceRate(source_currency, base, date))` (fallback to `round(|amount| × getReferenceRate(txn.currency, base, date))` when no source leg), `actualBaseForMatch = round(fullActualBase × proportion)`, `realized = matchedAmount − actualBaseForMatch`. Book `FX_GAIN_LOSS` and the base bank account in base currency, fx 1.0. Keep the Task-1 direction-aware `isGain`.

- [ ] **Step 4: Run tests, verify they PASS** — full file; all earlier FX tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/fx-realized.service.ts src/reconciliation/reconciliation.service.ts src/reconciliation/fx-realized.service.spec.ts
git commit -m "fix(fx): base-currency conversion and proportional partial-match realized FX"
```

---

### Task 9: Currency-normalised matching (#9)

**Files:**
- Modify: `src/reconciliation/reconciliation.service.ts` (matching signals: convert txn amount to base before comparison)
- Test: `src/reconciliation/reconciliation.service.spec.ts`

- [ ] **Step 1: Write the failing test** — USD bank transaction settling a EUR invoice; with a fake plugin rate, assert the matcher reports `exact`/`high` after converting the txn amount to base, and `amountMatched` is in base.

- [ ] **Step 2: Run test, verify it FAILS** — currently compares raw `absAmount` (USD) to base `remainingBalance`.

- [ ] **Step 3: Implement** — at the top of `proposeMatchesForTransaction`, compute `absBase = Math.round(Math.abs(txn.amount) × getReferenceRate(txn.currency, base, txn.transaction_date))` and thread `absBase` through `matchByInvoiceNumbers`/`matchByCounterparty`/`matchByAmountAndDate` in place of `absAmount` for the comparison and `amountMatched`. Same-currency reduces to identity (rate 1.0).

- [ ] **Step 4: Run test, verify it PASSES** — full file, then the whole reconciliation suite.

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/reconciliation.service.ts src/reconciliation/reconciliation.service.spec.ts
git commit -m "fix(reconciliation): normalise bank amount to base currency before matching"
```

---

### Task 10: Full regression + e2e

- [ ] **Step 1:** `npm run lint`
- [ ] **Step 2:** `npx jest src/` (unit)
- [ ] **Step 3:** `npx jest test/reconciliation.e2e-spec.ts` (e2e)
- [ ] **Step 4:** `npm run build`
- [ ] **Step 5:** Commit any lint fixups: `git commit -am "chore: lint + regression after wave-5 fixes"`

---

## Self-Review notes
- Files touched by exactly one task at a time: `fx-realized` (T1, T8), `reconciliation` (T2, T4, T8 call-site, T9), `personal-disposition` (T3, T5), `prepayment` (T6, T7). Run tasks sequentially in this order — no parallel edits to the same file.
- All amounts positive + `base = amount×fx_rate` invariant respected in every new posting (D3/D4 keep bank leg `base = amount×rate`, base legs `fx 1.0`).
- Cross-currency tests require a fake plugin (NullCountryPlugin throws); each Part B task seeds one via the Nest test module override.
