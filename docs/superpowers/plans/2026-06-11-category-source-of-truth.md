# Category Source-of-Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the active country plugin the single source of truth for the valid expense-category set and its account binding, eliminating the three divergent hardcoded lists and the silent `EXPENSE_OTHER` fallback.

**Architecture:** Add `getCategories(): CategoryDef[]` to the `CountryPlugin` interface (mirrors the existing `getVATCodes()`). Each plugin derives both `getCategories()` and `resolveCategoryMapping()` from one internal `category → account` map. A thin `CategoryService` exposes the active plugin's set for: a read-only `GET /api/categories`, the AI `listCategories` tool, triage-prompt injection, and boundary validation (manual create + AI triage). No DB table, migration, FK, CRUD, or custom categories — categories are plugin rules (ADR-0002/0022).

**Tech Stack:** NestJS 11, Kysely + better-sqlite3, Jest (unit + e2e), Mastra agents; React 18 + Vite + Vitest + Tailwind (operator SPA).

**Reference spec:** `docs/superpowers/specs/2026-06-11-category-source-of-truth-design.md`

**Branch:** `category-source-of-truth` (already created).

**Conventions for the executor:**
- Backend single-file unit test: `npx jest <path>` (e.g. `npx jest src/plugins/null-country.plugin.spec.ts`).
- Backend e2e single file: `npx jest --config test/jest-e2e.json <path>`.
- Frontend (run from `frontend/`): `npx vitest run <path>`.
- This is a SHARED git worktree with parallel agents. When committing, `git add` ONLY the exact files listed in that task — never `git add -A`.
- `npm run lint` runs `eslint --fix` and auto-modifies files; if you run it, re-stage only your task's files.

---

## File Structure

**Backend — create:**
- `src/categories/category.service.ts` — resolves the active plugin's category set; validation helpers.
- `src/categories/category.service.spec.ts` — unit tests.
- `src/categories/categories.controller.ts` — `GET /api/categories`.
- `src/categories/categories.module.ts` — wires the above (imports PluginsModule + OrganizationModule).
- `test/categories.e2e-spec.ts` — endpoint e2e.
- `src/ai/triage-instructions.ts` — pure helper that appends the category list to the base triage prompt.
- `src/ai/triage-instructions.spec.ts` — unit test for the helper.

**Backend — modify:**
- `src/plugins/country-plugin.interface.ts` — add `CategoryDef` + `getCategories()`.
- `src/plugins/null-country.plugin.ts` — extract `CATEGORY_ACCOUNTS`, implement `getCategories()`.
- `src/plugins/estonia-country.plugin.ts` — same refactor.
- `src/plugins/strict-test.plugin.ts` — override `getCategories()` to add `strict-test-category`.
- `src/plugins/*.plugin.spec.ts` — add `getCategories()` + consistency tests.
- `src/ai/tools/index.ts` — `createListCategoriesTool(categoryService)`; delete `CANONICAL_CATEGORIES`.
- `src/ai/tools/index.spec.ts` (or the existing tool spec) — assert tool reads from the plugin.
- `src/ai/mastra.service.ts` — inject `CategoryService`; pass it to the tool; inject categories into triage instructions.
- `src/ai/ai.module.ts` — import `CategoriesModule`.
- `src/expenses/expenses.service.ts` — inject `CategoryService`; validate category in `createExpense` + correction patch paths.
- `src/expenses/expenses.module.ts` — import `CategoriesModule`.
- `src/expenses/expenses.service.spec.ts` — validation tests.
- `src/ai/propose-draft.service.ts` — inject `CategoryService`; return `category-unresolved` for an unknown triage category.
- `src/ai/intake-workflow.service.ts` — route `category-unresolved` → needs_triage.
- `src/ai/propose-draft.service.spec.ts` / `intake-workflow.service.spec.ts` — routing tests.

**Frontend — create:**
- `frontend/src/components/CategoriesView.tsx` — read-only categories table.
- `frontend/src/components/CategoriesView.test.tsx` — render test.

**Frontend — modify:**
- `frontend/src/api.ts` — `CategoryDef` type + `getCategories()`.
- `frontend/src/tabs.tsx` — register the Categories tab.
- `frontend/src/components/ExpensesView.tsx` — Category input → `<select>`.

---

## Task 1: Plugin interface — `getCategories()` + `CategoryDef`

**Files:**
- Modify: `src/plugins/country-plugin.interface.ts` (after `getVATCodes()` at line 114)
- Modify: `src/plugins/null-country.plugin.ts:54-82`
- Modify: `src/plugins/estonia-country.plugin.ts:122-162`
- Modify: `src/plugins/strict-test.plugin.ts`
- Test: `src/plugins/null-country.plugin.spec.ts`, `src/plugins/estonia-country.plugin.spec.ts`

- [ ] **Step 1: Add the failing test (Null plugin) — `getCategories()` + consistency**

In `src/plugins/null-country.plugin.spec.ts`, add:

