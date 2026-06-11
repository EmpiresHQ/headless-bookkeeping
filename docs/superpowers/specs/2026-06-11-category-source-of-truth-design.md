# Category Source-of-Truth Design

**Date:** 2026-06-11
**Status:** Approved (brainstorming) — ready for implementation plan

## Problem

The expense `category` is freetext with no validation, and the set of valid
categories is duplicated across three places that have silently diverged:

1. `CANONICAL_CATEGORIES` — a hardcoded array shown to the AI
   (`src/ai/tools/index.ts:25`): `software, transport, rent, meals, office,
   utilities, marketing, professional_services, other`.
2. `NullCountryPlugin.resolveCategoryMapping` `expenseMap`
   (`src/plugins/null-country.plugin.ts:65`): `software, transport, travel,
   marketing, salary, contractor, rent, tax, bank fee, meals, insurance,
   education`.
3. `EstoniaCountryPlugin.resolveCategoryMapping` `expenseMap`
   (`src/plugins/estonia-country.plugin.ts:146`): its own list.

The AI list and the plugin maps are almost disjoint. Categories the AI is told
to use (`office`, `utilities`, `professional_services`) do not exist in the
plugin map, so they silently fall through to `EXPENSE_OTHER` (the `?? 'EXPENSE_OTHER'`
fallback). Categories the plugin DOES map (`travel`, `salary`, `contractor`,
`rent`, `tax`, `insurance`, `education`) are never offered to the AI. Net effect:
a large share of AI-classified expenses book to `EXPENSE_OTHER`, and `category`
accepts arbitrary strings end-to-end (DB `TEXT`, `z.string()` in both the
expense DTO and the triage schema).

## Architectural constraint (why NOT a lookup table)

A DB-backed `category` table with CRUD was considered and **rejected** because it
contradicts the established plugin boundary:

- **ADR-0002:** "A country plugin owns everything country-specific: the
  authoritative VAT codes, VAT rates, deductibility rules, `category → account +
  vat_code` mappings…"
- **ADR-0022:** "Country plugin — an in-process, **stateless** rule resolver…
  It owns … `category → account + vat_code` mapping … It has **no database of
  its own** — pure functions over (Supplier facts + Organization context)."

The category set and its `category → account` binding are **rules of the active
country plugin**, not user data. There are deliberately no user-defined
("custom") categories. "Editing categories" therefore means editing the plugin
(code), not a CRUD table.

There is an exact existing precedent: VAT codes. The plugin is already the sole
source of valid VAT codes via `getVATCodes(): VATCode[]`
(`src/plugins/country-plugin.interface.ts:114`), documented as "Used for
validation and UI dropdowns." Categories will mirror this exactly.

## Design

Make the **active country plugin the single source of truth** for the category
set, mirroring `getVATCodes()`. Collapse the three divergent lists into one
definition per plugin.

### 1. Plugin interface: `getCategories()`

Add to `CountryPlugin` (`src/plugins/country-plugin.interface.ts`):

```ts
/**
 * A user-facing expense category and its country-neutral account binding.
 * The category → account binding is context-free (it is the chart-of-accounts
 * binding); the VAT code is resolved separately by resolveCategoryMapping,
 * which depends on supplier + org context.
 */
export interface CategoryDef {
  /** Stable category key used as the stored `category` value (e.g. "software"). */
  key: string;
  /** Human-facing label for UI (e.g. "Software"). */
  label: string;
  /** Kernel account code this category books to (e.g. "EXPENSE_SOFTWARE"). */
  accountCode: string;
}

/**
 * Returns the set of valid expense categories for this country.
 * Used for validation, the AI prompt/tool, and UI display. Mirrors getVATCodes().
 */
getCategories(): CategoryDef[];
```

`key` is the value stored in `expense.category` and returned by triage — the
existing string-based kernel flow is unchanged.

### 2. Plugins: one definition feeds both methods

In each plugin, the existing `expenseMap: Record<string, string>` (category →
account code) becomes the single source. `getCategories()` derives its list from
it (plus a `label`), and `resolveCategoryMapping()` reads the account from the
same map. No second list.

- `NullCountryPlugin` — refactor `expenseMap` to a module-level/`readonly` const
  (`CATEGORY_ACCOUNTS`), implement `getCategories()` from it, keep the
  `'revenue'` branch and the `?? 'EXPENSE_OTHER'` fallback in
  `resolveCategoryMapping` (the fallback stays as a safety net; it should be
  unreachable once category is validated against the same set — ADR-0005 keeps
  `EXPENSE_OTHER` as the permissive default).
- `EstoniaCountryPlugin` — same refactor over its own `expenseMap`.
- `StrictTestPlugin` — extends `NullCountryPlugin`; it must additionally expose
  its `strict-test-category` so the ADR-0005 override-path test keeps a valid
  category that maps to the rejected VAT code. Add `strict-test-category` to the
  categories it returns (override `getCategories()` to append it).

`revenue` is a sales/posting concept, not an expense category — `getCategories()`
returns expense categories only (it is consumed by expense triage + the expense
UI). The `'revenue'` branch in `resolveCategoryMapping` is unaffected.

### 3. AI tool reads from the plugin

