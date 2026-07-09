# SPA Redesign — Plan 06: Settings section rebuild + final cleanup (the last legacy surfaces die)

> **⚠️ EXECUTOR ATTENTION — deviations from the superpowers TDD default, binding for every task:** this plan follows the Plan 02–05 conventions: complete code in every step (No Placeholders), each task = red → green → full suite → commit, `fireEvent` (never `userEvent`) for anything inside a vaul Drawer, typed fixtures, **never `git stash` in any form** (shared cross-worktree stash stack).

**Goal:** Replace the last legacy section — the `/settings` LegacyTabs mount with its five untouched Views (`OrgView`, `EntitiesView`, `CategoriesView`, `EnrollView`, `SettingsView` + the embedded `MailboxSettings`) — with the redesigned Settings section: an iOS grouped-list **hub** at `/settings` (with a legacy `?tab=` redirect and a mobile **Sign out** affordance the shell currently lacks below `lg:`), push sub-routes for **Organization** (the real `PUT /api/organization` surface, VAT-number hint tied to final KMD downloads), **Entities** (card list with role segments incl. the ADR-0036 **Team** filter, search, and a create sheet that can finally onboard **employee/director** claimants — the P04-flagged blocker that starves the Books upload claimant dropdown on fresh installs), an **entity detail card** per asset §8 (identity + immutable registration key, linked-bookings count-link, **aliases as chips with in-place add**, and a client-derived **classification-memory** section — the server exposes none over REST), read-only **Categories** that never render the ledger `accountCode` (ADR-0030 leak in the legacy table), **Enroll** (QR + honest guidance for the unset-`public_api_url` 500 with the fix field inline), **Mailbox** (connectors with visible status/last-error, IMAP sheet, BYO OAuth keys, OAuth-return banner that the current shell silently drops at `/`), **Telegram & approvers**, **AI models**, and **Policy** (risk gate **in euros** — the legacy raw-cents input dies, ingest policy). The plan also carries the **accumulated P01–P05 cleanup batch**: token promotion (`tint`/`fill`/`track`/`chevron`/`handle`/`ink-3`/`warn-deep`), the app-wide **minus-glyph decision** (U+2212, decided in `fmtCents`), `KeyValue` no-wrap, build hygiene (`vite.config.js`/`.d.ts` artifacts + `tsc -b` emit redirect — `noEmit` is **rejected** by TS 5.5 on referenced projects, verified), `lint`/`lint:fix` split, the shared `?seg=` hook (Entities is the third consumer), a11y fixes (Sheet focus release, `Field` aria-describedby + group variant), the P03/P05 test-hardening batch, the "Already handled"/"Already decided" flash fix, and the StatementScreen delete-invalidation gap. The final tasks swap the router and **delete `LegacyTabs.tsx`, all six legacy Settings components, and `Table.tsx`** — zero residual references; `TokenGate.tsx` explicitly SURVIVES (Root mounts it; it is the sign-in surface, not a Settings view). All on the EXISTING server API; the server is NOT modified.

**Architecture:** New screens live in `packages/web/src/settings/`; typed TanStack Query hooks + the pure model (role labels/segments, claimant filter, alias kinds, entity stats, classification-memory derivation, settings map) in `packages/web/src/queries/settings.ts`; the segment hook in `packages/web/src/lib/useSeg.ts` (extracted per P05 Appendix B — `InboxScreen` + `BooksScreen` refactored onto it, Settings/Entities is the third consumer). Transport: `src/api.ts` already has every wrapper this section needs (verified — organization, entities+aliases, categories, enrollment, mailbox, admin settings, policy config); Task 1 only widens the entity types for the four-role reality. Entity reads go through the FROZEN `sharedKeys.entities`/`categories`/`organization` (`src/queries/keys.ts`); the entity DETAIL key nests under the entities prefix (`['entities','detail',id]`) so existing invalidations cover it. Reused kit: `ListGroup`/`ListRow`/`KeyValue`/`GroupLabel`, `Chip`, `Sheet`, `ConfirmDialog`, `Button`/`LinkButton`, `Field`/`TextInput`/`SelectInput`/`INPUT_CLS`, `SearchInput`, `SegmentedControl`, `EmptyState`/`SkeletonRows`, `LoadError`, `LargeTitleHeader`/`ScreenHeader`, toasts; plus a new `src/settings/SettingField.tsx` (per-key admin-settings editor, ports the legacy unsaved-edit sync guard). The spec's `/settings/*` route list is followed with two recorded adjustments: `/settings/telegram` is ADDED (Telegram config landed after the spec; it is three real `KNOWN_SETTINGS` keys + `approvers`/`email_whitelist`, which the legacy UI never surfaced) and the sign-out row lives on the hub (mobile parity — the only existing sign-out is the `lg:` sidebar's). Legacy `?tab=` bookmarks (`/settings?tab=…`) are honored by a hub-level redirect (`app` → `/settings/llm`). Routes mount and legacy dies in Task 12. Spec: `docs/superpowers/specs/2026-07-08-spa-ux-redesign-design.md` (Settings subsection + IA + data rules); canonical asset: `docs/superpowers/specs/assets/2026-07-09-screens-data-redesign.html` §8 (Entities card) + §9+ (Settings rules).

**Tech Stack:** React 18, TypeScript 5.5, Vite 5, Tailwind 3 (foundation tokens), react-router-dom v7 (data mode), @tanstack/react-query v5, vaul (Sheet), sonner (toasts), `qrcode` (^1.5.4, already a dependency — EnrollView uses it today), vitest + @testing-library/react (jsdom). No new dependencies.

## Reality of the server contract (read this before touching any task)

These facts were verified against `packages/server/src` and BIND every task below:

1. **Organization is GET + PUT (not PATCH), and `public_api_url` is NOT on it.** `GET /api/organization` → `Organization { id, country, base_currency: string|null, vat_registered: boolean, org_type: 'company'|'sole_proprietor', created_at, vat_registration_number: string|null, name: string|null, iban: string|null }` (`organization/types.ts:1-15`); `PUT /api/organization` takes all-optional fields, writes only what is provided, and returns the updated org (`organization.controller.ts:42-51`, `organization.service.ts:45-59`). `base_currency: null` = inherit the country plugin default (ADR-0004). `GET /api/organization/period-config` → `{ frequency_options, default_frequency }` from the country plugin (`organization.controller.ts:25-40`) — org country changes therefore invalidate Reports-owned caches. `public_api_url` lives in the `setting` table (registry entry `admin/settings.registry.ts:77-82`), not on the org row.
2. **Admin settings are a validated key/value registry — exactly 19 keys, all string values.** `GET /admin/settings` → `{ settings: [{key,value}] }`; `GET|PUT|DELETE /admin/settings/:key` with body `{ value: string }` (`admin/settings.controller.ts:16,31-75`). Unknown key → 400 `` `Unknown setting key: ${key}` ``; failed validator → 400 `` `Invalid value for setting ${key}` `` (`settings.service.ts:35-49`). The full registry (`settings.registry.ts:15-99`): `ai_model`, `ai_model.triage`, `ai_model.intent_classifier`, `ai_model.ocr`, `ai_base_url`, `ai_api_key`, `prompt.triage`, `prompt.intent_classifier`, `ingest_policy` (enum `known-only|quarantine|open`, `:9-10`), `telegram_allowlist`, `telegram_webhook_secret`, `telegram_bot_token`, `approvers`, `email_whitelist`, `public_api_url` (validator `httpsOrLocalhost`, `:11-13`), `google_oauth_client_id/secret`, `microsoft_oauth_client_id/secret`. `approvers` and `email_whitelist` are REAL settable keys the legacy UI never surfaced — this plan surfaces them (ADR-0028: expose what the API offers, nothing more).
3. **LIVE LEGACY BUG — `mailbox_initial_fetch_count` is not a known setting.** The mail-sync worker READS it (`mailbox/mail-sync.worker.ts:168`) but it is absent from `KNOWN_SETTINGS`, so the legacy MailboxSettings "Sync settings → Save" has always 400'd with `Unknown setting key: mailbox_initial_fetch_count`. The new Mailbox screen renders NO initial-fetch-count editor (no fake surface); the registry addition is Appendix A gap 4.
4. **Entities have exactly FOUR roles, with per-role required identity.** `EntityRole = 'supplier' | 'customer' | 'employee' | 'director'` (`entities/types.ts:4`; onboard zod enum `:44`). There is NO `claimant` role — a claimant is an entity with role `employee` or `director` (ADR-0036, which specifies the Books upload dropdown as exactly `Entity(role: employee|director)`). Onboarding (`entities.service.ts:42-85`): supplier/customer REQUIRE `registrationKey` (400 `'registrationKey is required for supplier/customer entities'`, `:43-47` — stored as a confirmed `registration_key` identifier); employee/director REQUIRE `email` (400 `'email is required for employee/director entities'`, `:63-66` — stored as an `email` identifier, optional `tgUserId` as `tg_user_id`). The legacy EntitiesView offers only supplier/customer (`ROLES`, `EntitiesView.tsx:16`) — the P04-confirmed blocker: on a fresh install the claimant dropdown is empty and reimbursement flows are unreachable from the UI. Task 6 fixes this.
5. **The entity write surface is narrow — and aliases have no list/delete endpoints.** `PATCH /api/entities/:id` updates ONLY `name`/`country`/`goodsVsServices` (`types.ts:68-72`; the registration key is deliberately immutable, `:64-67`). `POST /api/entities/:id/aliases` accepts ONLY `kind ∈ {iban, merchant_descriptor, name_alias}` (`types.ts:56-60`) even though the identifier union is wider (`registration_key|iban|merchant_descriptor|name_alias|email|phone|address|tg_user_id`, `:6-14`) — so an employee's email/tg identity is NOT editable after onboarding (rendered read-only; Appendix A gap 2). Identifiers arrive inline on `GET /api/entities/:id` (`EntityWithIdentifiers`, `:34-36`); there is no alias delete (gap 1). `DELETE /api/entities/:id` → 409 `` `Entity ${id} (${name}) is referenced by an expense/invoice — cannot delete.` `` when referenced (`entities.service.ts:336-352`). A merge endpoint exists (`POST /api/entities/:survivorId/merge`, `entities.controller.ts:84-96`) but is out of scope (Appendix B). No duplicate-name guard exists — the create sheet does not pretend one does.
6. **Classification memory is NOT exposed over REST.** It exists only as an internal AI tool (`createGetClassificationMemoryTool`, `ai/tools/index.ts:155-176`) that gathers categories from prior expenses. The honest client substitute (asset §8's «Память классификации» section): derive "usually `<category>` (n of m)" from the CACHED shared expenses list (`supplier_id` + `category`, posted rows) — the same source the server tool reads — labeled as an AI hint, not a rule (ADR-0014 advisory). Appendix A gap 3.
7. **Categories are plugin-owned, read-only, and the response leaks ledger vocabulary.** `GET /api/categories` → `CategoryDef { key, label, accountCode }` (`categories.controller.ts:11-18`; `country-plugin.interface.ts:91-98` — "Kernel account code this category books to"). No write endpoint exists. The legacy CategoriesView renders an "Account" column (`CategoriesView.tsx:27,35`) — an ADR-0001/0030 violation that dies with it: the new screen renders `label` + `key` (the key IS operator-facing — it is the `category` value on every expense) and NEVER `accountCode`.
8. **Enrollment is one POST with two honest 500s.** `POST /api/device-enrollments` → `{ apiBaseUrl, enrollmentToken, expiresAt }` (ISO string), HTTP 201 (`auth/mobile-auth.controller.ts:29-57`). `apiBaseUrl` = setting `public_api_url` ?? env `PUBLIC_API_URL` (`:36-38`); when both are unset → 500 `'Public API URL is not configured — set "public_api_url" in Settings (or the PUBLIC_API_URL env var)'` (`:39-44`); non-https non-localhost → 500 `'Public API URL must use https'` (`:45-50`). The QR payload is client-built: `{ v:1, api, enroll }` (legacy `EnrollView.tsx:20-24`, kept verbatim — the mobile app parses this shape).
9. **Mailbox: six endpoints; the OAuth callback redirects to `/` — where the SPA currently DROPS the result.** `GET/POST /api/mailbox/connectors`, `DELETE /api/mailbox/connectors/:id`, `POST /api/mailbox/connectors/:id/sync`, `GET /api/mailbox/oauth/start?provider=gmail|outlook&channel=…` → `{ url }`, and the `@Public()` `GET /api/mailbox/oauth/callback` which 302s the browser to `/?mailbox=connected` or `/?mailbox_error=…` (`mailbox/mailbox.controller.ts:35-164`). The shell's `/` route is `<Navigate to="/inbox" replace/>` (`src/shell/router.tsx:63`) which discards the search string — the OAuth result banner has been silently lost since Plan 01. Task 12 routes `/?mailbox…` to `/settings/mailbox` preserving params; the Mailbox screen surfaces and strips them. Connector rows carry `status ∈ connected|auth_failed|disconnected|error`, `last_synced_at`, `last_error` (`mailbox-connector.service.ts:8-43`). Missing `MAILBOX_SECRET_KEY` env → 500 with a self-explanatory message (`mailbox.controller.ts:69-73`) — surfaced verbatim.
10. **Telegram has NO management endpoints — it is three settings keys plus a webhook.** The only Telegram route is the inbound `@Public()` `POST /api/channels/telegram/webhook` (`interaction/channels/telegram/telegram-webhook.controller.ts:21-52`). Configuration = `telegram_bot_token`, `telegram_webhook_secret`, `telegram_allowlist` via `PUT /admin/settings/:key`. The legacy restart caveat stays true (webhook registration reads the token at boot) and the new screen keeps that copy.
11. **Policy config is a real typed endpoint — and the ceiling is INTEGER CENTS.** `GET /api/policy-config` → `PolicyConfig { auto_post_amount_ceiling /* cents */, auto_post_min_confidence, unknown_supplier_requires_approval, always_approve_operations: string[] }`; `PUT /api/policy-config` takes a PARTIAL body (zod `.partial()`, ceiling `z.number().int()`) and returns the result (`policy/policy-config.controller.ts:17-36`, `policy/types.ts:24-46`). The legacy SettingsView exposes the ceiling as a raw-cents number input (`SettingsView.tsx:339-353`) — data-rule-3/asset-§9+ violation ("центы → евро"); the new Policy screen takes EUROS via `eurosToCents`/`centsToEuroInput` and explains the effect ("expenses above X are held for approval"). `hold_claimant_expenses` (ADR-0036) is NOT in the REST type — not rendered (no fake surface).
12. **LLM/agent config has no dedicated endpoint.** `AgentConfigService` reads `ai_model[.agent]`, `ai_base_url`, `ai_api_key`, `prompt.<agent>` from the setting table (`ai/agent-config.service.ts:30-66`); the agent set is fixed: `triage`, `intent_classifier` (`settings.registry.ts:2`); `ai_model.ocr` is the OCR vision model. The AI screen is therefore a stack of validated key editors — the provider-prefix guidance from the legacy view is kept (registry `:16-23` documents the same rule).

## Client reality (cross-plan cleanup facts, verified in this worktree)

- **`fmtCents` emits an ASCII hyphen-minus** for negatives (`src/api.ts:391`, `(cents/100).toFixed(2)`), while ten production files prefix positive totals with the typographic **U+2212 `−`** (InboxScreen, ExpensesSegment, ExpenseScreen, create, CreditNoteCreateScreen, CorrectSheet, CreditNotesSegment, LockSheet, reports/sections, inbox/format's `signedEuros` uses ASCII). Task 2 decides U+2212 app-wide at the single source (`fmtCents` + `signedEuros`).
- **`noEmit` is NOT a legal fix for the committed `vite.config.js`/`.d.ts` artifacts**: `tsconfig.json` references `tsconfig.node.json` (composite), and TS 5.5.4 rejects a referenced project that disables emit — verified in this worktree: `error TS6310: Referenced project '…/tsconfig.node.json' may not disable emit`. The verified recipe (build green end-to-end): redirect `outDir`/`tsBuildInfoFile` into the repo-root `node_modules/.tmp/`, `git rm` the two tracked artifacts, and gitignore them. Task 2.
- **`npm run lint` mutates** (`"lint": "eslint \"src/**/*.{ts,tsx}\" --fix"`, `package.json:13`). Task 2 splits `lint` (check) / `lint:fix` (mutate).
- **Tokens `ink-3`/`warn-deep` do not exist yet** (`tailwind.config.js` has `ink.DEFAULT/2`, `warn.DEFAULT/bg`); the raw-hex population is exactly known (Task 2 lists every file:line).
- **`?seg=` + legacy-`?tab=` logic is duplicated** in `InboxScreen.tsx:191-196` and `BooksScreen.tsx:26-49` (Books also clears `SEGMENT_PARAMS = ['status','nodoc','dstatus']` and deletes `tab` on write; Inbox's write path `setParams({seg:v})` currently DROPS all other params). Task 3 extracts `useSeg` and refactors both; the Entities screen (Task 6) is the third consumer.
- **The mobile shell has NO sign-out** — the only sign-out control is the `lg:`-only Sidebar button (`Sidebar.tsx:41-47`); `Root` wires it via `AppLayout onSignOut` (`Root.tsx:22`). Task 4 threads `onSignOut` through Outlet context to a hub row. `TokenGate` stays (`Root.tsx:18`).
- **Flash bugs**: `TriageDocScreen.runAction`/`finishTriage` and `ApprovalScreen` (lines 119-120, 130-131) `await invalidateInbox(qc)` BEFORE `navigate(next)` — the refetch lands first and the "Already handled"/"Already decided" empty state flashes. Task 13 swaps the order.
- **StatementScreen delete** invalidates only `bankKeys.statements` (`StatementScreen.tsx:351-362`) — unlink side effects (un-reconciled expenses) stay stale in Books/Reports ≤ staleTime; `invalidateStatement` (`queries/bank.ts:142-152`) already fans out to expenses/books/reports. Task 13.
- **`InPeriodSection`** (`reports/sections.tsx:157-165`) renders as soon as EITHER shared list resolves — the P05-flagged partial-source transient. Task 13 adds the joint `isSuccess` gate.

## Global Constraints

- Working directory for all commands: `packages/web` (repo root: `/Users/alekseirevin/test/headless-bookkeeping.spa-redesign-foundation`).
- Test command: `npx vitest run <file>`; full suite: `npm test`; lint: `npm run lint` (check-only AFTER Task 2; use `npm run lint:fix` to apply); build (typecheck + bundle): `npm run build`. Every task leaves the FULL suite green. **Never run `git stash` in any form** (shared cross-worktree stash stack).
- **Routes (binding, mounted in Task 12):** `/settings` (hub), `/settings/organization`, `/settings/entities`, `/settings/entities/:id`, `/settings/categories`, `/settings/enroll`, `/settings/mailbox`, `/settings/telegram`, `/settings/llm`, `/settings/policy`. All deep-linkable, all survive F5. `LEGACY_REDIRECTS` `/org`, `/entities`, `/categories`, `/enroll` re-point to the sub-routes; `/settings?tab=<organization|entities|categories|enroll|app>` redirects at the hub (`app` → `/settings/llm`); `/?mailbox=…`/`/?mailbox_error=…` (OAuth return) redirects to `/settings/mailbox` preserving params.
- **Cache keys:** entity/category/organization reads go through the FROZEN `sharedKeys` (`src/queries/keys.ts`) — never re-declare the literals. New Settings-domain keys live under `['settings', …]` in `src/queries/settings.ts`; the entity detail key is `[...sharedKeys.entities, 'detail', id]` so `sharedKeys.entities` prefix-invalidation covers it. Mutations invalidate via the Task 3 helpers: entity writes → `invalidateEntities` (covers list + details; Books/Inbox titles join through the same key); org writes → `invalidateOrganization` (org + `['reports']` — period-config and final-download eligibility are org-derived); admin-setting writes → `invalidateAdminSettings`; mailbox writes → `invalidateMailbox` (connectors + `['inbox']` — sync harvests documents into the queue); policy writes → `invalidatePolicy`.
- **NO new polling.** Zero `refetchInterval` in `src/settings/` or `src/queries/settings.ts`. The bank import job (1.5s) and the Inbox lists (30s, route-scoped) remain the only intervals (Plans 02/03).
- **Colors through tokens.** After Task 2 the token set includes `tint` (#E3EFE8), `fill` (#E9EBE7), `track` (#E5E7E3), `chevron` (#C2C7C1), `handle` (#D4D7D1), `ink-3` (#8A9089), `warn-deep` (#6D4A05) — new Settings code uses tokens ONLY. The surviving sanctioned inline hexes (single-site, commented at the site): `#4D534E` (`TxDispositions.tsx:17`), `#B7C4BA` (`SupplierSheet.tsx:133`), `#ECEEEA` (`Sidebar.tsx:12`), `#F5FAF6` (`StatementScreen.tsx:184`). No other raw hex anywhere in `src/`.
- **Anti-overlap rules (binding):** amounts never wrap (`AmountText` + `flex-none` containers); titles/subtitles single-line `truncate`; left column `min-w-0 flex-1`, right column `flex-none`.
- **Screen invariants:** exactly ONE primary button per state and its label states the outcome ("Add employee", "Save organization", "Delete entity" — never "Submit"/"OK"); IDs are not data (no "#12" in titles; ids live in URLs); reasons/errors are human sentences — server error messages that are already human (Reality #4/#5/#8/#9) surface verbatim in toasts; secrets render masked (`type="password"`).
- Money **inputs are euros** via `eurosToCents`/`centsToEuroInput` (`src/lib/money.ts`); the API speaks integer cents (Reality #11); display via `fmtCents`/`AmountText`.
- **Never** `window.prompt/confirm/alert` (the legacy EntitiesView delete-confirm dies with it). Never render voucher/account/debit/credit vocabulary — in particular `CategoryDef.accountCode` NEVER reaches the DOM (Reality #7; grep-enforced in Task 14). Irreversible actions (entity delete, connector remove) go through `ConfirmDialog` — plan→confirm→receipt, never optimistic.
- **Sheets remount per object** — action sheets carry `key={…}` or render only while open, so state never leaks across objects (Plan 03 Task 13 lesson). Compute-before-mutate for anything that navigates after a mutation; navigate BEFORE awaiting queue invalidation where a refetch would blank the current screen (Task 13's flash rule).
- UI copy is **English** (Russian in mockups is design annotation): "Settings", "Organization", "Entities", "Add employee", "Aliases — how documents name it", "Usually categorised", "Sign out".
- Test mocking rule (Plan 03): modules import the REAL `fmtCents` from `../api`, so tests mock the api module with the spread-importOriginal pattern (`vi.mock('../api', async (io) => ({ ...(await io<typeof import('../api')>()), <fn>: vi.fn() }))`), never a bare object literal. `fireEvent` (not `userEvent`) inside vaul Drawer tests.
- Commit style: `feat(web): …`/`chore(web): …`/`fix(web): …`, one commit per task. React StrictMode double-mount safe (one-shot fetches via React Query; effects with cleanup — the Enroll screen documents its deliberate legacy-parity exception).
- The legacy `/settings` mount stays untouched and functional until Task 12 swaps the router; every intermediate task leaves the suite green.

---
### Task 1: API transport — four-role entity reality (types only; every endpoint wrapper already exists)

**Files:**
- Modify: `packages/web/src/api.ts`
- Test: `packages/web/src/api.settings.test.ts` (new)

**Interfaces:**
- Consumes: existing `apiFetch`, existing `onboardEntity` (`src/api.ts:554` — a pass-through `POST /api/entities`; `JSON.stringify` drops `undefined` fields, so the new optional fields flow with zero body-building changes).
- Produces (all from `src/api.ts`):
  - `export type EntityRole = 'supplier' | 'customer' | 'employee' | 'director'` (verified enum `entities/types.ts:4` + zod `:44` — Reality #4).
  - `Entity.role` retyped from `string` to `EntityRole` (`src/api.ts:38-46`).
  - `OnboardEntityInput` widened: `role: EntityRole`; `registrationKey?: string` (now optional — required per-role by the SERVER, Reality #4); new `email?: string`, `tgUserId?: string`.
  - JSDoc on `OnboardEntityInput` documenting the per-role requirement with the two verbatim server 400s.
- NOT added (verified unnecessary): every other Settings endpoint already has a typed wrapper — `getOrganization`/`updateOrganization` (`api.ts:135,149`), `getEntities`/`getEntity`/`updateEntity`/`deleteEntity`/`addEntityAlias` (`:155,526,568,522,538`), `getCategories` (`:174`), `createDeviceEnrollment` (`:1124`), the five mailbox functions (`:1160-1185`), `getSettings`/`setSetting`/`deleteSetting` (`:818-831`), `getPolicyConfig`/`updatePolicyConfig` (`:845,848`). The merge endpoint gets no wrapper (out of scope, Appendix B).

- [ ] **Step 1: Write failing tests**

`src/api.settings.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setToken } from './auth';
import { onboardEntity, type EntityRole, type OnboardEntityInput } from './api';

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

describe('entity onboarding — four-role reality (Plan 06 Reality #4)', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('posts an employee with email + tgUserId and WITHOUT registrationKey', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({ id: 9, role: 'employee', country: 'EE', name: 'Mari Maasikas' }),
    );
    const input: OnboardEntityInput = {
      role: 'employee',
      country: 'EE',
      name: 'Mari Maasikas',
      email: 'mari@example.com',
      tgUserId: '123456789',
    };
    const created = await onboardEntity(input);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/entities');
    expect(init?.method).toBe('POST');
    // JSON.stringify drops undefined — the wire body must not carry a
    // registrationKey key at all for employee/director.
    expect(JSON.parse(init?.body as string)).toEqual({
      role: 'employee',
      country: 'EE',
      name: 'Mari Maasikas',
      email: 'mari@example.com',
      tgUserId: '123456789',
    });
    expect(created.id).toBe(9);
  });

  it('posts a supplier with registrationKey exactly as before (no regression)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({ id: 3, role: 'supplier', country: 'EE', name: 'Circle K Eesti AS' }),
    );
    await onboardEntity({
      role: 'supplier',
      country: 'EE',
      name: 'Circle K Eesti AS',
      registrationKey: 'EE100511246',
      goodsVsServices: 'goods',
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      role: 'supplier',
      country: 'EE',
      name: 'Circle K Eesti AS',
      registrationKey: 'EE100511246',
      goodsVsServices: 'goods',
    });
  });

  it('EntityRole covers exactly the server enum', () => {
    // Compile-time pin: assignment fails if the union drifts.
    const roles: EntityRole[] = ['supplier', 'customer', 'employee', 'director'];
    expect(roles).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/api.settings.test.ts
```

Expected: FAIL — the first test's `OnboardEntityInput` literal does not typecheck (`role: 'employee'` not assignable; `email` unknown). (vitest surfaces this as a transform/type error under `tsc -b`-checked test runs; if the runner executes anyway, the compile gate is Step 4's `npm run build`.)

- [ ] **Step 3: Implement in `src/api.ts`**

3a. Add the role union and retype `Entity.role` — in the `Entity` interface (`src/api.ts:38-46`) replace `role: string;` with `role: EntityRole;` and add above the interface:

```ts
/** The server's entity role enum — verified entities/types.ts:4. Employees
 *  and directors are the ADR-0036 claimants (there is NO 'claimant' role). */
export type EntityRole = 'supplier' | 'customer' | 'employee' | 'director';
```

3b. Replace the `OnboardEntityInput` interface (`src/api.ts:545-552`) with:

```ts
/**
 * POST /api/entities body. Identity is PER-ROLE (entities.service.ts:42-85):
 * supplier/customer REQUIRE registrationKey (400
 * 'registrationKey is required for supplier/customer entities'); employee/
 * director REQUIRE email (400 'email is required for employee/director
 * entities'), optional tgUserId. The server stores these as identifiers
 * (registration_key / email / tg_user_id); none is editable afterwards.
 */
export interface OnboardEntityInput {
  role: EntityRole;
  country: string;
  name: string;
  registrationKey?: string;
  goodsVsServices?: 'goods' | 'services' | 'unknown';
  email?: string;
  tgUserId?: string;
}
```

- [ ] **Step 4: Run tests, then the full suite and build**

```bash
npx vitest run src/api.settings.test.ts && npm test && npm run build
```

Expected: PASS. Fixture fallout rule: any test fixture that typed `Entity.role` as an arbitrary string must use one of the four literals; any `OnboardEntityInput` literal keeps compiling (`registrationKey` went optional — a widening). The bank `SupplierSheet` (P02 Task 10) always passes `registrationKey` — still valid. The legacy `EntitiesView` compiles unchanged (it passes `registrationKey` from its form).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api.ts packages/web/src/api.settings.test.ts
git commit -m "feat(web): entity transport knows all four roles (employee/director onboarding fields, ADR-0036)"
```

---

### Task 2: Foundation cleanup batch — tokens, minus glyph, KeyValue, build hygiene, lint split (P01–P05 carry-overs)

**Files:**
- Modify: `packages/web/tailwind.config.js`, `packages/web/src/api.ts` (fmtCents), `packages/web/src/inbox/format.ts` (signedEuros), `packages/web/src/ui/{Chip,Button,SearchInput,SegmentedControl,List,Sheet}.tsx`, `packages/web/src/inbox/InboxScreen.tsx`, `packages/web/src/reports/PeriodScreen.tsx`, `packages/web/src/bank/{TxCandidates,TxCreateExpense,StatementScreen,TxDispositions,TxMatched}.tsx`, `packages/web/src/ui/LinkButton.test.tsx`, `packages/web/tsconfig.node.json`, `packages/web/package.json`, `packages/web/.gitignore`
- Create: `packages/web/src/api.format.test.ts`
- Delete (tracked build artifacts): `packages/web/vite.config.js`, `packages/web/vite.config.d.ts`

**Interfaces:**
- Produces: Tailwind tokens `tint`, `fill`, `track`, `chevron`, `handle`, `ink.3`, `warn.deep`; `fmtCents`/`signedEuros` emitting **U+2212 `−`** for negatives; `KeyValue` value that never wraps; a check-only `lint` script + `lint:fix`; a `tsc -b` that emits `tsconfig.node.json` artifacts into repo-root `node_modules/.tmp/` (verified recipe — `noEmit` is rejected with TS6310 on referenced projects under TS 5.5.4, tested in this worktree).
- **Minus-glyph decision (binding app-wide):** the typographic minus **U+2212** wins. Rationale: ten production files already prefix totals with `−` (Client reality); U+2212 has figure width under `tabular-nums` so negative amounts align with `+`-signed inflows; the change is made at the SINGLE display source (`fmtCents` + `signedEuros`) rather than sweeping nine call sites the other way; input parsing (`eurosToCents`) is untouched — users still type ASCII `-` if they ever type signs.

- [ ] **Step 1: Write failing tests**

`src/api.format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fmtCents } from './api';
import { signedEuros } from './inbox/format';

describe('minus-glyph decision (U+2212 app-wide, Plan 06 Task 2)', () => {
  it('fmtCents emits the typographic minus for negatives', () => {
    expect(fmtCents(-4820)).toBe('−48.20');
    expect(fmtCents(4820)).toBe('48.20');
    expect(fmtCents(0)).toBe('0.00');
  });

  it('signedEuros signs with U+2212 / ASCII +', () => {
    expect(signedEuros(-4820)).toBe('−48.20 €');
    expect(signedEuros(4820)).toBe('+48.20 €');
    expect(signedEuros(0)).toBe('0.00 €');
  });
});
```

Also update the ONE existing pin that asserts a raw one-off hex class: in `src/ui/LinkButton.test.tsx:28` replace the `#E9EBE7` expectation with `bg-fill` (keep the assertion's structure otherwise).

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/api.format.test.ts src/ui/LinkButton.test.tsx
```

Expected: FAIL — `fmtCents(-4820)` is `'-48.20'` (ASCII); LinkButton still renders `bg-[#E9EBE7]`.

- [ ] **Step 3: Tokens — `tailwind.config.js`**

Replace the `colors` block with (values unchanged where they existed; additions commented):

```js
      colors: {
        // Semantic tokens (spec 2026-07-08-spa-ux-redesign-design.md).
        // Dark theme later = swap these values; never hardcode hex in components.
        bg: '#F2F3F1',
        surface: '#FFFFFF',
        ink: { DEFAULT: '#191C1A', 2: '#6E756F', 3: '#8A9089' },
        line: '#EEF0EC',
        accent: { DEFAULT: '#0E5A3C', deep: '#0E3B2C' },
        signal: '#3DDC97',
        ok: { DEFAULT: '#14713F', bg: '#E3F2E9' },
        warn: { DEFAULT: '#8A5A00', bg: '#FDF0D3', deep: '#6D4A05' },
        err: { DEFAULT: '#A83A2C', bg: '#FBE9E5' },
        alert: '#E8590C',
        // Promoted one-offs (Plan 06 Task 2 — previously sanctioned inline):
        tint: '#E3EFE8', // accent-tinted wash: accent chips, icon tiles
        fill: '#E9EBE7', // neutral control fill: secondary buttons, search field
        track: '#E5E7E3', // segmented-control track
        chevron: '#C2C7C1', // disclosure chevrons, checkbox borders
        handle: '#D4D7D1', // sheet drag handle
      },
```

- [ ] **Step 4: Sweep every promoted hex to its token (exact sites, verified)**

Mechanical class-name replacements — the utility prefix stays, only the arbitrary value becomes the token (`bg-[#E3EFE8]` → `bg-tint`, `text-[#C2C7C1]` → `text-chevron`, `border-[#C2C7C1]` → `border-chevron`, etc.):

| File:line | From | To |
|---|---|---|
| `src/ui/Chip.tsx:10` | `bg-[#E3EFE8]` | `bg-tint` |
| `src/inbox/InboxScreen.tsx:36` | `bg-[#E3EFE8]` | `bg-tint` |
| `src/reports/PeriodScreen.tsx:35` | `bg-[#E3EFE8]` | `bg-tint` |
| `src/ui/Button.tsx:11` | `bg-[#E9EBE7]` | `bg-fill` |
| `src/ui/SearchInput.tsx:11` | `bg-[#E9EBE7]` | `bg-fill` |
| `src/ui/SegmentedControl.tsx:11` | `[#E5E7E3]` | `track` (keep prefix) |
| `src/ui/List.tsx:68` | `[#C2C7C1]` | `chevron` |
| `src/ui/Sheet.tsx:22` | `bg-[#D4D7D1]` | `bg-handle` |
| `src/bank/TxCandidates.tsx:131` | `[#C2C7C1]` | `chevron` |
| `src/bank/TxCandidates.tsx:173` | `[#8A9089]` | `ink-3` |
| `src/bank/TxCreateExpense.tsx:175` | `[#C2C7C1]` | `chevron` |
| `src/bank/TxCreateExpense.tsx:193` | `[#8A9089]` | `ink-3` |
| `src/bank/StatementScreen.tsx:80,120` | `[#C2C7C1]` | `chevron` |
| `src/bank/TxDispositions.tsx:20,96` | `[#C2C7C1]` | `chevron` |
| `src/bank/TxDispositions.tsx:158` | `[#8A9089]` | `ink-3` |
| `src/bank/TxDispositions.tsx:138,187` | `[#6D4A05]` | `warn-deep` |
| `src/bank/TxMatched.tsx:147` | `[#8A9089]` | `ink-3` |

The four SURVIVING single-site one-offs get a sanctioning comment where one is missing (do not change their values): `#4D534E` (`TxDispositions.tsx:17`), `#B7C4BA` (`SupplierSheet.tsx:133`), `#ECEEEA` (`Sidebar.tsx:12`), `#F5FAF6` (`StatementScreen.tsx:184`) — e.g. `{/* sanctioned one-off (approved mockup), no token — Plan 06 Task 2 */}` or a `//` comment on the line above.

- [ ] **Step 5: `KeyValue` no-wrap (P05 kit nit) — `src/ui/List.tsx:91-98`**

Replace the value span's class list so the right column can never wrap:

```tsx
export function KeyValue({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line px-3.5 py-2.5 text-sm last:border-b-0">
      <span className="text-ink-2">{k}</span>
      <span className="min-w-0 truncate text-right font-semibold tabular-nums">
        {v}
      </span>
    </div>
  );
}
```

(`truncate` = `whitespace-nowrap` + ellipsis overflow — amounts never wrap AND a pathological long value — an email, a URL — degrades to ellipsis instead of blowing the row. `min-w-0` lets the truncation actually engage inside flex.)

- [ ] **Step 6: Minus glyph — single-source change**

`src/api.ts:391`:

```ts
/** Euro display formatting: integer cents → "48.20". Negatives carry the
 *  TYPOGRAPHIC minus U+2212 (figure-width under tabular-nums — aligns with
 *  '+'-signed inflows). App-wide decision, Plan 06 Task 2. */
export const fmtCents = (cents: number): string =>
  (cents < 0 ? '−' : '') + (Math.abs(cents) / 100).toFixed(2);
```

`src/inbox/format.ts` — replace `signedEuros` (and its stale comment):

```ts
/** Signed euro string for hero amounts and outcome-stating button labels.
 *  Negative sign is the typographic minus U+2212 (matches fmtCents). */
export function signedEuros(cents: number): string {
  const base = `${(Math.abs(cents) / 100).toFixed(2)} €`;
  if (cents < 0) return `−${base}`;
  if (cents > 0) return `+${base}`;
  return base;
}
```

- [ ] **Step 7: Build hygiene — artifact emit redirect + git rm + gitignore + lint split**

7a. `tsconfig.node.json` (whole file — the `outDir`/`tsBuildInfoFile` additions are the only change; **do NOT use `noEmit`**: TS 5.5.4 fails with `TS6310: Referenced project … may not disable emit`, verified in this worktree):

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "outDir": "../../node_modules/.tmp/web-tsconfig-node",
    "tsBuildInfoFile": "../../node_modules/.tmp/web-tsconfig-node.tsbuildinfo"
  },
  "include": ["vite.config.ts"]
}
```

7b. Remove the tracked artifacts and shield against recommit — append to `packages/web/.gitignore` (create the file if absent):

```
# Compiled tsconfig.node.json artifacts — emitted into repo-root
# node_modules/.tmp since Plan 06 Task 2; committed copies used to SHADOW
# vite.config.ts for Vite's dev server (P01 footgun).
/vite.config.js
/vite.config.d.ts
/tsconfig.node.tsbuildinfo
/tsconfig.tsbuildinfo
```

```bash
git rm --cached vite.config.js vite.config.d.ts
rm -f vite.config.js vite.config.d.ts tsconfig.node.tsbuildinfo
```

7c. `package.json` scripts — split check from mutate:

```json
    "lint": "eslint \"src/**/*.{ts,tsx}\"",
    "lint:fix": "eslint \"src/**/*.{ts,tsx}\" --fix",
```

- [ ] **Step 8: Run the suite; repair the minus-glyph pins the failures identify**

```bash
npm test
```

Expected fallout, mechanical and self-identifying: every failure is a test expectation containing an ASCII `-` immediately before a `fmtCents`-formatted amount (bank suites — `TxDispositions`, `TxMatched`, `StatementScreen`, `TxCandidates` pass raw negative cents and previously rendered `-48.20`). Fix each failing EXPECTED string by replacing that ASCII `-` with `−` (U+2212). Do not touch expectations that pass. Then:

```bash
npm test && npm run lint && npm run build
git status --short   # expect NO vite.config.js / vite.config.d.ts / *.tsbuildinfo anywhere
grep -rn "#[0-9A-Fa-f]\{6\}" src --include='*.tsx' --include='*.ts' | grep -v test | grep -vE "TxDispositions.tsx.*4D534E|SupplierSheet.tsx.*B7C4BA|Sidebar.tsx.*ECEEEA|StatementScreen.tsx.*F5FAF6"
```

Expected: suite/lint/build green; clean status; the final grep prints NOTHING (only the four sanctioned sites carry hex, and each carries its comment).

- [ ] **Step 9: Commit**

```bash
git add -A packages/web
git commit -m "chore(web): P01-P05 cleanup batch — token promotion + U+2212 minus + KeyValue no-wrap + tsconfig.node emit redirect (TS6310 blocks noEmit) + lint/lint:fix split"
```

---
### Task 3: Settings query layer + pure model + the shared `useSeg` hook (P05 carry-over: third consumer arrives)

**Files:**
- Create: `packages/web/src/queries/settings.ts`, `packages/web/src/queries/settings.test.tsx`, `packages/web/src/lib/useSeg.ts`, `packages/web/src/lib/useSeg.test.tsx`
- Modify: `packages/web/src/inbox/InboxScreen.tsx`, `packages/web/src/books/BooksScreen.tsx` (refactor onto `useSeg`; rendering byte-identical), plus their test files (additive round-trip pins only)

**Interfaces:**
- Consumes: `getEntity`, `getMailboxConnectors`, `getOrganization`, `getPolicyConfig`, `getSettings` and types from `../api`; `sharedKeys` from `./keys`.
- Produces from `src/queries/settings.ts`:
  - `settingsKeys` — `all: ['settings']`, `admin`, `policy`, `mailbox`; `entityDetailKey(id) = [...sharedKeys.entities, 'detail', id]`.
  - Hooks: `useOrganization()` (FULL org object on the frozen `sharedKeys.organization` — same key+fn as the existing `useOrganizationCountry`, different `select`, one cache entry), `useAdminSettings()` (→ `Record<string,string>`), `usePolicyConfig()`, `useMailboxConnectors()`, `useEntityDetail(id, enabled)`.
  - Invalidators: `invalidateEntities`, `invalidateOrganization`, `invalidateAdminSettings`, `invalidateMailbox`, `invalidatePolicy` (fan-outs per Global Constraints).
  - Pure model: `settingsMap`, `ROLE_LABEL`, `ROLE_TONE`, `CLAIMANT_ROLES`, `ENTITY_SEGMENTS`/`EntitySegment`, `segmentEntities`, `entityMatchesQuery`, `identifierOf`, `aliasesOf`, `ALIAS_KIND_LABEL`, `entityStats`, `classificationMemory`.
- Produces from `src/lib/useSeg.ts`: `useSeg<T extends string>(segments, fallback, clear?)` → `[T, (next: T) => void]`.
- **Extraction decision recorded:** P05 Appendix B deferred the `?seg=`+`?tab=` hook until Settings supplied a third consumer. The Settings HUB uses push sub-routes (spec IA), but the **Entities list** (Task 6) is a genuine segmented list (All | Suppliers | Customers | Team — asset §8 "Claimant-роли видны отдельным фильтром") — the third consumer is real, so the hook lands now and Inbox + Books refactor onto it.
- **One deliberate behavior unification, disclosed:** Inbox's legacy write path `setParams({ seg: v })` REPLACED the whole search string; the hook (like Books) PRESERVES unrelated params and deletes `tab` on write. For Inbox the only other params are `expand` (redirects away before the control renders) — no user-visible change; the round-trip pins prove it.

- [ ] **Step 1: Write failing tests**

`src/lib/useSeg.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useSeg } from './useSeg';

const SEGS = ['all', 'open', 'done'] as const;

function Probe({ clear }: { clear?: readonly string[] }) {
  const [seg, setSeg] = useSeg(SEGS, 'all', clear);
  const location = useLocation();
  return (
    <div>
      <span data-testid="seg">{seg}</span>
      <span data-testid="search">{location.search}</span>
      <button onClick={() => setSeg('done')}>go-done</button>
    </div>
  );
}

const mount = (initial: string, clear?: readonly string[]) =>
  render(
    <MemoryRouter initialEntries={[initial]}>
      <Probe clear={clear} />
    </MemoryRouter>,
  );

describe('useSeg (shared ?seg= + legacy ?tab= alias)', () => {
  it('reads ?seg=', () => {
    mount('/x?seg=open');
    expect(screen.getByTestId('seg').textContent).toBe('open');
  });

  it('accepts legacy ?tab= as an alias', () => {
    mount('/x?tab=open');
    expect(screen.getByTestId('seg').textContent).toBe('open');
  });

  it('falls back on unknown values (?seg wins over ?tab)', () => {
    mount('/x?seg=bogus');
    expect(screen.getByTestId('seg').textContent).toBe('all');
  });

  it('write round-trip: sets seg, drops tab, clears listed params, PRESERVES the rest', () => {
    mount('/x?tab=open&q=milk&status=draft', ['status']);
    fireEvent.click(screen.getByText('go-done'));
    expect(screen.getByTestId('seg').textContent).toBe('done');
    const search = new URLSearchParams(
      screen.getByTestId('search').textContent ?? '',
    );
    expect(search.get('seg')).toBe('done');
    expect(search.get('tab')).toBeNull();
    expect(search.get('status')).toBeNull();
    expect(search.get('q')).toBe('milk');
  });
});
```

`src/queries/settings.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getSettings: vi.fn(),
}));
import {
  getSettings,
  type Entity,
  type EntityIdentifier,
  type Expense,
  type SalesInvoice,
} from '../api';
import { sharedKeys } from './keys';
import {
  ALIAS_KIND_LABEL,
  aliasesOf,
  CLAIMANT_ROLES,
  classificationMemory,
  entityDetailKey,
  entityMatchesQuery,
  entityStats,
  identifierOf,
  invalidateEntities,
  invalidateMailbox,
  invalidateOrganization,
  ROLE_LABEL,
  segmentEntities,
  settingsKeys,
  settingsMap,
  useAdminSettings,
} from './settings';

const entity = (over: Partial<Entity> = {}): Entity =>
  ({
    id: 3,
    role: 'supplier',
    country: 'EE',
    name: 'Circle K Eesti AS',
    goods_vs_services: 'goods',
    ...over,
  }) as Entity;

const ident = (over: Partial<EntityIdentifier>): EntityIdentifier =>
  ({ id: 1, entity_id: 3, kind: 'name_alias', value: 'x', confirmed: true, ...over }) as EntityIdentifier;

const expense = (over: Partial<Expense> = {}): Expense =>
  ({
    id: 1,
    supplier_id: 3,
    category: 'fuel',
    gross_amount: 4820,
    vat_amount: 869,
    currency: 'EUR',
    tax_point_date: '2026-06-10',
    status: 'posted',
    reconciled: false,
    supplier_invoice_number: null,
    ...over,
  }) as Expense;

describe('pure model', () => {
  it('role labels and claimant roles mirror the server enum (Reality #4)', () => {
    expect(ROLE_LABEL).toEqual({
      supplier: 'Supplier',
      customer: 'Customer',
      employee: 'Employee',
      director: 'Director',
    });
    expect(CLAIMANT_ROLES).toEqual(['employee', 'director']);
  });

  it('segmentEntities: team = employee + director (ADR-0036 claimants)', () => {
    const rows = [
      entity({ id: 1, role: 'supplier' }),
      entity({ id: 2, role: 'customer' }),
      entity({ id: 3, role: 'employee' }),
      entity({ id: 4, role: 'director' }),
    ];
    expect(segmentEntities(rows, 'all').map((e) => e.id)).toEqual([1, 2, 3, 4]);
    expect(segmentEntities(rows, 'suppliers').map((e) => e.id)).toEqual([1]);
    expect(segmentEntities(rows, 'customers').map((e) => e.id)).toEqual([2]);
    expect(segmentEntities(rows, 'team').map((e) => e.id)).toEqual([3, 4]);
  });

  it('entityMatchesQuery is case-insensitive over the name', () => {
    expect(entityMatchesQuery(entity(), 'circle')).toBe(true);
    expect(entityMatchesQuery(entity(), 'CIRCLE K')).toBe(true);
    expect(entityMatchesQuery(entity(), 'wolt')).toBe(false);
    expect(entityMatchesQuery(entity(), '')).toBe(true);
  });

  it('identifierOf / aliasesOf split identity from aliases', () => {
    const e = entity({
      identifiers: [
        ident({ kind: 'registration_key', value: 'EE100511246' }),
        ident({ id: 2, kind: 'merchant_descriptor', value: 'CIRCLE K 4411' }),
        ident({ id: 3, kind: 'iban', value: 'EE38…', confirmed: false }),
        ident({ id: 4, kind: 'email', value: 'x@y.z' }),
      ],
    });
    expect(identifierOf(e, 'registration_key')).toBe('EE100511246');
    expect(identifierOf(e, 'email')).toBe('x@y.z');
    expect(identifierOf(e, 'phone')).toBeNull();
    expect(aliasesOf(e).map((a) => a.kind)).toEqual([
      'merchant_descriptor',
      'iban',
    ]);
    expect(ALIAS_KIND_LABEL.merchant_descriptor).toBe('Bank-line descriptor');
  });

  it('entityStats: supplier joins non-draft expenses; customer joins invoices; team → null', () => {
    const expenses = [
      expense({ id: 1, gross_amount: 4820 }),
      expense({ id: 2, gross_amount: 1000, status: 'draft' }), // excluded
      expense({ id: 3, gross_amount: 180, supplier_id: 99 }), // other supplier
    ];
    const invoices = [
      { id: 7, customer_id: 5, gross_amount: 12000, status: 'posted' } as SalesInvoice,
    ];
    expect(entityStats(expenses, invoices, entity())).toEqual({
      label: 'Expenses',
      count: 1,
      totalCents: 4820,
    });
    expect(
      entityStats(expenses, invoices, entity({ id: 5, role: 'customer' })),
    ).toEqual({ label: 'Invoices', count: 1, totalCents: 12000 });
    expect(
      entityStats(expenses, invoices, entity({ id: 9, role: 'employee' })),
    ).toBeNull();
  });

  it('classificationMemory: top posted category with honest counts; null when no posted rows', () => {
    const rows = [
      expense({ id: 1, category: 'fuel' }),
      expense({ id: 2, category: 'fuel', tax_point_date: '2026-06-11' }),
      expense({ id: 3, category: 'office', tax_point_date: '2026-06-12' }),
      expense({ id: 4, category: 'fuel', status: 'draft' }), // not evidence
    ];
    expect(classificationMemory(rows, 3)).toEqual({
      category: 'fuel',
      count: 2,
      of: 3,
    });
    expect(classificationMemory(rows, 42)).toBeNull();
  });

  it('settingsMap folds the list into a record', () => {
    expect(
      settingsMap([
        { key: 'ai_model', value: 'openai/gpt-4o-mini' },
        { key: 'public_api_url', value: 'https://api.example.com' },
      ]),
    ).toEqual({
      'ai_model': 'openai/gpt-4o-mini',
      'public_api_url': 'https://api.example.com',
    });
  });
});

describe('keys and invalidation', () => {
  it('entity detail nests under the FROZEN entities prefix', () => {
    expect(entityDetailKey(7)).toEqual(['entities', 'detail', 7]);
    expect(settingsKeys.all).toEqual(['settings']);
  });

  it('invalidators fan out per the binding rules', async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await invalidateEntities(qc);
    await invalidateOrganization(qc);
    await invalidateMailbox(qc);
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(sharedKeys.entities);
    expect(keys).toContainEqual(sharedKeys.organization);
    expect(keys).toContainEqual(['reports']);
    expect(keys).toContainEqual(settingsKeys.mailbox);
    expect(keys).toContainEqual(['inbox']);
  });
});

describe('hooks', () => {
  it('useAdminSettings selects the map', async () => {
    vi.mocked(getSettings).mockResolvedValue([
      { key: 'ingest_policy', value: 'quarantine' },
    ]);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useAdminSettings(), { wrapper });
    await waitFor(() =>
      expect(result.current.data).toEqual({ ingest_policy: 'quarantine' }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/lib/useSeg.test.tsx src/queries/settings.test.tsx
```

Expected: FAIL — both modules do not exist.

- [ ] **Step 3: Implement `src/lib/useSeg.ts`**

```ts
import { useSearchParams } from 'react-router-dom';

/**
 * Shared ?seg= segment state with the legacy ?tab= alias (LegacyTabs
 * bookmarks). Extracted in Plan 06 on the third consumer (P05 Appendix B):
 * InboxScreen, BooksScreen, settings/EntitiesScreen.
 * Read: ?seg= wins, ?tab= is the alias, anything unknown → fallback.
 * Write: sets ?seg=, deletes ?tab= and the segment-scoped `clear` params,
 * PRESERVES everything else (?q= survives a Books segment switch),
 * replace-history (a segment flick is not a navigation).
 */
export function useSeg<T extends string>(
  segments: readonly T[],
  fallback: T,
  clear: readonly string[] = [],
): [T, (next: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('seg') ?? params.get('tab');
  const seg = segments.includes(raw as T) ? (raw as T) : fallback;
  const setSeg = (next: T) => {
    const p = new URLSearchParams(params);
    p.set('seg', next);
    p.delete('tab');
    for (const key of clear) p.delete(key);
    setParams(p, { replace: true });
  };
  return [seg, setSeg];
}
```

- [ ] **Step 4: Implement `src/queries/settings.ts`**

```ts
import { useQuery, type QueryClient } from '@tanstack/react-query';
import {
  getEntity,
  getMailboxConnectors,
  getOrganization,
  getPolicyConfig,
  getSettings,
  type Entity,
  type EntityIdentifier,
  type EntityRole,
  type Expense,
  type SalesInvoice,
  type Setting,
} from '../api';
import { sharedKeys } from './keys';

/**
 * Settings data layer. Entity/category/organization READS ride the frozen
 * sharedKeys (bank/inbox/books already populate them); this module adds the
 * Settings-only reads and the PURE model (role segments, alias kinds, entity
 * stats, classification-memory derivation) so everything is unit-testable
 * without React. NO refetchInterval anywhere here (Global Constraints).
 */
export const settingsKeys = {
  all: ['settings'] as const,
  admin: ['settings', 'admin'] as const,
  policy: ['settings', 'policy-config'] as const,
  mailbox: ['settings', 'mailbox-connectors'] as const,
};

/** Detail nests under the FROZEN entities prefix so sharedKeys.entities
 *  prefix-invalidation covers list AND details. */
export const entityDetailKey = (id: number) =>
  [...sharedKeys.entities, 'detail', id] as const;

// ── Hooks ──────────────────────────────────────────────────────────────────

/** Full organization object — same cache entry as useOrganizationCountry
 *  (identical key + fn; that hook merely selects country). */
export const useOrganization = () =>
  useQuery({ queryKey: sharedKeys.organization, queryFn: getOrganization });

export const settingsMap = (list: Setting[]): Record<string, string> =>
  Object.fromEntries(list.map((s) => [s.key, s.value]));

/** All admin settings as a key→value record (Reality #2: 19 known keys,
 *  string values). */
export const useAdminSettings = () =>
  useQuery({
    queryKey: settingsKeys.admin,
    queryFn: getSettings,
    select: settingsMap,
  });

export const usePolicyConfig = () =>
  useQuery({ queryKey: settingsKeys.policy, queryFn: getPolicyConfig });

export const useMailboxConnectors = () =>
  useQuery({ queryKey: settingsKeys.mailbox, queryFn: getMailboxConnectors });

export const useEntityDetail = (id: number, enabled = true) =>
  useQuery({
    queryKey: entityDetailKey(id),
    queryFn: () => getEntity(id),
    enabled,
  });

// ── Invalidation (Global Constraints fan-outs) ─────────────────────────────

export const invalidateEntities = (qc: QueryClient): Promise<void> =>
  // Prefix covers the list AND every ['entities','detail',id]; Books/Inbox
  // name-joins read through the same shared key.
  qc.invalidateQueries({ queryKey: sharedKeys.entities });

export const invalidateOrganization = (qc: QueryClient): Promise<void> =>
  Promise.all([
    qc.invalidateQueries({ queryKey: sharedKeys.organization }),
    // period-config (frequency options) and final-download eligibility (VAT
    // registration number) are org-derived Reports inputs (Reality #1).
    qc.invalidateQueries({ queryKey: ['reports'] }),
  ]).then(() => undefined);

export const invalidateAdminSettings = (qc: QueryClient): Promise<void> =>
  qc.invalidateQueries({ queryKey: settingsKeys.admin });

export const invalidateMailbox = (qc: QueryClient): Promise<void> =>
  Promise.all([
    qc.invalidateQueries({ queryKey: settingsKeys.mailbox }),
    // A sync harvests documents straight into the triage queue.
    qc.invalidateQueries({ queryKey: ['inbox'] }),
  ]).then(() => undefined);

export const invalidatePolicy = (qc: QueryClient): Promise<void> =>
  qc.invalidateQueries({ queryKey: settingsKeys.policy });

// ── Pure model ─────────────────────────────────────────────────────────────

export const ROLE_LABEL: Record<EntityRole, string> = {
  supplier: 'Supplier',
  customer: 'Customer',
  employee: 'Employee',
  director: 'Director',
};

/** Chip tones per role — suppliers/customers neutral, team accent (they are
 *  the ADR-0036 claimants, visually distinct per asset §8). */
export const ROLE_TONE: Record<EntityRole, 'muted' | 'accent'> = {
  supplier: 'muted',
  customer: 'muted',
  employee: 'accent',
  director: 'accent',
};

/** ADR-0036: a claimant is an entity with one of these roles. */
export const CLAIMANT_ROLES: readonly EntityRole[] = ['employee', 'director'];

export const ENTITY_SEGMENTS = [
  'all',
  'suppliers',
  'customers',
  'team',
] as const;
export type EntitySegment = (typeof ENTITY_SEGMENTS)[number];

export function segmentEntities(
  entities: Entity[],
  seg: EntitySegment,
): Entity[] {
  switch (seg) {
    case 'all':
      return entities;
    case 'suppliers':
      return entities.filter((e) => e.role === 'supplier');
    case 'customers':
      return entities.filter((e) => e.role === 'customer');
    case 'team':
      return entities.filter((e) =>
        (CLAIMANT_ROLES as readonly string[]).includes(e.role),
      );
  }
}

export function entityMatchesQuery(e: Entity, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === '') return true;
  return e.name.toLowerCase().includes(needle);
}

export function identifierOf(
  e: Entity,
  kind: string,
): string | null {
  const hit = (e.identifiers ?? []).find((i) => i.kind === kind);
  return hit?.value ?? null;
}

/** The addable alias kinds (Reality #5: the aliases endpoint accepts exactly
 *  these three) — identity kinds (registration_key/email/…) are NOT aliases. */
export const ALIAS_KIND_LABEL: Record<string, string> = {
  iban: 'IBAN',
  merchant_descriptor: 'Bank-line descriptor',
  name_alias: 'Name alias',
};

export function aliasesOf(e: Entity): EntityIdentifier[] {
  return (e.identifiers ?? []).filter(
    (i) => i.kind in ALIAS_KIND_LABEL,
  );
}

/** Linked-bookings stat for the entity card (asset §8: «Расходов 12 ·
 *  −680,40 € ›»). Non-draft only (drafts are not bookings — Books total
 *  discipline, P04). Team roles: the expense list rows carry no claimant
 *  linkage — no stat rather than a fake one. */
export function entityStats(
  expenses: Expense[],
  invoices: SalesInvoice[],
  e: Entity,
): { label: string; count: number; totalCents: number } | null {
  if (e.role === 'supplier') {
    const rows = expenses.filter(
      (x) => x.supplier_id === e.id && x.status !== 'draft',
    );
    return {
      label: 'Expenses',
      count: rows.length,
      totalCents: rows.reduce((s, x) => s + x.gross_amount, 0),
    };
  }
  if (e.role === 'customer') {
    const rows = invoices.filter(
      (x) => x.customer_id === e.id && x.status !== 'draft',
    );
    return {
      label: 'Invoices',
      count: rows.length,
      totalCents: rows.reduce((s, x) => s + x.gross_amount, 0),
    };
  }
  return null;
}

/**
 * Client-side classification memory (asset §8): "usually <category>
 * (count of of)". Derived from POSTED expenses of this supplier — the same
 * evidence the server's internal AI tool gathers (Reality #6); labeled an
 * AI hint, not a rule (ADR-0014 advisory). Null when there is no evidence.
 */
export function classificationMemory(
  expenses: Expense[],
  entityId: number,
): { category: string; count: number; of: number } | null {
  const posted = expenses.filter(
    (x) => x.supplier_id === entityId && x.status === 'posted',
  );
  if (posted.length === 0) return null;
  const counts = new Map<string, number>();
  for (const x of posted)
    counts.set(x.category, (counts.get(x.category) ?? 0) + 1);
  let top: { category: string; count: number } | null = null;
  for (const [category, count] of counts)
    if (top === null || count > top.count) top = { category, count };
  return top === null
    ? null
    : { category: top.category, count: top.count, of: posted.length };
}
```

- [ ] **Step 5: Refactor the two existing `?seg=` consumers onto the hook (rendering byte-identical)**

5a. `src/inbox/InboxScreen.tsx` — add `import { useSeg } from '../lib/useSeg';`. Replace the segment block (`:191-196`):

```tsx
  const [params, setParams] = useSearchParams();
  // Legacy bookmarks used ?tab= (LegacyTabs); accept it as an alias.
  const rawSeg = params.get('seg') ?? params.get('tab');
  const seg: InboxSegment = SEGMENTS.includes(rawSeg as InboxSegment)
    ? (rawSeg as InboxSegment)
    : 'all';
```

with:

```tsx
  const [params] = useSearchParams();
  const [seg, setSeg] = useSeg<InboxSegment>(SEGMENTS, 'all');
```

(`params` stays — the `expand` deep-link redirect still reads it; `setParams` import usage disappears from this screen.) Replace the SegmentedControl's `onChange={(v) => setParams({ seg: v }, { replace: true })}` with `onChange={setSeg}`.

5b. `src/books/BooksScreen.tsx` — add the same import. Replace the read block and the local `setSeg` (`:26-42`):

```tsx
  const [seg, setSeg] = useSeg<Segment>(SEGMENTS, 'expenses', SEGMENT_PARAMS);
```

(keep `const [params, setParams] = useSearchParams();` and `q`/`setQ` untouched — the hook manages only the segment). Delete the now-unused local `setSeg` function.

- [ ] **Step 6: Add the round-trip pins to the two screen test files (P03/P05-routed hardening)**

In `src/inbox/InboxScreen.test.tsx` and `src/books/BooksScreen.test.tsx`, using EACH FILE'S existing render helper and api mocks (follow the FILE — Plans 03/04 established them), add one test per file:

- Inbox: mount at `/inbox?tab=approvals` → the Approvals segment is active (legacy alias); click the Triage tab → the location search contains `seg=triage` and no `tab=` (round-trip).
- Books: mount at `/books?seg=expenses&q=acme&status=draft` → click the Invoices segment → the location search has `seg=invoices`, `q=acme` PRESERVED, and the segment-scoped params (`status`/`nodoc`/`dstatus`) plus any `tab` dropped.

If an equivalent pin already exists in a file (P04 Task 13 added `?tab=` alias coverage to Books), extend rather than duplicate it: the NEW assertion is the preserved-`q` + dropped-`tab` write path. Disclose in the commit message which file already covered what.

- [ ] **Step 7: Run everything**

```bash
npx vitest run src/lib/useSeg.test.tsx src/queries/settings.test.tsx src/inbox/InboxScreen.test.tsx src/books/BooksScreen.test.tsx && npm test && npm run lint && npm run build
```

Expected: PASS — the existing Inbox/Books suites pin the alias/default behavior, which is unchanged by construction.

- [ ] **Step 8: Commit**

```bash
git add -A packages/web/src
git commit -m "feat(web): settings query layer + pure model; extract shared useSeg hook (third consumer) and refactor Inbox/Books onto it"
```

---
### Task 4: SettingsScreen — the grouped-list hub, legacy `?tab=` redirect, mobile Sign out

**Files:**
- Create: `packages/web/src/settings/SettingsScreen.tsx`, `packages/web/src/settings/SettingsScreen.test.tsx`
- Modify: `packages/web/src/shell/AppLayout.tsx` (thread `onSignOut` through Outlet context)

**Interfaces:**
- Consumes: `useOrganization`, `useMailboxConnectors` (Task 3), `useEntities` (`queries/shared.ts`); `ListGroup`/`ListRow`, `LargeTitleHeader`, `Button`; `useOutletContext`/`Navigate`/`useSearchParams`.
- Produces: `ShellOutletContext` (exported from `AppLayout.tsx`); the hub screen (NOT yet routed — Task 12 mounts it).
- **Sign out reality (verified):** the only existing sign-out is the `lg:`-only Sidebar button; `Root` owns the state flip (`onUnauthorized` → `clearToken` + `setHasToken(false)`, `Root.tsx:12-15`). The hub row reuses the SAME callback via Outlet context — no second sign-out implementation, no direct `clearToken` calls from screens. `TokenGate` is untouched.

- [ ] **Step 1: `src/shell/AppLayout.tsx` — provide the context**

```tsx
import { Outlet } from 'react-router-dom';
import { useInboxCount } from '../queries/inbox';
import { Sidebar } from './Sidebar';
import { TabBar } from './TabBar';

/** Screens reach shell affordances through Outlet context (react-router).
 *  Today that is only sign-out (Settings hub row — the sidebar is lg:-only,
 *  so phones had NO sign-out until Plan 06). */
export interface ShellOutletContext {
  onSignOut: () => void;
}

export function AppLayout({ onSignOut }: { onSignOut: () => void }) {
  // Live decision-queue badge. NO polling here — the hook shares the Inbox
  // queue's cache keys and refreshes via staleTime/focus + Inbox refetches.
  const inboxCount = useInboxCount();
  return (
    <div className="min-h-screen bg-bg text-ink">
      <Sidebar onSignOut={onSignOut} inboxCount={inboxCount} />
      <div className="pb-24 lg:pb-6 lg:pl-56">
        <Outlet context={{ onSignOut } satisfies ShellOutletContext} />
      </div>
      <TabBar inboxCount={inboxCount} />
    </div>
  );
}
```

- [ ] **Step 2: Write failing tests**

`src/settings/SettingsScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  createMemoryRouter,
  Outlet,
  RouterProvider,
} from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getOrganization: vi.fn(),
  getEntities: vi.fn(),
  getMailboxConnectors: vi.fn(),
}));
import {
  getEntities,
  getMailboxConnectors,
  getOrganization,
} from '../api';
import { SettingsScreen } from './SettingsScreen';

const onSignOut = vi.fn();

function mount(initial = '/settings') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        element: <Outlet context={{ onSignOut }} />,
        children: [
          { path: '/settings', element: <SettingsScreen /> },
          { path: '/settings/llm', element: <div>LLM SCREEN</div> },
          { path: '/settings/entities', element: <div>ENTITIES SCREEN</div> },
        ],
      },
    ],
    { initialEntries: [initial] },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOrganization).mockResolvedValue({
    id: 1,
    country: 'EE',
    base_currency: null,
    vat_registered: true,
    org_type: 'company',
    created_at: 0,
    name: 'Acme OÜ',
    vat_registration_number: 'EE123456789',
    iban: null,
  } as never);
  vi.mocked(getEntities).mockResolvedValue([]);
  vi.mocked(getMailboxConnectors).mockResolvedValue([]);
});