```ts
describe('getCategories()', () => {
  const plugin = new NullCountryPlugin();

  it('returns the expense categories with stable key/label/accountCode', () => {
    const cats = plugin.getCategories();
    const keys = cats.map((c) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'software',
        'transport',
        'travel',
        'marketing',
        'salary',
        'contractor',
        'rent',
        'tax',
        'bank fee',
        'meals',
        'insurance',
        'education',
      ]),
    );
    // No 'revenue' — getCategories() is the EXPENSE set only.
    expect(keys).not.toContain('revenue');
    const software = cats.find((c) => c.key === 'software');
    expect(software).toEqual({
      key: 'software',
      label: expect.any(String),
      accountCode: 'EXPENSE_SOFTWARE',
    });
  });

  it('is consistent with resolveCategoryMapping (no divergence possible)', () => {
    const facts = {
      country: 'IE',
      goodsVsServices: 'services' as const,
      classificationMemory: [],
    };
    const org = { country: 'IE', vatRegistered: true, baseCurrency: null };
    for (const cat of plugin.getCategories()) {
      expect(plugin.resolveCategoryMapping(cat.key, facts, org).accountCode).toBe(
        cat.accountCode,
      );
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/plugins/null-country.plugin.spec.ts -t getCategories`
Expected: FAIL — `plugin.getCategories is not a function`.

- [ ] **Step 3: Add `CategoryDef` + `getCategories()` to the interface**

In `src/plugins/country-plugin.interface.ts`, immediately after the `getVATCodes(): VATCode[];` method (line 114), add the method, and add the `CategoryDef` interface next to `CategoryMappingResult` (after line 60):

```ts
/**
 * CategoryDef - A user-facing expense category and its country-neutral account
 * binding. The category → account binding is context-free (it is the
 * chart-of-accounts binding); the VAT code is resolved separately by
 * resolveCategoryMapping, which depends on supplier + org context.
 */
export interface CategoryDef {
  /** Stable category key, stored as the `category` value (e.g. "software"). */
  key: string;
  /** Human-facing label for UI (e.g. "Software"). */
  label: string;
  /** Kernel account code this category books to (e.g. "EXPENSE_SOFTWARE"). */
  accountCode: string;
}
```

```ts
  /**
   * Returns the set of valid EXPENSE categories for this country, each with its
   * country-neutral account binding. Used for validation, the AI prompt/tool,
   * and UI display. Mirrors getVATCodes(). Does NOT include 'revenue'
   * (a sales/posting concept resolved by resolveCategoryMapping's own branch).
   */
  getCategories(): CategoryDef[];
```

- [ ] **Step 4: Implement in `NullCountryPlugin`**

In `src/plugins/null-country.plugin.ts`: add `CategoryDef` to the import from `./country-plugin.interface`. Replace the inline `expenseMap` (lines 64-78) with a module-level const + a label map, and implement `getCategories()`. Final shape:

```ts
// Module scope (top of file, after imports):
/**
 * The single source of the Null plugin's category → account binding. Both
 * resolveCategoryMapping() and getCategories() read from this map, so the two
 * cannot diverge.
 */
const CATEGORY_ACCOUNTS: Record<string, string> = {
  software: 'EXPENSE_SOFTWARE',
  transport: 'EXPENSE_TRANSPORT',
  travel: 'EXPENSE_TRAVEL',
  marketing: 'EXPENSE_MARKETING',
  salary: 'EXPENSE_SALARY',
  contractor: 'EXPENSE_CONTRACTOR',
  rent: 'EXPENSE_RENT',
  tax: 'EXPENSE_TAX',
  'bank fee': 'EXPENSE_BANK_FEE',
  meals: 'EXPENSE_MEALS',
  insurance: 'EXPENSE_INSURANCE',
  education: 'EXPENSE_EDUCATION',
};

/** Title-cases a category key into a display label ("bank fee" → "Bank Fee"). */
function labelFor(key: string): string {
  return key.replace(/\b\w/g, (c) => c.toUpperCase());
}
```

```ts
// In the class, replace the inline expenseMap with the const lookup:
  resolveCategoryMapping(
    category: string,
    _supplierFacts: SupplierFacts,
    _orgContext: OrgContext,
  ): CategoryMappingResult {
    if (category === 'revenue') {
      return { accountCode: 'REVENUE', vatCode: 'IE_OUTPUT_23' };
    }
    const accountCode = CATEGORY_ACCOUNTS[category] ?? 'EXPENSE_OTHER';
    return { accountCode, vatCode: 'IE_INPUT_23' };
  }

  getCategories(): CategoryDef[] {
    return Object.entries(CATEGORY_ACCOUNTS).map(([key, accountCode]) => ({
      key,
      label: labelFor(key),
      accountCode,
    }));
  }
```

- [ ] **Step 5: Run the Null test to verify it passes**

Run: `npx jest src/plugins/null-country.plugin.spec.ts`
Expected: PASS (all, including the new `getCategories` block).

- [ ] **Step 6: Add the failing test for `EstoniaCountryPlugin`**

