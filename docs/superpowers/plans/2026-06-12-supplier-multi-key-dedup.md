# Supplier Multi-Key Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the AI intake pipeline from creating a duplicate supplier on every document by matching on multiple normalized identifiers (reg number / email / phone) instead of one fabricated registration key.

**Architecture:** The triage structured-output proposal gains nullable email/phone/address fields and a now-nullable registration key. Supplier resolution normalizes the present identifiers, matches an existing supplier if ANY strong identifier (reg/email/phone) matches, onboards a new one with all identifiers when none match, and routes the all-null and ambiguous-conflict cases to operator triage. Address is stored but never used as a match key.

**Tech Stack:** NestJS, Kysely + SQLite (better-sqlite3), Zod (nestjs-zod), Jest.

**Spec:** `docs/superpowers/specs/2026-06-12-supplier-multi-key-dedup-design.md`

---

## File Structure

- `packages/server/src/database/migrations/043_widen_entity_identifier_kind.ts` — **Create.** Widen the `entity_identifier.kind` CHECK to admit `email`, `phone`, `address`.
- `packages/server/src/database/migrations/index.ts` — **Modify.** Register migration 043.
- `packages/server/src/entities/identifier-normalization.ts` — **Create.** Pure normalization helpers + the match-kind list (no DB, unit-testable).
- `packages/server/src/entities/identifier-normalization.spec.ts` — **Create.** Unit tests for the normalizers.
- `packages/server/src/entities/types.ts` — **Modify.** Extend `IdentifierKind` with `email | phone | address`.
- `packages/server/src/entities/entities.service.ts` — **Modify.** Add `resolveByIdentifiers`, `onboardWithIdentifiers`, `addIdentifierIfAbsent`.
- `packages/server/src/entities/entities.service.spec.ts` — **Modify.** Tests for the new methods + the migration kinds.
- `packages/server/src/triage/types.ts` — **Modify.** Make `create_registration_key` nullable; add `create_email/phone/address`; widen `PendingDraft.supplier_proposal`.
- `packages/server/src/triage/types.spec.ts` — **Modify.** Schema parse tests for the new shape.
- `packages/server/src/ai/agent-config.ts` — **Modify.** Update the triage prompt for the new fields / no-fabrication rule.
- `packages/server/src/ai/intake-workflow.service.ts` — **Modify.** Carry the new proposal fields into the `PendingDraft` view.
- `packages/server/src/ai/propose-draft.service.ts` — **Modify.** Rewrite the `create`-branch of `resolveSupplier`.
- `packages/server/src/ai/propose-draft.service.spec.ts` — **Modify.** Multi-key resolution tests incl. the "Anomaly" regression.
- `evals/triage/classify.yaml` — **Modify (follow-up).** Eval cases for identifier extraction + no-fabrication.

**Test command (from repo root):** `npm test -w @headless-bookkeeping/server -- <path-or-name-substring>`

---

## Task 1: Migration — widen `entity_identifier.kind` CHECK

**Files:**
- Create: `packages/server/src/database/migrations/043_widen_entity_identifier_kind.ts`
- Modify: `packages/server/src/database/migrations/index.ts`
- Test: `packages/server/src/entities/entities.service.spec.ts`

Background: `entity_identifier.kind` has a CHECK that only permits
`registration_key, iban, merchant_descriptor, name_alias` (migration 013). SQLite
cannot alter a CHECK in place, so the table is rebuilt (same 12-step pattern as
migration 041). Columns are `id, entity_id, kind, value, confirmed`; `entity_id`
is an FK to `entity.id` with `ON DELETE CASCADE`. No other table references
`entity_identifier`, so the rebuild is local — `PRAGMA foreign_keys = OFF` is safe.

- [ ] **Step 1: Write the failing test**

Add this `describe` block to `packages/server/src/entities/entities.service.spec.ts` (after the existing `onboard + findByRegistrationKey` block, inside the top-level `describe`):