describe('SettingsScreen (hub)', () => {
  it('renders the three groups with all eight rows', async () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    for (const row of [
      'Organization',
      'Entities',
      'Categories',
      'Mail intake',
      'Posting policy',
      'AI models',
      'Telegram & approvers',
      'Mobile device',
    ]) {
      expect(screen.getByText(row)).toBeInTheDocument();
    }
    // Org name arrives as the row subtitle once the shared cache resolves.
    await waitFor(() =>
      expect(screen.getByText('Acme OÜ')).toBeInTheDocument(),
    );
  });

  it('Sign out fires the shell callback (mobile parity)', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('redirects legacy ?tab= bookmarks: app → /settings/llm', async () => {
    const router = mount('/settings?tab=app');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/settings/llm'),
    );
    expect(screen.getByText('LLM SCREEN')).toBeInTheDocument();
  });

  it('redirects ?tab=entities to the sub-route', async () => {
    const router = mount('/settings?tab=entities');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/settings/entities'),
    );
  });

  it('ignores unknown ?tab= values (renders the hub)', () => {
    mount('/settings?tab=bogus');
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run src/settings/SettingsScreen.test.tsx
```

Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `src/settings/SettingsScreen.tsx`**

```tsx
import { Navigate, useSearchParams } from 'react-router-dom';
import { useEntities } from '../queries/shared';
import {
  useMailboxConnectors,
  useOrganization,
} from '../queries/settings';
import { LargeTitleHeader } from '../shell/Headers';
import type { ShellOutletContext } from '../shell/AppLayout';
import { useOutletContext } from 'react-router-dom';
import { Button } from '../ui/Button';
import { ListGroup, ListRow } from '../ui/List';

/** Legacy LegacyTabs bookmarks: /settings?tab=<key>. `app` was the combined
 *  SettingsView (LLM + Telegram + mailbox + policy) — the closest single
 *  target is the AI screen; the rest are one hub tap away. */
const TAB_ROUTES: Record<string, string> = {
  organization: '/settings/organization',
  entities: '/settings/entities',
  categories: '/settings/categories',
  enroll: '/settings/enroll',
  app: '/settings/llm',
};

/** /settings — the iOS grouped-list hub (spec IA). Rows are push routes;
 *  subtitles are honest cache reads (no extra fetches beyond the shared
 *  entries the rest of the app already populates). */
export function SettingsScreen() {
  const [params] = useSearchParams();
  const { onSignOut } = useOutletContext<ShellOutletContext>();
  const orgQ = useOrganization();
  const entitiesQ = useEntities();
  const connectorsQ = useMailboxConnectors();

  const tab = params.get('tab');
  if (tab !== null && TAB_ROUTES[tab] !== undefined) {
    return <Navigate to={TAB_ROUTES[tab]} replace />;
  }

  const entityCount = entitiesQ.data?.length;
  const connectorCount = connectorsQ.data?.length;

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <LargeTitleHeader title="Settings" />
      <ListGroup label="Organization">
        <ListRow
          to="/settings/organization"
          title="Organization"
          subtitle={orgQ.data?.name ?? undefined}
        />
        <ListRow
          to="/settings/entities"
          title="Entities"
          subtitle={
            entityCount === undefined
              ? 'Suppliers, customers, team'
              : `${entityCount} — suppliers, customers, team`
          }
        />
        <ListRow
          to="/settings/categories"
          title="Categories"
          subtitle="Read-only — owned by the country plugin"
        />
      </ListGroup>
      <ListGroup label="Intake">
        <ListRow
          to="/settings/mailbox"
          title="Mail intake"
          subtitle={
            connectorCount === undefined
              ? 'Mailbox connectors'
              : connectorCount === 0
                ? 'No mailboxes connected'
                : `${connectorCount} connected`
          }
        />
        <ListRow
          to="/settings/policy"
          title="Posting policy"
          subtitle="Risk gate & ingest policy"
        />
      </ListGroup>
      <ListGroup label="System">
        <ListRow
          to="/settings/llm"
          title="AI models"
          subtitle="Models, endpoint, prompts"
        />
        <ListRow
          to="/settings/telegram"
          title="Telegram & approvers"
          subtitle="Bot, allowlist, approver identities"
        />
        <ListRow
          to="/settings/enroll"
          title="Mobile device"
          subtitle="Enrollment QR"
        />
      </ListGroup>
      <div className="mx-3.5 mt-2">
        <Button variant="secondary" className="w-full" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run tests, then the full suite**

```bash
npx vitest run src/settings/SettingsScreen.test.tsx src/shell/AppLayout.test.tsx && npm test
```

Expected: PASS — `AppLayout.test.tsx` keeps passing (the context prop is additive; if any assertion pins the exact `<Outlet/>` element, follow the FILE and update it disclosing the change).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/settings packages/web/src/shell/AppLayout.tsx
git commit -m "feat(web): Settings hub — grouped list, legacy ?tab= redirects, mobile sign-out via shell outlet context"
```

---

### Task 5: OrganizationScreen — the real PUT surface, honest hints

**Files:**
- Create: `packages/web/src/settings/OrganizationScreen.tsx`, `packages/web/src/settings/OrganizationScreen.test.tsx`

**Interfaces:**
- Consumes: `useOrganization`, `invalidateOrganization` (Task 3); `updateOrganization`, `type Organization` (`api.ts:149,18`); `Field`/`TextInput`/`SelectInput`, `ScreenHeader`, `Button`, `SkeletonRows`, `LoadError`, toasts.
- Behavior (Reality #1): loads the org, edits locally, PUTs the normalized full field set (legacy OrgView's trim/empty→null rules preserved verbatim — they are the server's inherit semantics), writes the response back via `setQueryData` + `invalidateOrganization`. Country/base-currency are pattern-constrained inputs (the asset's "ISO selects" degrade honestly: no supported-countries endpoint exists — Appendix A gap 6). The VAT-number hint states the REAL consequence (final KMD downloads 400 without it — P05 Reality #13).

- [ ] **Step 1: Write failing tests**

`src/settings/OrganizationScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getOrganization: vi.fn(),
  updateOrganization: vi.fn(),
}));
import { getOrganization, updateOrganization, type Organization } from '../api';
import { AppToaster } from '../ui/toast';
import { OrganizationScreen } from './OrganizationScreen';

const ORG: Organization = {
  id: 1,
  country: 'EE',
  base_currency: null,
  vat_registered: true,
  org_type: 'company',
  created_at: 0,
  name: 'Acme OÜ',
  vat_registration_number: 'EE123456789',
  iban: null,
};

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: '/settings/organization', element: <OrganizationScreen /> }],
    { initialEntries: ['/settings/organization'] },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
      <AppToaster />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOrganization).mockResolvedValue(ORG);
});

