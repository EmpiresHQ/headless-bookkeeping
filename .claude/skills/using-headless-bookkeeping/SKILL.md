---
name: using-headless-bookkeeping
description: >-
  Use when operating the headless-bookkeeping system as a REMOTE HTTP API CLIENT — the agent never
  touches code or the database, only calls the running instance over REST. Covers auth (Bearer token),
  standard bookkeeping ops (add supplier/entity, enter expense, issue sales invoice, upload documents,
  approvals/HITL, VAT report, lock period, read the books), what is NOT reachable over API, and the
  domain model needed to drive it safely (double-entry ledger, posting pipeline AI→Rules→Policy→Voucher,
  period lock, no break-glass). Triggers: "как агенту провести документ", "как внести расход/инвойс",
  "как добавить поставщика", "как подбить ВАТ-отчёт", "remote API", bookkeeping kernel, voucher, approval.
---

# Using headless-bookkeeping

## Что это

**headless-bookkeeping** — AI-native, self-hosted бухгалтерское ядро для консультантов, фрилансеров и микро-SMB. Запускается на «$5 VPS»: один Docker-контейнер, один файл SQLite, без Postgres/Redis/Kafka/Kubernetes.

Два ключевых свойства:

- **Headless** — нет большого бухгалтерского UI. Взаимодействие идёт через каналы (Telegram, email, Slack, REST API) и инструменты агентов. Есть только защищённый `/admin` для диагностики/интеграций.
- **Agent-facing** — система спроектирована вокруг AI с самого начала (OCR, триаж, классификация, реконсиляция), **но AI всегда совещательный**. Книги ведёт детерминированное, валидируемое, защищённое от подделки ядро. Робот **никогда не пишет в книги напрямую**.

**Главный инвариант, который ты обязан уважать:**

```
AI предлагает  →  Rules валидируют  →  Policy решает  →  Voucher постится
 (fallible)        (нерушимые)         (настраиваемо)     (неизменяемый,
  OCR/триаж,        структура+              auto-post        сбалансированный,
  категория,        период-lock+            или hold-          hash-chained)
  уверенность       семантика               for-approval
```

AI не имеет инструментов `forcePost()` / `bypassApproval()` / прямой записи в `voucher`. Любой путь постинга проходит Rules → Policy → детерминированный сбалансированный неизменяемый Voucher.

## ⛔ Режим работы: только удалённый HTTP API

**Это рабочий контракт. Система крутится удалённо. Ты НЕ:**
- ❌ читаешь/правишь исходный код, не делаешь миграции, не запускаешь и не собираешь приложение;
- ❌ подключаешься к SQLite / пишешь в таблицы напрямую (`setting`, `voucher`, `api_token`, …).

**Ты ТОЛЬКО** делаешь HTTP-вызовы к запущенному инстансу: `Authorization: Bearer <token>`, бизнес-роуты под `/api/...`, диагностика под `/admin/...`. Главный раздел для тебя — **«Стандартные бухгалтерские операции (рецепты, проверено по API)»** ниже.

Архитектура, доменная модель, карта `src/` и пути к файлам в этом документе — **только чтобы понимать поведение системы, которой ты управляешь**. Это не значит, что их можно открывать или менять. Установка/запуск/настройки/токены — **операторская/деплой-зона**; если чего-то нет по API, ты это не делаешь, а запрашиваешь у оператора.

## Когда использовать этот навык

- Онбординг: «объясни, как устроена система», «с чего начать».
- Запуск/тесты: install, dev/prod/docker, unit/e2e.
- Настройка: сменить модель или промпт у AI-агента, понять иерархию конфигов.
- Рантайм: «как провести документ», «как создаётся черновик», «как работает аппрув», «как добавить канал».
- Перед любым изменением ledger/posting/rules/policy — свериться с инвариантами ниже.

## Tech stack