In `src/plugins/estonia-country.plugin.spec.ts`, add a `getCategories()` block mirroring Step 1 (same consistency loop; assert keys match the Estonia `expenseMap` and that `getCategories()` excludes `revenue`). Read the existing Estonia `expenseMap` (`src/plugins/estonia-country.plugin.ts:146-160`) to list its exact keys in the `arrayContaining([...])` assertion. Use the Estonia facts/org already used elsewhere in that spec file.

Run: `npx jest src/plugins/estonia-country.plugin.spec.ts -t getCategories`
Expected: FAIL — `plugin.getCategories is not a function`.

- [ ] **Step 7: Implement in `EstoniaCountryPlugin`**

Apply the same refactor as Step 4 to `src/plugins/estonia-country.plugin.ts`: hoist its `expenseMap` (lines 146-160) to a module-level `EE_CATEGORY_ACCOUNTS` const, add a `labelFor` helper (or import a shared one — keep it local to avoid cross-file coupling), have `resolveCategoryMapping` read `EE_CATEGORY_ACCOUNTS[category] ?? 'EXPENSE_OTHER'` (preserve its existing `vatCode: 'EE_INPUT_24'` and the `'revenue'` branch), and implement `getCategories()` from the const. Add `CategoryDef` to its interface import (line 2-9).

Run: `npx jest src/plugins/estonia-country.plugin.spec.ts`
Expected: PASS.

- [ ] **Step 8: Implement in `StrictTestPlugin` + test**

In `src/plugins/strict-test.plugin.ts`, add `CategoryDef` to the import and override `getCategories()` so the strict trigger category is a valid, listable category (it must validate so the ADR-0005 override-path e2e — which creates an expense with `strict-test-category` — passes boundary validation in Task 5/6):

```ts
  override getCategories(): CategoryDef[] {
    return [
      ...super.getCategories(),
      {
        key: STRICT_REJECTED_CATEGORY,
        label: 'Strict Test Category',
        accountCode: 'EXPENSE_OTHER',
      },
    ];
  }
```

In `src/plugins/strict-test.plugin.spec.ts` (create if absent; otherwise add to it), assert:

```ts
it('exposes the strict trigger category so it survives boundary validation', () => {
  const plugin = new StrictTestPlugin();
  expect(plugin.getCategories().map((c) => c.key)).toContain(
    STRICT_REJECTED_CATEGORY,
  );
});
```

Run: `npx jest src/plugins/strict-test.plugin.spec.ts`
Expected: PASS. (If the spec file did not exist, also run `npx jest src/plugins` to confirm no regressions.)

- [ ] **Step 9: Commit**

```bash
git add src/plugins/country-plugin.interface.ts src/plugins/null-country.plugin.ts src/plugins/estonia-country.plugin.ts src/plugins/strict-test.plugin.ts src/plugins/null-country.plugin.spec.ts src/plugins/estonia-country.plugin.spec.ts src/plugins/strict-test.plugin.spec.ts
git commit -m "feat(plugins): getCategories() as single source of category->account binding"
```

---

## Task 2: `CategoryService` + `GET /api/categories`

**Files:**
- Create: `src/categories/category.service.ts`, `src/categories/category.service.spec.ts`
- Create: `src/categories/categories.controller.ts`, `src/categories/categories.module.ts`
- Create: `test/categories.e2e-spec.ts`
- Reference patterns: `src/ledger/account/account.controller.ts`, `src/ai/tools/index.ts:133-159` (how `resolveMapping` reads `organizationService.getOrganization().country` then `pluginLoader.resolve(country)`).

- [ ] **Step 1: Write the failing service test**

`src/categories/category.service.spec.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import { CategoryService } from './category.service';

function makeService(categories: { key: string; label: string; accountCode: string }[]) {
  const plugin = { getCategories: () => categories };
  const pluginLoader = { resolve: jest.fn().mockReturnValue(plugin) };
  const organizationService = {
    getOrganization: jest.fn().mockResolvedValue({ country: 'IE' }),
  };
  return new CategoryService(
    pluginLoader as never,
    organizationService as never,
  );
}

const CATS = [
  { key: 'software', label: 'Software', accountCode: 'EXPENSE_SOFTWARE' },
  { key: 'rent', label: 'Rent', accountCode: 'EXPENSE_RENT' },
];

describe('CategoryService', () => {
  it('list() returns the active plugin categories', async () => {
    const svc = makeService(CATS);
    expect(await svc.list()).toEqual(CATS);
  });

  it('isValid() is true for a known key, false otherwise', async () => {
    const svc = makeService(CATS);
    expect(await svc.isValid('software')).toBe(true);
    expect(await svc.isValid('not-a-category')).toBe(false);
  });

  it('assertValid() throws BadRequestException listing valid keys for an unknown category', async () => {
    const svc = makeService(CATS);
    await expect(svc.assertValid('garbage')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.assertValid('software')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/categories/category.service.spec.ts`
Expected: FAIL — cannot find `./category.service`.

- [ ] **Step 3: Implement `CategoryService`**

`src/categories/category.service.ts`:

```ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CategoryDef } from '../plugins/country-plugin.interface';
import { OrganizationService } from '../organization/organization.service';

/**
 * CategoryService — the single read/validation surface over the active country
 * plugin's expense-category set (ADR-0002/0022: categories are plugin rules,
 * not DB rows). Backs GET /api/categories, the AI listCategories tool, the
 * triage-prompt injection, and write-path validation. getCategories() is
 * context-free, so this only needs the org's country to pick the active plugin.
 */
@Injectable()
export class CategoryService {
  constructor(
    private readonly pluginLoader: PluginLoader,
    private readonly organizationService: OrganizationService,
  ) {}

  async list(): Promise<CategoryDef[]> {
    const org = await this.organizationService.getOrganization();
    return this.pluginLoader.resolve(org.country).getCategories();
  }

  async isValid(category: string): Promise<boolean> {
    return (await this.list()).some((c) => c.key === category);
  }

  /** Throws BadRequestException (→ 400) for an unknown category. */
  async assertValid(category: string): Promise<void> {
    const cats = await this.list();
    if (!cats.some((c) => c.key === category)) {
      const valid = cats.map((c) => c.key).join(', ');
      throw new BadRequestException(
        `Unknown category '${category}'. Valid categories: ${valid}`,
      );
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/categories/category.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Add the controller + module**

`src/categories/categories.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CategoryService } from './category.service';
import { CategoryDef } from '../plugins/country-plugin.interface';

@ApiTags('categories')
@Controller('api/categories')
export class CategoriesController {
  constructor(private readonly categoryService: CategoryService) {}

  @Get()
  async getCategories(): Promise<{ categories: CategoryDef[] }> {
    return { categories: await this.categoryService.list() };
  }
}
```

`src/categories/categories.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PluginsModule } from '../plugins/plugins.module';
import { OrganizationModule } from '../organization/organization.module';
import { CategoriesController } from './categories.controller';
import { CategoryService } from './category.service';

@Module({
  imports: [PluginsModule, OrganizationModule],
  controllers: [CategoriesController],
  providers: [CategoryService],
  exports: [CategoryService],
})
export class CategoriesModule {}
```

Register it in the app module. Find where modules are registered (`grep -n "AccountModule\|ExpensesModule" src/app.module.ts`) and add `CategoriesModule` to the `imports` array alongside the others (and its import line at the top).

- [ ] **Step 6: Write the e2e test**

`test/categories.e2e-spec.ts` — model it on an existing endpoint e2e (open `test/` and copy the bootstrap from a simple GET e2e such as the accounts/expenses one: `INIT_FUNCTIONS`, `Test.createTestingModule({ imports: [AppModule] })`, `app.setGlobalPrefix` if used, the API token header). Core assertion:

```ts
it('GET /api/categories returns the active plugin category set', async () => {
  const res = await request(app.getHttpServer())
    .get('/api/categories')
    .set('Authorization', `Bearer ${token}`) // match the project's auth header
    .expect(200);
  const body = res.body as { categories: { key: string; accountCode: string }[] };
  expect(Array.isArray(body.categories)).toBe(true);
  expect(body.categories.map((c) => c.key)).toContain('software');
  expect(body.categories.find((c) => c.key === 'software')?.accountCode).toBe(
    'EXPENSE_SOFTWARE',
  );
});
```

Before writing the auth/bootstrap, READ an existing file under `test/` (e.g. the expenses or accounts e2e) and copy its exact app-bootstrap + auth-token pattern — do not invent header/prefix conventions.

- [ ] **Step 7: Run the e2e**

Run: `npx jest --config test/jest-e2e.json test/categories.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/categories/ test/categories.e2e-spec.ts src/app.module.ts
git commit -m "feat(categories): CategoryService + read-only GET /api/categories"
```

---

## Task 3: AI `listCategories` tool reads from the plugin

**Files:**
- Modify: `src/ai/tools/index.ts:21-35` (delete `CANONICAL_CATEGORIES`), `:83-97` (`createListCategoriesTool`)
- Modify: `src/ai/mastra.service.ts:52-79` (`buildTools`)
- Modify: `src/ai/ai.module.ts` (import `CategoriesModule`)
- Test: `src/ai/tools/index.spec.ts` (create if absent) or the existing tools spec

- [ ] **Step 1: Write the failing test**

In `src/ai/tools/index.spec.ts` (create if it does not exist), add:

```ts
import { createListCategoriesTool } from './index';

