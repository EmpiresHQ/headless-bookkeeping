# Wave 8a — Interaction Core (Channel-adapter seam, Router, Principal gating, Telegram) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the channel-agnostic interaction **core** — a unified-envelope **Channel adapter** seam, the intent **router** (deterministic Conversation resolution → `RoutedIntent` classification via a Mastra+Zod agent → `FlowDispatcher` port), the channel-agnostic **Principal** resolver + access gating — and wire **one** concrete adapter, **Telegram**, behind a mockable transport port.

**Architecture:** A new `src/interaction/` module. The core (`envelope`, `principal`, `router`, `transport`) never sees a raw channel payload; each **Channel adapter** (`channels/telegram`) is a pure **mapper** + a thin injectable **transport port** (live Bot API, mocked in tests). The router resolves the **Conversation** aggregate (Wave-6/7 `ConversationsService.resolve`, by `channel + thread_key`), gates on a resolved **Principal**, runs the ingest track through `DocumentsService.upload`, classifies a message into a discriminated `RoutedIntent`, and either dispatches to the `FlowDispatcher` port (a **stub** in 8a; real flows are 8b) or emits a `clarify` question via the transport. See ADR-0025 (interaction-layer architecture), ADR-0016 (intent routing), ADR-0014 (channels/approvers).

**Tech Stack:** NestJS 11, Kysely 0.29 over better-sqlite3, Jest 30, Zod, Mastra (`@mastra/*`, stubbed in tests via `test/mastra-stub.ts` + jest `moduleNameMapper`). **Node 24** (`.nvmrc` = 24; the gate fails under Node 22 — better-sqlite3 NODE_MODULE_VERSION mismatch).

---

## Guardrails baked into every task (read once, apply always)

- **G1 — wave gate is CI parity.** The *final commit of every task* must be preceded by all four commands green, in this exact order, **under Node 24**: `npm run build && npm run lint && npm run test && npm run test:e2e`. Run `nvm use 24` first in every shell. Never commit on red.
- **G2 — wiring needs a real integration test.** Every behavior crossing a DI/module boundary gets a test that boots the **real DI graph against in-memory SQLite** and runs the real migrations via `Migrator.migrateToLatest()`. Harness to copy verbatim: `src/currency/currency.resolution.spec.ts`.
- **G3 — acceptance criteria discriminate.** Assert against inputs that differ from defaults so a hardcoded stub cannot pass by coincidence (e.g. assert a specific `thread_key`/`convKey`, a specific dispatched `actionIntent`, not just "truthy").
- **G4 — schema only in migrations.** No `createTable`/`CREATE TABLE`/`ALTER TABLE`/`db.schema.*` outside `src/database/migrations/`. 8a needs **no new table** — `telegram_allowlist`, `approvers`, `email_whitelist`, `ingest_policy`, `telegram_webhook_secret` are rows in the existing generic `setting` table. Grep gate (must be empty): `grep -rn "createTable\|CREATE TABLE" src --include=*.ts | grep -v "src/database/migrations/"`.
- **G5 — no `any`, no `as`.** TypeScript strict is ON; the codebase has zero `any`/`as` casts in `src/` (migrations may use `Kysely<any>` by convention — but 8a adds no migration). `npm run lint` enforces it and is part of the gate.
- **G6 — the core never imports a channel.** Grep gate (must be empty): `grep -rn "telegram\|Telegram" src/interaction/envelope src/interaction/principal src/interaction/router src/interaction/transport --include=*.ts`. Channel-specific code lives ONLY under `src/interaction/channels/`.
- **Money/time conventions.** Timestamps are unix-seconds `integer` (`Math.floor(Date.now() / 1000)`); never store ms. Booleans persist as `integer` (0/1). 8a stores no money.

## Assumed prior-wave contracts (treated as implemented — do NOT rebuild)

