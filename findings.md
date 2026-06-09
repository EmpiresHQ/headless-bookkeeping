# Findings: чего не хватает для режима «только remote API»

Контекст: агент работает **исключительно по HTTP API** удалённого инстанса — не трогает код и БД. Ниже — что мешает в этом режиме. Проверено на живом инстансе (свежая БД, поднята локально на :3100, операции прогнаны curl'ом; рабочая БД пользователя не затронута), кроме пунктов, помеченных `[требует проверки]`.

Дата: 2026-06-09. Ветка: `wave-8-interaction`.

---

## A. Блокеры: нужно агенту/оператору, но по API недоступно

### A1. Нет выдачи API-токенов по API  `[проверено]`
- Init-токен пишется в stdout **один раз** при первом старте (`ApiTokenService.onModuleInit`, лог `INIT API TOKEN …`). Новые — только через `ApiTokenService.create()` (код/деплой). HTTP-роутов `create/list/revoke` нет.
- Последствие: удалённого агента нельзя забутстрапить/ротировать токен без доступа к серверу. Токен приходит к агенту out-of-band.
- Желательно: защищённый admin-эндпоинт выпуска/отзыва токенов (под существующим guard).

### A2. Нет HTTP API для настроек (`setting`)  `[проверено: контроллера нет]`
- Не настраиваются по API: `ai_model`, `ai_model.<agent>`, `prompt.<agent>`, `telegram_bot_token`, `telegram_webhook_secret`, `telegram_allowlist`, `approvers`, `email_whitelist`, `ingest_policy`.
- Последствие: для headless/remote-деплоя модель агентов, промпты и **вся настройка каналов и принципалов** задаётся только на деплое / правкой БД. Оператор не может донастроить удалённо.
- Желательно: admin CRUD по `setting` (хотя бы whitelisted-ключи) + переинициализация закешированных агентов (см. A6).

### A3. Нет HTTP API для порогов политики (`policy_config`)  `[проверено: только GET /api/overrides]`
- Risk-gate (`ceiling`, `confidence floor`, `unknown_supplier_requires_approval`) не читается и не меняется по API. Есть только `GET /api/overrides` (журнал семантических override'ов).
- Последствие: нельзя удалённо настроить, какие суммы уходят на аппрув. Дефолтный ceiling зашит (наблюдал `ceiling 100000`).
- Желательно: `GET/PUT /api/policy-config` под guard.

---

## B. Баги/несогласованности (найдены вживую)

### B1. Зависший hold: `/post` держит объект, но аппрув создать нельзя  `[проверено]`
- Сценарий: `POST /api/expenses/:id/post` → Policy = `hold-for-approval` → expense переходит в `pending`, voucher не создаётся, **запись approval не создаётся**.
- Затем `POST /api/approvals {object_type:expense, object_id}` → `409 "Expense X is pending, expected draft"`. Объект застревает в `pending` без аппрува — **по API нерешаемо**.
- Рабочий обход (задокументирован в SKILL.md): для ожидаемого hold **не звать `/post`**, а из `draft` сразу делать `POST /api/approvals` (он гонит Rules, переводит draft→pending, создаёт approval) → `/approve`.
- Корень: два пути hold (`/post` и `/approvals`) рассинхронизированы. Ожидаемо: либо `/post` создаёт approval атомарно при hold, либо `createApproval` принимает `pending`, либо `/post` при hold оставляет `draft`.
- `[проверено]` **то же у `POST /api/sales-invoices/:id/post`**: over-ceiling → invoice `pending`, voucher `null`; затем `POST /api/approvals {object_type:"sales_invoice"}` → `409 "SalesInvoice N is pending, expected draft"`. Стрэндинг идентичен расходу.

---

## C. Отсутствующий функционал (честные границы scope)

### C1. Налоги — только VAT  `[проверено через ресерч + VAT-отчёт]`
- Считается только VAT (коды плагина + VAT-отчёт). Подоходного/корпоративного налога, withholding по зарплате и т.п. нет.
- «Высчитать налоги» сверх VAT — не поддерживается.

### C2. Cross-border / reverse-charge VAT не подключён  `[проверено: интерфейс есть, вызова нет]`
- `CountryPlugin.resolveCrossBorderTreatment()` определён, но в v1 **не вызывается** (зарезервировано, Wave-5 Task 34). Иностранный VAT тихо не реклеймится; спорное → hold.
- Последствие: трансграничные закупки обрабатываются консервативно/неполно.

### C3. Нет годового отчёта / финансовой отчётности  `[проверено: модуля нет; V2-ROADMAP]`
- Нет P&L, баланса, оформленного trial balance, year-end close. Есть только сырые балансы (`GET /admin/accounts`) и утилита распределяемой прибыли (для дивидендов).
- «Подбить годовой отчёт» — недоступно (отложено в V2).

### C4. Нет правки/алиасов контрагента по API  `[проверено: только create/list/get]`
- `EntitiesService.addAlias()` (IBAN / merchant_descriptor / name_alias) и любое обновление — service-only, HTTP-роутов нет.
- Последствие: исправить имя/страну/добавить идентификатор поставщика по API нельзя; коррекция/слияние идентичности заблокированы.

---

## D. Эргономика / заметки по API-поверхности

- **D1. Непоследовательные префиксы** `[проверено]`: бизнес-роуты — `/api/...`; `/admin/*`, `/health`, а также `corrections`/`triage` (`@Controller()`) — без `api`. Глобального `setGlobalPrefix` нет. Путает; стоит унифицировать или задокументировать (сделано в SKILL.md).
- **D2. Bootstrap-токен в plaintext в stdout** `[проверено]`: единоразово при первом старте — нужно надёжно перехватывать на деплое.
- **D3. Периоды не валидируются на пересечение/частоту** `[проверено]`: `POST /api/reporting-periods` принял период `2026-06-01..07-31` **поверх** уже открытого `FY2026` (HTTP 201). Перекрытие и частота (плагин) не проверяются → риск: `GET /api/reporting-periods/current` отдаёт «самый поздний по start_date», а `tax_point_date` может попасть в два открытых периода (неоднозначность/двойной учёт в VAT-отчёте). Стоит запретить перекрытие открытых периодов. **Severity: Medium.**
- **D4. Скачивания байтов документа нет** `[проверено: грепом]`: в `documents.controller.ts` только `POST` (upload), `GET` (list), `GET /:id` (метаданные + sources). Эндпоинта отдачи файла нет → агент не может вытащить исходный PDF/изображение по API.
- **D5. Реконсиляция банка — РАБОТАЕТ по API** `[проверено]` (не пробел): `POST /api/bank-statements` (выписка+транзакции) → `GET /api/bank-statements/:id/transactions` → `POST /api/bank-statements/:id/propose-matches` (вернул ранжированный `MatchProposal[]`: exact/high по `invoice_number`) → `POST /api/bank-statements/:id/match {matches:[...]}` (создал `reconciliation_match`; `fxResults: no_fx` при одной валюте). Матч **не** постит settlement-voucher автоматически (by design). Также есть `/personal`, `/prepayment` + `/draw-down`, `/fx-realized` (не гонялись отдельно).

---

## Сводка приоритетов

| # | Что | Severity | Тип |
|---|---|---|---|
| A1 | Выдача/отзыв токенов по API | High | блокер деплоя |
| A2 | Настройки (`setting`) по API | High | блокер конфигурации |
| B1 | Зависший hold (`/post` без approval) — expense **и** sales_invoice | High | баг |
| A3 | Пороги политики по API | Medium | блокер настройки |
| C4 | Правка/алиасы контрагента по API | Medium | функционал |
| C2 | Cross-border VAT не подключён | Medium | функционал |
| D3 | Перекрытие/частота периодов не валидируется | Medium | корректность |
| D4 | Нет скачивания байтов документа по API | Medium | функционал |
| C1/C3 | Налоги сверх VAT / годовой отчёт | Low (V2) | scope |
| D1/D2 | Эргономика (префиксы, plaintext-токен) | Low | заметки |

> Что проверено вживую (temp-инстанс на :3100, свежая БД): token-only-at-boot; отсутствие контроллеров `setting`/`policy`/download/entity-update; зависший hold у **expense и sales_invoice** (живой 409); `PUT /api/organization`; полный VAT-отчёт с реальным merkle_root; sequential lock + блок постинга в залоченный период; **реконсиляция банка end-to-end (propose-matches → match)**; перекрытие периодов принимается (нет валидации); отсутствие глобального `/api`-префикса. Все пункты выше теперь `[проверено]`, кроме помеченных иначе.