```ts
  describe('migration 043 — entity_identifier kinds', () => {
    it('accepts email, phone, and address identifier kinds', async () => {
      const supplier = await entitiesService.onboard({
        role: 'supplier',
        country: 'US',
        name: 'Anomaly',
        registrationKey: 'REG-1',
      });

      // Direct inserts: the CHECK must now admit the three new kinds.
      await expect(
        db
          .insertInto('entity_identifier')
          .values([
            { entity_id: supplier.id, kind: 'email', value: 'help@anoma.ly', confirmed: 1 },
            { entity_id: supplier.id, kind: 'phone', value: '+1555', confirmed: 1 },
            { entity_id: supplier.id, kind: 'address', value: '1 main st', confirmed: 1 },
          ])
          .execute(),
      ).resolves.toBeDefined();
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @headless-bookkeeping/server -- entities.service.spec`
Expected: FAIL — SQLite raises a CHECK constraint violation on `kind` (the new kinds are rejected by the migration-013 CHECK).

- [ ] **Step 3: Create the migration**

Create `packages/server/src/database/migrations/043_widen_entity_identifier_kind.ts`:

```ts
import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Migration 043: widen `entity_identifier.kind` to admit `email`, `phone`,
 * and `address`. These power multi-key supplier deduplication (a supplier with
 * no registration/VAT number is matched on email/phone instead of a fabricated
 * key). SQLite cannot alter a CHECK in place, so the table is rebuilt (official
 * 12-step). Only `entity_identifier` references `entity`; nothing references
 * `entity_identifier`, so the rebuild is local and the foreign_keys toggle is
 * safe (it is restored to ON at the end).
 */
const COLUMNS = `id, entity_id, kind, value, confirmed`;

export async function up(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  await sql`
    CREATE TABLE entity_identifier_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN (
        'registration_key', 'iban', 'merchant_descriptor', 'name_alias',
        'email', 'phone', 'address'
      )),
      value TEXT NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0
    )
  `.execute(db);

  await sql`INSERT INTO entity_identifier_new (${sql.raw(COLUMNS)}) SELECT ${sql.raw(COLUMNS)} FROM entity_identifier`.execute(
    db,
  );

  await sql`DROP TABLE entity_identifier`.execute(db);
  await sql`ALTER TABLE entity_identifier_new RENAME TO entity_identifier`.execute(db);

  await sql`PRAGMA foreign_keys = ON`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  await sql`
    CREATE TABLE entity_identifier_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN (
        'registration_key', 'iban', 'merchant_descriptor', 'name_alias'
      )),
      value TEXT NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0
    )
  `.execute(db);

  // Drop any rows whose kind the narrow CHECK cannot hold.
  await sql`INSERT INTO entity_identifier_new (${sql.raw(COLUMNS)}) SELECT ${sql.raw(COLUMNS)} FROM entity_identifier WHERE kind IN ('registration_key', 'iban', 'merchant_descriptor', 'name_alias')`.execute(
    db,
  );

  await sql`DROP TABLE entity_identifier`.execute(db);
  await sql`ALTER TABLE entity_identifier_new RENAME TO entity_identifier`.execute(db);

  await sql`PRAGMA foreign_keys = ON`.execute(db);
}
```

- [ ] **Step 4: Register the migration in `index.ts`**

In `packages/server/src/database/migrations/index.ts`, add the import after the `m042` import line:

```ts
import * as m043 from './043_widen_entity_identifier_kind';
```

And add the entry after the `'042_...': m042,` line inside the `migrations` object:

```ts
  '043_widen_entity_identifier_kind': m043,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w @headless-bookkeeping/server -- entities.service.spec`
Expected: PASS — the three new kinds insert without a CHECK violation.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/database/migrations/043_widen_entity_identifier_kind.ts \
        packages/server/src/database/migrations/index.ts \
        packages/server/src/entities/entities.service.spec.ts
git commit -m "feat(db): widen entity_identifier.kind for email/phone/address (migration 043)"
```

---

## Task 2: Pure identifier-normalization module

**Files:**
- Create: `packages/server/src/entities/identifier-normalization.ts`
- Modify: `packages/server/src/entities/types.ts:6-10`
- Test: `packages/server/src/entities/identifier-normalization.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/entities/identifier-normalization.spec.ts`:

```ts
import { normalizeIdentifier, MATCH_KINDS } from './identifier-normalization';