describe('OrganizationScreen', () => {
  it('prefills every field from the org (data rule 7)', async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Name')).toHaveValue('Acme OÜ'),
    );
    expect(screen.getByLabelText('Country')).toHaveValue('EE');
    expect(screen.getByLabelText('Type')).toHaveValue('company');
    expect(screen.getByLabelText('VAT registered')).toBeChecked();
    expect(screen.getByLabelText('VAT registration number')).toHaveValue(
      'EE123456789',
    );
    expect(screen.getByLabelText('Base currency')).toHaveValue('');
  });

  it('saves the normalized field set and toasts a receipt', async () => {
    vi.mocked(updateOrganization).mockResolvedValue({
      ...ORG,
      iban: 'EE382200221020145685',
    });
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Name')).toHaveValue('Acme OÜ'),
    );
    fireEvent.change(screen.getByLabelText('IBAN'), {
      target: { value: '  EE382200221020145685  ' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save organization' }),
    );
    await waitFor(() =>
      expect(updateOrganization).toHaveBeenCalledWith({
        country: 'EE',
        org_type: 'company',
        vat_registered: true,
        base_currency: null,
        name: 'Acme OÜ',
        vat_registration_number: 'EE123456789',
        iban: 'EE382200221020145685', // trimmed
      }),
    );
    expect(await screen.findByText('Organization saved')).toBeInTheDocument();
  });

  it('blocks save on a malformed country and explains why', async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Country')).toHaveValue('EE'),
    );
    fireEvent.change(screen.getByLabelText('Country'), {
      target: { value: 'Estonia' },
    });
    expect(
      screen.getByText('Two-letter ISO code, e.g. EE'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save organization' }),
    ).toBeDisabled();
    expect(updateOrganization).not.toHaveBeenCalled();
  });

  it('surfaces a server failure verbatim and keeps the form editable', async () => {
    vi.mocked(updateOrganization).mockRejectedValue(
      new Error('Expected exactly 1 organization record, found 0'),
    );
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Name')).toHaveValue('Acme OÜ'),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Save organization' }),
    );
    expect(
      await screen.findByText('Expected exactly 1 organization record, found 0'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save organization' }),
    ).toBeEnabled();
  });

  it('renders LoadError with retry when the org read fails', async () => {
    vi.mocked(getOrganization).mockRejectedValue(new Error('boom'));
    mount();
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/settings/OrganizationScreen.test.tsx
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/settings/OrganizationScreen.tsx`**

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  updateOrganization,
  type Organization,
} from '../api';
import { sharedKeys } from '../queries/keys';
import {
  invalidateOrganization,
  useOrganization,
} from '../queries/settings';
import { ScreenHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { SkeletonRows } from '../ui/Feedback';
import { Field, INPUT_CLS, SelectInput, TextInput } from '../ui/Form';
import { LoadError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';

const COUNTRY_RE = /^[A-Z]{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** /settings/organization — the GET+PUT /api/organization surface
 *  (Reality #1). Country/base-currency are constrained TEXT inputs, not the
 *  asset's ISO selects: the API exposes no supported-countries list and a
 *  200-entry ISO dropdown would be fake surface (Appendix A gap 6). */
export function OrganizationScreen() {
  const orgQ = useOrganization();
  if (orgQ.isPending) {
    return (
      <Frame>
        <SkeletonRows count={4} />
      </Frame>
    );
  }
  if (orgQ.isError) {
    return (
      <Frame>
        <LoadError
          message={orgQ.error instanceof Error ? orgQ.error.message : 'Failed'}
          onRetry={() => void orgQ.refetch()}
        />
      </Frame>
    );
  }
  return (
    <Frame>
      <OrgForm key={orgQ.dataUpdatedAt} initial={orgQ.data} />
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Organization" backTo="/settings" />
      {children}
    </div>
  );
}

function OrgForm({ initial }: { initial: Organization }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [country, setCountry] = useState(initial.country);
  const [orgType, setOrgType] = useState(
    initial.org_type === 'sole_proprietor' ? 'sole_proprietor' : 'company',
  );
  const [vatRegistered, setVatRegistered] = useState(initial.vat_registered);
  const [name, setName] = useState(initial.name ?? '');
  const [vatNumber, setVatNumber] = useState(
    initial.vat_registration_number ?? '',
  );
  const [iban, setIban] = useState(initial.iban ?? '');
  const [currency, setCurrency] = useState(initial.base_currency ?? '');

  const countryErr = COUNTRY_RE.test(country.trim().toUpperCase())
    ? null
    : 'Two-letter ISO code, e.g. EE';
  const currencyErr =
    currency.trim() === '' ||
    CURRENCY_RE.test(currency.trim().toUpperCase())
      ? null
      : 'Three-letter ISO code, e.g. EUR — or blank to inherit';
  const valid = countryErr === null && currencyErr === null;

  const save = async () => {
    setBusy(true);
    try {
      const saved = await updateOrganization({
        country: country.trim().toUpperCase(),
        org_type: orgType === 'sole_proprietor' ? 'sole_proprietor' : 'company',
        vat_registered: vatRegistered,
        // Empty string → null: inherit the country plugin's base currency
        // (ADR-0004; legacy OrgView semantics preserved).
        base_currency: currency.trim() ? currency.trim().toUpperCase() : null,
        name: name.trim() ? name.trim() : null,
        vat_registration_number: vatNumber.trim() ? vatNumber.trim() : null,
        iban: iban.trim() ? iban.trim() : null,
      });
      qc.setQueryData(sharedKeys.organization, saved);
      await invalidateOrganization(qc);
      toastOk('Organization saved');
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-3.5 mb-3.5 space-y-4 rounded-2xl bg-surface p-4">
      <Field label="Name">
        <TextInput
          aria-label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Acme OÜ"
        />
      </Field>
      <Field
        label="Country"
        error={countryErr}
        hint="Determines the accounting plugin, VAT rates and period frequency"
      >
        <TextInput
          aria-label="Country"
          value={country}
          onChange={(e) => setCountry(e.target.value.toUpperCase())}
          placeholder="EE"
          maxLength={2}
          className={`${INPUT_CLS} uppercase`}
        />
      </Field>
      <Field label="Type">
        <SelectInput
          aria-label="Type"
          value={orgType}
          onChange={(e) => setOrgType(e.target.value)}
        >
          <option value="company">Company</option>
          <option value="sole_proprietor">Sole proprietor</option>
        </SelectInput>
      </Field>
      <label className="flex items-center gap-2 text-[15px]">
        <input
          type="checkbox"
          aria-label="VAT registered"
          checked={vatRegistered}
          onChange={(e) => setVatRegistered(e.target.checked)}
        />
        <span>VAT registered</span>
      </label>
      <Field
        label="VAT registration number"
        hint="Declarant identity — a locked period's FINAL KMD download fails without it"
      >
        <TextInput
          aria-label="VAT registration number"
          value={vatNumber}
          onChange={(e) => setVatNumber(e.target.value)}
          placeholder="e.g. EE123456789"
        />
      </Field>
      <Field label="IBAN">
        <TextInput
          aria-label="IBAN"
          value={iban}
          onChange={(e) => setIban(e.target.value)}
          placeholder="e.g. EE382200221020145685"
        />
      </Field>
      <Field
        label="Base currency"
        error={currencyErr}
        hint="Blank = inherit the country plugin default"
      >
        <TextInput
          aria-label="Base currency"
          value={currency}
          onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          placeholder="(inherit)"
          maxLength={3}
          className={`${INPUT_CLS} uppercase`}
        />
      </Field>
      <Button
        className="w-full"
        busy={busy}
        disabled={!valid || busy}
        onClick={() => void save()}
      >
        Save organization
      </Button>
    </div>
  );
}
```

NOTE (verified against the kit): `TextInput` spreads props AFTER `className={INPUT_CLS}` (`Form.tsx:37-39`), so a caller-passed `className` REPLACES the kit class entirely — that is why both uppercase inputs pass `` `${INPUT_CLS} uppercase` `` rather than `"uppercase"`.

- [ ] **Step 4: Run tests, then the full suite**

```bash
npx vitest run src/settings/OrganizationScreen.test.tsx && npm test
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/settings
git commit -m "feat(web): Organization screen — PUT surface with inherit semantics, constrained ISO inputs, final-KMD VAT-number hint"
```

---
### Task 6: EntitiesScreen — segmented card list + CreateEntitySheet (the ADR-0036 unblocking)

**Files:**
- Create: `packages/web/src/settings/EntitiesScreen.tsx`, `packages/web/src/settings/EntitiesScreen.test.tsx`, `packages/web/src/settings/CreateEntitySheet.tsx`, `packages/web/src/settings/CreateEntitySheet.test.tsx`

**Interfaces:**
- Consumes: `useEntities` (shared), `useSeg` (Task 3 — **third consumer**), the Task 3 model (`ENTITY_SEGMENTS`, `segmentEntities`, `entityMatchesQuery`, `ROLE_LABEL`, `ROLE_TONE`), `onboardEntity`/`EntityRole` (Task 1), `invalidateEntities`; kit: `SegmentedControl`, `SearchInput`, `ListGroup`/`ListRow`, `Chip`, `Sheet`, `Field`/`TextInput`/`SelectInput`, `Button`, `EmptyState`/`SkeletonRows`/`LoadError`, `LargeTitleHeader`, toasts.
- Produces: `/settings/entities` list (mounted in Task 12): segments **All | Suppliers | Customers | Team** in `?seg=`, `?q=` search (both survive F5), rows `name + role chip + country` (NO ids — data rule 1), each row → `/settings/entities/:id`; a `+ Add` header action opening `CreateEntitySheet`.
- **CreateEntitySheet is the ADR-0036 fix (Reality #4):** the role select offers all four roles; supplier/customer show Registration key (required, marked immutable) + Goods/services; employee/director show Email (required) + Telegram user id (optional) and a consequence hint ("appears in the claimant dropdown when uploading a receipt"). Payload mirrors the server per-role contract exactly; the primary label states the outcome ("Add employee"); on success → receipt toast → navigate to the new detail → background invalidation.

- [ ] **Step 1: Write failing tests**

`src/settings/CreateEntitySheet.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  onboardEntity: vi.fn(),
}));
import { onboardEntity } from '../api';
import { AppToaster } from '../ui/toast';
import { CreateEntitySheet } from './CreateEntitySheet';

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const router = createMemoryRouter(
    [
      {
        path: '/settings/entities',
        element: <CreateEntitySheet open onClose={onClose} />,
      },
      { path: '/settings/entities/:id', element: <div>DETAIL</div> },
    ],
    { initialEntries: ['/settings/entities'] },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
      <AppToaster />
    </QueryClientProvider>,
  );
  return { router, onClose };
}

beforeEach(() => vi.clearAllMocks());

describe('CreateEntitySheet', () => {
  it('supplier: requires name, country and registration key; posts the exact payload', async () => {
    vi.mocked(onboardEntity).mockResolvedValue({ id: 31 } as never);
    const { router } = mount();
    const submit = () => screen.getByRole('button', { name: 'Add supplier' });
    expect(submit()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: ' Circle K Eesti AS ' },
    });
    fireEvent.change(screen.getByLabelText('Country'), {
      target: { value: 'EE' },
    });
    expect(submit()).toBeDisabled(); // still no registration key
    fireEvent.change(screen.getByLabelText('Registration key'), {
      target: { value: 'EE100511246' },
    });
    fireEvent.change(screen.getByLabelText('Goods or services'), {
      target: { value: 'goods' },
    });
    fireEvent.click(submit());
    await waitFor(() =>
      expect(onboardEntity).toHaveBeenCalledWith({
        role: 'supplier',
        name: 'Circle K Eesti AS',
        country: 'EE',
        registrationKey: 'EE100511246',
        goodsVsServices: 'goods',
      }),
    );
    // Navigates straight to the new entity's card.
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/settings/entities/31'),
    );
  });

  it('employee: swaps identity fields (email required, tg optional) — the ADR-0036 path', async () => {
    vi.mocked(onboardEntity).mockResolvedValue({ id: 9 } as never);
    mount();
    fireEvent.change(screen.getByLabelText('Role'), {
      target: { value: 'employee' },
    });
    // Supplier-only fields are GONE; identity fields appear.
    expect(screen.queryByLabelText('Registration key')).toBeNull();
    expect(screen.queryByLabelText('Goods or services')).toBeNull();
    expect(
      screen.getByText(
        'Appears in the claimant dropdown when uploading a receipt (reimbursement)',
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Mari Maasikas' },
    });
    fireEvent.change(screen.getByLabelText('Country'), {
      target: { value: 'EE' },
    });
    const submit = screen.getByRole('button', { name: 'Add employee' });
    expect(submit).toBeDisabled(); // email required (server 400s without it)
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'mari@example.com' },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(onboardEntity).toHaveBeenCalledWith({
        role: 'employee',
        name: 'Mari Maasikas',
        country: 'EE',
        email: 'mari@example.com',
      }),
    );
  });

  it('surfaces the server per-role 400 verbatim and stays open', async () => {
    vi.mocked(onboardEntity).mockRejectedValue(
      new Error('registrationKey is required for supplier/customer entities'),
    );
    const { onClose } = mount();
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'X' },
    });
    fireEvent.change(screen.getByLabelText('Country'), {
      target: { value: 'EE' },
    });
    fireEvent.change(screen.getByLabelText('Registration key'), {
      target: { value: 'k' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add supplier' }));
    expect(
      await screen.findByText(
        'registrationKey is required for supplier/customer entities',
      ),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
```

`src/settings/EntitiesScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getEntities: vi.fn(),
}));
import { getEntities, type Entity } from '../api';
import { EntitiesScreen } from './EntitiesScreen';

const ROWS: Entity[] = [
  { id: 1, role: 'supplier', country: 'EE', name: 'Circle K Eesti AS', goods_vs_services: 'goods' },
  { id: 2, role: 'customer', country: 'FI', name: 'Acme Oy', goods_vs_services: null },
  { id: 3, role: 'employee', country: 'EE', name: 'Mari Maasikas', goods_vs_services: null },
] as Entity[];

function mount(initial = '/settings/entities') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: '/settings/entities', element: <EntitiesScreen /> }],
    { initialEntries: [initial] },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEntities).mockResolvedValue(ROWS);
});

describe('EntitiesScreen', () => {
  it('lists name + role chip + country, no raw ids (data rule 1)', async () => {
    mount();
    expect(await screen.findByText('Circle K Eesti AS')).toBeInTheDocument();
    expect(screen.getByText('Supplier')).toBeInTheDocument();
    expect(screen.getByText('Employee')).toBeInTheDocument();
    expect(screen.queryByText('#1')).toBeNull();
    expect(screen.queryByText(/^1$/)).toBeNull();
  });

  it('Team segment filters to ADR-0036 claimants and survives in ?seg=', async () => {
    const router = mount('/settings/entities?seg=team');
    expect(await screen.findByText('Mari Maasikas')).toBeInTheDocument();
    expect(screen.queryByText('Circle K Eesti AS')).toBeNull();
    // Round-trip: switching writes ?seg=.
    fireEvent.click(screen.getByRole('tab', { name: 'Suppliers' }));
    await waitFor(() =>
      expect(router.state.location.search).toContain('seg=suppliers'),
    );
    expect(await screen.findByText('Circle K Eesti AS')).toBeInTheDocument();
  });

  it('search narrows by name and persists in ?q=', async () => {
    const router = mount();
    await screen.findByText('Circle K Eesti AS');
    fireEvent.change(screen.getByPlaceholderText('Search entities'), {
      target: { value: 'mari' },
    });
    await waitFor(() =>
      expect(router.state.location.search).toContain('q=mari'),
    );
    expect(screen.getByText('Mari Maasikas')).toBeInTheDocument();
    expect(screen.queryByText('Acme Oy')).toBeNull();
  });

  it('honest empty state on a fresh install points at creation', async () => {
    vi.mocked(getEntities).mockResolvedValue([]);
    mount();
    expect(
      await screen.findByText('No entities yet'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Suppliers and customers are created automatically/),
    ).toBeInTheDocument();
  });

  it('read failure → LoadError with retry', async () => {
    vi.mocked(getEntities).mockRejectedValue(new Error('boom'));
    mount();
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/settings/CreateEntitySheet.test.tsx src/settings/EntitiesScreen.test.tsx
```

Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement `src/settings/CreateEntitySheet.tsx`**

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  onboardEntity,
  type EntityRole,
  type OnboardEntityInput,
} from '../api';
import { invalidateEntities, ROLE_LABEL } from '../queries/settings';
import { Button } from '../ui/Button';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

const ROLES: readonly EntityRole[] = [
  'supplier',
  'customer',
  'employee',
  'director',
];
const NEEDS_REG_KEY: readonly EntityRole[] = ['supplier', 'customer'];

/**
 * Onboarding sheet — all FOUR server roles (Reality #4; the legacy view
 * offered two, which starved the ADR-0036 claimant dropdown). Identity is
 * per-role: supplier/customer → registration key (immutable, the strong
 * match identity); employee/director → email (+ optional Telegram id).
 */
export function CreateEntitySheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<EntityRole>('supplier');
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [regKey, setRegKey] = useState('');
  const [goods, setGoods] = useState<'goods' | 'services' | 'unknown'>(
    'unknown',
  );
  const [email, setEmail] = useState('');
  const [tgUserId, setTgUserId] = useState('');

  const needsRegKey = NEEDS_REG_KEY.includes(role);
  const valid =
    name.trim() !== '' &&
    country.trim() !== '' &&
    (needsRegKey ? regKey.trim() !== '' : email.trim() !== '');

  const submit = async () => {
    setBusy(true);
    try {
      const input: OnboardEntityInput = needsRegKey
        ? {
            role,
            name: name.trim(),
            country: country.trim().toUpperCase(),
            registrationKey: regKey.trim(),
            goodsVsServices: goods,
          }
        : {
            role,
            name: name.trim(),
            country: country.trim().toUpperCase(),
            email: email.trim(),
            ...(tgUserId.trim() !== '' ? { tgUserId: tgUserId.trim() } : {}),
          };
      const created = await onboardEntity(input);
      toastOk(`${ROLE_LABEL[role]} added — ${name.trim()}`);
      onClose();
      navigate(`/settings/entities/${created.id}`);
      void invalidateEntities(qc);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && !busy && onClose()} title="Add entity">
      <div className="space-y-4 px-6 pb-2">
        <Field label="Role">
          <SelectInput
            aria-label="Role"
            value={role}
            onChange={(e) => setRole(e.target.value as EntityRole)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </SelectInput>
        </Field>
        {!needsRegKey && (
          <p className="text-[12.5px] text-ink-2">
            Appears in the claimant dropdown when uploading a receipt
            (reimbursement)
          </p>
        )}
        <Field label="Name">
          <TextInput
            aria-label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={needsRegKey ? 'e.g. Circle K Eesti AS' : 'e.g. Mari Maasikas'}
          />
        </Field>
        <Field label="Country">
          <TextInput
            aria-label="Country"
            value={country}
            onChange={(e) => setCountry(e.target.value.toUpperCase())}
            placeholder="EE"
            maxLength={2}
          />
        </Field>
        {needsRegKey ? (
          <>
            <Field
              label="Registration key"
              hint="Registry or VAT number — the strong identity that matches documents and bank lines. Cannot be changed later."
            >
              <TextInput
                aria-label="Registration key"
                value={regKey}
                onChange={(e) => setRegKey(e.target.value)}
                placeholder="e.g. EE100511246"
              />
            </Field>
            <Field label="Goods or services">
              <SelectInput
                aria-label="Goods or services"
                value={goods}
                onChange={(e) =>
                  setGoods(e.target.value as 'goods' | 'services' | 'unknown')
                }
              >
                <option value="unknown">Unknown</option>
                <option value="goods">Goods</option>
                <option value="services">Services</option>
              </SelectInput>
            </Field>
          </>
        ) : (
          <>
            <Field label="Email" hint="Identity for reimbursement and channel matching">
              <TextInput
                aria-label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="mari@example.com"
              />
            </Field>
            <Field label="Telegram user id" hint="Optional — links their Telegram messages">
              <TextInput
                aria-label="Telegram user id"
                value={tgUserId}
                onChange={(e) => setTgUserId(e.target.value)}
                placeholder="123456789"
              />
            </Field>
          </>
        )}
        <Button
          className="w-full"
          busy={busy}
          disabled={!valid || busy}
          onClick={() => void submit()}
        >
          {`Add ${ROLE_LABEL[role].toLowerCase()}`}
        </Button>
      </div>
    </Sheet>
  );
}
```

Wire nit the tests pin: the submit label is `Add supplier` / `Add employee` — the test queries `{ name: 'Add supplier' }`, and `ROLE_LABEL[role].toLowerCase()` yields `supplier`, so the accessible name is `Add supplier`. Keep the template literal exactly.

- [ ] **Step 4: Implement `src/settings/EntitiesScreen.tsx`**

```tsx
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSeg } from '../lib/useSeg';
import {
  ENTITY_SEGMENTS,
  entityMatchesQuery,
  ROLE_LABEL,
  ROLE_TONE,
  segmentEntities,
  type EntitySegment,
} from '../queries/settings';
import { useEntities } from '../queries/shared';
import { LargeTitleHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { SearchInput } from '../ui/SearchInput';
import { SegmentedControl } from '../ui/SegmentedControl';
import { CreateEntitySheet } from './CreateEntitySheet';

/** /settings/entities — asset §8 list: name + role chip + country, search,
 *  role segments incl. Team (= ADR-0036 claimants). No ids on screen. */
export function EntitiesScreen() {
  const [seg, setSeg] = useSeg<EntitySegment>(ENTITY_SEGMENTS, 'all');
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [createOpen, setCreateOpen] = useState(false);
  const entitiesQ = useEntities();

  const setQ = (next: string) => {
    const p = new URLSearchParams(params);
    if (next === '') p.delete('q');
    else p.set('q', next);
    setParams(p, { replace: true });
  };

  const rows = segmentEntities(entitiesQ.data ?? [], seg).filter((e) =>
    entityMatchesQuery(e, q),
  );

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <LargeTitleHeader
        title="Entities"
        trailing={
          <Button variant="secondary" onClick={() => setCreateOpen(true)}>
            ＋ Add
          </Button>
        }
      />
      <div className="space-y-2.5 px-4 pb-3">
        <SegmentedControl
          options={[
            { value: 'all' as const, label: 'All' },
            { value: 'suppliers' as const, label: 'Suppliers' },
            { value: 'customers' as const, label: 'Customers' },
            { value: 'team' as const, label: 'Team' },
          ]}
          value={seg}
          onChange={setSeg}
        />
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder="Search entities"
        />
      </div>
      {entitiesQ.isPending ? (
        <SkeletonRows count={4} />
      ) : entitiesQ.isError ? (
        <LoadError
          message={
            entitiesQ.error instanceof Error
              ? entitiesQ.error.message
              : 'Failed to load entities'
          }
          onRetry={() => void entitiesQ.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="👥"
          title={q !== '' || seg !== 'all' ? 'Nothing matches' : 'No entities yet'}
          hint={
            q !== '' || seg !== 'all'
              ? 'Try another segment or search term.'
              : 'Suppliers and customers are created automatically when documents and bank lines are booked; employees and directors (reimbursement claimants) are added here.'
          }
          action={
            <Button onClick={() => setCreateOpen(true)}>Add entity</Button>
          }
        />
      ) : (
        <ListGroup>
          {rows.map((e) => (
            <ListRow
              key={e.id}
              to={`/settings/entities/${e.id}`}
              title={e.name}
              subtitle={e.country}
              chip={<Chip tone={ROLE_TONE[e.role]}>{ROLE_LABEL[e.role]}</Chip>}
            />
          ))}
        </ListGroup>
      )}
      {createOpen && (
        <CreateEntitySheet open onClose={() => setCreateOpen(false)} />
      )}
    </div>
  );
}
```

(`CreateEntitySheet` renders ONLY while open — fresh state per opening, the Plan 03 remount discipline. `SearchInput`'s props are `{ value, onChange, placeholder }` per the kit — verify at the file; if its `onChange` receives an event rather than a string, adapt the `setQ` call to the FILE and disclose.)

- [ ] **Step 5: Run tests, then the full suite**

```bash
npx vitest run src/settings/CreateEntitySheet.test.tsx src/settings/EntitiesScreen.test.tsx && npm test
```

Expected: PASS (8 tests). NOTE: the sheet tests use `fireEvent` throughout (vaul Drawer rule).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/settings
git commit -m "feat(web): Entities list + create sheet — all four roles onboardable (employee/director claimants, ADR-0036)"
```

---

### Task 7: EntityScreen — the asset §8 card (identity, linked bookings, aliases, classification memory)

**Files:**
- Create: `packages/web/src/settings/EntityScreen.tsx`, `packages/web/src/settings/EntityScreen.test.tsx`, `packages/web/src/settings/AddAliasSheet.tsx`, `packages/web/src/settings/EditEntitySheet.tsx` (sheet tests live inside `EntityScreen.test.tsx` — one surface, one file)

**Interfaces:**
- Consumes: `useEntityDetail`, `entityDetailKey`, `invalidateEntities`, `identifierOf`, `aliasesOf`, `ALIAS_KIND_LABEL`, `entityStats`, `classificationMemory`, `ROLE_LABEL`, `ROLE_TONE` (Task 3); `useExpenses`/`useInvoices` (shared); `updateEntity`, `deleteEntity`, `addEntityAlias`, `type AddAliasInput` (api); `fmtCents`; kit: `ScreenHeader`, `KeyValue`, `ListGroup`/`ListRow`/`GroupLabel`, `Chip`, `Sheet`, `ConfirmDialog`, `Button`, `Field`/`TextInput`/`SelectInput`, `SkeletonRows`/`LoadError`/`EmptyState`, toasts.
- Produces `/settings/entities/:id` (mounted in Task 12):
  - **Hero**: name + `ROLE_LABEL · country · goods/services` line + role chip.
  - **Identity group**: supplier/customer → `Registration key` KV (immutable — the hint says why, Reality #5); employee/director → `Email` + `Telegram id` KVs rendered read-only (no edit endpoint exists — Reality #5, Appendix A gap 2).
  - **Linked bookings**: one `ListRow` per `entityStats` result — `Expenses · 12` with `−680.40 €` trailing, navigating to `/books?seg=expenses&q=<name>` (Books' `?q=` search is the real filter surface; suppliers) or `/books?seg=invoices&q=<name>` (customers). No fake "Documents" count — the archive rows carry no entity linkage.
  - **Aliases group** («как его пишут в документах»): chips of `aliasesOf`, unconfirmed ones marked; `+ Add alias` opens `AddAliasSheet` (kind select over the three REAL kinds, value); no delete affordance (no endpoint — gap 1).
  - **Classification memory group**: `classificationMemory` → "Usually categorised" / "`fuel` (11 of 12)" + "Used as" / "AI hint, not a rule" + a derived-from-your-books footnote; whole group hidden when null (no fake memory).
  - **Edit sheet**: name/country/goods (the exact PATCH surface); **Delete** via `ConfirmDialog` (destructive) — 409 surfaced verbatim, success navigates to the list.

- [ ] **Step 1: Write failing tests**

`src/settings/EntityScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getEntity: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  updateEntity: vi.fn(),
  deleteEntity: vi.fn(),
  addEntityAlias: vi.fn(),
}));
import {
  addEntityAlias,
  deleteEntity,
  getEntity,
  getExpenses,
  getInvoices,
  updateEntity,
  type Entity,
  type Expense,
} from '../api';
import { AppToaster } from '../ui/toast';
import { EntityScreen } from './EntityScreen';

const SUPPLIER: Entity = {
  id: 3,
  role: 'supplier',
  country: 'EE',
  name: 'Circle K Eesti AS',
  goods_vs_services: 'goods',
  identifiers: [
    { id: 1, entity_id: 3, kind: 'registration_key', value: 'EE100511246', confirmed: true },
    { id: 2, entity_id: 3, kind: 'merchant_descriptor', value: 'CIRCLE K 4411', confirmed: true },
    { id: 3, entity_id: 3, kind: 'iban', value: 'EE111222333', confirmed: false },
  ],
} as Entity;

const EXPENSES = [
  { id: 1, supplier_id: 3, category: 'fuel', gross_amount: 4820, vat_amount: 869, currency: 'EUR', tax_point_date: '2026-06-10', status: 'posted', reconciled: true, supplier_invoice_number: null },
  { id: 2, supplier_id: 3, category: 'fuel', gross_amount: 1000, vat_amount: 180, currency: 'EUR', tax_point_date: '2026-06-11', status: 'posted', reconciled: false, supplier_invoice_number: null },
  { id: 3, supplier_id: 3, category: 'office', gross_amount: 500, vat_amount: 90, currency: 'EUR', tax_point_date: '2026-06-12', status: 'draft', supplier_invoice_number: null },
] as Expense[];

function mount(id = '3') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/settings/entities/:id', element: <EntityScreen /> },
      { path: '/settings/entities', element: <div>LIST</div> },
    ],
    { initialEntries: [`/settings/entities/${id}`] },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
      <AppToaster />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEntity).mockResolvedValue(SUPPLIER);
  vi.mocked(getExpenses).mockResolvedValue(EXPENSES);
  vi.mocked(getInvoices).mockResolvedValue([]);
});

describe('EntityScreen (asset §8 card)', () => {
  it('renders identity, linked-expenses link, aliases with unconfirmed marker, memory', async () => {
    mount();
    expect(await screen.findByText('Circle K Eesti AS')).toBeInTheDocument();
    expect(screen.getByText('EE100511246')).toBeInTheDocument();
    // Linked bookings: 2 non-draft expenses, 58.20 € total, real Books link.
    const link = await screen.findByRole('link', { name: /Expenses · 2/ });
    expect(link).toHaveAttribute(
      'href',
      '/books?seg=expenses&q=Circle+K+Eesti+AS',
    );
    expect(screen.getByText('−58.20 €')).toBeInTheDocument();
    // Aliases (registration_key is identity, NOT an alias chip).
    expect(screen.getByText('CIRCLE K 4411')).toBeInTheDocument();
    expect(screen.getByText(/EE111222333/)).toBeInTheDocument();
    expect(screen.getByText(/unconfirmed/)).toBeInTheDocument();
    // Classification memory derived from posted rows: fuel 2 of 2 posted.
    expect(screen.getByText('fuel (2 of 2)')).toBeInTheDocument();
    expect(screen.getByText('AI hint, not a rule')).toBeInTheDocument();
  });

  it('adds an alias through the sheet with the exact payload', async () => {
    vi.mocked(addEntityAlias).mockResolvedValue({
      id: 9, entity_id: 3, kind: 'name_alias', value: 'CIRCLEK', confirmed: true,
    } as never);
    mount();
    await screen.findByText('Circle K Eesti AS');
    fireEvent.click(screen.getByRole('button', { name: '＋ Add alias' }));
    fireEvent.change(screen.getByLabelText('Kind'), {
      target: { value: 'name_alias' },
    });
    fireEvent.change(screen.getByLabelText('Value'), {
      target: { value: ' CIRCLEK ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add alias' }));
    await waitFor(() =>
      expect(addEntityAlias).toHaveBeenCalledWith(3, {
        kind: 'name_alias',
        value: 'CIRCLEK',
      }),
    );
  });

  it('edits name/country/goods through the PATCH sheet', async () => {
    vi.mocked(updateEntity).mockResolvedValue({ ...SUPPLIER, name: 'Circle K AS' } as never);
    mount();
    await screen.findByText('Circle K Eesti AS');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const sheet = screen.getByRole('dialog');
    fireEvent.change(within(sheet).getByLabelText('Name'), {
      target: { value: 'Circle K AS' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(updateEntity).toHaveBeenCalledWith(3, {
        name: 'Circle K AS',
        country: 'EE',
        goodsVsServices: 'goods',
      }),
    );
  });

  it('delete: confirm-gated; the 409 reaches the operator verbatim', async () => {
    vi.mocked(deleteEntity).mockRejectedValue(
      new Error(
        'Entity 3 (Circle K Eesti AS) is referenced by an expense/invoice — cannot delete.',
      ),
    );
    mount();
    await screen.findByText('Circle K Eesti AS');
    fireEvent.click(screen.getByRole('button', { name: 'Delete entity…' }));
    // Nothing deleted until the dialog confirm.
    expect(deleteEntity).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete entity' }));
    expect(
      await screen.findByText(
        'Entity 3 (Circle K Eesti AS) is referenced by an expense/invoice — cannot delete.',
      ),
    ).toBeInTheDocument();
  });

  it('successful delete navigates back to the list', async () => {
    vi.mocked(deleteEntity).mockResolvedValue(SUPPLIER as never);
    const router = mount();
    await screen.findByText('Circle K Eesti AS');
    fireEvent.click(screen.getByRole('button', { name: 'Delete entity…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete entity' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/settings/entities'),
    );
  });

  it('employee card: email identity read-only, no memory/bookings fabrication', async () => {
    vi.mocked(getEntity).mockResolvedValue({
      id: 9,
      role: 'employee',
      country: 'EE',
      name: 'Mari Maasikas',
      goods_vs_services: null,
      identifiers: [
        { id: 5, entity_id: 9, kind: 'email', value: 'mari@example.com', confirmed: true },
        { id: 6, entity_id: 9, kind: 'tg_user_id', value: '123456789', confirmed: true },
      ],
    } as Entity);
    mount('9');
    expect(await screen.findByText('Mari Maasikas')).toBeInTheDocument();
    expect(screen.getByText('mari@example.com')).toBeInTheDocument();
    expect(screen.getByText('123456789')).toBeInTheDocument();
    expect(screen.queryByText(/Usually categorised/)).toBeNull();
    expect(screen.queryByText(/Expenses ·/)).toBeNull();
  });

  it('bad :id → honest not-found, no fetch storm', async () => {
    mount('banana');
    expect(
      await screen.findByText('This entity does not exist'),
    ).toBeInTheDocument();
    expect(getEntity).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/settings/EntityScreen.test.tsx
```

Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement `src/settings/AddAliasSheet.tsx`**

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { addEntityAlias, type AddAliasInput } from '../api';
import { ALIAS_KIND_LABEL, invalidateEntities } from '../queries/settings';
import { Button } from '../ui/Button';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

const KINDS: AddAliasInput['kind'][] = [
  'merchant_descriptor',
  'iban',
  'name_alias',
];

/** Add-alias sheet — exactly the three kinds the endpoint accepts
 *  (Reality #5). Aliases teach reconciliation to recognise this
 *  counterparty on bank lines and documents (ADR-0014). */
export function AddAliasSheet({
  entityId,
  open,
  onClose,
}: {
  entityId: number;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<AddAliasInput['kind']>('merchant_descriptor');
  const [value, setValue] = useState('');

  const submit = async () => {
    setBusy(true);
    try {
      await addEntityAlias(entityId, { kind, value: value.trim() });
      toastOk('Alias added');
      onClose();
      void invalidateEntities(qc);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && !busy && onClose()} title="Add alias">
      <div className="space-y-4 px-6 pb-2">
        <p className="text-[12.5px] text-ink-2">
          How documents and bank lines name this counterparty — an IBAN or
          card descriptor lets reconciliation recognise it automatically.
        </p>
        <Field label="Kind">
          <SelectInput
            aria-label="Kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as AddAliasInput['kind'])}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {ALIAS_KIND_LABEL[k]}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label="Value">
          <TextInput
            aria-label="Value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. CIRCLE K 4411"
          />
        </Field>
        <Button
          className="w-full"
          busy={busy}
          disabled={busy || value.trim() === ''}
          onClick={() => void submit()}
        >
          Add alias
        </Button>
      </div>
    </Sheet>
  );
}
```

- [ ] **Step 4: Implement `src/settings/EditEntitySheet.tsx`**

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { updateEntity, type Entity } from '../api';
import { invalidateEntities } from '../queries/settings';
import { Button } from '../ui/Button';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

/** Edit sheet — EXACTLY the server's PATCH surface: name, country,
 *  goods/services (Reality #5; identity fields are immutable). */
export function EditEntitySheet({
  entity,
  open,
  onClose,
}: {
  entity: Entity;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(entity.name);
  const [country, setCountry] = useState(entity.country);
  const [goods, setGoods] = useState<'goods' | 'services' | 'unknown'>(
    entity.goods_vs_services === 'goods' ||
      entity.goods_vs_services === 'services'
      ? entity.goods_vs_services
      : 'unknown',
  );

  const valid = name.trim() !== '' && country.trim() !== '';

  const submit = async () => {
    setBusy(true);
    try {
      await updateEntity(entity.id, {
        name: name.trim(),
        country: country.trim().toUpperCase(),
        goodsVsServices: goods,
      });
      toastOk('Entity updated');
      onClose();
      void invalidateEntities(qc);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && !busy && onClose()} title="Edit entity">
      <div className="space-y-4 px-6 pb-2">
        <Field label="Name">
          <TextInput
            aria-label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Country">
          <TextInput
            aria-label="Country"
            value={country}
            onChange={(e) => setCountry(e.target.value.toUpperCase())}
            maxLength={2}
          />
        </Field>
        <Field label="Goods or services">
          <SelectInput
            aria-label="Goods or services"
            value={goods}
            onChange={(e) =>
              setGoods(e.target.value as 'goods' | 'services' | 'unknown')
            }
          >
            <option value="unknown">Unknown</option>
            <option value="goods">Goods</option>
            <option value="services">Services</option>
          </SelectInput>
        </Field>
        <Button
          className="w-full"
          busy={busy}
          disabled={!valid || busy}
          onClick={() => void submit()}
        >
          Save changes
        </Button>
      </div>
    </Sheet>
  );
}
```

- [ ] **Step 5: Implement `src/settings/EntityScreen.tsx`**

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { deleteEntity, fmtCents, type Entity } from '../api';
import {
  aliasesOf,
  classificationMemory,
  entityStats,
  identifierOf,
  invalidateEntities,
  ROLE_LABEL,
  ROLE_TONE,
  useEntityDetail,
} from '../queries/settings';
import { useExpenses, useInvoices } from '../queries/shared';
import { ScreenHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { GroupLabel, KeyValue, ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';
import { AddAliasSheet } from './AddAliasSheet';
import { EditEntitySheet } from './EditEntitySheet';

/** /settings/entities/:id — asset §8: identity + links + memory in one card. */
export function EntityScreen() {
  const { id: idParam } = useParams();
  const valid = idParam !== undefined && /^\d+$/.test(idParam);
  const id = valid ? Number(idParam) : 0;
  const entityQ = useEntityDetail(id, valid);

  if (!valid) {
    return (
      <Frame>
        <EmptyState icon="❓" title="This entity does not exist" />
      </Frame>
    );
  }
  if (entityQ.isPending) {
    return (
      <Frame>
        <SkeletonRows count={4} />
      </Frame>
    );
  }
  if (entityQ.isError) {
    return (
      <Frame>
        <LoadError
          message={
            entityQ.error instanceof Error ? entityQ.error.message : 'Failed'
          }
          onRetry={() => void entityQ.refetch()}
        />
      </Frame>
    );
  }
  return (
    <Frame>
      <EntityCard entity={entityQ.data} />
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Entity" backTo="/settings/entities" />
      {children}
    </div>
  );
}

function EntityCard({ entity }: { entity: Entity }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editOpen, setEditOpen] = useState(false);
  const [aliasOpen, setAliasOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const expensesQ = useExpenses();
  const invoicesQ = useInvoices();

  const regKey = identifierOf(entity, 'registration_key');
  const email = identifierOf(entity, 'email');
  const tg = identifierOf(entity, 'tg_user_id');
  const aliases = aliasesOf(entity);
  const stats = entityStats(
    expensesQ.data ?? [],
    invoicesQ.data ?? [],
    entity,
  );
  const memory =
    entity.role === 'supplier'
      ? classificationMemory(expensesQ.data ?? [], entity.id)
      : null;

  const onDelete = async () => {
    setDeleting(true);
    try {
      await deleteEntity(entity.id);
      toastOk(`Deleted — ${entity.name}`);
      navigate('/settings/entities');
      void invalidateEntities(qc);
    } catch (e) {
      // The server's 409 sentence is already human (Reality #5).
      toastErr(e instanceof Error ? e.message : String(e));
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  const bookingsQuery = `q=${encodeURIComponent(entity.name).replace(/%20/g, '+')}`;

  return (
    <>
      <div className="px-5 pb-3 pt-1 text-center">
        <p className="truncate text-[21px] font-extrabold">{entity.name}</p>
        <p className="mt-1 flex items-center justify-center gap-2 text-[13px] text-ink-2">
          <Chip tone={ROLE_TONE[entity.role]}>{ROLE_LABEL[entity.role]}</Chip>
          <span>
            {entity.country}
            {entity.goods_vs_services != null &&
            entity.goods_vs_services !== 'unknown'
              ? ` · ${entity.goods_vs_services}`
              : ''}
          </span>
        </p>
      </div>

      <ListGroup>
        {regKey !== null && <KeyValue k="Registration key" v={regKey} />}
        {email !== null && <KeyValue k="Email" v={email} />}
        {tg !== null && <KeyValue k="Telegram id" v={tg} />}
        {stats !== null && (
          <ListRow
            to={
              entity.role === 'supplier'
                ? `/books?seg=expenses&${bookingsQuery}`
                : `/books?seg=invoices&${bookingsQuery}`
            }
            title={`${stats.label} · ${stats.count}`}
            trailing={
              <span className="whitespace-nowrap font-bold tabular-nums">
                {entity.role === 'supplier'
                  ? `−${fmtCents(stats.totalCents)} €`
                  : `+${fmtCents(stats.totalCents)} €`}
              </span>
            }
          />
        )}
      </ListGroup>
      {regKey !== null && (
        <p className="mx-6 -mt-2 mb-3.5 text-[12px] text-ink-2">
          The registration key is the strong identity documents and bank lines
          match against — it cannot be changed.
        </p>
      )}
      {email !== null && (
        <p className="mx-6 -mt-2 mb-3.5 text-[12px] text-ink-2">
          Identity fields are set at creation and are read-only here.
        </p>
      )}

      {entity.role !== 'employee' && entity.role !== 'director' && (
        <>
          <GroupLabel>Aliases — how documents name it</GroupLabel>
          <div className="mx-3.5 mb-3.5 rounded-2xl bg-surface p-3.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {aliases.map((a) => (
                <Chip key={a.id} tone={a.confirmed ? 'muted' : 'warn'}>
                  {a.value}
                  {a.confirmed ? '' : ' · unconfirmed'}
                </Chip>
              ))}
              {aliases.length === 0 && (
                <span className="text-[12.5px] text-ink-2">
                  No aliases yet.
                </span>
              )}
              <button
                type="button"
                onClick={() => setAliasOpen(true)}
                className="rounded-full bg-tint px-2 py-0.5 text-[10px] font-bold text-accent"
              >
                ＋ Add alias
              </button>
            </div>
          </div>
        </>
      )}

      {memory !== null && (
        <>
          <GroupLabel>Classification memory</GroupLabel>
          <ListGroup>
            <KeyValue
              k="Usually categorised"
              v={`${memory.category} (${memory.count} of ${memory.of})`}
            />
            <KeyValue k="Used as" v="AI hint, not a rule" />
          </ListGroup>
          <p className="mx-6 -mt-2 mb-3.5 text-[12px] text-ink-2">
            Derived from this supplier's posted expenses — the same evidence
            the AI reads when suggesting a category.
          </p>
        </>
      )}

      <div className="mx-3.5 space-y-2.5">
        <Button
          variant="secondary"
          className="w-full"
          onClick={() => setEditOpen(true)}
        >
          Edit
        </Button>
        <Button
          variant="ghost"
          className="w-full text-err"
          onClick={() => setDeleteOpen(true)}
        >
          Delete entity…
        </Button>
      </div>

      {editOpen && (
        <EditEntitySheet
          key={entity.id}
          entity={entity}
          open
          onClose={() => setEditOpen(false)}
        />
      )}
      {aliasOpen && (
        <AddAliasSheet
          key={entity.id}
          entityId={entity.id}
          open
          onClose={() => setAliasOpen(false)}
        />
      )}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(o) => !deleting && setDeleteOpen(o)}
        title="Delete this entity?"
        body={`${entity.name} disappears from pickers and its aliases die with it. If any expense or invoice references it, the server refuses the deletion.`}
        confirmLabel="Delete entity"
        destructive
        busy={deleting}
        onConfirm={() => void onDelete()}
      />
    </>
  );
}
```

- [ ] **Step 6: Run tests, then the full suite**

```bash
npx vitest run src/settings/EntityScreen.test.tsx && npm test
```

Expected: PASS (7 tests). If the `Expenses · 2` link's href encodes spaces as `%20` instead of `+`, follow the TEST (the `bookingsQuery` replace handles it — keep the pin and the code in agreement; disclose if the assertion form changed).

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/settings
git commit -m "feat(web): entity card — identity + linked bookings + alias chips + derived classification memory (asset §8)"
```

---
### Task 8: `SettingField` (the admin-settings editor) + CategoriesScreen + EnrollScreen

**Files:**
- Create: `packages/web/src/settings/SettingField.tsx`, `packages/web/src/settings/SettingField.test.tsx`, `packages/web/src/settings/CategoriesScreen.tsx`, `packages/web/src/settings/CategoriesScreen.test.tsx`, `packages/web/src/settings/EnrollScreen.tsx`, `packages/web/src/settings/EnrollScreen.test.tsx`

**Interfaces:**
- `SettingField({ def, current })` — one validated-registry key editor: `def: { key, label, placeholder?, multiline?, secret?, hint? }`; text/textarea + **Save** (disabled on empty draft — the server's `nonEmpty` validator would 400) + **Clear** (DELETE, disabled when unset); ports the legacy `SettingsView` unsaved-edit sync guard verbatim (a background refetch must not clobber a mid-edit draft); mutations → `setSetting`/`deleteSetting` → `invalidateAdminSettings` → receipt toast; failures verbatim (`Unknown setting key: …` / `Invalid value for setting …`, Reality #2). Consumed by Enroll (here), Mailbox (Task 9), LLM/Telegram (Task 10).
- CategoriesScreen — `useCategories` (shared); renders `label` (title) + the `key` as subtitle (it IS operator vocabulary — the `category` value on every expense); **`accountCode` never reaches the DOM** (Reality #7; pinned by test + Task 14 grep).
- EnrollScreen — `createDeviceEnrollment` + `qrcode`'s `toDataURL` with the EXACT legacy payload `{ v:1, api, enroll }` (Reality #8 — the mobile app parses it); expiry line; **Regenerate**; the unset-URL 500 renders a guidance card WITH the `public_api_url` `SettingField` inline (fix-in-place) and a retry; the setting field is also visible under the QR when everything works (it lives here — it IS the QR's base URL). Double-mount note: StrictMode fires the effect twice in dev, minting two one-time tokens — legacy-parity, harmless (only the rendered one is scanned), documented in a comment.

- [ ] **Step 1: Write failing tests**

`src/settings/SettingField.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  setSetting: vi.fn(),
  deleteSetting: vi.fn(),
}));
import { deleteSetting, setSetting } from '../api';
import { AppToaster } from '../ui/toast';
import { SettingField } from './SettingField';

const DEF = {
  key: 'ai_model',
  label: 'Global model',
  placeholder: 'openai/gpt-4o-mini',
};

function mount(current = '') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SettingField def={DEF} current={current} />
      <AppToaster />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('SettingField', () => {
  it('saves the trimmed draft to the exact key', async () => {
    vi.mocked(setSetting).mockResolvedValue({ key: 'ai_model', value: 'openai/gpt-5' });
    mount('');
    fireEvent.change(screen.getByLabelText('Global model'), {
      target: { value: '  openai/gpt-5  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Global model' }));
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith('ai_model', 'openai/gpt-5'),
    );
    expect(await screen.findByText('Global model saved')).toBeInTheDocument();
  });

  it('Save disabled on an empty draft (server nonEmpty validator); Clear disabled when unset', () => {
    mount('');
    expect(
      screen.getByRole('button', { name: 'Save Global model' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Clear Global model' }),
    ).toBeDisabled();
  });

  it('Clear DELETEs the key when a value exists', async () => {
    vi.mocked(deleteSetting).mockResolvedValue({ key: 'ai_model', deleted: true });
    mount('openai/gpt-4o-mini');
    fireEvent.click(screen.getByRole('button', { name: 'Clear Global model' }));
    await waitFor(() =>
      expect(deleteSetting).toHaveBeenCalledWith('ai_model'),
    );
  });

  it('surfaces the registry 400 verbatim', async () => {
    vi.mocked(setSetting).mockRejectedValue(
      new Error('Invalid value for setting public_api_url'),
    );
    mount('');
    fireEvent.change(screen.getByLabelText('Global model'), {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Global model' }));
    expect(
      await screen.findByText('Invalid value for setting public_api_url'),
    ).toBeInTheDocument();
  });

  it('adopts a background value change ONLY when the draft is untouched (legacy sync guard)', async () => {
    const { rerender } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SettingField def={DEF} current="one" />
      </QueryClientProvider>,
    );
    // Untouched → a refetched value flows in.
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SettingField def={DEF} current="two" />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Global model')).toHaveValue('two'),
    );
    // Mid-edit → the operator's draft survives the next background change.
    fireEvent.change(screen.getByLabelText('Global model'), {
      target: { value: 'operator-draft' },
    });
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SettingField def={DEF} current="three" />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText('Global model')).toHaveValue('operator-draft');
  });
});
```

`src/settings/CategoriesScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getCategories: vi.fn(),
  getOrganization: vi.fn(),
}));
import { getCategories, getOrganization } from '../api';
import { CategoriesScreen } from './CategoriesScreen';

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/categories']}>
        <CategoriesScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCategories).mockResolvedValue([
    { key: 'software', label: 'Software', accountCode: 'EXPENSE_SOFTWARE' },
    { key: 'fuel', label: 'Fuel', accountCode: 'EXPENSE_FUEL' },
  ]);
  vi.mocked(getOrganization).mockResolvedValue({ country: 'EE' } as never);
});

describe('CategoriesScreen', () => {
  it('lists label + key and explains plugin ownership', async () => {
    mount();
    expect(await screen.findByText('Software')).toBeInTheDocument();
    expect(screen.getByText('Fuel')).toBeInTheDocument();
    expect(screen.getByText(/software/)).toBeInTheDocument();
    expect(
      screen.getByText(/Defined by the EE country plugin/),
    ).toBeInTheDocument();
  });

  it('NEVER renders the ledger accountCode (ADR-0030 — the legacy leak dies)', async () => {
    mount();
    await screen.findByText('Software');
    expect(screen.queryByText(/EXPENSE_SOFTWARE/)).toBeNull();
    expect(screen.queryByText(/EXPENSE_FUEL/)).toBeNull();
    expect(screen.queryByText(/[Aa]ccount/)).toBeNull();
  });
});
```

`src/settings/EnrollScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,QR') },
}));
vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  createDeviceEnrollment: vi.fn(),
  getSettings: vi.fn(),
}));
import QRCode from 'qrcode';
import { createDeviceEnrollment, getSettings } from '../api';
import { EnrollScreen } from './EnrollScreen';

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/enroll']}>
        <EnrollScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSettings).mockResolvedValue([]);
});

describe('EnrollScreen', () => {
  it('renders the QR from the EXACT legacy payload shape', async () => {
    vi.mocked(createDeviceEnrollment).mockResolvedValue({
      apiBaseUrl: 'https://api.example.com',
      enrollmentToken: 'tok-123',
      expiresAt: '2026-07-11T10:00:00.000Z',
    });
    mount();
    expect(await screen.findByAltText('Enrollment QR code')).toHaveAttribute(
      'src',
      'data:image/png;base64,QR',
    );
    expect(vi.mocked(QRCode.toDataURL)).toHaveBeenCalledWith(
      JSON.stringify({
        v: 1,
        api: 'https://api.example.com',
        enroll: 'tok-123',
      }),
    );
    expect(screen.getByText(/Expires/)).toBeInTheDocument();
  });

  it('unset public_api_url 500 → honest guidance with the fix field inline', async () => {
    vi.mocked(createDeviceEnrollment).mockRejectedValue(
      new Error(
        'Public API URL is not configured — set "public_api_url" in Settings (or the PUBLIC_API_URL env var)',
      ),
    );
    mount();
    expect(
      await screen.findByText(/The QR cannot be generated yet/),
    ).toBeInTheDocument();
    // The fix is right here — the public_api_url editor, not a dead end.
    expect(screen.getByLabelText('Public API URL')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument();
  });

  it('Regenerate mints a fresh enrollment', async () => {
    vi.mocked(createDeviceEnrollment).mockResolvedValue({
      apiBaseUrl: 'https://api.example.com',
      enrollmentToken: 'tok-123',
      expiresAt: '2026-07-11T10:00:00.000Z',
    });
    mount();
    await screen.findByAltText('Enrollment QR code');
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() =>
      expect(createDeviceEnrollment).toHaveBeenCalledTimes(2),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/settings/SettingField.test.tsx src/settings/CategoriesScreen.test.tsx src/settings/EnrollScreen.test.tsx
```

Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement `src/settings/SettingField.tsx`**

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { deleteSetting, setSetting } from '../api';
import { invalidateAdminSettings } from '../queries/settings';
import { Button } from '../ui/Button';
import { Field, INPUT_CLS, TextInput } from '../ui/Form';
import { toastErr, toastOk } from '../ui/toast';

export interface SettingDef {
  key: string;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  secret?: boolean;
  hint?: string;
}

/**
 * One validated-registry admin setting (Reality #2). Save is disabled on an
 * empty draft (the server's nonEmpty validator would 400); Clear DELETEs the
 * key (server falls back to its built-in default). The sync guard is the
 * legacy SettingsView's: a background refetch adopts the new server value
 * ONLY while the operator has no unsaved edit.
 */
export function SettingField({
  def,
  current,
}: {
  def: SettingDef;
  current: string;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(current);
  const [busy, setBusy] = useState(false);

  const syncedCurrent = useRef(current);
  useEffect(() => {
    if (current === syncedCurrent.current) return;
    if (draft === syncedCurrent.current) setDraft(current);
    syncedCurrent.current = current;
  }, [current, draft]);

  const run = async (fn: () => Promise<unknown>, receipt: string) => {
    setBusy(true);
    try {
      await fn();
      await invalidateAdminSettings(qc);
      toastOk(receipt);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Field label={def.label} hint={def.hint}>
      <div className="flex items-start gap-2">
        {def.multiline === true ? (
          <textarea
            aria-label={def.label}
            rows={3}
            placeholder={def.placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className={`${INPUT_CLS} min-w-0 flex-1 font-mono text-[13px]`}
          />
        ) : (
          <TextInput
            aria-label={def.label}
            type={def.secret === true ? 'password' : 'text'}
            placeholder={def.placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className={`${INPUT_CLS} min-w-0 flex-1 font-mono text-[13px]`}
          />
        )}
        <div className="flex flex-none flex-col gap-1.5">
          <Button
            busy={busy}
            disabled={busy || draft.trim().length === 0}
            onClick={() =>
              void run(
                () => setSetting(def.key, draft.trim()),
                `${def.label} saved`,
              )
            }
            aria-label={`Save ${def.label}`}
          >
            Save
          </Button>
          <Button
            variant="ghost"
            disabled={busy || current.length === 0}
            onClick={() =>
              void run(() => deleteSetting(def.key), `${def.label} cleared`)
            }
            aria-label={`Clear ${def.label}`}
          >
            Clear
          </Button>
        </div>
      </div>
    </Field>
  );
}
```

- [ ] **Step 4: Implement `src/settings/CategoriesScreen.tsx`**

```tsx
import { useCategories } from '../queries/shared';
import { useOrganization } from '../queries/settings';
import { ScreenHeader } from '../shell/Headers';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';

/**
 * /settings/categories — READ-ONLY reference (spec: plugin-owned). Rows are
 * label + key; the key is legitimate operator vocabulary (it is the
 * `category` value on every expense). CategoryDef.accountCode NEVER renders
 * (Reality #7 — ADR-0001/0030; the legacy "Account" column dies with
 * CategoriesView).
 */
export function CategoriesScreen() {
  const categoriesQ = useCategories();
  const orgQ = useOrganization();
  const country = orgQ.data?.country ?? 'country';
  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Categories" backTo="/settings" />
      <p className="mx-6 mb-3 text-[12.5px] text-ink-2">
        Defined by the {country} country plugin — read-only. The AI and the
        classify forms pick from this list; each expense carries one of these
        keys as its category.
      </p>
      {categoriesQ.isPending ? (
        <SkeletonRows count={5} />
      ) : categoriesQ.isError ? (
        <LoadError
          message={
            categoriesQ.error instanceof Error
              ? categoriesQ.error.message
              : 'Failed to load categories'
          }
          onRetry={() => void categoriesQ.refetch()}
        />
      ) : categoriesQ.data.length === 0 ? (
        <EmptyState
          icon="🏷"
          title="No categories"
          hint="The active country plugin defines none — check the organization country."
        />
      ) : (
        <ListGroup>
          {categoriesQ.data.map((c) => (
            <ListRow key={c.key} title={c.label} subtitle={c.key} />
          ))}
        </ListGroup>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Implement `src/settings/EnrollScreen.tsx`**

```tsx
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { createDeviceEnrollment, type DeviceEnrollment } from '../api';
import { useAdminSettings } from '../queries/settings';
import { ScreenHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { SkeletonRows } from '../ui/Feedback';
import { GroupLabel } from '../ui/List';
import { SettingField } from './SettingField';

/**
 * /settings/enroll — mobile enrollment QR. The payload shape {v,api,enroll}
 * is the mobile-app contract (legacy EnrollView verbatim). The dominant
 * failure — unset public_api_url → server 500 (Reality #8) — renders
 * guidance WITH the fix inline: the public_api_url setting lives on this
 * screen (it IS the QR's base URL).
 * StrictMode note: dev double-mount mints two one-time tokens (legacy
 * parity) — only the rendered one is ever scanned; harmless.
 */
export function EnrollScreen() {
  const [qr, setQr] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<DeviceEnrollment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const settingsQ = useAdminSettings();

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setPending(true);
      setError(null);
      setQr(null);
      try {
        const e = await createDeviceEnrollment();
        if (cancelled) return;
        setEnrollment(e);
        const payload = JSON.stringify({
          v: 1,
          api: e.apiBaseUrl,
          enroll: e.enrollmentToken,
        });
        const dataUrl = await QRCode.toDataURL(payload);
        if (!cancelled) setQr(dataUrl);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setPending(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const unconfigured =
    error !== null && error.includes('Public API URL');

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Mobile device" backTo="/settings" />
      {pending && <SkeletonRows count={2} />}
      {!pending && error !== null && (
        <div className="mx-3.5 mb-3.5 rounded-2xl bg-warn-bg p-4">
          <p className="text-[13.5px] font-bold text-warn">
            {unconfigured
              ? 'The QR cannot be generated yet'
              : 'Enrollment failed'}
          </p>
          <p className="mt-1 text-[12.5px] leading-snug text-warn">
            {unconfigured
              ? 'The phone needs a public base URL to talk to. Set it below (https://…, or http://localhost for dev) and try again.'
              : error}
          </p>
          <Button
            variant="secondary"
            className="mt-3"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Try again
          </Button>
        </div>
      )}
      {!pending && qr !== null && (
        <div className="mx-3.5 mb-3.5 flex flex-col items-center gap-2 rounded-2xl bg-surface p-5">
          <img src={qr} alt="Enrollment QR code" width={256} height={256} />
          {enrollment !== null && (
            <p className="text-[12.5px] text-ink-2">
              Expires {new Date(enrollment.expiresAt).toLocaleTimeString()} —
              one-time use
            </p>
          )}
          <Button
            variant="secondary"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Regenerate
          </Button>
        </div>
      )}
      <GroupLabel>Public API URL</GroupLabel>
      <div className="mx-3.5 mb-3.5 rounded-2xl bg-surface p-4">
        <SettingField
          def={{
            key: 'public_api_url',
            label: 'Public API URL',
            placeholder: 'https://api.example.com',
            hint: 'Embedded in the QR — the address the phone will call. https:// required (http://localhost allowed for dev).',
          }}
          current={settingsQ.data?.['public_api_url'] ?? ''}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Run tests, then the full suite**

```bash
npx vitest run src/settings/SettingField.test.tsx src/settings/CategoriesScreen.test.tsx src/settings/EnrollScreen.test.tsx && npm test
```

Expected: PASS (10 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/settings
git commit -m "feat(web): SettingField editor + Categories (accountCode leak dies) + Enroll with inline public_api_url fix"
```

---

### Task 9: MailboxScreen — connectors with visible truth, IMAP sheet, BYO OAuth, the rescued OAuth-return banner

**Files:**
- Create: `packages/web/src/settings/MailboxScreen.tsx`, `packages/web/src/settings/MailboxScreen.test.tsx`, `packages/web/src/settings/AddImapSheet.tsx` (tests in `MailboxScreen.test.tsx`)

**Interfaces:**
- Consumes: `useMailboxConnectors`, `useAdminSettings`, `invalidateMailbox` (Task 3); `createMailboxConnector`, `deleteMailboxConnector`, `startMailboxOAuth`, `syncMailboxConnector`, types (api); `SettingField` (Task 8); kit + toasts.
- Behavior (Reality #3/#9):
  - Connector rows: username (title), `channel · provider · auth_mode` (subtitle), status `Chip` (`connected` ok / `auth_failed`,`error` err / `disconnected` warn) + "last synced" line + **`last_error` visible** (asset §9+ mandate); per-row **Sync** (busy per connector id) and **Remove** (ConfirmDialog — deleting a connector stops harvesting; irreversible).
  - **Connect Gmail / Connect Outlook** → `startMailboxOAuth({provider, channel})` → `window.location.assign(url)`; errors verbatim (usually missing BYO credentials).
  - **BYO OAuth credentials** group: 4 `SettingField`s (`google_oauth_client_id/secret`, `microsoft_oauth_client_id/secret`) + the redirect-URI hint.
  - **Add IMAP mailbox** sheet: channel/provider/host/port/username/app-password/folder — submit disabled until host+username+secret present; the `MAILBOX_SECRET_KEY` 500 surfaces verbatim.
  - **OAuth return params**: reads `?mailbox=connected` → success toast; `?mailbox_error=…` → error toast; strips both via `setParams(…, { replace: true })` (Task 12 routes `/?mailbox…` here).
  - **NO initial-fetch-count editor** — Reality #3: the key is not in the registry; the legacy editor always 400'd. A one-line note renders instead ("Initial fetch depth is server-configured") so the capability loss is explained, not hidden.
  - Channel semantics copy preserved from legacy (`email_sync` = your own inbox, read-only firehose; `email_push` = dedicated accounting mailbox).

- [ ] **Step 1: Write failing tests**

`src/settings/MailboxScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getMailboxConnectors: vi.fn(),
  getSettings: vi.fn(),
  createMailboxConnector: vi.fn(),
  deleteMailboxConnector: vi.fn(),
  startMailboxOAuth: vi.fn(),
  syncMailboxConnector: vi.fn(),
}));
import {
  createMailboxConnector,
  deleteMailboxConnector,
  getMailboxConnectors,
  getSettings,
  startMailboxOAuth,
  syncMailboxConnector,
  type MailboxConnector,
} from '../api';
import { AppToaster } from '../ui/toast';
import { MailboxScreen } from './MailboxScreen';

const CONNECTOR: MailboxConnector = {
  id: 4,
  channel: 'email_sync',
  auth_mode: 'password',
  provider: 'imap',
  host: 'imap.example.com',
  port: 993,
  username: 'me@example.com',
  folder: 'INBOX',
  status: 'auth_failed',
  last_synced_at: 1751600000,
  last_error: 'Invalid credentials (Failure)',
} as MailboxConnector;

function mount(initial = '/settings/mailbox') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: '/settings/mailbox', element: <MailboxScreen /> }],
    { initialEntries: [initial] },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
      <AppToaster />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMailboxConnectors).mockResolvedValue([CONNECTOR]);
  vi.mocked(getSettings).mockResolvedValue([]);
});

describe('MailboxScreen', () => {
  it('shows the connector with status chip AND the last error visible (asset §9+)', async () => {
    mount();
    expect(await screen.findByText('me@example.com')).toBeInTheDocument();
    expect(screen.getByText('auth failed')).toBeInTheDocument();
    expect(
      screen.getByText(/Invalid credentials \(Failure\)/),
    ).toBeInTheDocument();
    // No fake fetch-count editor (Reality #3) — the note explains instead.
    expect(screen.queryByLabelText('Initial fetch count')).toBeNull();
    expect(
      screen.getByText(/Initial fetch depth is server-configured/),
    ).toBeInTheDocument();
  });

  it('per-row Sync calls the endpoint and refreshes', async () => {
    vi.mocked(syncMailboxConnector).mockResolvedValue({
      ...CONNECTOR,
      status: 'connected',
      last_error: null,
    });
    mount();
    await screen.findByText('me@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Sync me@example.com' }));
    await waitFor(() => expect(syncMailboxConnector).toHaveBeenCalledWith(4));
  });

  it('Remove is confirm-gated and deletes', async () => {
    vi.mocked(deleteMailboxConnector).mockResolvedValue(undefined);
    mount();
    await screen.findByText('me@example.com');
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove me@example.com' }),
    );
    expect(deleteMailboxConnector).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove mailbox' }));
    await waitFor(() => expect(deleteMailboxConnector).toHaveBeenCalledWith(4));
  });

  it('adds an IMAP connector through the sheet with the exact payload', async () => {
    vi.mocked(createMailboxConnector).mockResolvedValue(CONNECTOR);
    mount();
    await screen.findByText('me@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Add IMAP mailbox…' }));
    fireEvent.change(screen.getByLabelText('IMAP host'), {
      target: { value: 'imap.example.com' },
    });
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'me@example.com' },
    });
    fireEvent.change(screen.getByLabelText('App password'), {
      target: { value: 's3cret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add mailbox' }));
    await waitFor(() =>
      expect(createMailboxConnector).toHaveBeenCalledWith({
        channel: 'email_sync',
        provider: 'imap',
        host: 'imap.example.com',
        port: 993,
        username: 'me@example.com',
        secret: 's3cret',
        folder: 'INBOX',
      }),
    );
  });

  it('OAuth return params surface as a toast and are stripped from the URL', async () => {
    const router = mount('/settings/mailbox?mailbox=connected');
    expect(await screen.findByText('Mailbox connected')).toBeInTheDocument();
    await waitFor(() =>
      expect(router.state.location.search).not.toContain('mailbox'),
    );
  });

  it('OAuth error param surfaces verbatim', async () => {
    mount('/settings/mailbox?mailbox_error=consent_denied');
    expect(await screen.findByText('consent_denied')).toBeInTheDocument();
  });

  it('Connect Gmail starts the OAuth round-trip', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign,
    } as never);
    vi.mocked(startMailboxOAuth).mockResolvedValue({
      url: 'https://accounts.google.com/o/oauth2/x',
    });
    mount();
    await screen.findByText('me@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Connect Gmail' }));
    await waitFor(() =>
      expect(startMailboxOAuth).toHaveBeenCalledWith({
        provider: 'gmail',
        channel: 'email_sync',
      }),
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/x'),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/settings/MailboxScreen.test.tsx
```

Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement `src/settings/AddImapSheet.tsx`**

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  createMailboxConnector,
  type MailboxChannel,
  type MailboxProvider,
} from '../api';
import { invalidateMailbox } from '../queries/settings';
import { Button } from '../ui/Button';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

/** App-password IMAP connector (Reality #9). Credentials are encrypted at
 *  rest server-side; access is read-only. */
export function AddImapSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [channel, setChannel] = useState<MailboxChannel>('email_sync');
  const [provider, setProvider] = useState<MailboxProvider>('imap');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('993');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [folder, setFolder] = useState('INBOX');

  const valid =
    host.trim() !== '' && username.trim() !== '' && secret.length > 0;

  const submit = async () => {
    setBusy(true);
    try {
      await createMailboxConnector({
        channel,
        provider,
        host: host.trim(),
        port: Number(port),
        username: username.trim(),
        secret,
        folder: folder.trim() || undefined,
      });
      toastOk(`Mailbox added — ${username.trim()}`);
      onClose();
      void invalidateMailbox(qc);
    } catch (e) {
      // Includes the server's MAILBOX_SECRET_KEY guidance verbatim.
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && !busy && onClose()} title="Add IMAP mailbox">
      <div className="space-y-4 px-6 pb-2">
        <Field
          label="Mode"
          hint="email_sync polls your own inbox (read-only firehose); email_push is a single dedicated accounting mailbox"
        >
          <SelectInput
            aria-label="Mode"
            value={channel}
            onChange={(e) => setChannel(e.target.value as MailboxChannel)}
          >
            <option value="email_sync">Your inbox (email_sync)</option>
            <option value="email_push">Dedicated mailbox (email_push)</option>
          </SelectInput>
        </Field>
        <Field label="Provider">
          <SelectInput
            aria-label="Provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as MailboxProvider)}
          >
            <option value="imap">IMAP</option>
            <option value="gmail">Gmail</option>
            <option value="outlook">Outlook</option>
          </SelectInput>
        </Field>
        <Field label="IMAP host">
          <TextInput
            aria-label="IMAP host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="imap.example.com"
          />
        </Field>
        <Field label="Port">
          <TextInput
            aria-label="Port"
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </Field>
        <Field label="Username">
          <TextInput
            aria-label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="me@example.com"
          />
        </Field>
        <Field label="App password">
          <TextInput
            aria-label="App password"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </Field>
        <Field label="Folder">
          <TextInput
            aria-label="Folder"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
          />
        </Field>
        <Button
          className="w-full"
          busy={busy}
          disabled={!valid || busy}
          onClick={() => void submit()}
        >
          Add mailbox
        </Button>
      </div>
    </Sheet>
  );
}
```

- [ ] **Step 4: Implement `src/settings/MailboxScreen.tsx`**

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  deleteMailboxConnector,
  startMailboxOAuth,
  syncMailboxConnector,
  type MailboxConnector,
} from '../api';
import {
  invalidateMailbox,
  useAdminSettings,
  useMailboxConnectors,
} from '../queries/settings';
import { ScreenHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { GroupLabel, ListGroup } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';
import { AddImapSheet } from './AddImapSheet';
import { SettingField } from './SettingField';

const STATUS_TONE: Record<MailboxConnector['status'], 'ok' | 'warn' | 'err'> = {
  connected: 'ok',
  disconnected: 'warn',
  auth_failed: 'err',
  error: 'err',
};

const OAUTH_DEFS = [
  { key: 'google_oauth_client_id', label: 'Google client id' },
  { key: 'google_oauth_client_secret', label: 'Google client secret', secret: true },
  { key: 'microsoft_oauth_client_id', label: 'Microsoft client id' },
  { key: 'microsoft_oauth_client_secret', label: 'Microsoft client secret', secret: true },
];

const lastSynced = (ts: number | null): string =>
  ts === null ? 'never synced' : `last synced ${new Date(ts * 1000).toLocaleString()}`;

/** /settings/mailbox — connectors with the truth visible (status + last
 *  error, asset §9+), sync/remove, IMAP sheet, BYO OAuth keys, and the
 *  rescued OAuth-return banner (Reality #9). */
export function MailboxScreen() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const connectorsQ = useMailboxConnectors();
  const settingsQ = useAdminSettings();
  const [imapOpen, setImapOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<MailboxConnector | null>(null);
  const [removing, setRemoving] = useState(false);
  const [syncing, setSyncing] = useState<number | null>(null);

  // OAuth round-trip result (server callback → /?mailbox=… → Task 12 redirect
  // → here). Surface once, then strip so refresh doesn't replay the banner.
  useEffect(() => {
    const connected = params.get('mailbox') === 'connected';
    const err = params.get('mailbox_error');
    if (!connected && err === null) return;
    if (connected) toastOk('Mailbox connected');
    if (err !== null) toastErr(err);
    const p = new URLSearchParams(params);
    p.delete('mailbox');
    p.delete('mailbox_error');
    setParams(p, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sync = async (id: number) => {
    setSyncing(id);
    try {
      await syncMailboxConnector(id);
      toastOk('Sync finished');
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(null);
      void invalidateMailbox(qc);
    }
  };

  const remove = async () => {
    if (removeTarget === null) return;
    setRemoving(true);
    try {
      await deleteMailboxConnector(removeTarget.id);
      toastOk(`Removed — ${removeTarget.username}`);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(false);
      setRemoveTarget(null);
      void invalidateMailbox(qc);
    }
  };

  const connect = async (provider: 'gmail' | 'outlook') => {
    try {
      const { url } = await startMailboxOAuth({
        provider,
        channel: 'email_sync',
      });
      window.location.assign(url);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Mail intake" backTo="/settings" />
      <p className="mx-6 mb-3 text-[12.5px] text-ink-2">
        Connected mailboxes are harvested for invoice attachments straight
        into the Inbox queue. Credentials are encrypted at rest; access is
        read-only.
      </p>

      {connectorsQ.isPending ? (
        <SkeletonRows count={2} />
      ) : connectorsQ.isError ? (
        <LoadError
          message={
            connectorsQ.error instanceof Error
              ? connectorsQ.error.message
              : 'Failed to load connectors'
          }
          onRetry={() => void connectorsQ.refetch()}
        />
      ) : connectorsQ.data.length === 0 ? (
        <EmptyState
          icon="📮"
          title="No mailboxes connected"
          hint="Connect Gmail/Outlook below, or add any IMAP mailbox with an app password."
        />
      ) : (
        <ListGroup>
          {connectorsQ.data.map((c) => (
            <div
              key={c.id}
              className="flex items-start justify-between gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold">
                  {c.username}
                </p>
                <p className="text-[12px] text-ink-2">
                  {c.channel} · {c.provider} · {c.auth_mode} ·{' '}
                  {lastSynced(c.last_synced_at)}
                </p>
                {c.last_error !== null && (
                  <p className="mt-0.5 text-[12px] text-err">
                    {c.last_error}
                  </p>
                )}
              </div>
              <div className="flex flex-none flex-col items-end gap-1.5">
                <Chip tone={STATUS_TONE[c.status]}>
                  {c.status.replace('_', ' ')}
                </Chip>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    busy={syncing === c.id}
                    disabled={syncing !== null}
                    onClick={() => void sync(c.id)}
                    aria-label={`Sync ${c.username}`}
                  >
                    Sync
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-err"
                    onClick={() => setRemoveTarget(c)}
                    aria-label={`Remove ${c.username}`}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </ListGroup>
      )}
      <p className="mx-6 -mt-2 mb-3.5 text-[12px] text-ink-2">
        Initial fetch depth is server-configured (mailbox_initial_fetch_count
        is not operator-settable over the API).
      </p>

      <div className="mx-3.5 mb-3.5 flex flex-wrap gap-2">
        <Button onClick={() => void connect('gmail')}>Connect Gmail</Button>
        <Button onClick={() => void connect('outlook')}>
          Connect Outlook
        </Button>
        <Button variant="secondary" onClick={() => setImapOpen(true)}>
          Add IMAP mailbox…
        </Button>
      </div>

      <GroupLabel>Your OAuth app (required for Gmail/Outlook)</GroupLabel>
      <div className="mx-3.5 mb-3.5 space-y-4 rounded-2xl bg-surface p-4">
        <p className="text-[12px] text-ink-2">
          Connecting Gmail/Outlook uses your own OAuth app. Set its redirect
          URI to{' '}
          <code className="font-mono">
            {'{public_api_url}'}/api/mailbox/oauth/callback
          </code>{' '}
          in the provider console, then paste the client id/secret here.
        </p>
        {OAUTH_DEFS.map((def) => (
          <SettingField
            key={def.key}
            def={def}
            current={settingsQ.data?.[def.key] ?? ''}
          />
        ))}
      </div>

      {imapOpen && <AddImapSheet open onClose={() => setImapOpen(false)} />}
      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(o) => !removing && !o && setRemoveTarget(null)}
        title="Remove this mailbox?"
        body={
          removeTarget !== null
            ? `${removeTarget.username} stops being harvested. Documents already in the queue stay.`
            : ''
        }
        confirmLabel="Remove mailbox"
        destructive
        busy={removing}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
```

- [ ] **Step 5: Run tests, then the full suite**

```bash
npx vitest run src/settings/MailboxScreen.test.tsx && npm test
```

Expected: PASS (7 tests). The `window.location.assign` spy pattern follows the repo's jsdom conventions; if jsdom rejects the location getter spy, use `vi.stubGlobal`-based replacement and disclose.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/settings
git commit -m "feat(web): Mailbox screen — visible connector truth, IMAP sheet, BYO OAuth keys, rescued OAuth-return banner; fetch-count fake surface removed"
```

---
### Task 10: LlmScreen + TelegramScreen — validated-registry key stacks

**Files:**
- Create: `packages/web/src/settings/LlmScreen.tsx`, `packages/web/src/settings/TelegramScreen.tsx`, `packages/web/src/settings/LlmScreen.test.tsx`, `packages/web/src/settings/TelegramScreen.test.tsx`

**Interfaces:**
- Consumes: `useAdminSettings` (Task 3), `SettingField` (Task 8), `ScreenHeader`, `GroupLabel`, `SkeletonRows`/`LoadError`.
- LlmScreen (`/settings/llm`, hub row "AI models") — Reality #12: the 8 AI keys grouped (Endpoint: `ai_base_url`, `ai_api_key`; Models: `ai_model`, `ai_model.triage`, `ai_model.intent_classifier`, `ai_model.ocr`; Prompts: `prompt.triage`, `prompt.intent_classifier` — multiline). The provider-prefix guidance is kept (it mirrors the registry's own description). The legacy "OCR uses a faux model" footnote is DROPPED — stale: `ai_model.ocr` is a real registry key ("OCR vision model").
- TelegramScreen (`/settings/telegram`, hub row "Telegram & approvers") — Reality #10: `telegram_bot_token` (secret), `telegram_webhook_secret` (secret), `telegram_allowlist` (multiline) + the restart caveat (true: webhook registration reads the token at boot) + the two keys the legacy UI never surfaced (Reality #2): `approvers` (comma-separated approver identities) and `email_whitelist` (multiline).

- [ ] **Step 1: Write failing tests**

`src/settings/LlmScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getSettings: vi.fn(),
  setSetting: vi.fn(),
}));
import { getSettings, setSetting } from '../api';
import { AppToaster } from '../ui/toast';
import { LlmScreen } from './LlmScreen';

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/llm']}>
        <LlmScreen />
      </MemoryRouter>
      <AppToaster />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSettings).mockResolvedValue([
    { key: 'ai_model', value: 'openai/gpt-4o-mini' },
  ]);
});

describe('LlmScreen', () => {
  it('renders all eight AI keys, prefilled from the registry read', async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Global model')).toHaveValue(
        'openai/gpt-4o-mini',
      ),
    );
    for (const label of [
      'Inference base URL',
      'API key',
      'Global model',
      'Model — triage',
      'Model — intent classifier',
      'Model — OCR',
      'Prompt — triage',
      'Prompt — intent classifier',
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    // Secrets are masked.
    expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
  });

  it('saves a per-agent override to its dotted key', async () => {
    vi.mocked(setSetting).mockResolvedValue({
      key: 'ai_model.triage',
      value: 'openai/gpt-5-mini',
    });
    mount();
    await screen.findByLabelText('Model — triage');
    fireEvent.change(screen.getByLabelText('Model — triage'), {
      target: { value: 'openai/gpt-5-mini' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save Model — triage' }),
    );
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith(
        'ai_model.triage',
        'openai/gpt-5-mini',
      ),
    );
  });
});
```

`src/settings/TelegramScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getSettings: vi.fn(),
}));
import { getSettings } from '../api';
import { TelegramScreen } from './TelegramScreen';

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/telegram']}>
        <TelegramScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSettings).mockResolvedValue([
    { key: 'approvers', value: 'tg:123' },
  ]);
});