| Слой | Технология |
|------|-----------|
| Framework | NestJS 11 (TypeScript, Node ≥ 24) |
| БД (system of record) | SQLite через `better-sqlite3` (один файл) |
| Query builder / миграции | Kysely + `nestjs-kysely` (type-safe SQL) |
| Валидация | Zod 4 (глобальный pipe) |
| AI-оркестрация | Mastra (`@mastra/core` 1.41) — в процессе, ledger остаётся SoR |
| Расписания | `@nestjs/schedule` (cron-агенты) |
| Тесты | Jest 30 (unit + e2e); `@mastra/core` застаблен в тестах |
| Деплой | Docker Compose (multi-stage) |

> В юнит-тестах Mastra подменяется стабом `test/mastra-stub.ts` (см. `jest.moduleNameMapper` в `package.json`). Настоящих LLM-вызовов в тестах нет.

---

## Онбординг: установка и запуск (операторская зона — НЕ для агента)

> Этот раздел — для оператора, который разворачивает инстанс. Агент в remote-API-режиме сюда не лезет (не ставит, не запускает, не мигрирует). Оставлено для понимания, как появляется тот инстанс, к которому ты обращаешься по API.

### Предусловия
- **Node 24+** (`.nvmrc` = `24`; `engines.node` = `>=24`). На Node 22 `better-sqlite3` падает с `NODE_MODULE_VERSION` mismatch.
- **npm** (есть `package-lock.json`, Docker использует `npm ci`).
- Для сборки `better-sqlite3`: Python 3, make, g++ (в Docker ставятся через `apk add python3 make g++`).

### Установка и запуск
```bash
nvm use 24            # или nvm install 24
npm ci                # установка зависимостей
npm run start:dev     # dev с hot-reload на http://localhost:3000
curl http://localhost:3000/health   # проверка
```

Production / Docker:
```bash
npm run build && npm run start          # сборка в dist/ и запуск
# либо контейнер:
docker compose up -d                    # build + run, том ./data, healthcheck на /health
docker compose logs -f app
```

### Конфигурация при первом запуске
- **Отдельного `.env` нет.** Из окружения читаются только `PORT` (по умолчанию 3000) и `NODE_ENV`. Вся бизнес-конфигурация живёт в БД (таблицы `organization` и `setting`).
- **Миграции (30 шт., `src/database/migrations/`) запускаются автоматически** при старте в `DatabaseModule.onModuleInit()` (Kysely `Migrator.migrateToLatest()`). Идемпотентны.
- Сид при первом запуске: одна `organization` (Ireland/`IE`, не VAT-registered, base currency наследуется от плагина → EUR) и базовый chart of accounts. **CLI-сидера нет** — остальные данные вводятся через API.

### Тесты, линт, сборка
```bash
npm test            # unit (~686 тестов); npm run test:watch / test:cov
npm run test:e2e    # e2e (8 файлов, 33 теста; test/jest-e2e.json)
npm run lint        # eslint --fix
npm run format      # prettier
npm run build       # nest build → dist/
```

> SQLite синхронный: останови `start:dev` перед запуском тестов, иначе возможен «database is locked».

---

## Конфигурация AI-агентов (AgentConfigService)

Три уровня, мутабельны в рантайме (без редеплоя):

1. **Окружение** — `PORT`, `NODE_ENV` (только инфраструктура).
2. **БД-настройки** (`setting` table, key/value) — модели и промпты агентов, токены каналов, политики.
3. **Один захардкоженный дефолт** — `DEFAULT_MODEL = 'openai/gpt-4o-mini'` в `src/ai/agent-config.ts`. Это **единственный** литерал модели во всём коде.

### Иерархия резолва (`src/ai/agent-config.service.ts`)

```
Модель:  ai_model.<agent>  →  ai_model  →  DEFAULT_MODEL
Промпт:  prompt.<agent>    →  AGENT_PROMPTS[<agent>]  (дефолт в коде)
```

API сервиса:
```ts
resolveModel(key): Promise<string>
resolveInstructions(key): Promise<string>
resolve(key): Promise<{ model, instructions }>   // оба параллельно
```

**Известные ключи агентов** (`AgentKey = 'triage' | 'intent_classifier'`):