describe('normalizeIdentifier', () => {
  it('registration_key: uppercases and strips internal whitespace', () => {
    expect(normalizeIdentifier('registration_key', '  ee 100 200 300 ')).toBe('EE100200300');
  });

  it('email: trims and lowercases', () => {
    expect(normalizeIdentifier('email', '  Help@Anoma.LY ')).toBe('help@anoma.ly');
  });

  it('phone: keeps a leading + and digits, drops separators', () => {
    expect(normalizeIdentifier('phone', '+1 (555) 234-5678')).toBe('+15552345678');
    expect(normalizeIdentifier('phone', '555.234.5678')).toBe('5552345678');
  });

  it('address: collapses whitespace and lowercases', () => {
    expect(normalizeIdentifier('address', '  1   Main  St\n')).toBe('1 main st');
  });

  it('returns null when the value normalizes to empty', () => {
    expect(normalizeIdentifier('email', '   ')).toBeNull();
    expect(normalizeIdentifier('phone', '()-')).toBeNull();
  });

  it('MATCH_KINDS excludes address', () => {
    expect(MATCH_KINDS).toEqual(['registration_key', 'email', 'phone']);
    expect(MATCH_KINDS).not.toContain('address');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @headless-bookkeeping/server -- identifier-normalization`
Expected: FAIL — `Cannot find module './identifier-normalization'`.

- [ ] **Step 3: Write the module**

Create `packages/server/src/entities/identifier-normalization.ts`:

```ts
/**
 * Identifier kinds that participate in supplier MATCHING. `address` is stored
 * (for record-keeping) but deliberately NOT a match key — exact-matching on a
 * postal address produces false merges (shared coworking addresses, formatting
 * variance). Reg number / email / phone are the strong anchors.
 */
export const MATCH_KINDS = ['registration_key', 'email', 'phone'] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

/**
 * Canonicalize an identifier value for BOTH storage and matching, so a later
 * lookup is a plain equality comparison. Returns null when the value carries no
 * usable signal (normalizes to empty) — the caller drops it.
 */
export function normalizeIdentifier(kind: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  switch (kind) {
    case 'registration_key': {
      const out = trimmed.toUpperCase().replace(/\s+/g, '');
      return out || null;
    }
    case 'email':
      return trimmed.toLowerCase();
    case 'phone': {
      const hasPlus = trimmed.startsWith('+');
      const digits = trimmed.replace(/\D/g, '');
      if (!digits) return null;
      return (hasPlus ? '+' : '') + digits;
    }
    case 'address':
      return trimmed.replace(/\s+/g, ' ').toLowerCase();
    default:
      return trimmed;
  }
}
```

- [ ] **Step 4: Extend the `IdentifierKind` type**

In `packages/server/src/entities/types.ts`, replace the `IdentifierKind` union (lines 6-10):

```ts
export type IdentifierKind =
  | 'registration_key'
  | 'iban'
  | 'merchant_descriptor'
  | 'name_alias'
  | 'email'
  | 'phone'
  | 'address';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w @headless-bookkeeping/server -- identifier-normalization`
Expected: PASS — all six cases green.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/entities/identifier-normalization.ts \
        packages/server/src/entities/identifier-normalization.spec.ts \
        packages/server/src/entities/types.ts
git commit -m "feat(entities): add identifier normalization helpers and match-kind list"
```

---

## Task 3: EntitiesService multi-key methods

**Files:**
- Modify: `packages/server/src/entities/entities.service.ts`
- Test: `packages/server/src/entities/entities.service.spec.ts`

Adds three methods:
- `resolveByIdentifiers(candidates)` — normalize each candidate, look up
  `entity_identifier` by `(kind, value)` with `confirmed = 1`, return the
  DISTINCT matched entity ids.
- `onboardWithIdentifiers(input)` — create a supplier with an arbitrary set of
  identifiers (normalized; null-normalizing ones skipped), all `confirmed = 1`.
- `addIdentifierIfAbsent(entityId, kind, rawValue)` — backfill one identifier if
  the entity does not already carry it (idempotent enrichment).

- [ ] **Step 1: Write the failing test**

Add to `packages/server/src/entities/entities.service.spec.ts` (new top-level-inner `describe`):

```ts
  describe('multi-key resolution', () => {
    it('resolveByIdentifiers matches on ANY identifier and dedups entity ids', async () => {
      const s = await entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: 'US',
        name: 'Anomaly',
        identifiers: [
          { kind: 'email', value: 'Help@Anoma.LY' },
          { kind: 'phone', value: '+1 555 0000' },
        ],
      });

      // Match by email alone (different casing) and by phone alone.
      expect(
        await entitiesService.resolveByIdentifiers([{ kind: 'email', value: 'help@anoma.ly' }]),
      ).toEqual([s.id]);
      expect(
        await entitiesService.resolveByIdentifiers([{ kind: 'phone', value: '+15550000' }]),
      ).toEqual([s.id]);

      // Two candidates that both hit the same entity → single, deduped id.
      expect(
        await entitiesService.resolveByIdentifiers([
          { kind: 'email', value: 'help@anoma.ly' },
          { kind: 'phone', value: '+15550000' },
        ]),
      ).toEqual([s.id]);

      // No match → empty array.
      expect(
        await entitiesService.resolveByIdentifiers([{ kind: 'email', value: 'nobody@x.io' }]),
      ).toEqual([]);
    });

    it('onboardWithIdentifiers writes every present identifier and skips empties', async () => {
      const s = await entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: 'US',
        name: 'Anomaly',
        identifiers: [
          { kind: 'registration_key', value: '   ' }, // normalizes to null → skipped
          { kind: 'email', value: 'help@anoma.ly' },
          { kind: 'address', value: '1 Main St' },
        ],
      });

      const found = await entitiesService.findById(s.id);
      const kinds = found.identifiers.map((i) => i.kind).sort();
      expect(kinds).toEqual(['address', 'email']);
    });

    it('addIdentifierIfAbsent inserts once and is idempotent', async () => {
      const s = await entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: 'US',
        name: 'Anomaly',
        identifiers: [{ kind: 'email', value: 'help@anoma.ly' }],
      });

      await entitiesService.addIdentifierIfAbsent(s.id, 'phone', '+1 555 0000');
      await entitiesService.addIdentifierIfAbsent(s.id, 'phone', '+15550000'); // same after normalize

      const phones = (await entitiesService.findById(s.id)).identifiers.filter(
        (i) => i.kind === 'phone',
      );
      expect(phones).toHaveLength(1);
      expect(phones[0].value).toBe('+15550000');
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @headless-bookkeeping/server -- entities.service.spec`
Expected: FAIL — `entitiesService.resolveByIdentifiers is not a function` (and the other two methods).

- [ ] **Step 3: Implement the methods**

In `packages/server/src/entities/entities.service.ts`, add the import at the top (after the `./types` import):

```ts
import { normalizeIdentifier } from './identifier-normalization';
```

Then add these three methods to the class (e.g. just after `findByRegistrationKey`):

```ts
  /**
   * Resolve any of a set of candidate identifiers to existing entities. Each
   * candidate is normalized; a candidate that normalizes to null is skipped.
   * Returns the DISTINCT entity ids that match at least one candidate on a
   * confirmed identifier. Empty array when nothing matches.
   */
  async resolveByIdentifiers(
    candidates: { kind: string; value: string }[],
  ): Promise<number[]> {
    const ids = new Set<number>();
    for (const c of candidates) {
      const value = normalizeIdentifier(c.kind, c.value);
      if (value === null) continue;
      const rows = await this.db
        .selectFrom('entity_identifier')
        .select('entity_id')
        .where('kind', '=', c.kind)
        .where('value', '=', value)
        .where('confirmed', '=', 1)
        .execute();
      for (const r of rows) ids.add(r.entity_id);
    }
    return [...ids];
  }

  /**
   * Onboard a supplier/customer with an arbitrary set of identifiers (each
   * normalized before write; identifiers that normalize to null are skipped).
   * All written identifiers are confirmed. Used by the AI intake path where the
   * anchoring identifier may be an email/phone rather than a registration key.
   */
  async onboardWithIdentifiers(input: {
    role: 'supplier' | 'customer';
    country: string;
    name: string;
    goodsVsServices?: 'goods' | 'services' | 'unknown';
    identifiers: { kind: string; value: string }[];
  }): Promise<EntityWithIdentifiers> {
    const now = Math.floor(Date.now() / 1000);
    const normalized = input.identifiers
      .map((i) => ({ kind: i.kind, value: normalizeIdentifier(i.kind, i.value) }))
      .filter((i): i is { kind: string; value: string } => i.value !== null);

    const entity = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('entity')
        .values({
          role: input.role,
          country: input.country,
          name: input.name,
          goods_vs_services: input.goodsVsServices ?? null,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      if (normalized.length > 0) {
        await trx
          .insertInto('entity_identifier')
          .values(
            normalized.map((i) => ({
              entity_id: row.id,
              kind: i.kind,
              value: i.value,
              confirmed: 1,
            })),
          )
          .execute();
      }
      return row;
    });

    const identifiers = await this.getIdentifiers(entity.id);
    return { ...this.mapEntity(entity), identifiers };
  }

  /**
   * Backfill a single identifier onto an existing entity if it is not already
   * present (compared on the normalized value). Idempotent. Confirmed on write.
   */
  async addIdentifierIfAbsent(
    entityId: number,
    kind: string,
    rawValue: string,
  ): Promise<void> {
    const value = normalizeIdentifier(kind, rawValue);
    if (value === null) return;

    const existing = await this.db
      .selectFrom('entity_identifier')
      .select('id')
      .where('entity_id', '=', entityId)
      .where('kind', '=', kind)
      .where('value', '=', value)
      .limit(1)
      .executeTakeFirst();
    if (existing) return;

    await this.db
      .insertInto('entity_identifier')
      .values({ entity_id: entityId, kind, value, confirmed: 1 })
      .execute();
  }
```

Note: `mapEntity`, `getIdentifiers` are existing private methods on the class; `onboardWithIdentifiers` mirrors the existing `onboard` transaction shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @headless-bookkeeping/server -- entities.service.spec`
Expected: PASS — all three new cases green; existing entity tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/entities/entities.service.ts \
        packages/server/src/entities/entities.service.spec.ts
git commit -m "feat(entities): resolveByIdentifiers + onboardWithIdentifiers + addIdentifierIfAbsent"
```

---

## Task 4: Supplier proposal schema, prompt, and triage view

**Files:**
- Modify: `packages/server/src/triage/types.ts:30-40` (schema), `:117-124` (PendingDraft)
- Modify: `packages/server/src/ai/agent-config.ts:49-60`
- Modify: `packages/server/src/ai/intake-workflow.service.ts:401-405`
- Test: `packages/server/src/triage/types.spec.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/server/src/triage/types.spec.ts` (import `triageResultSchema` and/or `supplierProposalSchema` if not already imported at the top):

```ts
  describe('create proposal — nullable identifiers (multi-key dedup)', () => {
    it('parses a create proposal with NO registration key but an email', () => {
      const parsed = supplierProposalSchema.parse({
        mode: 'create',
        create_name: 'Anomaly',
        create_country: 'US',
        create_email: 'help@anoma.ly',
      });
      expect(parsed).toMatchObject({
        mode: 'create',
        create_registration_key: null,
        create_email: 'help@anoma.ly',
        create_phone: null,
        create_address: null,
      });
    });

    it('still parses a create proposal with only a registration key', () => {
      const parsed = supplierProposalSchema.parse({
        mode: 'create',
        create_name: 'Acme OÜ',
        create_country: 'EE',
        create_registration_key: 'EE100200300',
      });
      expect(parsed.mode).toBe('create');
      if (parsed.mode === 'create') {
        expect(parsed.create_registration_key).toBe('EE100200300');
        expect(parsed.create_email).toBeNull();
      }
    });
  });
```

If `supplierProposalSchema` is not exported-imported in this spec yet, add it to the existing import from `'./types'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @headless-bookkeeping/server -- triage/types.spec`
Expected: FAIL — the first case throws (current schema requires `create_registration_key`, rejects unknown `create_email`).

- [ ] **Step 3: Update the schema**

In `packages/server/src/triage/types.ts`, replace the `mode: 'create'` object in `supplierProposalSchema` (lines 30-39):

```ts
  z.object({
    mode: z.literal('create'),
    create_name: z.string().min(1),
    create_country: z.string().min(1),
    // Identifiers are ALL optional/nullable: a non-EU supplier may print none of
    // them. The model must NOT fabricate a registration key just to fill the
    // field (that was the duplicate-supplier bug). When every identifier is
    // null, resolveSupplier routes the document to operator triage.
    create_registration_key: z.string().nullable().default(null),
    create_email: z.string().nullable().default(null),
    create_phone: z.string().nullable().default(null),
    create_address: z.string().nullable().default(null),
  }),
```

- [ ] **Step 4: Widen the `PendingDraft` view type**

In `packages/server/src/triage/types.ts`, replace the `supplier_proposal` block of the `PendingDraft` interface (lines 120-124):

```ts
  supplier_proposal: {
    create_name: string;
    create_country: string;
    create_registration_key: string | null;
    create_email: string | null;
    create_phone: string | null;
    create_address: string | null;
  };
```

- [ ] **Step 5: Carry the new fields into the triage view builder**

In `packages/server/src/ai/intake-workflow.service.ts`, replace the `supplier_proposal` object inside `getPendingDraft` (lines 401-405):

```ts
      supplier_proposal: {
        create_name: tr.supplier_proposal.create_name,
        create_country: tr.supplier_proposal.create_country,
        create_registration_key: tr.supplier_proposal.create_registration_key,
        create_email: tr.supplier_proposal.create_email,
        create_phone: tr.supplier_proposal.create_phone,
        create_address: tr.supplier_proposal.create_address,
      },
```

- [ ] **Step 6: Update the triage prompt**

In `packages/server/src/ai/agent-config.ts`, replace the `create`-mode sentence span (lines 54-60) with:

```ts
    'or { mode: "create", create_name, create_country, and any of ' +
    'create_registration_key / create_email / create_phone / create_address } ' +
    'when no existing supplier matched and you propose creating one: ALWAYS ' +
    "provide the name and the ISO country code, plus EVERY identifier the " +
    'document actually prints — the registration/VAT number, email, phone, and ' +
    'postal address. Use null for any identifier the document does not print; ' +
    'NEVER invent or guess a registration key (a fabricated key creates a ' +
    'duplicate supplier). Never mix the two modes. Omit supplier_proposal ' +
    'entirely only if you cannot determine the supplier at all.',
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test -w @headless-bookkeeping/server -- triage/types.spec`
Expected: PASS — both parse cases green.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/triage/types.ts \
        packages/server/src/ai/agent-config.ts \
        packages/server/src/ai/intake-workflow.service.ts \
        packages/server/src/triage/types.spec.ts
git commit -m "feat(triage): nullable supplier identifiers + email/phone/address in create proposal"
```

---

## Task 5: Rewrite `resolveSupplier` for multi-key resolution

**Files:**
- Modify: `packages/server/src/ai/propose-draft.service.ts:216-255`
- Test: `packages/server/src/ai/propose-draft.service.spec.ts`

New `create`-branch behavior:
- Collect match candidates (reg/email/phone present on the proposal).
- No candidates → `supplier-unresolved` (triage).
- `resolveByIdentifiers` → 0 matches: onboard new with ALL identifiers (incl.
  address); 1 match: resolve + backfill missing identifiers; >1: `supplier-unresolved`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/server/src/ai/propose-draft.service.spec.ts` (inside the `describe('proposeDraft', ...)` block). These reuse the file's existing `module`, `service`, `db`, `sampleTriageResult`, and `expectDraft` helpers:

```ts
    it('reuses an existing Supplier when only the EMAIL matches (Anomaly regression)', async () => {
      const entitiesService = module.get(EntitiesService);
      const existing = await entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: 'US',
        name: 'Anomaly',
        identifiers: [{ kind: 'email', value: 'help@anoma.ly' }],
      });

      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: {
          mode: 'create',
          create_name: 'Anomaly',
          create_country: 'US',
          create_registration_key: null, // no reg number on this document
          create_email: 'help@anoma.ly',
          create_phone: null,
          create_address: null,
        },
      };

      const outcome = expectDraft(await service.proposeDraft(triageResult, 20));

      // No duplicate: the draft links to the pre-existing supplier.
      const expenses = await db
        .selectFrom('expense')
        .selectAll()
        .where('document_id', '=', 20)
        .execute();
      expect(expenses[0].supplier_id).toBe(existing.id);

      const suppliers = await db
        .selectFrom('entity')
        .select('id')
        .where('role', '=', 'supplier')
        .where('name', '=', 'Anomaly')
        .execute();
      expect(suppliers).toHaveLength(1);
    });

    it('onboards a new Supplier with all identifiers when nothing matches', async () => {
      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: {
          mode: 'create',
          create_name: 'Fresh US Co',
          create_country: 'US',
          create_registration_key: null,
          create_email: 'billing@fresh.io',
          create_phone: '+1 555 7777',
          create_address: '1 Market St',
        },
      };

      expectDraft(await service.proposeDraft(triageResult, 21));

      const entitiesService = module.get(EntitiesService);
      const [match] = await entitiesService.resolveByIdentifiers([
        { kind: 'phone', value: '+15557777' },
      ]);
      expect(match).toBeDefined();
      const created = await entitiesService.findById(match);
      const kinds = created.identifiers.map((i) => i.kind).sort();
      expect(kinds).toEqual(['address', 'email', 'phone']);
    });

    it('backfills a missing identifier onto a matched Supplier', async () => {
      const entitiesService = module.get(EntitiesService);
      const existing = await entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: 'US',
        name: 'Anomaly',
        identifiers: [{ kind: 'email', value: 'help@anoma.ly' }],
      });

      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: {
          mode: 'create',
          create_name: 'Anomaly',
          create_country: 'US',
          create_registration_key: null,
          create_email: 'help@anoma.ly',
          create_phone: '+1 555 0000', // new — should be backfilled
          create_address: null,
        },
      };

      expectDraft(await service.proposeDraft(triageResult, 22));

      const phones = (await entitiesService.findById(existing.id)).identifiers.filter(
        (i) => i.kind === 'phone',
      );
      expect(phones).toHaveLength(1);
      expect(phones[0].value).toBe('+15550000');
    });

    it('routes to supplier-unresolved when the create proposal has no match keys', async () => {
      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: {
          mode: 'create',
          create_name: 'No Identifiers Inc',
          create_country: 'US',
          create_registration_key: null,
          create_email: null,
          create_phone: null,
          create_address: '1 Anonymous Way', // address is NOT a match key
        },
      };

      const outcome = await service.proposeDraft(triageResult, 23);
      expect(outcome.outcome).toBe('supplier-unresolved');
    });

    it('routes to supplier-unresolved when identifiers match TWO different Suppliers', async () => {
      const entitiesService = module.get(EntitiesService);
      await entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: 'US',
        name: 'Supplier A',
        identifiers: [{ kind: 'email', value: 'a@x.io' }],
      });
      await entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: 'US',
        name: 'Supplier B',
        identifiers: [{ kind: 'phone', value: '+15551111' }],
      });

      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: {
          mode: 'create',
          create_name: 'Ambiguous',
          create_country: 'US',
          create_registration_key: null,
          create_email: 'a@x.io', // → Supplier A
          create_phone: '+1 555 1111', // → Supplier B
          create_address: null,
        },
      };

      const outcome = await service.proposeDraft(triageResult, 24);
      expect(outcome.outcome).toBe('supplier-unresolved');
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @headless-bookkeeping/server -- propose-draft.service.spec`
Expected: FAIL — the email-only case currently onboards a SECOND "Anomaly" (old find-or-onboard keys on the now-null registration key); the no-match-keys and conflict cases do not yet return `supplier-unresolved`.

- [ ] **Step 3: Rewrite the `create` branch of `resolveSupplier`**

In `packages/server/src/ai/propose-draft.service.ts`, replace the body of the `// mode === 'create'` block (the `try { ... } catch { ... }` at lines 232-254) with:

```ts
    // mode === 'create' — multi-key find-or-onboard (ADR-0014).
    // Match candidates are the STRONG identifiers (reg/email/phone); address is
    // stored on a new supplier but is never a match key (false-merge risk).
    const matchCandidates: { kind: string; value: string }[] = [];
    if (proposal.create_registration_key)
      matchCandidates.push({ kind: 'registration_key', value: proposal.create_registration_key });
    if (proposal.create_email)
      matchCandidates.push({ kind: 'email', value: proposal.create_email });
    if (proposal.create_phone)
      matchCandidates.push({ kind: 'phone', value: proposal.create_phone });

    // No strong identifier to anchor on → route to operator triage rather than
    // spawning an unanchored duplicate.
    if (matchCandidates.length === 0) {
      return {
        outcome: 'supplier-unresolved',
        reason:
          'create proposal carries no strong identifier (registration key / email / phone) to match or anchor a supplier',
      };
    }

    try {
      const matches = await this.entitiesService.resolveByIdentifiers(matchCandidates);

      if (matches.length > 1) {
        // Ambiguous: identifiers point at distinct existing suppliers (possibly
        // a sign they should be merged). Never guess.
        return {
          outcome: 'supplier-unresolved',
          reason: `ambiguous supplier: identifiers match ${matches.length} existing entities (${matches.join(', ')})`,
        };
      }

      if (matches.length === 1) {
        const supplierId = matches[0];
        // Enrich: backfill any identifier this supplier does not yet carry.
        await this.entitiesService.addIdentifierIfAbsent(supplierId, 'registration_key', proposal.create_registration_key ?? '');
        await this.entitiesService.addIdentifierIfAbsent(supplierId, 'email', proposal.create_email ?? '');
        await this.entitiesService.addIdentifierIfAbsent(supplierId, 'phone', proposal.create_phone ?? '');
        await this.entitiesService.addIdentifierIfAbsent(supplierId, 'address', proposal.create_address ?? '');
        return { outcome: 'resolved', supplierId };
      }

      // No match — onboard a new supplier with ALL present identifiers (incl. address).
      const identifiers = [
        ...matchCandidates,
        ...(proposal.create_address ? [{ kind: 'address', value: proposal.create_address }] : []),
      ];
      const created = await this.entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: proposal.create_country,
        name: proposal.create_name,
        identifiers,
      });
      return { outcome: 'resolved', supplierId: created.id };
    } catch (e) {
      return {
        outcome: 'supplier-unresolved',
        reason: `supplier resolution failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
```

Note: `addIdentifierIfAbsent` no-ops on an empty/null-normalizing value, so passing `?? ''` for absent fields is safe.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @headless-bookkeeping/server -- propose-draft.service.spec`
Expected: PASS — all five new cases plus the pre-existing create/match/reuse cases.

- [ ] **Step 5: Run the full server suite for regressions**

Run: `npm test -w @headless-bookkeeping/server`
Expected: PASS — no regressions in intake-workflow, triage, or entities specs. (If a pre-existing spec builds a `create` proposal object and TypeScript now flags missing fields, it does NOT — the new fields have `.default(null)` so they are optional on input.)

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/ai/propose-draft.service.ts \
        packages/server/src/ai/propose-draft.service.spec.ts
git commit -m "feat(intake): multi-key supplier resolution with triage on no-key/conflict"
```

---

## Task 6: Triage evals (follow-up — may be deferred)

**Files:**
- Modify: `evals/triage/classify.yaml`

The user flagged evals as a later pass. This task documents the cases to add; run
with `npm run eval:triage:classify` from the repo root once written.

- [ ] **Step 1: Add an identifier-extraction case**

Append a test to `evals/triage/classify.yaml` whose document fixture prints a
supplier email and phone (but no VAT number), asserting the produced
`supplier_proposal` is `mode: create` with `create_email` / `create_phone`
populated and `create_registration_key: null`. Mirror the structure of the
existing cases in that file (vars → assert on the structured output).

- [ ] **Step 2: Add a no-fabrication case**

Append a test whose document prints NO registration/VAT number, asserting
`create_registration_key` is `null` (the model must not invent one).

- [ ] **Step 3: Run the eval**

Run: `npm run eval:triage:classify`
Expected: both new cases pass; review with `npm run eval:view`.

- [ ] **Step 4: Commit**

```bash
git add evals/triage/classify.yaml
git commit -m "test(evals): identifier extraction + no-fabrication triage cases"
```

---

## Done

After Task 5 the duplicate-supplier bug is fixed and regression-guarded; Task 6
hardens the model behavior via evals. Existing duplicate entities (#5/#6) are not
auto-merged — that is a separate follow-up noted in the spec.