describe('createListCategoriesTool', () => {
  it('returns the active plugin category keys (not a hardcoded list)', async () => {
    const categoryService = {
      list: jest.fn().mockResolvedValue([
        { key: 'software', label: 'Software', accountCode: 'EXPENSE_SOFTWARE' },
        { key: 'rent', label: 'Rent', accountCode: 'EXPENSE_RENT' },
      ]),
    };
    const tool = createListCategoriesTool(categoryService as never);
    const result = await tool.execute();
    expect(result).toEqual(['software', 'rent']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/ai/tools/index.spec.ts`
Expected: FAIL — `createListCategoriesTool` expects 0 args / returns the hardcoded list.

- [ ] **Step 3: Update the tool + delete `CANONICAL_CATEGORIES`**

In `src/ai/tools/index.ts`: delete the `CANONICAL_CATEGORIES` const (lines 21-35) and rewrite the tool to accept a `CategoryService` and read from it:

```ts
import { CategoryService } from '../../categories/category.service';
```

```ts
/**
 * Create the listCategories tool. The active country plugin is the SOLE source
 * of the category set (ADR-0002) — this reads it via CategoryService.
 */
export function createListCategoriesTool(categoryService: CategoryService) {
  return {
    id: 'listCategories',
    description:
      'List all available expense categories. These are user-facing labels that map to accounting accounts and VAT codes.',
    inputSchema: listCategoriesOutputSchema,
    outputSchema: listCategoriesOutputSchema,
    execute: async (): Promise<string[]> => {
      const cats = await categoryService.list();
      return cats.map((c) => c.key);
    },
  };
}
```

- [ ] **Step 4: Wire `CategoryService` into `MastraService`**

In `src/ai/mastra.service.ts`: import `CategoryService`, add it to the constructor (after `config`), and pass it to the tool in `buildTools`:

```ts
import { CategoryService } from '../categories/category.service';
```

```ts
    private readonly config: AgentConfigService,
    private readonly categoryService: CategoryService,
  ) {}
```

```ts
    const listCategories = createListCategoriesTool(this.categoryService);
```

In `src/ai/ai.module.ts`, add `CategoriesModule` to the `imports` array (and its top import). Verify with `grep -n "imports" src/ai/ai.module.ts`.

- [ ] **Step 5: Run the tool test + the mastra spec**

Run: `npx jest src/ai/tools/index.spec.ts src/ai/mastra.service.spec.ts`
Expected: PASS. (If `mastra.service.spec.ts` constructs `MastraService` directly, add a `CategoryService` stub to its constructor args — `{ list: async () => [] }` cast — so it still compiles.)

- [ ] **Step 6: Commit**

```bash
git add src/ai/tools/index.ts src/ai/tools/index.spec.ts src/ai/mastra.service.ts src/ai/mastra.service.spec.ts src/ai/ai.module.ts
git commit -m "refactor(ai): listCategories tool reads from CategoryService; drop hardcoded list"
```

---

## Task 4: Inject categories into the triage prompt

**Files:**
- Create: `src/ai/triage-instructions.ts`, `src/ai/triage-instructions.spec.ts`
- Modify: `src/ai/mastra.service.ts:87-97` (`buildTriageAgent`)

- [ ] **Step 1: Write the failing test for the pure helper**

`src/ai/triage-instructions.spec.ts`:

```ts
import { withCategoryList } from './triage-instructions';

describe('withCategoryList', () => {
  const cats = [
    { key: 'software', label: 'Software', accountCode: 'EXPENSE_SOFTWARE' },
    { key: 'rent', label: 'Rent', accountCode: 'EXPENSE_RENT' },
  ];

  it('appends the exact valid category keys to the base instructions', () => {
    const out = withCategoryList('BASE PROMPT', cats);
    expect(out).toContain('BASE PROMPT');
    expect(out).toContain('software');
    expect(out).toContain('rent');
  });

  it('directs the model to choose exactly one and never invent a category', () => {
    const out = withCategoryList('BASE', cats);
    expect(out.toLowerCase()).toContain('exactly one');
    expect(out.toLowerCase()).toContain('never invent');
  });

  it('is a no-op suffix when there are no categories', () => {
    expect(withCategoryList('BASE', [])).toBe('BASE');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/ai/triage-instructions.spec.ts`
Expected: FAIL — cannot find `./triage-instructions`.

- [ ] **Step 3: Implement the helper**

`src/ai/triage-instructions.ts`:

```ts
import { CategoryDef } from '../plugins/country-plugin.interface';

/**
 * Append the active plugin's valid category keys to the base triage prompt, so
 * the model selects `category` from a CLOSED set at generation time rather than
 * inventing a label the kernel can't map (which would otherwise silently book to
 * EXPENSE_OTHER). Returns the base prompt unchanged when there are no categories.
 */
export function withCategoryList(
  baseInstructions: string,
  categories: CategoryDef[],
): string {
  if (categories.length === 0) return baseInstructions;
  const list = categories.map((c) => `"${c.key}"`).join(', ');
  return (
    baseInstructions +
    `\n\nThe \`category\` field MUST be EXACTLY ONE of these valid categories: ` +
    `${list}. Choose the closest match. NEVER invent a category outside this list.`
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/ai/triage-instructions.spec.ts`
Expected: PASS.

- [ ] **Step 5: Use the helper in `buildTriageAgent`**

In `src/ai/mastra.service.ts`, import the helper and inject the category list into the resolved instructions:

```ts
import { withCategoryList } from './triage-instructions';
```

```ts
  async buildTriageAgent(): Promise<Agent> {
    const { instructions } = await this.config.resolve('triage');
    const model = await this.config.resolveModelConfig('triage');
    const categories = await this.categoryService.list();
    return new Agent({
      id: 'triage-agent',
      name: 'Triage Agent',
      instructions: withCategoryList(instructions, categories),
      model,
      tools: this.buildTools(),
    });
  }
```

- [ ] **Step 6: Run the mastra spec to confirm no regression**

Run: `npx jest src/ai/mastra.service.spec.ts`
Expected: PASS. (The `CategoryService` stub from Task 3 Step 5 returns `[]`, so `withCategoryList` is a no-op there — instructions unchanged.)

- [ ] **Step 7: Commit**

```bash
git add src/ai/triage-instructions.ts src/ai/triage-instructions.spec.ts src/ai/mastra.service.ts
git commit -m "feat(ai): inject valid category list into the triage prompt"
```

---

## Task 5: Validate category on the manual write path

**Files:**
- Modify: `src/expenses/expenses.service.ts:15-45` (constructor + `createExpense`), and the correction patch entry points (`previewPatchedDraft` ~line 125, and the apply-patch methods that accept `patch.category`)
- Modify: `src/expenses/expenses.module.ts` (import `CategoriesModule`)
- Test: `src/expenses/expenses.service.spec.ts`

- [ ] **Step 1: Write the failing test**

In `src/expenses/expenses.service.spec.ts`, add (adapt to the file's existing setup helper for constructing `ExpensesService` — it will now need a `CategoryService` arg; pass a stub):

```ts
describe('createExpense category validation', () => {
  it('rejects an unknown category with BadRequestException', async () => {
    // categoryService stub: only 'software' is valid
    const categoryService = {
      assertValid: async (c: string) => {
        if (c !== 'software')
          throw new BadRequestException(`Unknown category '${c}'.`);
      },
    };
    const service = makeExpensesService({ categoryService }); // extend the existing factory
    await expect(
      service.createExpense({
        category: 'garbage',
        gross_amount: 1000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-01-01',
        supplier_id: null,
        document_id: null,
        document_vat_marking: null,
        supplier_invoice_number: null,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
```

If the spec has no `makeExpensesService` factory, read the file's existing `beforeEach`/construction and thread a `categoryService` stub through it the same way the other injected deps are provided. Import `BadRequestException` from `@nestjs/common`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/expenses/expenses.service.spec.ts -t "category validation"`
Expected: FAIL — `createExpense` does not validate (no `categoryService` on the service yet).

- [ ] **Step 3: Inject `CategoryService` + validate**

In `src/expenses/expenses.service.ts`: import `CategoryService` from `../categories/category.service`, add it to the constructor, and call it at the top of `createExpense` and in the correction patch paths when a category is present:

```ts
// constructor: add after the existing injected deps
    private readonly categoryService: CategoryService,
```

```ts
  async createExpense(dto: CreateExpenseDto): Promise<Expense> {
    await this.categoryService.assertValid(dto.category);
    // ... existing insert (category: dto.category, …) unchanged
  }
```

For the correction patch path(s) that accept `patch.category` (the methods around lines 125-136, 280-292), guard each:

```ts
    if (patch.category !== undefined) {
      await this.categoryService.assertValid(patch.category);
    }
```

Add this validation in `previewPatchedDraft` (the public entry that builds a patched draft) so a correction with a bad category is rejected before it can post. If the patch methods are pure/synchronous transaction helpers that cannot be made async, validate in the public correction entry point that calls them instead — the contract is "a correction with an unknown category is rejected (400), never posted to EXPENSE_OTHER." Read the surrounding methods and place the single async guard at the outermost public correction entry.

In `src/expenses/expenses.module.ts`, add `CategoriesModule` to `imports` (and its top import).

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/expenses/expenses.service.spec.ts`
Expected: PASS (the new test + all existing).

- [ ] **Step 5: Commit**

```bash
git add src/expenses/expenses.service.ts src/expenses/expenses.service.spec.ts src/expenses/expenses.module.ts
git commit -m "feat(expenses): validate category against the active plugin set on write"
```

---

## Task 6: Route an unknown triage category to needs_triage

**Files:**
- Modify: `src/ai/propose-draft.service.ts:42-51` (outcome union), `:82-89` (constructor), `:105-133` (add the category guard)
- Modify: `src/ai/intake-workflow.service.ts:213-224` (route the new outcome)
- Test: `src/ai/propose-draft.service.spec.ts`, `src/ai/intake-workflow.service.spec.ts`

- [ ] **Step 1: Write the failing test (propose-draft returns category-unresolved)**

In `src/ai/propose-draft.service.spec.ts`, add (adapt to the file's existing service-construction helper; it will need a `CategoryService` stub):

```ts
it('returns category-unresolved for a triage category the active plugin does not know', async () => {
  const categoryService = {
    isValid: async (c: string) => c === 'software',
  };
  const service = makeProposeDraftService({ categoryService }); // extend existing factory
  const triage = {
    kind: 'new_expense',
    category: 'made-up-category',
    gross_amount: 1000,
    vat_amount: 0,
    currency: 'EUR',
    tax_point_date: '2026-01-01',
    document_type: 'receipt',
    document_vat_marking: null,
    supplier_invoice_number: null,
    confidence: 0.9,
  };
  const outcome = await service.proposeDraft(triage as never, null, 1);
  expect(outcome.outcome).toBe('category-unresolved');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/ai/propose-draft.service.spec.ts -t "category-unresolved"`
Expected: FAIL — no such outcome; `proposeDraft` proceeds and calls `createExpense`.

- [ ] **Step 3: Add the outcome + the guard**

In `src/ai/propose-draft.service.ts`:

Add the result type next to `SupplierUnresolvedResult` (around line 42-51) and extend the union:

```ts
/**
 * Returned when the triage `category` is not in the active country plugin's
 * category set. Like supplier-unresolved, the caller routes it to needs_triage
 * rather than silently booking to EXPENSE_OTHER (ADR-0002).
 */
export interface CategoryUnresolvedResult {
  outcome: 'category-unresolved';
  reason: string;
}

export type ProposeDraftOutcome =
  | ProposeDraftResult
  | SupplierUnresolvedResult
  | CategoryUnresolvedResult;
```

Inject `CategoryService` in the constructor (import from `../categories/category.service`; add after `config`).

Add the guard immediately AFTER the existing `kind !== 'new_expense'` backstop and BEFORE supplier resolution (around line 119-120):

```ts
    // Category backstop: the prompt injects the closed set and the manual path
    // validates, but a model can still emit an unknown category (Zod admits any
    // string). Route it to needs_triage rather than letting createExpense throw.
    if (!(await this.categoryService.isValid(triageResult.category))) {
      return {
        outcome: 'category-unresolved',
        reason: `new_expense has an unknown category '${triageResult.category}'`,
      };
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/ai/propose-draft.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Route the outcome in `IntakeWorkflowService`**

In `src/ai/intake-workflow.service.ts`, in the `new_expense` case (after the existing `supplier-unresolved` branch at lines 217-222), add:

```ts
          if (outcome.outcome === 'category-unresolved') {
            this.logger.warn(
              `new_expense for document ${documentId} has an unresolved category: ${outcome.reason}`,
            );
            return this.routeNeedsTriage(documentId, outcome.reason);
          }
```

(Match the exact logger field name used by the surrounding code — read lines 217-224 for the precise `this.logger.warn(...)` form and the `routeNeedsTriage` signature.)

- [ ] **Step 6: Write + run the workflow routing test**

In `src/ai/intake-workflow.service.spec.ts`, add a test that stubs `proposeDraft.proposeDraft` to resolve `{ outcome: 'category-unresolved', reason: '...' }` and asserts the workflow result is `status: 'needs_triage'` (mirror the existing `supplier-unresolved` routing test in that file).

Run: `npx jest src/ai/intake-workflow.service.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ai/propose-draft.service.ts src/ai/propose-draft.service.spec.ts src/ai/intake-workflow.service.ts src/ai/intake-workflow.service.spec.ts
git commit -m "feat(ai): route unknown triage category to needs_triage (no silent EXPENSE_OTHER)"
```

---

## Task 7: Frontend — read-only Categories tab + expense create dropdown

**Files:**
- Modify: `frontend/src/api.ts` (after the `Expense` interface / near `getExpenses`)
- Create: `frontend/src/components/CategoriesView.tsx`, `frontend/src/components/CategoriesView.test.tsx`
- Modify: `frontend/src/tabs.tsx`
- Modify: `frontend/src/components/ExpensesView.tsx:18-32,125-131`

Run all frontend commands from `frontend/`.

- [ ] **Step 1: Add the API type + fetch**

In `frontend/src/api.ts`, add near the other read helpers:

```ts
export interface CategoryDef {
  key: string;
  label: string;
  accountCode: string;
}

export const getCategories = () =>
  apiFetch<{ categories: CategoryDef[] }>('/api/categories').then(
    (r) => r.categories,
  );
```

- [ ] **Step 2: Write the failing CategoriesView test**

`frontend/src/components/CategoriesView.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CategoriesView } from './CategoriesView';
import * as api from '../api';

describe('CategoriesView', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getCategories').mockResolvedValue([
      { key: 'software', label: 'Software', accountCode: 'EXPENSE_SOFTWARE' },
      { key: 'rent', label: 'Rent', accountCode: 'EXPENSE_RENT' },
    ]);
  });

  it('renders each category with its account binding', async () => {
    render(<CategoriesView />);
    await waitFor(() => expect(screen.getByText('software')).toBeInTheDocument());
    expect(screen.getByText('EXPENSE_SOFTWARE')).toBeInTheDocument();
    expect(screen.getByText('rent')).toBeInTheDocument();
    expect(screen.getByText('EXPENSE_RENT')).toBeInTheDocument();
  });
});
```

Run: `npx vitest run src/components/CategoriesView.test.tsx`
Expected: FAIL — cannot find `./CategoriesView`.

- [ ] **Step 3: Implement `CategoriesView`**

`frontend/src/components/CategoriesView.tsx` (read-only; follow the table + `overflow-x-auto` + state pattern already used in `DocumentsView.tsx`):

```tsx
import { useEffect, useState } from 'react';
import { getCategories, type CategoryDef } from '../api';

export function CategoriesView() {
  const [cats, setCats] = useState<CategoryDef[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCategories()
      .then(setCats)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="p-4 space-y-4 text-sm">
      {error && <p className="text-red-600">{error}</p>}
      <p className="text-xs text-gray-500">
        Categories are defined by the active country plugin (read-only). Each
        maps to a chart-of-accounts expense account.
      </p>
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="px-3 py-2 font-medium text-gray-700">Key</th>
              <th className="px-3 py-2 font-medium text-gray-700">Label</th>
              <th className="px-3 py-2 font-medium text-gray-700">Account</th>
            </tr>
          </thead>
          <tbody>
            {cats.map((c) => (
              <tr key={c.key} className="border-b align-top">
                <td className="px-3 py-2">{c.key}</td>
                <td className="px-3 py-2">{c.label}</td>
                <td className="px-3 py-2 font-mono">{c.accountCode}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

Run: `npx vitest run src/components/CategoriesView.test.tsx`
Expected: PASS.

- [ ] **Step 4: Register the tab**

In `frontend/src/tabs.tsx`: import `CategoriesView`, define the tab, and insert it into `TABS` (place it right after `expensesTab` so it sits near Expenses):

```tsx
import { CategoriesView } from './components/CategoriesView';
```

```tsx
const categoriesTab: TabDef = {
  key: 'categories',
  label: 'Categories',
  load: async () => [],
  columns: [],
  Custom: CategoriesView,
};
```

Add `categoriesTab,` to the `TABS` array after `expensesTab,`.

- [ ] **Step 5: Turn the expense Category input into a dropdown**

In `frontend/src/components/ExpensesView.tsx`:

Add an import and load the categories. At the top imports add `getCategories, type CategoryDef`:

```tsx
import {
  getExpenses,
  createExpense,
  deleteExpense,
  correctExpense,
  getCategories,
  fmtCents,
  type Expense,
  type CategoryDef,
  type CorrectionRequest,
} from '../api';
```

Add state + load inside the component (next to the other `useState`/`useEffect`):

```tsx
  const [categories, setCategories] = useState<CategoryDef[]>([]);

  useEffect(() => {
    getCategories()
      .then(setCategories)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
```

Replace the Category `<input>` (the freetext field at lines ~125-131) with a `<select>`:

```tsx
          <Field label="Category">
            <select
              aria-label="Category"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              className="border rounded px-2 py-1"
            >
              <option value="">— select —</option>
              {categories.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
```

(The existing `addValid` already requires a non-empty `category`, so the empty placeholder keeps Add disabled until a real category is chosen — verify that guard at line ~114-115 is `form.category.trim() !== ''`.)

- [ ] **Step 6: Run the frontend gate**

Run (from `frontend/`):
```bash
rm -f *.tsbuildinfo && npx tsc -b && npx vitest run && npm run build
```
Expected: tsc clean, all vitest tests pass (including `ExpensesView.test.tsx` — if that test typed the Category field as a textbox via `getByLabelText('Category')`, update it to select an option; read the test and adjust the interaction to `selectOptions`), build succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api.ts frontend/src/components/CategoriesView.tsx frontend/src/components/CategoriesView.test.tsx frontend/src/tabs.tsx frontend/src/components/ExpensesView.tsx frontend/src/components/ExpensesView.test.tsx
git commit -m "feat(spa): read-only Categories tab + expense category dropdown"
```

---

## Final verification (after all tasks)

- [ ] **Backend full gate:** `npm run lint && npm test && npm run test:e2e` — all green. (Re-stage only your files if lint --fix touches parallel work.)
- [ ] **Frontend full gate** (from `frontend/`): `rm -f *.tsbuildinfo && npx tsc -b && npx vitest run && npm run build` — all green.
- [ ] **Grep for the deleted divergence source:** `grep -rn "CANONICAL_CATEGORIES" src/` returns nothing.
- [ ] **Dispatch a final code reviewer** over the whole branch (spec compliance + quality), then push `category-source-of-truth` for the user to open a PR.

---

## Self-review notes (author)

- **Spec §1 getCategories** → Task 1. **§2 plugins one-definition** → Task 1 (Null/Estonia/strict). **§3 AI tool** → Task 3. **§4 prompt injection** → Task 4. **§5 validation** → Task 5 (manual/corrections) + Task 6 (triage path). **§6 SPA + endpoint** → Task 2 (`GET /api/categories`) + Task 7 (view + dropdown). All spec sections covered.
- **Out-of-scope guardrails** (no table/migration/FK/CRUD/custom categories) respected — no migration file is created anywhere in this plan.
- **Type consistency:** `CategoryDef { key, label, accountCode }` is defined once in `country-plugin.interface.ts` (Task 1) and reused verbatim by `CategoryService` (Task 2), the tool (Task 3), the prompt helper (Task 4), and the frontend mirror type (Task 7). Outcome `category-unresolved` is defined in Task 6 and routed in the same task.
- **Known coupling:** Tasks 3-6 depend on `CategoryService` (Task 2) and `getCategories()` (Task 1) — execute in order.