Verified against the merged `wave-8-interaction` branch (post PR-#36 merge):

- **`ConversationsService`** (`src/conversations/conversations.service.ts`), exported by `ConversationsModule`:
  - `resolve(input: ResolveInput): Promise<Conversation>` — `ResolveInput = { channel: ConversationChannel; thread_key: string; threading_keys?: string | null }`. Deterministic find-or-create by `(channel, thread_key)`; **reopens** a closed Conversation (logged). `ConversationChannel = 'telegram' | 'email' | 'slack' | 'api'`.
  - `appendMessage(input: AppendMessageInput): Promise<Message>` — `AppendMessageInput = { conversation_id; direction: 'inbound'|'outbound'; sender: string; body: string; threading_keys?; dkim_spf_pass? }`.
  - `attachArtifact(input: AttachArtifactInput): Promise<Artifact>` — `{ conversation_id; kind: 'inbound_attachment'|'outbound_output'|'ocr_markdown'; storage_path; document_id?; crc32? }`.
  - `associateDocument(input: { conversation_id; document_id }): Promise<void>`.
  - `Conversation = { id; channel; thread_key; status: 'open'|'closed'; created_at; updated_at; closed_at }`.
- **`DocumentsService.upload`** (`src/documents/documents.service.ts`), exported by `DocumentsModule`:
  - `upload(input: UploadDocumentInput): Promise<UploadDocumentResult>` — `UploadDocumentInput = { buffer: Buffer; filename: string; mimeType: string; channel: 'upload'|'telegram'|'email'|'drive'; sourceIdentifier?: string }`. SHA-256 dedup; returns `{ document: Document; deduplicated: boolean }` where `Document` has `{ id; storage_path; ... }`.
- **Mastra structured output** (pattern from `src/ai/pass2-agent.service.ts`): create `new Agent({ id, name, instructions, model, tools })`, then `const result = await agent.generate(input, { structuredOutput: { schema } }); const raw = result.object;` then `schema.safeParse(raw)`. In tests, `@mastra/*` resolves to `test/mastra-stub.ts` (jest `moduleNameMapper`); spy with `jest.spyOn(agent, 'generate').mockResolvedValue({ object, text: '' })`.
- **`MastraService`** (`src/ai/mastra.service.ts`) — `async initialize(): Promise<void>`; reads the model from the `setting` table key `ai_model` (default `'openai/gpt-4o-mini'`). Exported by `AiModule`.
- **Config reads**: single-row `setting` lookups — `this.db.selectFrom('setting').select('value').where('key','=',KEY).executeTakeFirst()`; `OrganizationService.getOrganization()` for org facts.
- **Test harness**: `src/currency/currency.resolution.spec.ts` — in-memory `Kysely<Database>` + `SqliteDialect(new SqliteDb(':memory:'))` + `Migrator.migrateToLatest()` + `Test.createTestingModule({ providers: [{ provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db }, ...] })`.
- **Auth**: `ApiTokenGuard` + `@Public()` decorator (`src/auth/api-token.guard.ts`). A webhook endpoint must be `@Public()` (Telegram has no bearer token; it authenticates via the secret-token header instead).
- **Migrations**: highest is `032_add_artifact_crc32`. Registered in `src/database/migrations/index.ts`; tables typed in `src/database/types.ts` `Database` interface. **8a adds none.**

---

## File Structure

```
src/interaction/
  interaction.module.ts                         # wires DatabaseModule, ConversationsModule, DocumentsModule, AiModule; registers core + telegram
  config/
    interaction-config.service.ts               # typed reads of setting rows (allowlists, ingest_policy, telegram secret)
    interaction-config.service.spec.ts          # real-DI (G2)
  envelope/
    types.ts                                    # UnifiedEnvelope, EnvelopeAuth, InboundAttachment, InteractionChannel
  principal/
    types.ts                                    # Principal, PrincipalRole
    principal-resolver.service.ts               # envelope.auth → Principal
    principal-resolver.service.spec.ts          # real-DI (G2)
    interaction-gate.ts                         # pure gating: canConverse / ingestDecision / canCommit
    interaction-gate.spec.ts                    # pure unit
  router/
    types.ts                                    # RoutedIntent union, IntentClass, ActionIntent, RouterOutcome
    routed-intent.schema.ts                     # Zod schema + mapToRoutedIntent()
    intent-classifier.service.ts                # Mastra+Zod agent → RoutedIntent
    intent-classifier.service.spec.ts           # stubbed agent.generate
    flow-dispatcher.ts                          # abstract FlowDispatcher + RecordingFlowDispatcher (8a stub)
    interaction-router.service.ts               # the orchestrator
    interaction-router.service.spec.ts          # real-DI routing table (G2/G3)
  transport/
    types.ts                                    # OutboundMessage, ActionPoint, InteractionTransport, TransportRegistry
    transport-registry.service.ts               # resolve transport by channel
    transport-registry.service.spec.ts
  channels/
    telegram/
      telegram.types.ts                         # minimal Telegram Update shape we consume
      telegram-mapper.ts                        # pure: Update ↔ envelope / outbound payload
      telegram-mapper.spec.ts                   # pure unit
      telegram-transport.service.ts             # InteractionTransport impl over an injected TelegramApi port
      telegram-transport.service.spec.ts        # mocked TelegramApi
      telegram-api.port.ts                      # abstract TelegramApi (sendMessage); + HttpTelegramApi
      telegram-webhook.controller.ts            # @Public POST /api/channels/telegram/webhook (secret-token gate)
      telegram-webhook.controller.spec.ts       # real-DI + mocked TelegramApi
test/
  interaction.e2e-spec.ts                       # end-to-end webhook → conversation persisted → dispatch/clarify recorded
```

---

## Task 1: Interaction config reads (`InteractionConfigService`)

**Files:**
- Create: `src/interaction/config/interaction-config.service.ts`
- Test: `src/interaction/config/interaction-config.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/interaction/config/interaction-config.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../../database/types';
import { migrations } from '../../database/migrations';
import { InteractionConfigService } from './interaction-config.service';

describe('InteractionConfigService (integration)', () => {
  let db: Kysely<Database>;
  let config: InteractionConfigService;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error instanceof Error ? error : new Error('migrate failed');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        InteractionConfigService,
      ],
    }).compile();
    config = module.get(InteractionConfigService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function setSetting(key: string, value: string): Promise<void> {
    await db
      .insertInto('setting')
      .values({ key, value, updated_at: 0 })
      .execute();
  }

  it('defaults ingest_policy to known-only when unset', async () => {
    await expect(config.getIngestPolicy()).resolves.toBe('known-only');
  });

  it('reads a configured ingest_policy', async () => {
    await setSetting('ingest_policy', 'quarantine');
    await expect(config.getIngestPolicy()).resolves.toBe('quarantine');
  });

  it('parses the telegram_allowlist as a comma-separated id set', async () => {
    await setSetting('telegram_allowlist', '111, 222 ,333');
    const ids = await config.getTelegramAllowlist();
    expect(ids).toEqual(new Set(['111', '222', '333']));
  });

  it('returns an empty approver set when unset', async () => {
    await expect(config.getApprovers()).resolves.toEqual(new Set());
  });

  it('reads the telegram webhook secret', async () => {
    await setSetting('telegram_webhook_secret', 's3cr3t');
    await expect(config.getTelegramWebhookSecret()).resolves.toBe('s3cr3t');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 24 && npx jest src/interaction/config/interaction-config.service.spec.ts`
Expected: FAIL — `Cannot find module './interaction-config.service'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/interaction/config/interaction-config.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../../database/types';

export type IngestPolicy = 'known-only' | 'quarantine' | 'open';

@Injectable()
export class InteractionConfigService {
  constructor(
    @Inject(KYSELY_MODULE_CONNECTION_TOKEN())
    private readonly db: Kysely<Database>,
  ) {}

  private async read(key: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('setting')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst();
    return row?.value ?? null;
  }

  private async readIdSet(key: string): Promise<Set<string>> {
    const raw = await this.read(key);
    if (!raw) return new Set();
    return new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
  }

  async getIngestPolicy(): Promise<IngestPolicy> {
    const raw = await this.read('ingest_policy');
    if (raw === 'quarantine' || raw === 'open') return raw;
    return 'known-only';
  }

  async getTelegramAllowlist(): Promise<Set<string>> {
    return this.readIdSet('telegram_allowlist');
  }

  async getApprovers(): Promise<Set<string>> {
    return this.readIdSet('approvers');
  }

  async getEmailWhitelist(): Promise<Set<string>> {
    return this.readIdSet('email_whitelist');
  }

  async getTelegramWebhookSecret(): Promise<string | null> {
    return this.read('telegram_webhook_secret');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use 24 && npx jest src/interaction/config/interaction-config.service.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/interaction/config
git commit -m "feat(interaction): InteractionConfigService reads setting rows (allowlists, ingest_policy, webhook secret)"
```

---

## Task 2: Unified envelope + Principal types & resolver

**Files:**
- Create: `src/interaction/envelope/types.ts`
- Create: `src/interaction/principal/types.ts`
- Create: `src/interaction/principal/principal-resolver.service.ts`
- Test: `src/interaction/principal/principal-resolver.service.spec.ts`

- [ ] **Step 1: Write the envelope + principal types (no test — pure type declarations consumed by Step 2's test)**

```typescript
// src/interaction/envelope/types.ts
export type InteractionChannel = 'telegram' | 'email' | 'slack' | 'api';

export interface InboundAttachment {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

/** Normalized authenticity signals lifted out of a channel payload by its adapter. */
export interface EnvelopeAuth {
  /** Email address (email) or Telegram chat id as a string (telegram). */
  senderId: string;
  /** Transport-level proof the sender is who they claim: DKIM+SPF pass (email), secret-token-verified webhook (telegram). */
  transportVerified: boolean;
}

/** The channel-agnostic representation of ONE inbound interaction (ADR-0025). */
export interface UnifiedEnvelope {
  channel: InteractionChannel;
  /** Raw display sender (for the Message record). */
  sender: string;
  /** Channel-scoped thread key → ConversationsService.resolve({ channel, thread_key }). */
  convKey: string;
  /** Text body; null for an attachment-only or a button-tap interaction. */
  message: string | null;
  attachments: InboundAttachment[];
  /** Channel extras the core may read deterministically (e.g. callbackData for a button tap). */
  metadata: Record<string, string>;
  auth: EnvelopeAuth;
}
```

```typescript
// src/interaction/principal/types.ts
export type PrincipalRole = 'approver' | 'known_counterparty' | 'unknown';

/** Who the core decides an inbound interaction is from (ADR-0025). */
export interface Principal {
  role: PrincipalRole;
  /** True only when the channel's transport proved authenticity AND the sender is an approver. */
  authVerified: boolean;
  senderId: string;
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/interaction/principal/principal-resolver.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../../database/types';
import { migrations } from '../../database/migrations';
import { InteractionConfigService } from '../config/interaction-config.service';
import { PrincipalResolverService } from './principal-resolver.service';
import { UnifiedEnvelope } from '../envelope/types';

function tgEnvelope(chatId: string, verified: boolean): UnifiedEnvelope {
  return {
    channel: 'telegram',
    sender: chatId,
    convKey: `tg:${chatId}`,
    message: 'hi',
    attachments: [],
    metadata: {},
    auth: { senderId: chatId, transportVerified: verified },
  };
}

describe('PrincipalResolverService (integration)', () => {
  let db: Kysely<Database>;
  let resolver: PrincipalResolverService;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error instanceof Error ? error : new Error('migrate failed');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        InteractionConfigService,
        PrincipalResolverService,
      ],
    }).compile();
    resolver = module.get(PrincipalResolverService);

    await db
      .insertInto('setting')
      .values({ key: 'telegram_allowlist', value: '999', updated_at: 0 })
      .execute();
    await db
      .insertInto('setting')
      .values({ key: 'approvers', value: '999', updated_at: 0 })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('resolves an allowlisted, transport-verified telegram sender as an authVerified approver', async () => {
    const p = await resolver.resolve(tgEnvelope('999', true));
    expect(p.role).toBe('approver');
    expect(p.authVerified).toBe(true);
  });

  it('does not authVerify an approver whose transport was not verified', async () => {
    const p = await resolver.resolve(tgEnvelope('999', false));
    expect(p.role).toBe('approver');
    expect(p.authVerified).toBe(false);
  });

  it('resolves an unknown telegram sender as unknown', async () => {
    const p = await resolver.resolve(tgEnvelope('123', true));
    expect(p.role).toBe('unknown');
    expect(p.authVerified).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `nvm use 24 && npx jest src/interaction/principal/principal-resolver.service.spec.ts`
Expected: FAIL — `Cannot find module './principal-resolver.service'`.

- [ ] **Step 4: Write minimal implementation**

```typescript
// src/interaction/principal/principal-resolver.service.ts
import { Injectable } from '@nestjs/common';
import { InteractionConfigService } from '../config/interaction-config.service';
import { UnifiedEnvelope } from '../envelope/types';
import { Principal, PrincipalRole } from './types';

@Injectable()
export class PrincipalResolverService {
  constructor(private readonly config: InteractionConfigService) {}

  async resolve(envelope: UnifiedEnvelope): Promise<Principal> {
    const senderId = envelope.auth.senderId;
    const approvers = await this.approverSetFor(envelope.channel);
    const role: PrincipalRole = approvers.has(senderId)
      ? 'approver'
      : 'unknown';
    // known_counterparty resolution (a known Entity email) lands with the email
    // adapter in 8c; telegram has no counterparties.
    const authVerified = role === 'approver' && envelope.auth.transportVerified;
    return { role, authVerified, senderId };
  }

  private async approverSetFor(channel: string): Promise<Set<string>> {
    const approvers = await this.config.getApprovers();
    if (channel === 'telegram') {
      const allowlist = await this.config.getTelegramAllowlist();
      // approver ⊆ allowlist: a telegram approver must be on both.
      return new Set([...approvers].filter((id) => allowlist.has(id)));
    }
    return approvers;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `nvm use 24 && npx jest src/interaction/principal/principal-resolver.service.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/interaction/envelope src/interaction/principal/types.ts src/interaction/principal/principal-resolver.service.ts src/interaction/principal/principal-resolver.service.spec.ts
git commit -m "feat(interaction): UnifiedEnvelope + channel-agnostic Principal resolver"
```

---

## Task 3: Access gating (`InteractionGate`)

**Files:**
- Create: `src/interaction/principal/interaction-gate.ts`
- Test: `src/interaction/principal/interaction-gate.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/interaction/principal/interaction-gate.spec.ts
import { canConverse, canCommit, ingestDecision } from './interaction-gate';
import { Principal } from './types';

const approver = (authVerified: boolean): Principal => ({
  role: 'approver',
  authVerified,
  senderId: '999',
});
const known: Principal = { role: 'known_counterparty', authVerified: false, senderId: 's@x.com' };
const unknown: Principal = { role: 'unknown', authVerified: false, senderId: 'x' };

describe('InteractionGate', () => {
  it('lets only an approver converse', () => {
    expect(canConverse(approver(false))).toBe(true);
    expect(canConverse(known)).toBe(false);
    expect(canConverse(unknown)).toBe(false);
  });

  it('commits only for an authVerified approver', () => {
    expect(canCommit(approver(true))).toBe(true);
    expect(canCommit(approver(false))).toBe(false);
    expect(canCommit(unknown)).toBe(false);
  });

  it('accepts ingest from an approver or known counterparty regardless of policy', () => {
    expect(ingestDecision(approver(false), 'known-only')).toBe('accept');
    expect(ingestDecision(known, 'known-only')).toBe('accept');
  });

  it('gates unknown ingest by policy', () => {
    expect(ingestDecision(unknown, 'known-only')).toBe('reject');
    expect(ingestDecision(unknown, 'quarantine')).toBe('quarantine');
    expect(ingestDecision(unknown, 'open')).toBe('accept');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 24 && npx jest src/interaction/principal/interaction-gate.spec.ts`
Expected: FAIL — `Cannot find module './interaction-gate'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/interaction/principal/interaction-gate.ts
import { IngestPolicy } from '../config/interaction-config.service';
import { Principal } from './types';

export type IngestDecision = 'accept' | 'quarantine' | 'reject';

/** Converse / take commands: approver only. */
export function canConverse(p: Principal): boolean {
  return p.role === 'approver';
}

/** Commit an Action point: approver AND transport-proven. */
export function canCommit(p: Principal): boolean {
  return p.role === 'approver' && p.authVerified;
}

/** Ingest an inbound document: known senders always; unknown by policy. */
export function ingestDecision(p: Principal, policy: IngestPolicy): IngestDecision {
  if (p.role === 'approver' || p.role === 'known_counterparty') return 'accept';
  if (policy === 'open') return 'accept';
  if (policy === 'quarantine') return 'quarantine';
  return 'reject';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use 24 && npx jest src/interaction/principal/interaction-gate.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/interaction/principal/interaction-gate.ts src/interaction/principal/interaction-gate.spec.ts
git commit -m "feat(interaction): per-track access gating over the Principal"
```

---

## Task 4: `RoutedIntent` types + Zod schema + mapper

**Files:**
- Create: `src/interaction/router/types.ts`
- Create: `src/interaction/router/routed-intent.schema.ts`
- Test: `src/interaction/router/routed-intent.schema.spec.ts`

- [ ] **Step 1: Write the types (consumed by the schema + Step 2 test)**

```typescript
// src/interaction/router/types.ts
export type IntentClass = 'advisory' | 'action' | 'report' | 'reconciliation';
export type ActionIntent =
  | 'create_sales_invoice'
  | 'approve'
  | 'reject'
  | 'correct';

export type RoutedIntent =
  | { kind: 'advisory' }
  | { kind: 'action'; actionIntent: ActionIntent; fields: Record<string, string> }
  | { kind: 'report'; reportKind: string }
  | { kind: 'reconciliation' }
  | { kind: 'clarify'; question: string };

/** What the router did with one inbound envelope — returned for tests/e2e and audit. */
export interface RouterOutcome {
  conversation_id: number;
  gated_in: boolean;
  ingested: number; // count of documents ingested this turn
  intent: RoutedIntent | null; // null when no message / gated out
  dispatched: boolean;
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/interaction/router/routed-intent.schema.spec.ts
import { routedIntentSchema, mapToRoutedIntent } from './routed-intent.schema';

describe('routedIntentSchema + mapToRoutedIntent', () => {
  it('maps an advisory classification', () => {
    const raw = routedIntentSchema.parse({ kind: 'advisory' });
    expect(mapToRoutedIntent(raw)).toEqual({ kind: 'advisory' });
  });

  it('maps an action classification with intent + fields', () => {
    const raw = routedIntentSchema.parse({
      kind: 'action',
      actionIntent: 'create_sales_invoice',
      fields: { amount: '10000', currency: 'EUR' },
    });
    expect(mapToRoutedIntent(raw)).toEqual({
      kind: 'action',
      actionIntent: 'create_sales_invoice',
      fields: { amount: '10000', currency: 'EUR' },
    });
  });

  it('maps a clarify classification', () => {
    const raw = routedIntentSchema.parse({
      kind: 'clarify',
      question: 'Which customer?',
    });
    expect(mapToRoutedIntent(raw)).toEqual({
      kind: 'clarify',
      question: 'Which customer?',
    });
  });

  it('defaults a malformed action (missing actionIntent) to a clarify', () => {
    const raw = routedIntentSchema.parse({ kind: 'action' });
    expect(mapToRoutedIntent(raw)).toEqual({
      kind: 'clarify',
      question: expect.any(String),
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `nvm use 24 && npx jest src/interaction/router/routed-intent.schema.spec.ts`
Expected: FAIL — `Cannot find module './routed-intent.schema'`.

- [ ] **Step 4: Write minimal implementation**

> A **flat** Zod object (not a discriminated union) — mirrors the Pass-2 pattern and is what Mastra `structuredOutput` reliably produces. `mapToRoutedIntent` narrows it into the typed `RoutedIntent`, degrading a malformed shape to a `clarify` (the router is not a security boundary — a bad parse must never throw; ADR-0016).

```typescript
// src/interaction/router/routed-intent.schema.ts
import { z } from 'zod';
import { ActionIntent, RoutedIntent } from './types';

export const routedIntentSchema = z.object({
  kind: z.enum(['advisory', 'action', 'report', 'reconciliation', 'clarify']),
  actionIntent: z
    .enum(['create_sales_invoice', 'approve', 'reject', 'correct'])
    .optional(),
  fields: z.record(z.string(), z.string()).optional(),
  reportKind: z.string().optional(),
  question: z.string().optional(),
});

export type RawRoutedIntent = z.infer<typeof routedIntentSchema>;

const CLARIFY_FALLBACK =
  'Sorry, I did not quite get that — could you rephrase what you need?';

export function mapToRoutedIntent(raw: RawRoutedIntent): RoutedIntent {
  switch (raw.kind) {
    case 'advisory':
      return { kind: 'advisory' };
    case 'reconciliation':
      return { kind: 'reconciliation' };
    case 'report':
      return { kind: 'report', reportKind: raw.reportKind ?? 'unspecified' };
    case 'clarify':
      return { kind: 'clarify', question: raw.question ?? CLARIFY_FALLBACK };
    case 'action':
      if (!raw.actionIntent) {
        return { kind: 'clarify', question: CLARIFY_FALLBACK };
      }
      return {
        kind: 'action',
        actionIntent: raw.actionIntent as ActionIntent,
        fields: raw.fields ?? {},
      };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `nvm use 24 && npx jest src/interaction/router/routed-intent.schema.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/interaction/router/types.ts src/interaction/router/routed-intent.schema.ts src/interaction/router/routed-intent.schema.spec.ts
git commit -m "feat(interaction): RoutedIntent union + Zod schema + degrade-to-clarify mapper"
```

---

## Task 5: Intent classifier (Mastra + Zod agent)

**Files:**
- Create: `src/interaction/router/intent-classifier.service.ts`
- Test: `src/interaction/router/intent-classifier.service.spec.ts`

- [ ] **Step 1: Write the failing test** (stub `agent.generate` exactly as `pass2-agent.service.spec.ts` does)

```typescript
// src/interaction/router/intent-classifier.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { Agent } from '@mastra/core/agent'; // resolves to test/mastra-stub.ts
import { IntentClassifierService } from './intent-classifier.service';

describe('IntentClassifierService', () => {
  let service: IntentClassifierService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [IntentClassifierService],
    }).compile();
    service = module.get(IntentClassifierService);
    await service.initialize();
  });

  it('returns the agent-classified action intent', async () => {
    const agent = service.agentForTest();
    jest.spyOn(agent, 'generate').mockResolvedValue({
      object: {
        kind: 'action',
        actionIntent: 'create_sales_invoice',
        fields: { amount: '10000' },
      },
      text: '',
    });

    const intent = await service.classify('please invoice Acme 100 eur');
    expect(intent).toEqual({
      kind: 'action',
      actionIntent: 'create_sales_invoice',
      fields: { amount: '10000' },
    });
  });

  it('degrades an unparseable agent output to a clarify (never throws)', async () => {
    const agent = service.agentForTest();
    jest
      .spyOn(agent, 'generate')
      .mockResolvedValue({ object: { kind: 'banana' }, text: '' });

    const intent = await service.classify('???');
    expect(intent.kind).toBe('clarify');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 24 && npx jest src/interaction/router/intent-classifier.service.spec.ts`
Expected: FAIL — `Cannot find module './intent-classifier.service'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/interaction/router/intent-classifier.service.ts
import { Injectable } from '@nestjs/common';
import { Agent } from '@mastra/core/agent';
import { routedIntentSchema, mapToRoutedIntent } from './routed-intent.schema';
import { RoutedIntent } from './types';

const INSTRUCTIONS = `You classify a single user message in an accounting assistant into one intent.
- advisory: a read-only question about the books.
- action: the user wants to do something. Set actionIntent (create_sales_invoice | approve | reject | correct) and pull any obvious fields.
- report: the user wants a report; set reportKind.
- reconciliation: the user is resolving a bank line.
- clarify: you are NOT confident. Set a short question. Prefer clarify over guessing.`;

@Injectable()
export class IntentClassifierService {
  private agent: Agent | null = null;

  initialize(): Promise<void> {
    this.agent = new Agent({
      id: 'intent-classifier',
      name: 'Intent Classifier',
      instructions: INSTRUCTIONS,
      model: 'openai/gpt-4o-mini',
      tools: {},
    });
    return Promise.resolve();
  }

  /** Test seam — lets a spec spy on agent.generate (mirrors Pass2AgentService). */
  agentForTest(): Agent {
    if (!this.agent) throw new Error('not initialized');
    return this.agent;
  }

  async classify(message: string): Promise<RoutedIntent> {
    if (!this.agent) throw new Error('IntentClassifierService not initialized');
    const result = await this.agent.generate(message, {
      structuredOutput: { schema: routedIntentSchema },
    });
    const parsed = routedIntentSchema.safeParse(result.object);
    if (!parsed.success) {
      return { kind: 'clarify', question: 'Could you rephrase what you need?' };
    }
    return mapToRoutedIntent(parsed.data);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use 24 && npx jest src/interaction/router/intent-classifier.service.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/interaction/router/intent-classifier.service.ts src/interaction/router/intent-classifier.service.spec.ts
git commit -m "feat(interaction): Mastra+Zod intent classifier (degrades to clarify)"
```

---

## Task 6: `FlowDispatcher` port + 8a recording stub

**Files:**
- Create: `src/interaction/router/flow-dispatcher.ts`
- Test: `src/interaction/router/flow-dispatcher.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/interaction/router/flow-dispatcher.spec.ts
import { RecordingFlowDispatcher } from './flow-dispatcher';
import { RoutedIntent } from './types';

describe('RecordingFlowDispatcher (8a stub)', () => {
  it('records the dispatched intent and reports unhandled', async () => {
    const d = new RecordingFlowDispatcher();
    const intent: RoutedIntent = {
      kind: 'action',
      actionIntent: 'create_sales_invoice',
      fields: {},
    };
    const result = await d.dispatch(intent, { conversation_id: 7 });
    expect(result.handled).toBe(false);
    expect(d.calls).toEqual([{ intent, ctx: { conversation_id: 7 } }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 24 && npx jest src/interaction/router/flow-dispatcher.spec.ts`
Expected: FAIL — `Cannot find module './flow-dispatcher'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/interaction/router/flow-dispatcher.ts
import { Injectable } from '@nestjs/common';
import { RoutedIntent } from './types';

export interface DispatchContext {
  conversation_id: number;
}

export interface DispatchResult {
  handled: boolean;
  /** Optional dialogue reply to send back on the channel. */
  reply?: string;
}

/** The seam 8b plugs real conversational flows into. */
export abstract class FlowDispatcher {
  abstract dispatch(
    intent: RoutedIntent,
    ctx: DispatchContext,
  ): Promise<DispatchResult>;
}

/** 8a stub: records calls, handles nothing. Replaced by real flows in 8b. */
@Injectable()
export class RecordingFlowDispatcher extends FlowDispatcher {
  readonly calls: { intent: RoutedIntent; ctx: DispatchContext }[] = [];

  dispatch(intent: RoutedIntent, ctx: DispatchContext): Promise<DispatchResult> {
    this.calls.push({ intent, ctx });
    return Promise.resolve({ handled: false });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use 24 && npx jest src/interaction/router/flow-dispatcher.spec.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/interaction/router/flow-dispatcher.ts src/interaction/router/flow-dispatcher.spec.ts
git commit -m "feat(interaction): FlowDispatcher port + 8a recording stub"
```

---

## Task 7: Transport port + registry

**Files:**
- Create: `src/interaction/transport/types.ts`
- Create: `src/interaction/transport/transport-registry.service.ts`
- Test: `src/interaction/transport/transport-registry.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/interaction/transport/transport-registry.service.spec.ts
import { TransportRegistry, InteractionTransport, OutboundMessage } from './types';
import { TransportRegistryService } from './transport-registry.service';

class FakeTransport implements InteractionTransport {
  readonly channel = 'telegram' as const;
  readonly sent: OutboundMessage[] = [];
  send(out: OutboundMessage): Promise<void> {
    this.sent.push(out);
    return Promise.resolve();
  }
}

describe('TransportRegistryService', () => {
  it('routes an outbound message to the transport for its channel', async () => {
    const tg = new FakeTransport();
    const registry: TransportRegistry = new TransportRegistryService([tg]);
    await registry.send({
      channel: 'telegram',
      convKey: 'tg:999',
      text: 'hello',
    });
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toBe('hello');
  });

  it('throws for a channel with no registered transport', async () => {
    const registry: TransportRegistry = new TransportRegistryService([]);
    await expect(
      registry.send({ channel: 'slack', convKey: 'x', text: 'y' }),
    ).rejects.toThrow(/no transport/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 24 && npx jest src/interaction/transport/transport-registry.service.spec.ts`
Expected: FAIL — `Cannot find module './types'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/interaction/transport/types.ts
import { InteractionChannel } from '../envelope/types';

/** An abstract commit step the user must take (rendered per channel: TG button / email YES). */
export interface ActionPoint {
  id: string;
  label: string;
}

export interface OutboundMessage {
  channel: InteractionChannel;
  convKey: string;
  text: string;
  actionPoint?: ActionPoint;
}

/** One channel's outbound edge. Implemented by each adapter (e.g. TelegramTransport). */
export interface InteractionTransport {
  readonly channel: InteractionChannel;
  send(out: OutboundMessage): Promise<void>;
}

/** Resolves the right transport for an outbound message's channel. */
export interface TransportRegistry {
  send(out: OutboundMessage): Promise<void>;
}
```

```typescript
// src/interaction/transport/transport-registry.service.ts
import { Inject, Injectable } from '@nestjs/common';
import {
  InteractionTransport,
  OutboundMessage,
  TransportRegistry,
} from './types';

export const INTERACTION_TRANSPORTS = Symbol('INTERACTION_TRANSPORTS');

@Injectable()
export class TransportRegistryService implements TransportRegistry {
  private readonly byChannel = new Map<string, InteractionTransport>();

  constructor(
    @Inject(INTERACTION_TRANSPORTS) transports: InteractionTransport[],
  ) {
    for (const t of transports) this.byChannel.set(t.channel, t);
  }

  async send(out: OutboundMessage): Promise<void> {
    const transport = this.byChannel.get(out.channel);
    if (!transport) {
      throw new Error(`no transport registered for channel ${out.channel}`);
    }
    await transport.send(out);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use 24 && npx jest src/interaction/transport/transport-registry.service.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/interaction/transport
git commit -m "feat(interaction): transport port + channel-keyed registry"
```

---

## Task 8: `InteractionRouter` — the orchestrator

**Files:**
- Create: `src/interaction/router/interaction-router.service.ts`
- Test: `src/interaction/router/interaction-router.service.spec.ts`

This is the heart: resolve Conversation → persist inbound Message → resolve Principal → ingest track → (if message & canConverse) classify → dispatch or clarify. A button tap (`metadata.callbackData`) is a **deterministic** pre-classified action (no LLM), handed straight to the dispatcher.

- [ ] **Step 1: Write the failing test** (real DI; stub the classifier + a recording transport + the recording dispatcher)

```typescript
// src/interaction/router/interaction-router.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../../database/types';
import { migrations } from '../../database/migrations';
import { ConversationsService } from '../../conversations/conversations.service';
import { DocumentsService } from '../../documents/documents.service';
import { InteractionConfigService } from '../config/interaction-config.service';
import { PrincipalResolverService } from '../principal/principal-resolver.service';
import { IntentClassifierService } from './intent-classifier.service';
import { RecordingFlowDispatcher, FlowDispatcher } from './flow-dispatcher';
import { TransportRegistryService, INTERACTION_TRANSPORTS } from '../transport/transport-registry.service';
import { InteractionTransport, OutboundMessage } from '../transport/types';
import { InteractionRouterService } from './interaction-router.service';
import { UnifiedEnvelope } from '../envelope/types';

class RecordingTransport implements InteractionTransport {
  readonly channel = 'telegram' as const;
  readonly sent: OutboundMessage[] = [];
  send(out: OutboundMessage): Promise<void> {
    this.sent.push(out);
    return Promise.resolve();
  }
}

describe('InteractionRouterService (integration)', () => {
  let db: Kysely<Database>;
  let router: InteractionRouterService;
  let classifier: IntentClassifierService;
  let dispatcher: RecordingFlowDispatcher;
  let transport: RecordingTransport;

  function envelope(over: Partial<UnifiedEnvelope>): UnifiedEnvelope {
    return {
      channel: 'telegram',
      sender: '999',
      convKey: 'tg:999',
      message: 'hello',
      attachments: [],
      metadata: {},
      auth: { senderId: '999', transportVerified: true },
      ...over,
    };
  }

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error instanceof Error ? error : new Error('migrate failed');

    transport = new RecordingTransport();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        ConversationsService,
        DocumentsService,
        InteractionConfigService,
        PrincipalResolverService,
        IntentClassifierService,
        { provide: FlowDispatcher, useClass: RecordingFlowDispatcher },
        { provide: INTERACTION_TRANSPORTS, useValue: [transport] },
        TransportRegistryService,
        InteractionRouterService,
      ],
    }).compile();

    router = module.get(InteractionRouterService);
    classifier = module.get(IntentClassifierService);
    dispatcher = module.get(FlowDispatcher) as RecordingFlowDispatcher;
    await classifier.initialize();

    // approver 999 on both allowlists
    await db.insertInto('setting').values({ key: 'telegram_allowlist', value: '999', updated_at: 0 }).execute();
    await db.insertInto('setting').values({ key: 'approvers', value: '999', updated_at: 0 }).execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('resolves a Conversation and persists the inbound message', async () => {
    jest.spyOn(classifier, 'classify').mockResolvedValue({ kind: 'advisory' });
    const outcome = await router.handle(envelope({}));
    expect(outcome.conversation_id).toBeGreaterThan(0);
    const convo = await db
      .selectFrom('conversation')
      .selectAll()
      .where('thread_key', '=', 'tg:999')
      .executeTakeFirstOrThrow();
    expect(convo.channel).toBe('telegram');
    const msgs = await db.selectFrom('message').selectAll().where('conversation_id', '=', convo.id).execute();
    expect(msgs.some((m) => m.direction === 'inbound' && m.body === 'hello')).toBe(true);
  });

  it('dispatches a non-clarify intent to the FlowDispatcher', async () => {
    jest.spyOn(classifier, 'classify').mockResolvedValue({
      kind: 'action',
      actionIntent: 'create_sales_invoice',
      fields: {},
    });
    const outcome = await router.handle(envelope({}));
    expect(outcome.dispatched).toBe(true);
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0].intent).toEqual({
      kind: 'action',
      actionIntent: 'create_sales_invoice',
      fields: {},
    });
  });

  it('sends a clarify question over the transport and does NOT dispatch', async () => {
    jest
      .spyOn(classifier, 'classify')
      .mockResolvedValue({ kind: 'clarify', question: 'Which customer?' });
    const outcome = await router.handle(envelope({}));
    expect(outcome.dispatched).toBe(false);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].text).toBe('Which customer?');
    // the clarify is also persisted as an outbound Message
    const msgs = await db.selectFrom('message').selectAll().where('conversation_id', '=', outcome.conversation_id).execute();
    expect(msgs.some((m) => m.direction === 'outbound' && m.body === 'Which customer?')).toBe(true);
  });

  it('ignores (no classify, no dispatch) a non-approver message', async () => {
    const spy = jest.spyOn(classifier, 'classify');
    const outcome = await router.handle(
      envelope({ sender: '123', convKey: 'tg:123', auth: { senderId: '123', transportVerified: true } }),
    );
    expect(outcome.gated_in).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(dispatcher.calls).toHaveLength(0);
  });

  it('treats a button tap (callbackData) as a deterministic action — no classifier call', async () => {
    const spy = jest.spyOn(classifier, 'classify');
    const outcome = await router.handle(
      envelope({ message: null, metadata: { callbackData: 'approve:42' } }),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0].intent).toEqual({
      kind: 'action',
      actionIntent: 'approve',
      fields: { ref: '42' },
    });
  });

  it('ingests an attachment through DocumentsService and binds it to the Conversation', async () => {
    jest.spyOn(classifier, 'classify').mockResolvedValue({ kind: 'advisory' });
    const outcome = await router.handle(
      envelope({
        message: null,
        attachments: [
          { buffer: Buffer.from('PDFBYTES'), filename: 'r.pdf', mimeType: 'application/pdf' },
        ],
      }),
    );
    expect(outcome.ingested).toBe(1);
    const arts = await db.selectFrom('artifact').selectAll().where('conversation_id', '=', outcome.conversation_id).execute();
    expect(arts.some((a) => a.kind === 'inbound_attachment' && a.document_id !== null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 24 && npx jest src/interaction/router/interaction-router.service.spec.ts`
Expected: FAIL — `Cannot find module './interaction-router.service'`.

- [ ] **Step 3: Write minimal implementation**

> A button tap maps deterministically: `callbackData = "<actionIntent>:<ref>"` → `{ kind:'action', actionIntent, fields: { ref } }`. Only the four `ActionIntent` values are honored; anything else degrades to a clarify.

```typescript
// src/interaction/router/interaction-router.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConversationsService } from '../../conversations/conversations.service';
import { DocumentsService } from '../../documents/documents.service';
import { InteractionConfigService } from '../config/interaction-config.service';
import { PrincipalResolverService } from '../principal/principal-resolver.service';
import {
  canConverse,
  ingestDecision,
} from '../principal/interaction-gate';
import { IntentClassifierService } from './intent-classifier.service';
import { FlowDispatcher } from './flow-dispatcher';
import { TransportRegistryService } from '../transport/transport-registry.service';
import { UnifiedEnvelope } from '../envelope/types';
import { ActionIntent, RoutedIntent, RouterOutcome } from './types';

const ACTION_INTENTS: ReadonlySet<string> = new Set([
  'create_sales_invoice',
  'approve',
  'reject',
  'correct',
]);

@Injectable()
export class InteractionRouterService {
  private readonly logger = new Logger(InteractionRouterService.name);

  constructor(
    private readonly conversations: ConversationsService,
    private readonly documents: DocumentsService,
    private readonly config: InteractionConfigService,
    private readonly principals: PrincipalResolverService,
    private readonly classifier: IntentClassifierService,
    private readonly dispatcher: FlowDispatcher,
    private readonly transports: TransportRegistryService,
  ) {}

  async handle(envelope: UnifiedEnvelope): Promise<RouterOutcome> {
    // 1. Deterministic Conversation resolution (by channel + thread key).
    const conversation = await this.conversations.resolve({
      channel: envelope.channel,
      thread_key: envelope.convKey,
    });

    // 2. Persist the inbound turn (text or a button-tap marker).
    await this.conversations.appendMessage({
      conversation_id: conversation.id,
      direction: 'inbound',
      sender: envelope.sender,
      body: envelope.message ?? `[callback:${envelope.metadata.callbackData ?? ''}]`,
    });

    // 3. Resolve the Principal once, in the core.
    const principal = await this.principals.resolve(envelope);

    // 4. Ingest track (independent of conversing).
    let ingested = 0;
    if (envelope.attachments.length > 0) {
      const policy = await this.config.getIngestPolicy();
      const decision = ingestDecision(principal, policy);
      if (decision === 'accept') {
        for (const att of envelope.attachments) {
          const { document } = await this.documents.upload({
            buffer: att.buffer,
            filename: att.filename,
            mimeType: att.mimeType,
            channel: envelope.channel === 'api' ? 'upload' : envelope.channel,
          });
          await this.conversations.attachArtifact({
            conversation_id: conversation.id,
            kind: 'inbound_attachment',
            storage_path: document.storage_path,
            document_id: document.id,
          });
          await this.conversations.associateDocument({
            conversation_id: conversation.id,
            document_id: document.id,
          });
          ingested += 1;
        }
      } else {
        this.logger.log(`ingest ${decision} for ${principal.role} sender`);
      }
    }

    // 5. Deterministic button tap → pre-classified action (no LLM).
    const callbackData = envelope.metadata.callbackData;
    if (callbackData) {
      const intent = this.intentFromCallback(callbackData);
      const dispatched = await this.dispatch(intent, conversation.id, envelope);
      return { conversation_id: conversation.id, gated_in: true, ingested, intent, dispatched };
    }

    // 6. No message, or sender may not converse → stop after ingest.
    if (!envelope.message || !canConverse(principal)) {
      return {
        conversation_id: conversation.id,
        gated_in: canConverse(principal),
        ingested,
        intent: null,
        dispatched: false,
      };
    }

    // 7. Classify, then clarify-or-dispatch.
    const intent = await this.classifier.classify(envelope.message);
    const dispatched = await this.dispatch(intent, conversation.id, envelope);
    return { conversation_id: conversation.id, gated_in: true, ingested, intent, dispatched };
  }

  private intentFromCallback(callbackData: string): RoutedIntent {
    const [head, ref] = callbackData.split(':');
    if (ACTION_INTENTS.has(head)) {
      return { kind: 'action', actionIntent: head as ActionIntent, fields: { ref: ref ?? '' } };
    }
    return { kind: 'clarify', question: 'That button is no longer valid.' };
  }

  /** Returns true when a flow handled it; a clarify is sent over the transport instead. */
  private async dispatch(
    intent: RoutedIntent,
    conversationId: number,
    envelope: UnifiedEnvelope,
  ): Promise<boolean> {
    if (intent.kind === 'clarify') {
      await this.sendOutbound(envelope, conversationId, intent.question);
      return false;
    }
    const result = await this.dispatcher.dispatch(intent, { conversation_id: conversationId });
    if (result.reply) {
      await this.sendOutbound(envelope, conversationId, result.reply);
    }
    return true;
  }

  private async sendOutbound(
    envelope: UnifiedEnvelope,
    conversationId: number,
    text: string,
  ): Promise<void> {
    await this.transports.send({
      channel: envelope.channel,
      convKey: envelope.convKey,
      text,
    });
    await this.conversations.appendMessage({
      conversation_id: conversationId,
      direction: 'outbound',
      sender: 'system',
      body: text,
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use 24 && npx jest src/interaction/router/interaction-router.service.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/interaction/router/interaction-router.service.ts src/interaction/router/interaction-router.service.spec.ts
git commit -m "feat(interaction): InteractionRouter orchestrator (resolve→gate→ingest→classify→dispatch/clarify)"
```

---

## Task 9: Telegram mapper (pure)

**Files:**
- Create: `src/interaction/channels/telegram/telegram.types.ts`
- Create: `src/interaction/channels/telegram/telegram-mapper.ts`
- Test: `src/interaction/channels/telegram/telegram-mapper.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/interaction/channels/telegram/telegram-mapper.spec.ts
import { toEnvelope, toSendPayload } from './telegram-mapper';
import { TelegramUpdate } from './telegram.types';

const textUpdate: TelegramUpdate = {
  update_id: 1,
  message: { message_id: 5, chat: { id: 999 }, from: { id: 999 }, text: 'invoice acme' },
};

const callbackUpdate: TelegramUpdate = {
  update_id: 2,
  callback_query: { id: 'c1', from: { id: 999 }, message: { chat: { id: 999 } }, data: 'approve:42' },
};

describe('telegram-mapper', () => {
  it('maps a text message to a verified envelope (transportVerified set by caller=true)', () => {
    const env = toEnvelope(textUpdate, true);
    expect(env.channel).toBe('telegram');
    expect(env.convKey).toBe('tg:999');
    expect(env.message).toBe('invoice acme');
    expect(env.auth).toEqual({ senderId: '999', transportVerified: true });
    expect(env.metadata.callbackData).toBeUndefined();
  });

  it('maps a button tap to a message-less envelope carrying callbackData', () => {
    const env = toEnvelope(callbackUpdate, true);
    expect(env.message).toBeNull();
    expect(env.convKey).toBe('tg:999');
    expect(env.metadata.callbackData).toBe('approve:42');
  });

  it('renders an outbound message to a sendMessage payload', () => {
    const payload = toSendPayload({ channel: 'telegram', convKey: 'tg:999', text: 'Which customer?' });
    expect(payload).toEqual({ chat_id: 999, text: 'Which customer?' });
  });

  it('renders an action point as an inline keyboard button', () => {
    const payload = toSendPayload({
      channel: 'telegram',
      convKey: 'tg:999',
      text: 'Approve this?',
      actionPoint: { id: 'approve:42', label: 'Approve' },
    });
    expect(payload.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Approve', callback_data: 'approve:42' }]],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 24 && npx jest src/interaction/channels/telegram/telegram-mapper.spec.ts`
Expected: FAIL — `Cannot find module './telegram-mapper'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/interaction/channels/telegram/telegram.types.ts
export interface TelegramChat {
  id: number;
}
export interface TelegramUser {
  id: number;
}
export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: { chat: TelegramChat };
  data?: string;
}
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramSendPayload {
  chat_id: number;
  text: string;
  reply_markup?: {
    inline_keyboard: { text: string; callback_data: string }[][];
  };
}
```

```typescript
// src/interaction/channels/telegram/telegram-mapper.ts
import { UnifiedEnvelope } from '../../envelope/types';
import { OutboundMessage } from '../../transport/types';
import { TelegramSendPayload, TelegramUpdate } from './telegram.types';

/** Pure: a Telegram Update → the channel-agnostic envelope. `transportVerified`
 * is decided by the webhook controller (secret-token check) and passed in. */
export function toEnvelope(
  update: TelegramUpdate,
  transportVerified: boolean,
): UnifiedEnvelope {
  if (update.callback_query) {
    const chatId = update.callback_query.message?.chat.id ?? update.callback_query.from.id;
    const senderId = String(update.callback_query.from.id);
    const metadata: Record<string, string> = {};
    if (update.callback_query.data) metadata.callbackData = update.callback_query.data;
    return {
      channel: 'telegram',
      sender: senderId,
      convKey: `tg:${chatId}`,
      message: null,
      attachments: [],
      metadata,
      auth: { senderId, transportVerified },
    };
  }
  const msg = update.message;
  const chatId = msg?.chat.id ?? 0;
  const senderId = String(msg?.from?.id ?? chatId);
  return {
    channel: 'telegram',
    sender: senderId,
    convKey: `tg:${chatId}`,
    message: msg?.text ?? null,
    attachments: [],
    metadata: {},
    auth: { senderId, transportVerified },
  };
}

/** Pure: an abstract outbound message → the Telegram sendMessage body. */
export function toSendPayload(out: OutboundMessage): TelegramSendPayload {
  const chatId = Number(out.convKey.replace(/^tg:/, ''));
  const payload: TelegramSendPayload = { chat_id: chatId, text: out.text };
  if (out.actionPoint) {
    payload.reply_markup = {
      inline_keyboard: [
        [{ text: out.actionPoint.label, callback_data: out.actionPoint.id }],
      ],
    };
  }
  return payload;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use 24 && npx jest src/interaction/channels/telegram/telegram-mapper.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/interaction/channels/telegram/telegram.types.ts src/interaction/channels/telegram/telegram-mapper.ts src/interaction/channels/telegram/telegram-mapper.spec.ts
git commit -m "feat(interaction): pure Telegram mapper (update↔envelope, outbound→sendMessage)"
```

---

## Task 10: Telegram transport (port impl over a mockable Bot API)

**Files:**
- Create: `src/interaction/channels/telegram/telegram-api.port.ts`
- Create: `src/interaction/channels/telegram/telegram-transport.service.ts`
- Test: `src/interaction/channels/telegram/telegram-transport.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/interaction/channels/telegram/telegram-transport.service.spec.ts
import { TelegramApi } from './telegram-api.port';
import { TelegramTransportService } from './telegram-transport.service';
import { TelegramSendPayload } from './telegram.types';

class FakeTelegramApi implements TelegramApi {
  readonly calls: TelegramSendPayload[] = [];
  sendMessage(payload: TelegramSendPayload): Promise<void> {
    this.calls.push(payload);
    return Promise.resolve();
  }
}

describe('TelegramTransportService', () => {
  it('renders an outbound message and calls the Bot API port', async () => {
    const api = new FakeTelegramApi();
    const transport = new TelegramTransportService(api);
    expect(transport.channel).toBe('telegram');
    await transport.send({ channel: 'telegram', convKey: 'tg:999', text: 'hi' });
    expect(api.calls).toEqual([{ chat_id: 999, text: 'hi' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 24 && npx jest src/interaction/channels/telegram/telegram-transport.service.spec.ts`
Expected: FAIL — `Cannot find module './telegram-api.port'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/interaction/channels/telegram/telegram-api.port.ts
import { Injectable, Logger } from '@nestjs/common';
import { TelegramSendPayload } from './telegram.types';

/** The live Bot API edge. Mocked in every test; only the real impl does network I/O. */
export abstract class TelegramApi {
  abstract sendMessage(payload: TelegramSendPayload): Promise<void>;
}

/** Real implementation — uses global fetch (Node 24). Not exercised in unit tests. */
@Injectable()
export class HttpTelegramApi extends TelegramApi {
  private readonly logger = new Logger(HttpTelegramApi.name);

  constructor(private readonly botTokenProvider: () => Promise<string | null>) {
    super();
  }

  async sendMessage(payload: TelegramSendPayload): Promise<void> {
    const token = await this.botTokenProvider();
    if (!token) {
      this.logger.warn('telegram_bot_token unset — dropping outbound message');
      return;
    }
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
}
```

```typescript
// src/interaction/channels/telegram/telegram-transport.service.ts
import { Injectable } from '@nestjs/common';
import { InteractionChannel } from '../../envelope/types';
import { InteractionTransport, OutboundMessage } from '../../transport/types';
import { TelegramApi } from './telegram-api.port';
import { toSendPayload } from './telegram-mapper';

@Injectable()
export class TelegramTransportService implements InteractionTransport {
  readonly channel: InteractionChannel = 'telegram';

  constructor(private readonly api: TelegramApi) {}

  async send(out: OutboundMessage): Promise<void> {
    await this.api.sendMessage(toSendPayload(out));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use 24 && npx jest src/interaction/channels/telegram/telegram-transport.service.spec.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/interaction/channels/telegram/telegram-api.port.ts src/interaction/channels/telegram/telegram-transport.service.ts src/interaction/channels/telegram/telegram-transport.service.spec.ts
git commit -m "feat(interaction): Telegram transport over a mockable Bot API port"
```

---

## Task 11: Telegram webhook controller + module wiring

**Files:**
- Create: `src/interaction/channels/telegram/telegram-webhook.controller.ts`
- Create: `src/interaction/interaction.module.ts`
- Modify: `src/app.module.ts` (register `InteractionModule`)
- Test: `src/interaction/channels/telegram/telegram-webhook.controller.spec.ts`

- [ ] **Step 1: Write the failing test** (real DI; mocked `TelegramApi`; assert secret-token gating + routing)

```typescript
// src/interaction/channels/telegram/telegram-webhook.controller.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../../../database/types';
import { migrations } from '../../../database/migrations';
import { ConversationsService } from '../../../conversations/conversations.service';
import { DocumentsService } from '../../../documents/documents.service';
import { InteractionConfigService } from '../../config/interaction-config.service';
import { PrincipalResolverService } from '../../principal/principal-resolver.service';
import { IntentClassifierService } from '../../router/intent-classifier.service';
import { FlowDispatcher, RecordingFlowDispatcher } from '../../router/flow-dispatcher';
import { TransportRegistryService, INTERACTION_TRANSPORTS } from '../../transport/transport-registry.service';
import { InteractionRouterService } from '../../router/interaction-router.service';
import { TelegramTransportService } from './telegram-transport.service';
import { TelegramApi } from './telegram-api.port';
import { TelegramWebhookController } from './telegram-webhook.controller';

class FakeTelegramApi implements TelegramApi {
  sendMessage(): Promise<void> { return Promise.resolve(); }
}

describe('TelegramWebhookController (integration)', () => {
  let db: Kysely<Database>;
  let controller: TelegramWebhookController;
  let classifier: IntentClassifierService;

  beforeEach(async () => {
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }) });
    const migrator = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error instanceof Error ? error : new Error('migrate failed');

    const api = new FakeTelegramApi();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TelegramWebhookController],
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        ConversationsService,
        DocumentsService,
        InteractionConfigService,
        PrincipalResolverService,
        IntentClassifierService,
        { provide: FlowDispatcher, useClass: RecordingFlowDispatcher },
        { provide: TelegramApi, useValue: api },
        TelegramTransportService,
        { provide: INTERACTION_TRANSPORTS, useFactory: (t: TelegramTransportService) => [t], inject: [TelegramTransportService] },
        TransportRegistryService,
        InteractionRouterService,
      ],
    }).compile();

    controller = module.get(TelegramWebhookController);
    classifier = module.get(IntentClassifierService);
    await classifier.initialize();
    jest.spyOn(classifier, 'classify').mockResolvedValue({ kind: 'advisory' });

    await db.insertInto('setting').values({ key: 'telegram_webhook_secret', value: 'sek', updated_at: 0 }).execute();
    await db.insertInto('setting').values({ key: 'telegram_allowlist', value: '999', updated_at: 0 }).execute();
    await db.insertInto('setting').values({ key: 'approvers', value: '999', updated_at: 0 }).execute();
  });

  afterEach(async () => { await db.destroy(); });

  const update = { update_id: 1, message: { message_id: 5, chat: { id: 999 }, from: { id: 999 }, text: 'hi' } };

  it('rejects a webhook with a wrong secret token', async () => {
    await expect(controller.handle('nope', update)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accepts a correct secret token and routes to a persisted Conversation', async () => {
    const res = await controller.handle('sek', update);
    expect(res).toEqual({ ok: true });
    const convo = await db.selectFrom('conversation').selectAll().where('thread_key', '=', 'tg:999').executeTakeFirst();
    expect(convo).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 24 && npx jest src/interaction/channels/telegram/telegram-webhook.controller.spec.ts`
Expected: FAIL — `Cannot find module './telegram-webhook.controller'`.

- [ ] **Step 3: Write the controller**

```typescript
// src/interaction/channels/telegram/telegram-webhook.controller.ts
import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { Public } from '../../../auth/api-token.guard';
import { InteractionConfigService } from '../../config/interaction-config.service';
import { InteractionRouterService } from '../../router/interaction-router.service';
import { toEnvelope } from './telegram-mapper';
import { TelegramUpdate } from './telegram.types';

@Controller('api/channels/telegram')
export class TelegramWebhookController {
  constructor(
    private readonly config: InteractionConfigService,
    private readonly router: InteractionRouterService,
  ) {}

  // Telegram has no bearer token; it authenticates via the secret-token header.
  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handle(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: TelegramUpdate,
  ): Promise<{ ok: true }> {
    const expected = await this.config.getTelegramWebhookSecret();
    const verified = !!expected && secret === expected;
    if (!verified) {
      throw new ForbiddenException('invalid telegram secret token');
    }
    const envelope = toEnvelope(update, verified);
    await this.router.handle(envelope);
    return { ok: true };
  }
}
```

- [ ] **Step 4: Run the controller test to verify it passes**

Run: `nvm use 24 && npx jest src/interaction/channels/telegram/telegram-webhook.controller.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the module + register it**

```typescript
// src/interaction/interaction.module.ts
import { Module } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DatabaseModule } from '../database/database.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { DocumentsModule } from '../documents/documents.module';
import { Database } from '../database/types';
import { InteractionConfigService } from './config/interaction-config.service';
import { PrincipalResolverService } from './principal/principal-resolver.service';
import { IntentClassifierService } from './router/intent-classifier.service';
import { FlowDispatcher, RecordingFlowDispatcher } from './router/flow-dispatcher';
import { InteractionRouterService } from './router/interaction-router.service';
import {
  TransportRegistryService,
  INTERACTION_TRANSPORTS,
} from './transport/transport-registry.service';
import { TelegramTransportService } from './channels/telegram/telegram-transport.service';
import { TelegramApi, HttpTelegramApi } from './channels/telegram/telegram-api.port';
import { TelegramWebhookController } from './channels/telegram/telegram-webhook.controller';

@Module({
  imports: [DatabaseModule, ConversationsModule, DocumentsModule],
  controllers: [TelegramWebhookController],
  providers: [
    InteractionConfigService,
    PrincipalResolverService,
    IntentClassifierService,
    InteractionRouterService,
    TransportRegistryService,
    // 8a: the FlowDispatcher seam is stubbed; 8b binds the real flows here.
    { provide: FlowDispatcher, useClass: RecordingFlowDispatcher },
    // Live Bot API edge — reads the bot token lazily from settings.
    {
      provide: TelegramApi,
      useFactory: (db: Kysely<Database>) =>
        new HttpTelegramApi(async () => {
          const row = await db
            .selectFrom('setting')
            .select('value')
            .where('key', '=', 'telegram_bot_token')
            .executeTakeFirst();
          return row?.value ?? null;
        }),
      inject: [InjectKysely() as unknown as symbol],
    },
    TelegramTransportService,
    {
      provide: INTERACTION_TRANSPORTS,
      useFactory: (t: TelegramTransportService) => [t],
      inject: [TelegramTransportService],
    },
  ],
})
export class InteractionModule {
  // IntentClassifierService must be initialized at boot; do it in onModuleInit.
  constructor(private readonly classifier: IntentClassifierService) {}
  async onModuleInit(): Promise<void> {
    await this.classifier.initialize();
  }
}
```

> **Note on the `TelegramApi` factory `inject`:** match the existing `InjectKysely()` token convention used elsewhere (see `src/ai/ai.module.ts` / `src/conversations/conversations.module.ts` for the exact provider-injection form in this repo). If the repo injects Kysely via `KYSELY_MODULE_CONNECTION_TOKEN()`, use `inject: [KYSELY_MODULE_CONNECTION_TOKEN()]` and import that instead — copy whichever the neighboring modules use verbatim.

- [ ] **Step 6: Register the module in the app**

```typescript
// src/app.module.ts — add InteractionModule to the imports array
import { InteractionModule } from './interaction/interaction.module';
// ...
@Module({
  imports: [
    // ...existing modules...
    InteractionModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 7: Run the full unit suite to verify wiring**

Run: `nvm use 24 && npm run build && npm run lint && npm test`
Expected: build PASS, lint PASS, all suites PASS (existing 636 + the new interaction suites).

- [ ] **Step 8: Commit**

```bash
git add src/interaction/channels/telegram/telegram-webhook.controller.ts src/interaction/channels/telegram/telegram-webhook.controller.spec.ts src/interaction/interaction.module.ts src/app.module.ts
git commit -m "feat(interaction): @Public Telegram webhook (secret-token gate) + InteractionModule wiring"
```

---

## Task 12: End-to-end webhook flow + wave gate

**Files:**
- Create: `test/interaction.e2e-spec.ts`

- [ ] **Step 1: Write the e2e test** (boot the real Nest app; `@mastra/*` is stubbed via `test/jest-e2e.json` moduleNameMapper; seed settings; POST the webhook; assert Conversation + outbound recorded). Copy the app-bootstrap + auth-token helpers from `test/intake.e2e-spec.ts` and `test/e2e-auth.ts`.

```typescript
// test/interaction.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Kysely } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { AppModule } from '../src/app.module';
import { Database } from '../src/database/types';

describe('Telegram webhook (e2e)', () => {
  let app: INestApplication;
  let db: Kysely<Database>;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    db = app.get<Kysely<Database>>(KYSELY_MODULE_CONNECTION_TOKEN());
    await db.insertInto('setting').values({ key: 'telegram_webhook_secret', value: 'sek', updated_at: 0 }).execute();
    await db.insertInto('setting').values({ key: 'telegram_allowlist', value: '999', updated_at: 0 }).execute();
    await db.insertInto('setting').values({ key: 'approvers', value: '999', updated_at: 0 }).execute();
  });

  afterAll(async () => {
    await app.close();
  });

  const update = { update_id: 1, message: { message_id: 5, chat: { id: 999 }, from: { id: 999 }, text: 'what is my VAT due?' } };

  it('403s a webhook with a wrong secret token', async () => {
    await request(app.getHttpServer())
      .post('/api/channels/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'wrong')
      .send(update)
      .expect(403);
  });

  it('accepts a valid webhook and creates an open Conversation', async () => {
    await request(app.getHttpServer())
      .post('/api/channels/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'sek')
      .send(update)
      .expect(200)
      .expect({ ok: true });

    const convo = await db
      .selectFrom('conversation')
      .selectAll()
      .where('thread_key', '=', 'tg:999')
      .executeTakeFirstOrThrow();
    expect(convo.status).toBe('open');
    expect(convo.channel).toBe('telegram');
  });
});
```

> The advisory path calls the real (stubbed) Mastra agent — in e2e the stub's `generate` returns `{ object: undefined }`, which `safeParse` rejects → the classifier degrades to `clarify`, the router sends an outbound clarify via the (real) `HttpTelegramApi` whose token is unset → it logs-and-drops (no network). The webhook still returns `{ ok: true }`. The test asserts only the Conversation, so it is deterministic without a live Bot API.

- [ ] **Step 2: Run the e2e test to verify it passes**

Run: `nvm use 24 && npx jest --config test/jest-e2e.json test/interaction.e2e-spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Run the FULL wave gate**

Run: `nvm use 24 && npm run build && npm run lint && npm run test && npm run test:e2e`
Expected: all green — build exit 0, lint exit 0, unit (636 + new) PASS, e2e (31 + new) PASS.

- [ ] **Step 4: Run the G4 + G6 grep gates (must be empty)**

```bash
grep -rn "createTable\|CREATE TABLE" src --include=*.ts | grep -v "src/database/migrations/"
grep -rn "telegram\|Telegram" src/interaction/envelope src/interaction/principal src/interaction/router src/interaction/transport --include=*.ts
```
Expected: both produce **no output**.

- [ ] **Step 5: Commit**

```bash
git add test/interaction.e2e-spec.ts
git commit -m "test(interaction): e2e Telegram webhook → Conversation; full 8a gate green"
```

---

## Task 13: Update the wave-8 stub status

**Files:**
- Modify: `.omo/plans/wave-8-interaction.md`

- [ ] **Step 1: Mark 8a complete in the stub**

Change the STATUS line to note 8a is implemented and gated green, and that 8b (flows) is the next grill. Add a one-line pointer to this plan.

- [ ] **Step 2: Commit**

```bash
git add .omo/plans/wave-8-interaction.md
git commit -m "plan: mark Wave 8a core complete; 8b (flows) is next"
```

---

## Self-Review (author checklist — completed)

**1. Spec coverage** (against ADR-0025 + the wave-8 stub 8a decisions):
- Channel-adapter boundary (mapper + transport port) → Tasks 9, 10, 11. ✅
- Unified envelope → Task 2. ✅
- Router (resolve → RoutedIntent classify → FlowDispatcher port; clarify branch) → Tasks 4, 5, 6, 8. ✅
- Channel-agnostic Principal + per-track gating → Tasks 2, 3. ✅
- Telegram concrete adapter (mapper, transport, webhook, secret-token) → Tasks 9–11. ✅
- Config reads (allowlists, ingest_policy, secret) → Task 1. ✅
- Deterministic button tap (callback_data) as action-point → Task 8. ✅
- e2e + gate → Task 12. ✅
- **Deferred (explicitly out of 8a):** real flows (8b `FlowDispatcher`), email/Slack/Drive adapters + email confirmation-loop + `known_counterparty` resolution + SecretaryAgent (8c), Telegram **attachment** ingest download (the ingest *track* is built + tested via a synthetic envelope in Task 8; Telegram file-download lands with a later adapter pass). These are named so the cut is explicit, not silently dropped.

**2. Placeholder scan:** no TBD/TODO; every code step shows full code. One callout in Task 11 Step 5 flags the repo's Kysely-injection token form to copy verbatim — that is a real existing-pattern reference, not a placeholder.

**3. Type consistency:** `UnifiedEnvelope`/`EnvelopeAuth`/`Principal`/`RoutedIntent`/`OutboundMessage`/`InteractionTransport`/`TelegramUpdate`/`TelegramSendPayload` names and fields are identical across Tasks 2–12. `convKey` ↔ `thread_key` mapping is consistent (`tg:<chatId>`). `FlowDispatcher` abstract + `RecordingFlowDispatcher` binding consistent across Tasks 6, 8, 11.

---

## Execution Handoff

Wave 8a is 13 tasks, each red→green→commit, gated under Node 24. Recommended execution: **subagent-driven** (fresh subagent per task, review between). Tasks 1–7 are independent leaves; Task 8 depends on 1–7; Tasks 9–11 depend on 2/4/7; Task 12 depends on 11.