`createListCategoriesTool()` (`src/ai/tools/index.ts:86`) currently takes no args
and returns the hardcoded `CANONICAL_CATEGORIES`. Change it to accept
`pluginLoader: PluginLoader` and return `plugin.getCategories().map(c => c.key)`
(or the full defs). **Delete `CANONICAL_CATEGORIES`.** Update the call site in
`src/ai/mastra.service.ts:54` to pass the already-injected `pluginLoader`.

### 4. Inject categories into the triage prompt

The triage agent is built on demand (`buildTriageAgent()`,
`src/ai/mastra.service.ts:87`; prompt from `AGENT_PROMPTS.triage` in
`src/ai/agent-config.ts`). At build time, fetch
`pluginLoader.resolve(...).getCategories()` and inject the explicit list of valid
category keys (with labels) into the system instructions, with a directive to
pick exactly one from the list and never invent a category. This closes the set
at generation time rather than relying on the model to call `listCategories`.

### 5. Validate `category` at the boundary

Validate the incoming `category` against the active plugin's category set so an
unknown value is **rejected** (→ bounded-retry → `needs_triage`, the existing
ADR-0010/0012 path) instead of silently booking to `EXPENSE_OTHER`:

- **Triage** (`src/triage/types.ts:60`) — the Zod field stays `z.string()` at the
  schema level (the valid set is dynamic/plugin-driven, not a static enum), and
  validation against `getCategories()` happens in the triage/propose service that
  already holds the `pluginLoader`, alongside the existing supplier-proposal
  validation. An invalid category fails the same way a bad supplier_proposal does.
- **Manual expense create** (`src/expenses/expenses.service.ts:createExpense`,
  DTO `src/expenses/types.ts:27`) — validate `dto.category` against the plugin
  set before INSERT; reject with a 400 listing valid categories. (The SPA create
  form becomes a dropdown — see §6 — so this is a backstop.)
- **Corrections** (`src/corrections` / `expenses.service.previewPatchedDraft`) —
  if `patch.category` is present, validate it the same way.

Exact validation placement (a shared helper vs. per-service) is a plan-level
decision; the contract is "unknown category never reaches the ledger silently."

### 6. SPA: read-only categories view + create-form dropdown

- New `GET /api/categories` endpoint returning the active plugin's
  `getCategories()` (`{ key, label, accountCode }[]`). Mirrors the existing
  read-only `GET /api/accounts`.
- Frontend `getCategories()` in `frontend/src/api.ts`.
- A read-only "Categories" view (new tab, custom-tab pattern) listing
  `key → label → accountCode`. This is the "where is the list / what maps where"
  answer; there is no edit/create/delete (categories are plugin rules).
- The expense create form (`ExpensesView.tsx`) `Category` input becomes a
  `<select>` populated from `getCategories()` instead of a freetext field. (The
  triage AI path and corrections are covered by §4/§5.)

## Explicitly out of scope

- No `category` DB table, no migration, no FK, no `category_id`.
- No CRUD (create/update/delete) of categories.
- No user-defined / custom categories.
- No new ledger accounts; categories bind only to existing seeded chart accounts.
- No change to the string-based kernel flow (`category` stays a string key).

## Components & boundaries

| Unit | Responsibility | Depends on |
|------|----------------|-----------|
| `CountryPlugin.getCategories()` | Authoritative category set + account binding | plugin's own `expenseMap` const |
| `listCategories` tool | Expose category keys to the AI | `PluginLoader` |
| triage prompt builder | Inject valid categories into instructions | `PluginLoader` |
| category validation | Reject unknown category before ledger | `PluginLoader` |
| `GET /api/categories` + SPA view | Read-only display + create-form dropdown | plugin via loader |

## Testing strategy

- **Plugin unit tests:** `getCategories()` returns the expected set for Null and
  Estonia; every returned `accountCode` matches what `resolveCategoryMapping`
  resolves for that `key`; the two methods cannot diverge (a test asserts
  consistency by iterating `getCategories()` and comparing to
  `resolveCategoryMapping(key, …).accountCode`).
- **AI tool test:** `listCategories` returns the active plugin's keys (not a
  hardcoded list); `CANONICAL_CATEGORIES` is gone.
- **Triage prompt test:** built instructions contain the plugin's category keys.
- **Validation tests:** unknown category on manual create → 400; unknown category
  from triage → rejected/needs_triage; known category → posts to the mapped
  account (no `EXPENSE_OTHER` fallback for known keys).
- **StrictTestPlugin:** `strict-test-category` still present so the ADR-0005
  override-path e2e remains exercisable.
- **SPA:** `GET /api/categories` returns the set; Categories view renders rows;
  expense create form renders a populated `<select>`.
- Full gate: backend `npm run lint && npm test && npm run test:e2e`; frontend
  `tsc -b && vitest run && build`.

## Open questions for the plan

1. Should `getCategories()` return expense categories only, or include a typed
   marker for `revenue`? (Design assumes expense-only; revenue stays in
   `resolveCategoryMapping`'s dedicated branch.)
2. Validation placement: one shared `assertValidCategory(pluginLoader, category)`
   helper vs. inline per service. (Plan decides; behavior is fixed.)