| Setting key | Значение | Назначение | Дефолт |
|---|---|---|---|
| `ai_model` | строка модели | глобальная модель для всех агентов | `DEFAULT_MODEL` |
| `ai_model.triage` | строка модели | модель Pass-2 триаж-агента | `ai_model` / `DEFAULT_MODEL` |
| `ai_model.intent_classifier` | строка модели | модель классификатора интентов | `ai_model` / `DEFAULT_MODEL` |
| `prompt.triage` | текст | системный промпт триаж-агента | `AGENT_PROMPTS.triage` |
| `prompt.intent_classifier` | текст | системный промпт классификатора | `AGENT_PROMPTS.intent_classifier` |

Прочие ключи: `telegram_bot_token`, `telegram_webhook_secret`, `telegram_allowlist`, `approvers`, `email_whitelist`, `ingest_policy` (`known-only` | `quarantine` | `open`). Полная справка — `docs/CONFIG.md` (раздел 4 — LLM-профили).

### Как сменить модель/промпт
> ⚠️ **HTTP-эндпоинта для `setting` НЕТ.** Таблица настроек правится только на деплое / напрямую в БД. Удалённый агент, работающий по API, **не может** менять модель/промпт/политику/каналы/токены — это операторская задача (и это правильная защита: агент не переписывает свои же guardrails). См. раздел «Что НЕ доступно по API».

Операторская правка (деплой-тайм, через Kysely; UNIQUE на `key` → повторный insert замещает):
```ts
await db.insertInto('setting').values({
  key: 'ai_model.triage',
  value: 'anthropic/claude-opus-4-1',
  updated_at: Math.floor(Date.now() / 1000),
}).execute();
```

**Важный нюанс кеширования:** `MastraService` и `IntentClassifierService` резолвят конфиг **один раз в `onModuleInit()`** и кешируют агента в памяти — смена настройки применится только после перезапуска (или переинициализации сервиса). `ProposeDraftService` читает модель **свежей на каждый вызов** (используется только для записи provenance в `ai_proposal`).

### DI-топология
`AgentConfigModule` (импортирует `DatabaseModule`, экспортирует `AgentConfigService`) подключён в **двух** модулях — `AiModule` и `InteractionModule`. NestJS singleton-scope → один общий инстанс.

---

## Доменная модель (ubiquitous language)

Авторитет: `CONTEXT.md` (глоссарий) и `docs/DOMAIN-MODEL.md`. Ключевые термины:

- **Hidden double-entry ledger** — реальная двойная запись, скрытая от пользователя. Пользователь видит категорию (`software`, `transport`), ядро постит сбалансированные дебеты/кредиты по техническим счетам.
- **Voucher** — один неизменяемый сбалансированный документ для одного экономического события. Никогда не редактируется — только сторнируется встречным voucher. Несёт `tax_point_date` (в какой период попадает). Номер присваивается **только при постинге**.
- **VoucherLine** — дебет/кредит по `Account`: исходная сумма+валюта, сумма в базовой валюте, FX-курс, VAT-код. Машинный слой, пользователю не виден.
- **Account** — узел chart of accounts (Cash, Bank, AR, AP, Revenue, Expense-by-category, VAT-payable/receivable, Equity, Owner's-drawings, …). Тонкий канонический набор; всё страновое — в плагине.
- **Country plugin** (ADR-0002) — единственный резолвер VAT-кодов, маппинга `категория → счёт + VAT`, cross-border treatment, базовой валюты, частоты периодов. Канонического словаря VAT в ядре нет. Сейчас активен `NullCountryPlugin` (заглушка, Ireland).
- **Entity (Supplier/Customer)** — контрагент по **сильному ключу** (VAT-номер / CVR), не по имени. Хранит интринсик-факты + память классификации; **никогда не хранит VAT-код** (зависит от контекста организации).
- **Document** — сырой входящий артефакт (PDF/фото) + dedup-якорь по хешу. Байт-идентичные вложения схлопываются в один Document.
- **Reporting period** — VAT-период (`open → locked`). Лочится **подачей отчёта**, не календарём. После lock правки только через сторно + новый voucher в текущем периоде.
- **Reversal vs Credit note** — reversal = наша внутренняя отмена нашего voucher; credit note = внешний документ контрагента. Не смешиваются.
- **Multicurrency / Realized FX** (ADR-0004) — всё считается в базовой валюте; реализованная курсовая разница постится автоматически при расчёте позиции.
- **Hash-chained voucher log** (ADR-0013) — append-only цепочка хешей (git-style); ортогональна двойной записи. Merkle-root на период замораживается в VAT report.

---

## Карта модулей `src/`

| Модуль | Ответственность |
|---|---|
| `database/` | Kysely-модуль, 30 миграций, типы схемы |
| `organization/` | Single-tenant организация (id=1; `org_type`: company \| sole_proprietor) |
| `ledger/` | Двойная запись: `account/`, `voucher/`, `posting/`, `validation/`, `pipeline/` |
| `ledger/posting/` | `PostingService` — **единственная** валидируемая точка записи; атомарный пост + hash |
| `ledger/pipeline/` | `PostingPipelineService` — draft → resolve → Rules (3 tier) → Policy → post/hold |
| `rules/` | Три яруса: structural (арифметика), hard_process (период-lock), semantic (плагин) |
| `policy/` | Risk gate: amount/confidence/supplier/operation → auto-post или hold |
| `plugins/` | `CountryPlugin` интерфейс + `NullCountryPlugin` |
| `expenses/`, `sales-invoices/` | Бизнес-объекты (controller/service/tool) |
| `corrections/` | Сторно + замещение |
| `documents/`, `triage/` | Интейк, dedup, OCR-стаб, очередь триажа |
| `ai/` | Mastra runtime, `AgentConfigService`, Pass-2 агент, `IntakeWorkflowService`, `ProposeDraftService` |
| `bank/`, `reconciliation/` | Банковские выписки, матчинг, диспозиции, realized FX |
| `reporting-periods/`, `vat-report/` | Периоды (open/lock), immutable snapshot + Merkle root |
| `approvals/` | Жизненный цикл аппрувов (pending → approved \| rejected \| superseded) |
| `audit-findings/` | Findings + severity (forward-looking) |
| `audit-log/` | Append-only операционный лог (триггеры immutability) |
| `conversations/` | Conversation/Message/Artifact, детерминированный резолв по channel+thread_key |
| `interaction/` | Канал-адаптерный шов: envelope, Principal, router, intent classifier, FlowDispatcher |
| `agents/` | Пять агентов (Accounting, Reconciliation, Audit, Secretary, Dev) |
| `admin/`, `health/`, `auth/` | Диагностика `/admin`, `/health`, API-token guard |

---

## Рантайм-взаимодействие (Interaction layer, ADR-0025)

### Канал-адаптерный шов
Каждый канал = **чистый mapper** (raw payload → `UnifiedEnvelope`, юнит-тестируемый, без I/O) + **transport port** (`InteractionTransport.send(out)`) + webhook-контроллер (проверяет аутентичность). Ядро канал-агностично.

`UnifiedEnvelope`: `{ channel, sender, convKey, message, attachments[], metadata, auth: { senderId, transportVerified } }`.
`OutboundMessage`: `{ channel, convKey, text, actionPoint?: { id, label } }` — `actionPoint` рендерится как inline-кнопка.

**Добавить канал:** mapper + transport (`implements InteractionTransport`) + (если push) webhook-контроллер + регистрация в `TransportRegistryService`. Router/gating/flows не меняются.

### Роутер (`interaction/router/interaction-router.service.ts`) — 7 шагов
1. Резолв `Conversation` детерминированно по `channel + thread_key`.
2. Запись входящего turn в `message`.
3. Резолв `Principal` (`PrincipalResolverService`).
4. Ingest-трек: при вложениях — `ingestDecision(principal, policy)` → accept/quarantine/reject + аудит.
5. Кнопка (`metadata.callbackData`): проверка `canCommit` → детерминированный action без LLM.
6. Converse-gate: только `role==='approver'` может вести диалог.
7. `IntentClassifierService.classify()` → `RoutedIntent` → `FlowDispatcher.dispatch()`.

### Principal и гейтинг (`interaction/principal/`)
`Principal { role: 'approver' | 'known_counterparty' | 'unknown'; authVerified; senderId }`.
- `canConverse` — только approver.
- `canCommit` — только approver **и** `authVerified` (transport доказал аутентичность: secret-token Telegram / DKIM+SPF email). **Действия из свободного текста не коммитятся** — только через нажатие кнопки (ADR-0016).
- `ingestDecision` — по `ingest_policy`: approver/known_counterparty всегда accept; unknown зависит от политики.

### Интенты (`routed-intent.schema.ts`)
`advisory` | `action` (`actionIntent`: create_sales_invoice | approve | reject | correct) | `report` | `reconciliation` | `clarify`. При неуверенности агент предпочитает `clarify`, а не угадывает.

### Интейк: Document → Voucher (`ai/intake-workflow.service.ts`, ADR-0024/0010)
```
Upload → Pass1 OCR (→ markdown, артефакт) → Pass2 агент (классификация, read-only tools)
       → TriageResult → детерминированный роутинг:
         new_expense & confidence ≥ порог → ProposeDraftService → pipeline → draft/hold
         иначе / unknown / supplier-unresolved → needs_triage (AuditFinding человеку)
```
Статусы Document: `pending → triaged | needs_triage`, `triaged → processed`. OCR/Pass2 фейлы идут через единый типизированный seam (категории фейла в аудит).

### Аппрувы (ADR-0015) и аудит-лог (ADR-0026)
- Policy задержал draft → `Approval(pending)`. Аппрув **передеривирует** voucher из бизнес-объекта и прогоняет pipeline (идемпотентно, без двойного постинга). Reject → объект назад в draft. **Никогда не авторезолвится** по таймауту — только человек.
- `audit_log` — append-only `{ actor, action, outcome, target, detail }`, immutability через SQL-триггеры. Действия интейка/гейтинга/коммитов пишутся инкрементально. Это **не** часть hash-chained ledger.

---

## Что агент ДОЛЖЕН и НЕ ДОЛЖЕН делать

**НЕ ДОЛЖЕН (no break-glass, ADR-0012):**
- ❌ Писать напрямую в `voucher`/`voucher_line` — только через `PostingService`/pipeline.
- ❌ Создавать черновики записью в БД — только через `ProposeDraftService`.
- ❌ Обходить аппрув: задержанный Policy draft ждёт явного коммита approver'а кнопкой.
- ❌ Постить в **залоченный** период — ядро блокирует; правки только сторно + новый voucher в текущем периоде.
- ❌ Авторезолвить аппрув за человека.
- ❌ Тихо реклеймить иностранный VAT: `foreign_cost`/`unresolvable` не эмитят `VAT_RECEIVABLE`; `unresolvable` → hold.
- ❌ Мутировать `Conversation`/`Message` напрямую — только через сервис (роутер владеет агрегатом).

**Нерушимые инварианты:** structural (дебет=кредит в базовой валюте, существование счёта, положительные суммы/курсы, согласованность валют, immutability через триггеры) и hard_process (период-lock) **не переопределяются**. Переопределяется только **semantic** правило — и только с **залогированным Override** (`ruleType + reason`), атомарно в той же транзакции, что и пост.

---

## Работа по HTTP API (remote-режим)

Система рассчитана на удалённую работу: **агент делает всю повседневную бухгалтерию по HTTP, не трогая код и БД.** Проверено на живом инстансе — полный цикл (поставщик → расход → постинг → аппрув → VAT-отчёт → лок периода) проходит чистыми REST-вызовами.

**Аутентификация:** заголовок `Authorization: Bearer <token>` на всех роутах, кроме `@Public()`. Без токена — `401`.

**Префиксы роутов (важно, не глобальный prefix — он зашит в декораторах):**
- Бизнес-операции: `/api/...` (`/api/entities`, `/api/expenses`, …). `/entities` без `api` → `404`.
- Диагностика: `/admin/...` (без `api`). Здоровье: `/health` (без `api`, public).

**Суммы — в минорных единицах (центах), целые.** `gross_amount: 12300` = 123.00. Даты — `YYYY-MM-DD`.

### Что НЕ доступно по API (только деплой/оператор/БД)
- **Выдача API-токена** — HTTP-роута нет. Init-токен пишется в лог **один раз** при первом старте (`INIT API TOKEN …`), новые — только через `ApiTokenService.create()` (деплой-тайм). Агенту токен **выдают**, он его не добывает.
- **Настройки (`setting`)**: `ai_model.*`, `prompt.*`, `telegram_bot_token`, `telegram_webhook_secret`, `telegram_allowlist`, `approvers`, `email_whitelist`, `ingest_policy` — контроллера нет.
- **Пороги политики** (`policy_config`: ceiling, confidence) — есть только `GET /api/overrides`; записи политики по API нет.
- **Алиасы контрагента** (`addAlias`) — service-only, HTTP-роута нет (есть только create/list/get).

Вывод по вопросу «сможет ли агент по API и не лезть в код/базу»: **да — для ведения книг.** Конфигурация модели/политики/каналов/токенов остаётся операторской (деплой-тайм) — by design.

---

## Стандартные бухгалтерские операции (рецепты, проверено по API)

`B=http://host:3000`, `H="Authorization: Bearer $T"`, `J="Content-Type: application/json"`.

### Онбординг организации
```bash
curl -H "$H" $B/api/organization                      # текущее состояние (id=1)
curl -H "$H" -H "$J" -X PUT $B/api/organization \
  -d '{"country":"IE","org_type":"company","vat_registered":true,"base_currency":"EUR"}'
```
`org_type`: `company | sole_proprietor`. Сид: IE, base_currency=null (→ EUR от плагина).

### Открыть отчётный период (без него постинг упрётся в period-lock)
```bash
curl -H "$H" -H "$J" -X POST $B/api/reporting-periods \
  -d '{"name":"FY2026","start_date":"2026-01-01","end_date":"2026-12-31"}'   # status: open
curl -H "$H" $B/api/reporting-periods/current
```

### Добавить поставщика / клиента
```bash
curl -H "$H" -H "$J" -X POST $B/api/entities -d '{
  "role":"supplier", "country":"IE", "name":"Acme Software Ltd",
  "registrationKey":"IE1234567T", "goodsVsServices":"services"}'
# role: supplier|customer; идентичность по registrationKey (VAT/CVR), не по имени.
# GET /api/entities, GET /api/entities/:id. Update/alias по API нет.
```

### Внести траты (expense / покупка)
```bash
EXP=$(curl -s -H "$H" -H "$J" -X POST $B/api/expenses -d '{
  "category":"software","gross_amount":12300,"vat_amount":2300,
  "currency":"EUR","tax_point_date":"2026-06-09","supplier_id":1}')   # status: draft
# провести через pipeline (Rules→Policy→post/hold):
curl -H "$H" -H "$J" -X POST $B/api/expenses/<id>/post -d '{}'
```
Ответ содержит `policy.action`: **`auto-post`** (например, «within ceiling» → создаётся voucher, двойная запись Dr EXPENSE_* + Dr VAT_RECEIVABLE = Cr AP, VAT-код от плагина `IE_INPUT_23`) или **`hold-for-approval`** («exceeds ceiling …»).

### Внести инвойс (исходящий sales invoice — то, что мы выставляем)
```bash
curl -H "$H" -H "$J" -X POST $B/api/sales-invoices -d '{
  "invoice_number":"INV-001","customer_id":null,"gross_amount":24600,
  "vat_amount":4600,"currency":"EUR","tax_point_date":"2026-06-09"}'   # status: draft
curl -H "$H" -H "$J" -X POST $B/api/sales-invoices/<id>/post -d '{}'    # → voucher (Dr AR = Cr REVENUE + Cr VAT_PAYABLE)
# опц.: POST .../generate-draft (предпросмотр проводки), POST .../send (пометить отправленным)
```
> Входящий счёт поставщика — это **expense** (intake — только purchase-side), а не sales invoice.

### Hold → аппрув (HITL) — правильный путь
> ⚠️ Если ждёшь hold, **не зови `/post`**: он переведёт объект в `pending` **без** создания аппрува, и объект застрянет (проверено). Делай так:
```bash
# 1) объект в draft (создать и НЕ постить)
# 2) создать аппрув напрямую — он гонит Rules, переводит draft→pending, создаёт запись:
curl -H "$H" -H "$J" -X POST $B/api/approvals -d '{
  "object_type":"expense","object_id":4,"requested_by":"agent","reason":"over ceiling"}'
# 3) человек подтверждает → voucher постится:
curl -H "$H" -H "$J" -X POST $B/api/approvals/<id>/approve -d '{"approved_by":"owner@acme.ie"}'
# /reject {"rejected_reason":...}, /supersede {"superseded_by":...}
curl -H "$H" $B/api/approvals/pending
```
Аппрув идемпотентен, период-lock и инварианты не обходит.

### Внести доп. документы (загрузка + триаж)
```bash
curl -H "$H" -F "file=@receipt.pdf" $B/api/documents          # → {document, deduplicated}; dedup по SHA-256
curl -H "$H" -H "$J" -X POST $B/api/documents/<id>/triage -d '{}'   # AI: OCR→классификация→draft|needs_triage
curl -H "$H" $B/api/triage/pending
curl -H "$H" -H "$J" -X POST $B/api/documents/<id>/complete -d '{}' # пометить обработанным
# expense можно сразу привязать к документу: поле document_id при POST /api/expenses
```

### Посмотреть ВАТ-цифры (безопасно, read-only)
```bash
curl -H "$H" "$B/api/reporting-periods/<id>/vat-report/preview"
# → тот же формат, что у снапшота (input/output по кодам, итоги, voucher_ids,
#   merkle_root), но считается ЖИВЬЁМ и никуда не сохраняется. Зови сколько нужно.
#   frozen_snapshot_id ≠ null → снапшот уже заморожен, живые цифры могут с ним
#   расходиться, и при подаче использован будет ЗАМОРОЖЕННЫЙ.
curl -H "$H" "$B/api/reporting-periods/<id>/kmd"   # строки KMD-декларации, тоже живой расчёт
```

### Заморозить ВАТ-отчёт (навсегда — только при подаче)
```bash
curl -H "$H" -H "$J" -X POST $B/api/reporting-periods/<id>/vat-report -d '{}'
curl -H "$H" $B/api/vat-reports/<id>
curl -H "$H" $B/api/vat-reports/<id>/vouchers
```
> ⚠️ **Это ЗАМОРАЖИВАЕТ снапшот, а не считает.** «Идемпотентно» здесь значит
> *вернуть существующий*, а не *пересчитать*: как только снапшот для периода создан,
> любой следующий вызов отдаёт сохранённую копию, а строки `vat_report` отвергают
> UPDATE и DELETE на уровне БД. Снапшот, снятый на открытом периоде, **не увидит**
> проводки, корректировки и сторно, сделанные после — а `POST .../lock` молча подаст
> именно эту устаревшую копию. Откатить можно только сняв руками триггеры
> иммутабельности на живой базе — тот самый break-glass, который запрещает ADR-0012.
> **Чтобы посмотреть цифры, используй preview выше.** Этот вызов — только когда
> действительно подаёшь.

### Закрыть период (file VAT) — иммутабельный снапшот
```bash
curl -H "$H" -H "$J" -X POST $B/api/reporting-periods/<id>/lock -d '{}'
# атомарно: генерит снапшот VAT + Merkle, status→locked. Sequential: более ранний open-период блокирует лок.
# После лока постинг в этот период → 'Cannot post into locked period' (hard_process, без break-glass). Правки — сторно + новый voucher в текущем периоде.
```

### Корректировки (сторно/замещение)
```bash
curl -H "$H" -H "$J" -X POST $B/api/expenses/<id>/correct -d '{...}'
curl -H "$H" -H "$J" -X POST $B/api/sales-invoices/<id>/correct -d '{...}'
```

### Дивиденды (только company; gated плагином)
```bash
curl -H "$H" -H "$J" -X POST $B/api/dividends -d '{"gross_amount":100000,"tax_point_date":"2026-06-09"}'
# распределяемая прибыль = RETAINED_EARNINGS + чистая прибыль (live, без year-end close); withholding — правило плагина
curl -H "$H" -H "$J" -X POST $B/api/bank-transactions/<id>/dividend -d '{...}'   # settle через реконсиляцию
```

### Чтение книг
```bash
curl -H "$H" $B/api/accounts            ;  curl -H "$H" $B/api/accounts/<code>
curl -H "$H" $B/admin/accounts          # счета С балансами (сырой trial balance)
curl -H "$H" $B/admin/vouchers          ;  curl -H "$H" $B/admin/vouchers/<id>    # hash-chain (previous_hash) виден
curl -H "$H" "$B/admin/approvals" "$B/admin/findings/open" "$B/admin/periods"
```

### Чего НЕТ (честно): налоги и годовой отчёт
- **Налоги:** считается **только VAT** (через VAT-коды плагина и VAT-отчёт). Подоходного/корпоративного налога нет. Cross-border / reverse-charge — интерфейс есть, но в v1 **не вызывается** (зарезервировано); иностранный VAT не реклеймится тихо, спорное → hold.
- **Годовой отчёт / финансовая отчётность (P&L, баланс, trial balance как форма):** **не реализовано (V2).** Есть только сырые балансы (`/admin/accounts`) и утилита распределяемой прибыли. Year-end close отложен.

---

## Quick reference

```bash
# запуск/тесты
nvm use 24 && npm ci
npm run start:dev          # dev, :3000
docker compose up -d       # контейнер
npm test                   # ~686 unit
npm run test:e2e           # 33 e2e
npm run lint && npm run build

# здоровье
curl http://localhost:3000/health
```

| Что | Где |
|---|---|
| Корень NestJS | `src/app.module.ts`, вход `src/main.ts` |
| Pipeline / точка записи | `src/ledger/pipeline/posting-pipeline.service.ts`, `src/ledger/posting/posting.service.ts` |
| Три яруса правил | `src/rules/`; risk gate — `src/policy/` |
| Country plugin | `src/plugins/country-plugin.interface.ts` |
| Интейк/триаж | `src/ai/intake-workflow.service.ts`, `src/ai/propose-draft.service.ts` |
| Роутер/интенты | `src/interaction/router/` |
| Конфиг агентов | `src/ai/agent-config.ts`, `agent-config.service.ts` |
| Миграции | `src/database/migrations/` (30) |

---

## Частые ошибки

| Симптом | Причина / решение |
|---|---|
| `NODE_MODULE_VERSION` mismatch у better-sqlite3 | Node не 24 → `nvm use 24 && npm rebuild better-sqlite3` |
| Тесты падают «Mastra agent not initialized» | Ожидаемо: Mastra застаблен в тестах (`test/mastra-stub.ts`) |
| `database is locked` | SQLite синхронный — останови `start:dev` перед тестами |
| Смена `ai_model.*` не подействовала | `MastraService`/`IntentClassifierService` кешируют конфиг на `onModuleInit` → нужен перезапуск |
| `unknown_supplier_requires_approval` сработал | Значит интейк-резолв поставщика обошли (идентичность резолвится на шаге интейка, не при постинге) |
| Порт 3000 занят | `PORT=8000 npm run start:dev` |

---

## Авторитетные источники

- `CONTEXT.md` — глоссарий (load-bearing термины), `docs/DOMAIN-MODEL.md` — агрегаты/потоки/инварианты.
- `docs/CONFIG.md` — все ручки конфигурации (раздел 4 — LLM-профили и `ai_model.*`/`prompt.*`).
- `docs/VISION.md`, `docs/V2-ROADMAP.md`, `README.md`.
- ADRs (`docs/adr/`): 0001 (hidden ledger), 0002 (country plugin), 0005 (pipeline+policy), 0012 (no break-glass), 0013 (hash chain), 0015 (approvals/period-lock), 0016 (intent routing), 0018 (agents), 0019 (write path), 0024 (AI ingestion), 0025 (interaction seam), 0026 (audit log).

> Проект инициализирован с CodeGraph (`.codegraph/`). Для разведки по коду используй Explore-агента с `codegraph_explore`, а не чтение файлов целиком в основной сессии.