describe('TelegramScreen', () => {
  it('renders the three Telegram keys plus approvers and email whitelist', async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Approvers')).toHaveValue('tg:123'),
    );
    for (const label of [
      'Bot token',
      'Webhook secret',
      'Allowlist chat ids',
      'Approvers',
      'Email whitelist',
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByLabelText('Bot token')).toHaveAttribute(
      'type',
      'password',
    );
    // The honest operational caveat survives.
    expect(screen.getByText(/Restart the app after changing/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/settings/LlmScreen.test.tsx src/settings/TelegramScreen.test.tsx
```

Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement `src/settings/LlmScreen.tsx`**

```tsx
import { useAdminSettings } from '../queries/settings';
import { ScreenHeader } from '../shell/Headers';
import { SkeletonRows } from '../ui/Feedback';
import { GroupLabel } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { SettingField, type SettingDef } from './SettingField';

const ENDPOINT_DEFS: SettingDef[] = [
  {
    key: 'ai_base_url',
    label: 'Inference base URL',
    placeholder: '(provider default)',
    hint: 'Any OpenAI-compatible endpoint',
  },
  {
    key: 'ai_api_key',
    label: 'API key',
    placeholder: '(provider default / env)',
    secret: true,
  },
];

const MODEL_DEFS: SettingDef[] = [
  { key: 'ai_model', label: 'Global model', placeholder: 'openai/gpt-4o-mini' },
  { key: 'ai_model.triage', label: 'Model — triage', placeholder: '(inherits global)' },
  {
    key: 'ai_model.intent_classifier',
    label: 'Model — intent classifier',
    placeholder: '(inherits global)',
  },
  { key: 'ai_model.ocr', label: 'Model — OCR', placeholder: '(inherits global)' },
];

const PROMPT_DEFS: SettingDef[] = [
  {
    key: 'prompt.triage',
    label: 'Prompt — triage',
    placeholder: '(built-in default)',
    multiline: true,
  },
  {
    key: 'prompt.intent_classifier',
    label: 'Prompt — intent classifier',
    placeholder: '(built-in default)',
    multiline: true,
  },
];

/** /settings/llm — the fixed agent set is triage + intent classifier
 *  (Reality #12); everything is a validated settings key. Blank = built-in
 *  default; Clear returns a key to that default. */
export function LlmScreen() {
  const settingsQ = useAdminSettings();
  if (settingsQ.isPending) {
    return (
      <Frame>
        <SkeletonRows count={4} />
      </Frame>
    );
  }
  if (settingsQ.isError) {
    return (
      <Frame>
        <LoadError
          message={
            settingsQ.error instanceof Error
              ? settingsQ.error.message
              : 'Failed to load settings'
          }
          onRetry={() => void settingsQ.refetch()}
        />
      </Frame>
    );
  }
  const map = settingsQ.data;
  const group = (defs: SettingDef[]) => (
    <div className="mx-3.5 mb-3.5 space-y-4 rounded-2xl bg-surface p-4">
      {defs.map((def) => (
        <SettingField key={def.key} def={def} current={map[def.key] ?? ''} />
      ))}
    </div>
  );
  return (
    <Frame>
      <p className="mx-6 mb-3 text-[12.5px] text-ink-2">
        Model ids must include a provider prefix, e.g.{' '}
        <code className="font-mono">openai/gpt-4o-mini</code>. For a custom
        OpenAI-compatible endpoint, set the base URL/key and keep the{' '}
        <code className="font-mono">openai/</code> prefix — it only selects
        the request format; requests still go to your base URL.
      </p>
      <GroupLabel>Endpoint</GroupLabel>
      {group(ENDPOINT_DEFS)}
      <GroupLabel>Models</GroupLabel>
      {group(MODEL_DEFS)}
      <GroupLabel>Prompts</GroupLabel>
      {group(PROMPT_DEFS)}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="AI models" backTo="/settings" />
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Implement `src/settings/TelegramScreen.tsx`**

```tsx
import { useAdminSettings } from '../queries/settings';
import { ScreenHeader } from '../shell/Headers';
import { SkeletonRows } from '../ui/Feedback';
import { GroupLabel } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { SettingField, type SettingDef } from './SettingField';

const TELEGRAM_DEFS: SettingDef[] = [
  {
    key: 'telegram_bot_token',
    label: 'Bot token',
    placeholder: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
    secret: true,
  },
  {
    key: 'telegram_webhook_secret',
    label: 'Webhook secret',
    placeholder: 'telegram-webhook-secret',
    secret: true,
  },
  {
    key: 'telegram_allowlist',
    label: 'Allowlist chat ids',
    placeholder: 'tg:123456789, tg:987654321',
    multiline: true,
  },
];

const APPROVER_DEFS: SettingDef[] = [
  {
    key: 'approvers',
    label: 'Approvers',
    placeholder: 'tg:123456789, mailto:boss@example.com',
    hint: 'Comma-separated approver identities — who gets approval prompts',
  },
  {
    key: 'email_whitelist',
    label: 'Email whitelist',
    placeholder: 'boss@example.com, cfo@example.com',
    multiline: true,
    hint: 'Senders allowed to converse/command over email',
  },
];

/** /settings/telegram — Telegram config is exactly three settings keys plus
 *  a webhook the server registers at boot (Reality #10); approvers and the
 *  email whitelist are the channel-adjacent registry keys the legacy UI
 *  never surfaced (Reality #2). */
export function TelegramScreen() {
  const settingsQ = useAdminSettings();
  if (settingsQ.isPending) {
    return (
      <Frame>
        <SkeletonRows count={3} />
      </Frame>
    );
  }
  if (settingsQ.isError) {
    return (
      <Frame>
        <LoadError
          message={
            settingsQ.error instanceof Error
              ? settingsQ.error.message
              : 'Failed to load settings'
          }
          onRetry={() => void settingsQ.refetch()}
        />
      </Frame>
    );
  }
  const map = settingsQ.data;
  const group = (defs: SettingDef[]) => (
    <div className="mx-3.5 mb-3.5 space-y-4 rounded-2xl bg-surface p-4">
      {defs.map((def) => (
        <SettingField key={def.key} def={def} current={map[def.key] ?? ''} />
      ))}
    </div>
  );
  return (
    <Frame>
      <GroupLabel>Telegram bot</GroupLabel>
      {group(TELEGRAM_DEFS)}
      <p className="mx-6 -mt-2 mb-3.5 text-[12px] text-warn">
        Restart the app after changing these — the webhook registration reads
        the token and secret at boot.
      </p>
      <GroupLabel>Approvals & channels</GroupLabel>
      {group(APPROVER_DEFS)}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Telegram & approvers" backTo="/settings" />
      {children}
    </div>
  );
}
```

- [ ] **Step 5: Run tests, then the full suite**

```bash
npx vitest run src/settings/LlmScreen.test.tsx src/settings/TelegramScreen.test.tsx && npm test
```

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/settings
git commit -m "feat(web): AI models + Telegram/approvers screens over the validated settings registry"
```

---

### Task 11: PolicyScreen — the risk gate in euros (the raw-cents input dies)

**Files:**
- Create: `packages/web/src/settings/PolicyScreen.tsx`, `packages/web/src/settings/PolicyScreen.test.tsx`

**Interfaces:**
- Consumes: `usePolicyConfig`, `useAdminSettings`, `invalidatePolicy`, `invalidateAdminSettings` (Task 3); `updatePolicyConfig`, `setSetting`, `fmtCents` (api); `eurosToCents`/`centsToEuroInput` (`src/lib/money.ts`); kit + toasts.
- Behavior (Reality #11 + asset §9+ "центы → евро, thresholds с объяснением эффекта"):
  - **Ingest policy**: a `SelectInput` over `known-only | quarantine | open` written immediately via `setSetting('ingest_policy', …)` (matches legacy immediate-select semantics) with the hint "How intake treats documents from unknown senders".
  - **Risk gate form**: ceiling input in **EUROS** (`centsToEuroInput` prefill, `eurosToCents` parse — comma decimals accepted, invalid parse blocks save) with a LIVE consequence line "Expenses above `<amount>` € are held for approval"; min confidence (0–1, step 0.01, out-of-range blocks save); unknown-supplier checkbox; always-approve operations comma list. **Save policy** PUTs the full four-field object and toasts a receipt.

- [ ] **Step 1: Write failing tests**

`src/settings/PolicyScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getPolicyConfig: vi.fn(),
  updatePolicyConfig: vi.fn(),
  getSettings: vi.fn(),
  setSetting: vi.fn(),
}));
import {
  getPolicyConfig,
  getSettings,
  setSetting,
  updatePolicyConfig,
  type PolicyConfig,
} from '../api';
import { AppToaster } from '../ui/toast';
import { PolicyScreen } from './PolicyScreen';

const POLICY: PolicyConfig = {
  auto_post_amount_ceiling: 5000,
  auto_post_min_confidence: 0.8,
  unknown_supplier_requires_approval: true,
  always_approve_operations: ['credit_note'],
};

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/policy']}>
        <PolicyScreen />
      </MemoryRouter>
      <AppToaster />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPolicyConfig).mockResolvedValue(POLICY);
  vi.mocked(getSettings).mockResolvedValue([
    { key: 'ingest_policy', value: 'quarantine' },
  ]);
});

describe('PolicyScreen', () => {
  it('prefills the ceiling in EUROS and explains the effect live', async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Auto-post ceiling (€)')).toHaveValue(
        '50.00',
      ),
    );
    expect(
      screen.getByText('Expenses above 50.00 € are held for approval'),
    ).toBeInTheDocument();
  });

  it('saves comma-decimal euros as integer cents (the cent bug stays dead)', async () => {
    vi.mocked(updatePolicyConfig).mockResolvedValue({
      ...POLICY,
      auto_post_amount_ceiling: 12050,
    });
    mount();
    await screen.findByLabelText('Auto-post ceiling (€)');
    fireEvent.change(screen.getByLabelText('Auto-post ceiling (€)'), {
      target: { value: '120,50' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() =>
      expect(updatePolicyConfig).toHaveBeenCalledWith({
        auto_post_amount_ceiling: 12050,
        auto_post_min_confidence: 0.8,
        unknown_supplier_requires_approval: true,
        always_approve_operations: ['credit_note'],
      }),
    );
    expect(await screen.findByText('Policy saved')).toBeInTheDocument();
  });

  it('blocks save on an unparseable amount or out-of-range confidence', async () => {
    mount();
    await screen.findByLabelText('Auto-post ceiling (€)');
    fireEvent.change(screen.getByLabelText('Auto-post ceiling (€)'), {
      target: { value: 'fifty' },
    });
    expect(screen.getByRole('button', { name: 'Save policy' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Auto-post ceiling (€)'), {
      target: { value: '50.00' },
    });
    fireEvent.change(screen.getByLabelText('Minimum AI confidence (0–1)'), {
      target: { value: '1.5' },
    });
    expect(screen.getByRole('button', { name: 'Save policy' })).toBeDisabled();
    expect(updatePolicyConfig).not.toHaveBeenCalled();
  });

  it('ingest policy select writes the setting key immediately', async () => {
    vi.mocked(setSetting).mockResolvedValue({
      key: 'ingest_policy',
      value: 'open',
    });
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Ingest policy')).toHaveValue('quarantine'),
    );
    fireEvent.change(screen.getByLabelText('Ingest policy'), {
      target: { value: 'open' },
    });
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith('ingest_policy', 'open'),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/settings/PolicyScreen.test.tsx
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/settings/PolicyScreen.tsx`**

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  fmtCents,
  setSetting,
  updatePolicyConfig,
  type PolicyConfig,
} from '../api';
import { centsToEuroInput, eurosToCents } from '../lib/money';
import {
  invalidateAdminSettings,
  invalidatePolicy,
  useAdminSettings,
  usePolicyConfig,
} from '../queries/settings';
import { ScreenHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { SkeletonRows } from '../ui/Feedback';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { GroupLabel } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';

const INGEST_OPTIONS = ['known-only', 'quarantine', 'open'] as const;

/** /settings/policy — the risk gate in EUROS (Reality #11: the wire is
 *  integer cents; the legacy raw-cents input dies) + the ingest-policy
 *  setting. Every threshold explains its effect (asset §9+). */
export function PolicyScreen() {
  const policyQ = usePolicyConfig();
  const settingsQ = useAdminSettings();
  if (policyQ.isPending || settingsQ.isPending) {
    return (
      <Frame>
        <SkeletonRows count={3} />
      </Frame>
    );
  }
  if (policyQ.isError || settingsQ.isError) {
    const err = policyQ.error ?? settingsQ.error;
    return (
      <Frame>
        <LoadError
          message={err instanceof Error ? err.message : 'Failed to load policy'}
          onRetry={() => {
            void policyQ.refetch();
            void settingsQ.refetch();
          }}
        />
      </Frame>
    );
  }
  return (
    <Frame>
      <IngestPolicyGroup current={settingsQ.data['ingest_policy'] ?? ''} />
      <RiskGateForm key={policyQ.dataUpdatedAt} initial={policyQ.data} />
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Posting policy" backTo="/settings" />
      {children}
    </div>
  );
}

function IngestPolicyGroup({ current }: { current: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const onChange = async (value: string) => {
    setBusy(true);
    try {
      await setSetting('ingest_policy', value);
      await invalidateAdminSettings(qc);
      toastOk(`Ingest policy — ${value}`);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
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
            value={current}
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

function RiskGateForm({ initial }: { initial: PolicyConfig }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [ceiling, setCeiling] = useState(
    centsToEuroInput(initial.auto_post_amount_ceiling),
  );
  const [confidence, setConfidence] = useState(
    String(initial.auto_post_min_confidence),
  );
  const [unknownSupplier, setUnknownSupplier] = useState(
    initial.unknown_supplier_requires_approval,
  );
  const [alwaysApprove, setAlwaysApprove] = useState(
    initial.always_approve_operations.join(', '),
  );

  const ceilingCents = eurosToCents(ceiling);
  const confidenceNum = Number(confidence);
  const confidenceOk =
    confidence.trim() !== '' &&
    Number.isFinite(confidenceNum) &&
    confidenceNum >= 0 &&
    confidenceNum <= 1;
  const valid = ceilingCents !== null && ceilingCents >= 0 && confidenceOk;

  const save = async () => {
    if (ceilingCents === null || !confidenceOk) return;
    setBusy(true);
    try {
      await updatePolicyConfig({
        auto_post_amount_ceiling: ceilingCents,
        auto_post_min_confidence: confidenceNum,
        unknown_supplier_requires_approval: unknownSupplier,
        always_approve_operations: alwaysApprove
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      });
      await invalidatePolicy(qc);
      toastOk('Policy saved');
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <GroupLabel>Risk gate</GroupLabel>
      <div className="mx-3.5 mb-3.5 space-y-4 rounded-2xl bg-surface p-4">
        <Field
          label="Auto-post ceiling (€)"
          error={ceilingCents === null ? 'Enter an amount like 50.00' : null}
          hint={
            ceilingCents !== null
              ? `Expenses above ${fmtCents(ceilingCents)} € are held for approval`
              : undefined
          }
        >
          <TextInput
            aria-label="Auto-post ceiling (€)"
            inputMode="decimal"
            value={ceiling}
            onChange={(e) => setCeiling(e.target.value)}
          />
        </Field>
        <Field
          label="Minimum AI confidence (0–1)"
          error={confidenceOk ? null : 'A number between 0 and 1'}
          hint="Auto-posts below this confidence are held instead"
        >
          <TextInput
            aria-label="Minimum AI confidence (0–1)"
            inputMode="decimal"
            value={confidence}
            onChange={(e) => setConfidence(e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-[15px]">
          <input
            type="checkbox"
            aria-label="Unknown supplier requires approval"
            checked={unknownSupplier}
            onChange={(e) => setUnknownSupplier(e.target.checked)}
          />
          <span>Unknown supplier requires approval</span>
        </label>
        <Field
          label="Always-approve operations"
          hint="Comma-separated operation names — these are held for approval regardless of amount"
        >
          <TextInput
            aria-label="Always-approve operations"
            value={alwaysApprove}
            onChange={(e) => setAlwaysApprove(e.target.value)}
            placeholder="comma-separated"
          />
        </Field>
        <Button
          className="w-full"
          busy={busy}
          disabled={!valid || busy}
          onClick={() => void save()}
        >
          Save policy
        </Button>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Run tests, then the full suite**

```bash
npx vitest run src/settings/PolicyScreen.test.tsx && npm test
```

Expected: PASS (4 tests). (`centsToEuroInput(5000)` must yield `"50.00"` — verified signature in `src/lib/money.ts`; if its exact format differs, follow the FILE in the prefill pin and disclose.)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/settings
git commit -m "feat(web): Policy screen — risk gate in euros with consequence hints; legacy raw-cents input path dies with SettingsView"
```

---
### Task 12: Router swap — LegacyTabs + six legacy views + Table.tsx die (zero residual references)

**Files:**
- Modify: `packages/web/src/shell/router.tsx`, `packages/web/src/shell/router.test.tsx`
- Delete (WITH tests): `packages/web/src/shell/LegacyTabs.tsx` (no test file — verified), `packages/web/src/components/SettingsView.tsx` + `.test.tsx`, `OrgView.tsx` + `.test.tsx`, `EntitiesView.tsx` + `.test.tsx`, `CategoriesView.tsx` + `.test.tsx`, `EnrollView.tsx` + `.test.tsx`, `MailboxSettings.tsx` + `.test.tsx`, `Table.tsx` + `Table.test.tsx` — 15 files.

**What SURVIVES (explicitly):** `src/components/TokenGate.tsx` — `Root.tsx:18` mounts it; it is the sign-in surface, not a Settings view. After this task it is the ONLY file left in `src/components/`. Api-layer functions: every function the legacy views consumed has a NEW consumer in `src/settings/` (verified per task: org, entities+aliases, categories, enrollment, mailbox, settings, policy) — nothing in `api.ts` is orphaned.

- [ ] **Step 1: Update `src/shell/router.tsx`**

1a. Replace the five legacy-view imports (`CategoriesView`, `EnrollView`, `EntitiesView`, `OrgView`, `SettingsView`) and the `LegacyTabs` import with:

```tsx
import { CategoriesScreen } from '../settings/CategoriesScreen';
import { EnrollScreen } from '../settings/EnrollScreen';
import { EntitiesScreen } from '../settings/EntitiesScreen';
import { EntityScreen } from '../settings/EntityScreen';
import { LlmScreen } from '../settings/LlmScreen';
import { MailboxScreen } from '../settings/MailboxScreen';
import { OrganizationScreen } from '../settings/OrganizationScreen';
import { PolicyScreen } from '../settings/PolicyScreen';
import { SettingsScreen } from '../settings/SettingsScreen';
import { TelegramScreen } from '../settings/TelegramScreen';
```

1b. Update the four Settings entries in `LEGACY_REDIRECTS` (`router.tsx:33-36`) — the sub-routes ARE the targets now, no `?tab=`:

```tsx
  '/org': '/settings/organization',
  '/entities': '/settings/entities',
  '/categories': '/settings/categories',
  '/enroll': '/settings/enroll',
```

1c. Replace the whole `path: '/settings'` LegacyTabs route object (`router.tsx:87-101`) with:

```tsx
        { path: '/settings', element: <SettingsScreen /> },
        { path: '/settings/organization', element: <OrganizationScreen /> },
        { path: '/settings/entities', element: <EntitiesScreen /> },
        { path: '/settings/entities/:id', element: <EntityScreen /> },
        { path: '/settings/categories', element: <CategoriesScreen /> },
        { path: '/settings/enroll', element: <EnrollScreen /> },
        { path: '/settings/mailbox', element: <MailboxScreen /> },
        { path: '/settings/telegram', element: <TelegramScreen /> },
        { path: '/settings/llm', element: <LlmScreen /> },
        { path: '/settings/policy', element: <PolicyScreen /> },
```

1d. The OAuth-return rescue (Reality #9): replace `{ path: '/', element: <Navigate to="/inbox" replace /> }` (`router.tsx:63`) with `{ path: '/', element: <RootRedirect /> }` and add next to `RedirectMergingSearch`:

```tsx
/** The mailbox OAuth callback bounces the browser to `/?mailbox=connected`
 *  or `/?mailbox_error=…` (mailbox.controller.ts:119-164). Route the result
 *  to the Mailbox screen instead of dropping it at the Inbox redirect. */
function RootRedirect() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const to =
    params.has('mailbox') || params.has('mailbox_error')
      ? `/settings/mailbox${location.search}`
      : '/inbox';
  return <Navigate to={to} replace />;
}
```

- [ ] **Step 2: Delete the legacy files**

```bash
cd packages/web
git rm src/shell/LegacyTabs.tsx \
  src/components/SettingsView.tsx src/components/SettingsView.test.tsx \
  src/components/OrgView.tsx src/components/OrgView.test.tsx \
  src/components/EntitiesView.tsx src/components/EntitiesView.test.tsx \
  src/components/CategoriesView.tsx src/components/CategoriesView.test.tsx \
  src/components/EnrollView.tsx src/components/EnrollView.test.tsx \
  src/components/MailboxSettings.tsx src/components/MailboxSettings.test.tsx \
  src/components/Table.tsx src/components/Table.test.tsx
```

- [ ] **Step 3: Verify zero residual references**

```bash
grep -rn "LegacyTabs\|SettingsView\|OrgView\|EntitiesView\|CategoriesView\|EnrollView\|MailboxSettings\|components/Table" src/ && echo "FAIL: dangling references" || echo "ok: legacy settings surface fully gone"
ls src/components/   # expect exactly: TokenGate.tsx
```

Expected: `ok: legacy settings surface fully gone`; `TokenGate.tsx` alone. If any reference surfaces, STOP and investigate before proceeding.

- [ ] **Step 4: Update `src/shell/router.test.tsx`**

The screens carry their own behavior tests — the router test pins MOUNTING and REDIRECTS only. Using the file's existing mount helper and `vi.mock('../api', …)` block (follow the FILE — Plans 03/04/05 established the pattern):

1. DELETE assertions that pinned LegacyTabs Settings content (the `?tab=` SegmentedControl labels, any legacy view text).
2. Add mounting pins: `/settings` → the "Settings" heading; `/settings/organization` → the "Organization" ScreenHeader; `/settings/entities` → the "Entities" heading; `/settings/entities/5` → skeleton-or-card (with `getEntity` mocked minimal); `/settings/policy` → "Posting policy". (The remaining five screens are one-liner mounts of already-tested components — pin at least `/settings/mailbox` and `/settings/llm` render their headers.)
3. Redirect pins: `/org` → `/settings/organization`; `/entities` → `/settings/entities`; `/categories` → `/settings/categories`; `/enroll` → `/settings/enroll`; `/settings?tab=app` → `/settings/llm` (hub-level, Task 4); `/?mailbox=connected` → pathname `/settings/mailbox` WITH `?mailbox=connected` preserved; plain `/` → `/inbox` (unchanged).
4. Mock additions for the newly mounted screens' mount-time reads: `getSettings`/`getPolicyConfig`/`getMailboxConnectors` → `[]`-ish minimal values, `getEntity` → a minimal entity, `createDeviceEnrollment` → resolved minimal object (or leave `/settings/enroll` unmounted in this file — its own test covers it; disclose the choice). NOTE: the hub needs `Outlet` context — the router file mounts through `<Root/>`… it does NOT (buildRoutes wraps children in `Root`, which requires a token). Follow the file's existing approach for the other sections (it already solved this for `/inbox` etc.); if it mounts `buildRoutes()` directly, the `useOutletContext` in `SettingsScreen` returns the context from `Root`'s `AppLayout` — present in the real tree. If the test harness bypasses `AppLayout`, wrap the routes under a test-level `<Outlet context={{ onSignOut: () => {} }}/>` layout exactly as `SettingsScreen.test.tsx` does, and disclose.
5. Whatever the file's existing structure is, follow the FILE; the pins above are the acceptance bar; disclose deviations in the commit message.

- [ ] **Step 5: Full suite, lint, build; record the test arithmetic**

```bash
npm test && npm run lint && npm run build
```

Expected: PASS. Record in the commit message: tests before − (deleted legacy test counts — read the run summary BEFORE deleting) + (new router pins) = tests after (Plan 02 Task 12 discipline). Also confirm the suite output contains ZERO `not wrapped in act` warnings — the known offenders (OrgView act() warning noted in P04 Task 14) die with the legacy files; if any remain, they belong to Task 13's sweep, note them in the commit message.

- [ ] **Step 6: Commit**

```bash
git add -A packages/web
git commit -m "feat(web): mount Settings routes; delete LegacyTabs + six legacy views + Table.tsx (last legacy surfaces die)"
```

---

### Task 13: a11y + cross-plan fix batch + test hardening (the routed P02–P05 triage items)

**Files:**
- Modify: `packages/web/src/ui/Sheet.tsx`, `packages/web/src/ui/Sheet.test.tsx`, `packages/web/src/ui/Form.tsx`, `packages/web/src/ui/Form.test.tsx`, `packages/web/src/reports/sections.tsx`, `packages/web/src/reports/sections.test.tsx`, `packages/web/src/bank/StatementScreen.tsx`, `packages/web/src/bank/StatementScreen.test.tsx`, `packages/web/src/inbox/TriageDocScreen.tsx`, `packages/web/src/inbox/ApprovalScreen.tsx` (+ their tests), `packages/web/src/reports/ReportsScreen.test.tsx`, `packages/web/src/reports/LockSheet.test.tsx`

Work through the sub-items in order; ONE commit at the end (they are one review unit: the accumulated triage batch).

- [ ] **Step 1: Sheet — release focus on close (Radix aria-hidden warning, P05-routed)**

`src/ui/Sheet.tsx` — wrap the open-change handler:

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
  const handleOpenChange = (o: boolean) => {
    // Radix marks the app root aria-hidden while the sheet animates out; if
    // focus is still INSIDE the closing sheet the browser logs "Blocked
    // aria-hidden on an element because its descendant retained focus".
    // Release focus before the state flips (P05-routed a11y fix).
    if (!o && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    onOpenChange(o);
  };
  return (
    <Drawer.Root open={open} onOpenChange={handleOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/45" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 flex max-h-[92vh] flex-col rounded-t-3xl bg-bg pb-6 outline-none">
          <div className="mx-auto mb-3 mt-2.5 h-1 w-10 flex-none rounded-full bg-handle" />
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

Add to `src/ui/Sheet.test.tsx` (follow the file's existing render pattern):

```tsx
it('releases focus from inside the sheet before closing (aria-hidden fix)', () => {
  const onOpenChange = vi.fn();
  render(
    <Sheet open onOpenChange={onOpenChange} title="T">
      <button>inside</button>
    </Sheet>,
  );
  const inside = screen.getByRole('button', { name: 'inside' });
  inside.focus();
  expect(document.activeElement).toBe(inside);
  fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
  // Whatever path closed it, the focused element must have been blurred
  // by the time onOpenChange(false) fires.
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(document.activeElement).not.toBe(inside);
});
```

(If vaul's jsdom Escape handling doesn't fire in this harness, drive the close through the overlay click the file already uses for its close test — the assertion pair stays the same. Follow the FILE.)

- [ ] **Step 2: Field — aria-describedby wiring + group variant (P01/P03-routed)**

Replace `src/ui/Form.tsx`'s `Field` (TextInput/SelectInput/INPUT_CLS unchanged):

```tsx
import { isValidElement, cloneElement, useId } from 'react';
import type {
  InputHTMLAttributes,
  ReactElement,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

export const INPUT_CLS =
  'w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-[15px] outline-none focus:border-accent disabled:opacity-50';

/**
 * Label + control + hint/error. hint/error are wired to the control via
 * aria-describedby when the child is a single element (P01 triage item).
 * `group` renders a role="group" with aria-labelledby instead of a <label>
 * — for chip/radio clusters where a <label> would click-forward to the
 * first labelable descendant (P03 triage item).
 */
export function Field({
  label,
  error,
  hint,
  group = false,
  children,
}: {
  label: string;
  error?: string | null;
  hint?: string;
  group?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  const labelId = `${id}-label`;
  const hasDesc = error != null || hint != null;
  const child =
    !group && isValidElement(children) && hasDesc
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          'aria-describedby': descId,
          ...(error != null ? { 'aria-invalid': true } : {}),
        })
      : children;
  const labelSpan = (
    <span
      id={group ? labelId : undefined}
      className="mb-1 block text-[13px] font-semibold"
    >
      {label}
    </span>
  );
  const desc = (
    <>
      {hint != null && error == null && (
        <span id={descId} className="mt-1 block text-xs text-ink-2">
          {hint}
        </span>
      )}
      {error != null && (
        <span id={descId} className="mt-1 block text-xs text-err">
          {error}
        </span>
      )}
    </>
  );
  if (group) {
    return (
      <div role="group" aria-labelledby={labelId} aria-describedby={hasDesc ? descId : undefined}>
        {labelSpan}
        {child}
        {desc}
      </div>
    );
  }
  return (
    <div>
      <label className="block">
        {labelSpan}
        {child}
      </label>
      {desc}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={INPUT_CLS} {...props} />;
}

export function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={INPUT_CLS} {...props} />;
}
```

Add to `src/ui/Form.test.tsx`:

```tsx
it('wires hint and error to the control via aria-describedby', () => {
  const { rerender } = render(
    <Field label="Amount" hint="In euros">
      <TextInput aria-label="Amount" />
    </Field>,
  );
  const input = screen.getByLabelText('Amount');
  expect(screen.getByText('In euros').id).toBe(
    input.getAttribute('aria-describedby'),
  );
  rerender(
    <Field label="Amount" error="Required">
      <TextInput aria-label="Amount" />
    </Field>,
  );
  expect(screen.getByLabelText('Amount')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText('Required').id).toBe(
    screen.getByLabelText('Amount').getAttribute('aria-describedby'),
  );
});

it('group variant renders role=group without a label element (chip clusters)', () => {
  render(
    <Field label="Category" group>
      <div>
        <button>Fuel</button>
        <button>Office</button>
      </div>
    </Field>,
  );
  const group = screen.getByRole('group', { name: 'Category' });
  expect(group).toBeInTheDocument();
  expect(group.querySelector('label')).toBeNull();
});
```

Then switch the chip-cluster call sites in `src/inbox/ClassifyExpenseSheet.tsx` and `src/inbox/ClassifyInvoiceSheet.tsx`: every `<Field label="…">` whose child is the category-chip cluster (NOT a single input) gains `group`. Find them with `grep -n "<Field" src/inbox/Classify*.tsx` and add the prop ONLY where the child is a chip group; existing tests must stay green (the P03 chip aria-label fix means chips are reachable by name either way — if a `getByLabelText` pin relied on the `<label>` element specifically, follow the TEST and adjust it to `getByRole('group', …)` scoped queries, disclosing the change).

- [ ] **Step 3: InPeriodSection joint isSuccess gate (P05-routed)**

`src/reports/sections.tsx` — in `InPeriodSection` insert after the three hook calls (`:158-161`):

```tsx
  // BOTH sources or nothing: rendering after only one list resolves showed a
  // half-total for a moment (P05 final-review transient). The section is
  // supplementary — skeletonless null is the honest loading state.
  if (!expensesQ.isSuccess || !invoicesQ.isSuccess) return null;
```

Add to `src/reports/sections.test.tsx` (follow the file's fixtures):

```tsx
it('InPeriodSection renders NOTHING until both lists resolved (no half-totals)', async () => {
  vi.mocked(getExpenses).mockResolvedValue([/* the file's in-period expense fixture */]);
  vi.mocked(getInvoices).mockReturnValue(new Promise(() => {})); // never resolves
  render(/* the file's InPeriodSection mount with its period fixture */);
  await waitFor(() => expect(getExpenses).toHaveBeenCalled());
  expect(screen.queryByText(/Purchases in this period/)).toBeNull();
});
```

(Adapt the two comment slots to the file's existing fixtures/mount helper — the assertion pair is the acceptance bar: expenses resolved + invoices pending ⇒ no section.)

- [ ] **Step 4: StatementScreen delete-statement invalidation (P04-routed backlog)**

`src/bank/StatementScreen.tsx:351-362` — replace the `onDelete` body's success path:

```tsx
  const onDelete = async () => {
    setDeleting(true);
    try {
      await deleteBankStatement(statementId);
      // Deleting a statement unlinks matches / un-reconciles expenses —
      // the same cross-domain staleness class P04 fixed for line-level
      // actions: fan out via invalidateStatement PLUS the list key.
      await Promise.all([
        qc.invalidateQueries({ queryKey: bankKeys.statements }),
        invalidateStatement(qc, statementId),
      ]);
      navigate('/bank');
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setDeleting(false);
      setDeleteOpen(false);
    }
  };
```

(`invalidateStatement` is already imported by this file for the line-level flows — verified `StatementScreen.tsx:298-335`.) Add a pin to `src/bank/StatementScreen.test.tsx` (follow the file's delete-flow test): after confirming deletion, the spied `qc.invalidateQueries` keys include `['expenses']`, `['books']`, and `['reports']`.

- [ ] **Step 5: The "Already handled"/"Already decided" flash (P03-routed) — navigate first, invalidate after**

5a. `src/inbox/TriageDocScreen.tsx` — in `finishTriage` swap the last two statements of the success path (`:76-78`):

```tsx
    toastOk(outcomeText(o));
    navigate(next);
    await invalidateInbox(qc);
```

and in `runAction` move `navigate(next)` BEFORE the invalidation (`:86-97` becomes):

```tsx
      await fn();
      toastOk(message);
      // Auto-advance re-renders this SAME element for the next document
      // (only the :id param changes) — reset the screen-level action state
      // BEFORE navigating, or doc N+1 renders with every action disabled,
      // the confirm dialog still open, or (OcrFailedSheet.onRetried, which
      // calls runAction directly) a Fix-file sheet auto-opened over the
      // WRONG document — its Upload replacement would then archive the
      // next doc's original file.
      setSheet(null);
      setBusy(false);
      setConfirm(null);
      // Navigate BEFORE the invalidation settles: awaiting it first let the
      // refetch land, the item vanish, and the "Already handled" empty
      // state flash for a frame (P03 Task 13 deferred item).
      navigate(next);
      await invalidateInbox(qc);
```

5b. `src/inbox/ApprovalScreen.tsx` — same swap at BOTH sites (`:119-120` and `:130-131`): `navigate(next);` then `await invalidateInbox(qc);`.

5c. Discriminating pin (both test files, following each file's helpers): make `invalidateInbox` resolve only manually —

```tsx
vi.mock('../queries/inbox', async (io) => ({
  ...(await io<typeof import('../queries/inbox')>()),
  invalidateInbox: vi.fn(),
}));
// in the test:
let release!: () => void;
vi.mocked(invalidateInbox).mockReturnValue(
  new Promise<void>((r) => (release = r)),
);
// …drive the approve/dismiss action…
await waitFor(() =>
  expect(router.state.location.pathname).not.toBe(startPath),
); // navigated WHILE invalidation still pending — the flash window is gone
release();
```

If a file already mocks `../queries/inbox` differently, extend its existing mock rather than re-mocking (follow the FILE). This test FAILS against the old order (navigation only happened after `release()`) — run it before applying 5a/5b to prove it discriminates, per the red-first rule.

- [ ] **Step 6: Reports test pins (P05-routed): fan-out call count + LockSheet 409 toast**

6a. `src/reports/ReportsScreen.test.tsx` — using the file's existing fixtures (two locked periods exist in its periods fixture; if only one, extend the fixture), add:

```tsx
it('folds submission state with exactly one request per LOCKED period (fan-out pin)', async () => {
  // …the file's standard mount…
  await screen.findByText(/* the file's rendered period title */);
  expect(getSubmissionState).toHaveBeenCalledTimes(2 /* = locked periods in fixture */);
});
```

6b. `src/reports/LockSheet.test.tsx` — add the 409 path (the file mocks `lockPeriod` already):

```tsx
it('surfaces the oldest-first 409 verbatim and keeps the sheet open', async () => {
  vi.mocked(lockPeriod).mockRejectedValue(
    new Error(
      'Cannot file period 2026-07: earlier period 2026-06 is still open — file it first',
    ),
  );
  // …the file's standard open-sheet + typed-confirmation flow…
  // fireEvent the confirm button, then:
  expect(
    await screen.findByText(
      'Cannot file period 2026-07: earlier period 2026-06 is still open — file it first',
    ),
  ).toBeInTheDocument();
  // The sheet did not close and no receipt fired.
  expect(screen.queryByText(/Period closed/)).toBeNull();
});
```

(Both are ADDITIVE tests against unchanged production code — they pin behavior the P05 review verified by inspection. Adapt query details to each file's fixtures; the assertions are the bar.)

- [ ] **Step 7: Full suite + act() sweep**

```bash
npm test 2>&1 | tee /tmp/p06-t13-suite.log
grep -c "not wrapped in act" /tmp/p06-t13-suite.log || echo "0 act warnings"
npm run lint && npm run build
```

Expected: PASS with `0 act warnings` (the legacy offenders died in Task 12; Step 1-6 changes introduce none). If a residual warning appears, fix it at the source (await the pending state with `waitFor`/`findBy` in the offending test) — do not suppress.

- [ ] **Step 8: Commit**

```bash
git add -A packages/web/src
git commit -m "fix(web): triage batch — Sheet focus release, Field aria-describedby + group variant, InPeriodSection joint gate, statement-delete fan-out, already-handled flash, fan-out/409 pins"
```

---

### Task 14: Final verification + browser smoke against a real backend

**Files:** none new; fixes only if verification fails.

- [ ] **Step 1: Full suite, lint, build**

```bash
npm test && npm run lint && npm run build
```

Expected: all tests PASS, no lint errors (`lint` is check-only now), `tsc -b` + vite build succeed, and `git status --short` shows no `vite.config.js`/`.d.ts`/`*.tsbuildinfo` reappearing after the build.

- [ ] **Step 2: Grep-level invariants**

```bash
grep -rn "window.prompt\|window.confirm\|window.alert" src/ && echo "FAIL: banned dialogs" || echo "ok: no banned dialogs (the last one died with EntitiesView)"
grep -rn "refetchInterval" src/settings src/queries/settings.ts && echo "FAIL: stray polling" || echo "ok: no new polling"
grep -rn "accountCode" src/settings src/queries/settings.ts && echo "FAIL: ledger vocabulary reaches Settings (Reality #7)" || echo "ok: accountCode never touched"
grep -rn "voucher\|debit\|credit_line" src/settings --include='*.tsx' && echo "CHECK: possible ledger vocabulary leak" || echo "ok: no ledger vocabulary"
grep -rn "#[0-9A-Fa-f]\{6\}" src --include='*.tsx' --include='*.ts' | grep -v test | grep -vE "TxDispositions|SupplierSheet|Sidebar.tsx|StatementScreen" && echo "FAIL: unsanctioned raw hex" || echo "ok: tokens only"
grep -rn "LegacyTabs\|components/Table" src/ && echo "FAIL: zombie legacy reference" || echo "ok"
grep -rn "mailbox_initial_fetch_count" src/ --include='*.tsx' | grep -v "server-configured" && echo "FAIL: fake fetch-count surface (Reality #3)" || echo "ok"
```

Expected: the seven `ok:` lines.

- [ ] **Step 3: Manual browser smoke — real backend at PORT=3210, init-token pattern**

The dev-proxy targets `:3000` (`vite.config.ts:9-13`), so the smoke runs against the server's OWN static serving of the built SPA (serve-static of `@headless-bookkeeping/web/dist`, `server/src/app.module.ts:70-85`) — no proxy involved, real production wiring:

```bash
# 1. Build the SPA the server will serve:
cd packages/web && npm run build

# 2. Boot the backend on 3210 with a SCRATCH data dir (first boot of an empty
#    DATA_DIR prints the one-time init token — api-token.service.ts:40-63):
cd ../server && DATA_DIR=/tmp/bk-smoke-plan06 PORT=3210 npm run start:dev
# → copy the "INIT API TOKEN (log once, store securely): <hex>" line

# 3. Open http://localhost:3210 → TokenGate → paste the init token.
```

Resize between ~390px and ≥1024px — every check on BOTH widths.

Hub & shell:
- `/settings` shows three groups + Sign out; on the PHONE width the Sign out row is reachable (the sidebar isn't) — tap it → TokenGate; paste the token again → back in.
- Legacy bookmarks: `/org`, `/entities`, `/categories`, `/enroll` land on the sub-routes; `/settings?tab=app` lands on `/settings/llm`. F5 everywhere restores state.

Organization:
- Set country EE, type Company, VAT registered, name, VAT reg number, IBAN → Save → receipt toast; F5 → values persist; malformed country ("EST") blocks save with the hint.

Entities (the ADR-0036 acceptance):
- Add a SUPPLIER with reg key → lands on its card; reg key shown immutable.
- Add an EMPLOYEE (email required — try skipping it: the button stays disabled) → card shows email read-only.
- **Books → "+" → Upload document → the claimant dropdown NOW lists the employee** — the P04-flagged fresh-install starvation is gone.
- Create two expenses for the supplier via Books (or Bank line→expense), same category → the supplier card shows "Usually categorised · <cat> (2 of 2)" and "Expenses · 2" linking into `/books?seg=expenses&q=…` (filter applied).
- Add an alias chip; try deleting the supplier → the 409 sentence appears verbatim as a toast; delete a FRESH unused entity → lands back on the list, entity gone.
- Segments round-trip: `?seg=team` shows only the employee; search narrows; F5 keeps both.

Categories:
- Labels + keys render; NO account codes anywhere on the page (view-source spot-check for `EXPENSE_`).

Enroll:
- Fresh install: `/settings/enroll` shows the guidance card (NOT a raw 500), the Public API URL field inline; set `http://localhost:3210` → Try again → the QR renders; Regenerate mints a new one; set an `http://` non-localhost value → the server's "must use https" message surfaces on save-then-retry (the registry validator 400s the save first — also fine, message verbatim).

Mailbox:
- Empty state renders; Add IMAP with garbage credentials → the server's error (or `MAILBOX_SECRET_KEY` guidance if the env is unset) surfaces verbatim, sheet stays; Connect Gmail without BYO creds → honest error toast. (A real OAuth round-trip needs live credentials — out of smoke scope, document as untested; the `?mailbox=connected` param path is covered by unit tests + a manual URL paste: open `http://localhost:3210/?mailbox=connected` → toast on the Mailbox screen, param stripped.)

Telegram / AI / Policy:
- Save + Clear a Telegram key and an AI model key → receipt toasts; values survive F5; `Clear` empties them.
- Policy: set the ceiling to `50,00` (comma!) → save → receipt; create an 89 € expense → it goes to approval and the Inbox reason reads "89.00 € above the 50.00 € auto-post limit" (the P03 parser + this euro form agree end-to-end); set an invalid confidence (1.5) → save blocked.

Cleanup acceptance:
- A negative amount anywhere in Bank renders with `−` (U+2212 — copy a rendered amount into a hex viewer or just compare glyph width with a `+` row) and never wraps.
- Close any sheet while a field inside it has focus → the console shows NO "Blocked aria-hidden" warning.
- Console clean across the whole pass (no act() noise is test-side; here: no React key warnings, no 4xx storms).

- [ ] **Step 4: Commit any smoke fixes**

```bash
git add -A packages/web && git commit -m "fix(web): settings smoke fixes"
```

(Skip if nothing needed fixing.)

---

## Appendix A — Server gaps & degradation (binding for this plan)

Every gap below is a SERVER gap this client-only plan degrades around. The client behavior is the contract; server work is queued for a later dedicated step.

| # | Spec/mockup expectation | Server reality (verified) | Client degradation in this plan | Exact server ask |
|---|---|---|---|---|
| 1 | Alias chips imply management — add AND remove | `POST /:id/aliases` only; no list (inline on GET) and NO delete (`entities.controller.ts:70-82`) | Chips render + add-in-place; no delete affordance; a mistyped alias is corrected by adding the right one (reconciliation treats them as hints) | `DELETE /api/entities/:id/aliases/:aliasId` |
| 2 | Employee/director identity (email, Telegram id) editable on the card | The alias endpoint zod-rejects `email`/`tg_user_id` kinds (`types.ts:56-60`); PATCH covers name/country/goods only | Identity KVs render read-only with the "set at creation" note | Widen the alias/identifier write surface (or a dedicated PATCH for identity kinds) |
| 3 | Asset §8 «Память классификации» from the server's ADR-0014 memory | Classification memory is an internal AI tool only (`ai/tools/index.ts:155-176`) — no REST route | Client derives "usually X (n of m)" from cached POSTED expenses of the supplier — the same evidence source — labeled "AI hint, not a rule" | `GET /api/entities/:id/classification-memory` |
| 4 | Mailbox initial-fetch depth operator-tunable (legacy UI pretended it was) | `mailbox_initial_fetch_count` is READ by the worker (`mail-sync.worker.ts:168`) but absent from `KNOWN_SETTINGS` — the legacy save always 400'd (Reality #3) | No editor; one-line "server-configured" note | Add the key to the registry with a non-negative-int validator |
| 5 | OAuth return lands on the mailbox screen | Callback 302s to `/?mailbox=…` (`mailbox.controller.ts:119-164`) | `RootRedirect` re-routes to `/settings/mailbox` preserving params (Task 12) | Redirect straight to `/settings/mailbox?…` |
| 6 | Asset §9+: country/currency as ISO SELECTS | No supported-countries/currencies endpoint; plugin resolution is by bare country code | Constrained uppercase pattern inputs with hints (a 200-option ISO dropdown would be 99% fake surface — selecting FR breaks plugin resolution downstream) | `GET /api/countries` → plugin-backed list (code, label, currencies) |
| 7 | ADR-0036 `hold_claimant_expenses` visible next to the other risk-gate switches | Not in the `PolicyConfig` REST type (`policy/types.ts:24-33`) | Not rendered — no fake toggle | Expose it on `GET/PUT /api/policy-config` |
| 8 | Telegram settings apply live | Webhook registration reads the token at boot only (legacy caveat still true) | The restart note renders verbatim on the Telegram screen | Re-register the webhook on settings change |
| 9 | Entity duplicate hygiene (same counterparty onboarded twice) | Merge endpoint EXISTS (`POST /api/entities/:survivorId/merge`) but no duplicate-name guard on onboard | Out of scope this plan (no UI); creation shows no fake uniqueness error | — (client follow-up: a Merge flow on the entity card, Appendix B) |

**Deliberately NOT on the ask list:** an unlock for anything, and client-side writes to `mailbox_initial_fetch_count` against the current registry (they 400 — the legacy UI proved it).

## Appendix B — Follow-ups for later work

- **Merge-duplicates flow** on the entity card (`POST /api/entities/:survivorId/merge` is live server surface — gap 9): a "Merge into…" sheet with an entity picker, guarded by the server's same-role rule.
- **Desktop two-pane** for Settings (`lg:` list + `<Outlet/>` detail) and the ⌘K palette entries — the spec's desktop vision, deferred with the same status as Reports'/Books' two-pane.
- **`?tab=` alias retirement**: after a deprecation window, drop `TAB_ROUTES` from the hub and the `?tab=` branch in `useSeg` (grep `tab` in `src/lib/useSeg.ts` + `src/settings/SettingsScreen.tsx`).
- **Entities list virtualization/search-server-side** if entity counts outgrow the client filter (`GET /api/entities` has no query params today — P03 server list already carries "entity search").
- **SERVER LIST (accumulated, Plan 06 additions):** alias delete (gap 1); identity-kind writes (gap 2); classification-memory endpoint (gap 3); `mailbox_initial_fetch_count` registry entry (gap 4); OAuth callback redirect target (gap 5); supported-countries endpoint (gap 6); `hold_claimant_expenses` on policy-config (gap 7); live webhook re-registration (gap 8). Carried from P05: correction re-dating tax_point_date [TOP]; structured review flags; batch submission-state; INF rows as JSON; per-box KMD composition; amended-snapshot v2; migration-011 seed removal. Carried from earlier: needs-triage amounts; `GET /api/sales-invoices/:id`; reconciliation policy_reason; draft currency; partial prepayment; bank-fee disposition; VAT-rate exposure; owner-debt balance; bank-accounts picker; ADR-0036 claimant hold via manual-classify (P04 smoke FAIL); ADR-0012 delete guard for invoice-linked documents.

## Appendix C — Coverage map (self-review)

**Spec Settings bullet → this plan:** "grouped list (iOS Settings idiom)" → Task 4 ✅ (three groups, push rows, `?tab=` redirect); "/settings/organization org form (country, type, VAT, IBAN, base currency)" → Task 5 ✅ (PUT surface verified, inherit semantics, final-KMD hint); "/settings/entities, /settings/entities/:id suppliers/customers/claimants + aliases" → Tasks 6–7 ✅ (FOUR roles — the ADR-0036 blocker dies; detail merges aliases into the card per asset §8, "no more bottom-of-page panel"); "classification memory visible" (asset §8) → Task 7 ✅ via client derivation (Reality #6, gap 3 — honest label); "/settings/mailbox connectors, sync, OAuth, IMAP" → Task 9 ✅ (+ rescued OAuth banner, Reality #9; fetch-count fake surface removed, Reality #3); "/settings/policy intake policy + risk gate (euro inputs, not cents)" → Task 11 ✅ (eurosToCents wire, live consequence line); "/settings/llm LLM agent settings" → Task 10 ✅ (8 registry keys; stale OCR-faux footnote dropped); "/settings/enroll device enrollment QR" → Task 8 ✅ (exact payload shape; unset-URL 500 → guidance + inline fix, per asset §9+ «понятная ошибка при неконфигурированном public_api_url»); "/settings/categories READ-ONLY category reference (plugin-owned)" → Task 8 ✅ (label+key, accountCode never renders — ADR-0030, grep-enforced Task 14); "Settings only exposes what /api + /admin/settings actually offer (ADR-0028) — no fake surface" → Tasks 8–11 ✅ (+ `approvers`/`email_whitelist` now surfaced BECAUSE they are real; fetch-count removed BECAUSE it is not); Telegram (post-spec addition, commit c2e3026 note) → Task 10 ✅ against the verified reality (three keys + webhook, Reality #10). Tab-bar/section IA unchanged (Settings stays the fifth section).

**Mandate cleanup batch → this plan:** shared `?seg=`+`?tab=` hook (Inbox/Books/Settings = 3 consumers) → Task 3 ✅ (Entities list is the third consumer; Inbox+Books refactored; round-trip pins added); KeyValue `whitespace-nowrap` → Task 2 ✅ (`truncate`, superset); `#E3EFE8`/`#E9EBE7`/chevron greys → Tailwind tokens + sweep → Task 2 ✅ (+ `track`/`handle`/`ink-3`/`warn-deep`; four documented survivors listed in Global Constraints); fmtCents minus-glyph decision → Task 2 ✅ (U+2212 app-wide at the single source, justification recorded, pins repaired); ink-3/warn-deep leftovers → Task 2 ✅ (they did not exist as tokens — created + swept); a11y pass (Radix aria-hidden on sheet close; Field group variant / aria-describedby) → Task 13 Steps 1–2 ✅; build hygiene (vite.config artifacts + noEmit) → Task 2 ✅ (**noEmit REJECTED by TS 5.5 — TS6310 verified; outDir redirect recipe verified green end-to-end**); test hardening (act() warnings → Task 12 Step 5 + Task 13 Step 7; ReportsScreen fan-out call-count pin → Task 13 Step 6a; 409-toast test → Step 6b; InPeriodSection joint isSuccess gate → Step 3; "Already handled" flash → Step 5 with a discriminating red-first pin; seg round-trips → Task 3 Step 6) ✅; StatementScreen delete-statement invalidation (reuse invalidateStatement) → Task 13 Step 4 ✅; lint / lint:fix split → Task 2 ✅; employee/director creation from the UI (ADR-0036 blocker, P04) → Task 6 ✅ + smoke acceptance in Task 14; P01 "/settings bookmark" migration note → Task 4's `TAB_ROUTES` ✅; 390px pass → Task 14 both-widths rule ✅. **P06 batch (progress.md:99) — every item mapped above; explicit REJECTIONS: none rejected.** P01-routed "SegmentedControl keyboard nav (roving tabindex)" — NOT landed: deferred again with reasoning (it needs a focus-management design pass across TabBar+SegmentedControl together; no Settings screen depends on it; tracked in Appendix B's a11y follow-up class) — this is the single consciously-deferred routed item. P01-routed "className-merge inconsistency in Form.tsx" — superseded by Task 13 Step 2's Field rewrite (the merge behavior is now documented at the call sites, Task 5 NOTE).

**Router/deletion acceptance:** LegacyTabs + SettingsView + OrgView + EntitiesView + CategoriesView + EnrollView + MailboxSettings + Table (+7 test files) deleted in Task 12 with grep-verified zero residuals; `TokenGate.tsx` survives as `src/components/`' only file (Root mounts it — verified `Root.tsx:18`); LEGACY_REDIRECTS updated (4 entries), `/settings?tab=` honored at the hub, `/?mailbox…` rescued; browser smoke on a real backend at `PORT=3210` with the boot-log init-token pattern (Task 14, serve-static path verified `app.module.ts:70-85` in P05).

**Placeholder scan:** every code block is complete and runnable as written; the four consciously file-adaptive test additions (Task 3 Step 6, Task 12 Step 4, Task 13 Steps 3/5c/6) name their acceptance assertions explicitly and follow the Plan 05 Task 9 "follow the FILE" precedent. **Type consistency:** every client field verified against server source (`organization/types.ts:1-26`, `entities/types.ts:4-78`, `admin/settings.registry.ts:15-99`, `policy/types.ts:24-46`, `mailbox-connector.service.ts:8-43`, `mobile-auth.controller.ts:29-57`, `categories` via `country-plugin.interface.ts:91-98`); every referenced api.ts export verified present at its cited line; kit component props verified against `src/ui/` source (List/Form/Sheet/ConfirmDialog/Chip/Feedback/SearchInput/SegmentedControl read this session); `useSeg` consumers verified against the live `InboxScreen.tsx:191-196` / `BooksScreen.tsx:26-49` code.
