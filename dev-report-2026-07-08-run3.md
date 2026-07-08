# Dev report: прогон #3 (override OÜ, remote-API, триаж очереди documents)

Контекст: агент работал **только по HTTP API** живого инстанса `bk.010.ee` (через `hbk` CLI + curl): банковская выписка июня → инвойсы → триаж очереди documents (41 parked-документ). Root-cause по коду — `main` @ `3a71a66`. Каждый пункт: `[воспроизведено]` — наблюдался вживую на проде, `[код]` — сверен с исходниками (файл:строка).

Дата: 2026-07-08. Предыдущие волны: `findings.md` (2026-06-09), `usage_note_2.md` в рабочей папке override_ou (2026-06-14). Здесь — только новое/уточнённое.

---

## A. Критично: точность книг

### A1. Voucher постится в дату, не покрытую НИ ОДНИМ периодом `[воспроизведено+код]`
- Live: expense из resolve-supplier запостился с `tax_point_date=2026-07-08`, когда существовали только периоды 2026-05/06 → voucher V-2026-000027 не принадлежал никакому периоду и не попал бы ни в один VAT-отчёт.
- Код: hard_process проверяет **только locked**: `rules/rules.service.ts:150-166` → `period-lock.service.ts:41-52` (`findLockedPeriod`: `WHERE status='locked' AND …`). Дата вне всех периодов → 0 строк → «passed». Бэкстоп `assertPeriodOpen` (`:57-67`) — та же логика. Правило отвечает на вопрос «не в locked ли?», а не «в каком-нибудь open ли?».
- Вместе с findings.md D3 (перекрытие периодов не валидируется) членство voucher↔период не гарантировано ничем с двух сторон.
- Фикс: hard_process-инвариант «tax_point_date обязан попадать в существующий open-период» + типизированная ошибка «нет периода — открой»; опционально авто-создание следующего месячного.
- **Severity: High** (тихая утечка проводок мимо VAT-отчёта).

### A2. `resolve-supplier` = «привяжи поставщика», а по факту — немедленный пост в ledger по кэшу LLM `[воспроизведено+код]`
- Live: один вызов `POST /api/documents/124/resolve-supplier {supplier_entity_id:37}` мгновенно создал expense **и запостил** неизменяемый voucher — с суммами из кэшированной AI-экстракции, которые оказались неверны (A3). Ответ — только `{expense_id}`, сумм/даты оператор не видит.
- Код: `intake-workflow.service.ts:684-788` — берёт сохранённый `TriageResult` (`:706`) и гонит полный `proposeDraft → runPipeline` (`:751`); policy-гейт проходится с `supplierKnown=true` (`propose-draft.service.ts:280`), сумма < ceiling 100000 (`policy.service.ts:27-32,91-99`) → auto-post (`posting-pipeline.service.ts:160-167`). Гейта «expense рождён из needs_triage → hold» не существует.
- Семантическая проблема: оператор чинит **одно** поле, система молча коммитит **все** поля экстракции, доверие к которой уже подорвано самим needs_triage.
- Фикс-варианты: (а) resolve-supplier → draft + предпросмотр проводки, пост отдельным шагом; (б) policy-гейт «needs_triage-происхождение → hold-for-approval»; (в) минимум — возвращать полный expense (суммы/дата/категория) в ответе.
- **Severity: High.**

### A3. Net/gross из OCR не кросс-валидируется — занижение AP `[воспроизведено+код]`
- Live: CityBee: net 1.76 + VAT 0.42 = **total 2.18** EUR. Экстракция дала `gross=176, vat=42` (net принят за gross) → забукано 1.76 вместо 2.18, AP занижена на 0.42.
- Код: соотношение не проверяется нигде. Схема `triage/types.ts:99-100` — голые `int`; `expenses.service.ts:24-34` вставляет verbatim (валидирует только категорию); `voucher-projection.service.ts:65` слепо `net = gross − vat`. Промпт (`agent-config.ts:44-47`) объясняет minor units, но **не говорит, что gross = VAT-inclusive total**.
- Фикс (3 слоя): промпт — «gross = сумма С НДС (Kokku/Total incl. VAT)»; экстракция — вытаскивать net, VAT и total отдельно + структурная проверка `net+vat==gross`; rules-ярус — reject с парковкой при расхождении.
- **Severity: High** (систематически неверные суммы в неизменяемых voucher).

### A4. `tax_point_date` — свободный вывод LLM без привязки к дате инвойса `[код]`
- `propose-draft.service.ts:256` — дата из `triageResult.tax_point_date` как есть; схема `z.string()` (`types.ts:101`); фолбэков и парсинга printed invoice date нет; промпт (`agent-config.ts:56-57`) не говорит «используй дату инвойса». Оператор значения не видит (см. A2). Вместе с A1 даёт проводки в несуществующие периоды.
- **Severity: Medium-High.**

## B. Документный конвейер (intake)

### B1. Гонка в `upload()`: строка видна воркеру раньше, чем записан `storage_path` `[воспроизведено+код]`
- Симптом: 7 документов (110, 103, 100, 90, 87, 84, 77) навечно в needs_triage с «OCR transcription failed (transient): Document X has no stored file», при этом `GET /:id/file` отдаёт 200 с полными байтами.
- Root cause: `documents.service.ts:41-138` `upload()` не атомарен: INSERT (`status='pending'`, `storage_path=NULL`, `:73-86`) → saveFile (`:88-92`) → **отдельный** UPDATE storage_path (`:94-98`), без транзакции. Бэкстоп-поллер `intake-queue.worker.ts:44` (1500 ms) через `claimNextPending` (`documents.service.ts:390-436`, фильтр только `status='pending'`) клеймит полузаписанную строку → `getFile` (`:274-283`) кидает «has no stored file» по `storage_path IS NULL` (диск не проверяется). Хранилище одно (`document-storage.service.ts:12-18`), теория «двух корней» исключена.
- Превью при этом есть — рендерится из RAM-буфера (`:106-107`), не из storage_path; это сбивает диагностику («файл же есть!»).
- Фикс: писать файл до INSERT и вставлять строку сразу с `storage_path` (или транзакция), и/или `claimNextPending += WHERE storage_path IS NOT NULL`.
- **Severity: High** (7/41 очереди — этот класс).

### B2. «transient» — ложное обещание: авто-ретрая нет `[код]`
- `needs_triage` никогда не переклеймится (`claimNextPending` берёт только `pending`); `MAX_ATTEMPTS=3` — про pending-клеймы. Категория `transient` (`ocr.service.ts:161-171`) — просто слово в тексте.
- Фикс: bounded auto-retry для `category=transient` (3 попытки, backoff) — гонка B1 самоизлечивалась бы.
- **Severity: Medium** (в паре с B1 — High).

### B3. `POST /:id/triage` не пере-триажит, а реплеит кэш; настоящий rerun `/retry` не доступен из CLI `[воспроизведено+код]`
- `intake-workflow.service.ts` `processInner`: `if (status==='needs_triage') return replayNeedsTriage(...)` — идемпотентный replay by design, но оператор зовёт «triage» и получает ту же ошибку, думая что она воспроизвелась заново (я на это попался: файл давно на месте, «no stored file» реплеился).
- Реальный rerun: `POST /api/documents/:id/retry` (`documents.controller.ts:283-294`, сброс в `pending`). **В CLI команды retry нет** — см. D2 (stale-спека).
- Фикс: replay-ответ помечать `"replayed": true` + hint «use /retry»; retry в CLI.
- **Severity: Medium.**

### B4. `DELETE /api/documents/:id` — тихая потеря первички + осиротевшие findings `[воспроизведено+код]`
- Live: findings 44/36 «Unexpected error during intake: Structural validation failed» ссылаются на документы **108 и 99** → `GET` по обоим **404**.
- Код: intake документы НЕ удаляет (safety-net `intake-workflow.service.ts:450-465` сохраняет строку). Исчезновение — через `DELETE /api/documents/:id` (`documents.service.ts:516-617`): hard-delete строки, связей **и байтов с диска** (`:566-569`, `:614-615` → `fs.unlink`). Guard слабый: 409 только если привязанный expense `posted|reversed` (`:530-537`) — needs_triage-документ с открытым finding **свободно удаляем**. `audit_finding` ссылается soft-указателем без FK (`migrations/018:12-13`), `deleteDocument` его не трогает → осиротевшие открытые findings.
- Фикс: (а) запрет delete при открытом finding (или каскадное resolve с reason='document deleted'); (б) soft-delete/архив вместо unlink байтов (первичка = юридический документ, 7-летнее хранение по EE-праву); (в) целостность findings→objects проверять при чтении.
- **Severity: High** (потеря первички одним вызовом; уже случилось дважды).

### B5. HEIC: конвертер в коде есть, бинаря на хосте нет `[воспроизведено+код]`
- 9 документов IMG_*.HEIC — «OCR endpoint returned HTTP 400». Код-путь корректен: `mime-routing-transcriber.ts:47-74` детектит HEIC (MIME + magic bytes) → `heic-decoder.ts:toPng` (`:80-105`) шеллится в `heif-convert`/`sips`/`magick`; если ни одного на PATH — `null` → unreadable, а 400 от vision-провайдера просачивается в причину.
- Фикс: поставить `libheif-examples`/`heif-convert` в Docker-образ (deploy); честная причина «no HEIC decoder installed» вместо HTTP 400.
- **Severity: Medium, фикс дешёвый.**

## C. AI-триаж: качество и обвязка

### C1. `match_entity_id` LLM не привязан к tool-выдаче — галлюцинированные id паркуют треть очереди `[воспроизведено+код]`
- Live: 13 документов с «match proposal references entity N, which does not exist», N ∈ {4, 4521, 11691363, 2052, 44592, 123, 535741, 45892, 568492, 1295628415, 12345, 2401000001} — явные галлюцинации.
- Код: схема требует лишь positive int (`triage/types.ts:25-38`); Zod-валидация Pass-2 (`pass2-agent.service.ts:128-146`) БД не трогает; существование проверяется только при потреблении (`propose-draft.service.ts:331-341`). Tools (`searchSuppliers` `tools/index.ts:27-66`, `getClassificationContext` `:240-332`) возвращают настоящие id, но модель ничем не обязана их использовать.
- Фикс-варианты: (а) DB-валидация id сразу на выходе Pass-2 + retry модели с ошибкой в контексте; (б) constrained choice — модель выбирает из enumerated кандидатов, id подставляет код; (в) fallback на match по registration key из экстракции при невалидном id.
- **Severity: High по трению** (точность не страдает — ловится при потреблении, но вся эта масса виснет на человеке).

### C2. Категории: закрытый список в коде плагина, нет нужных ключей, пустая категория врёт `[воспроизведено+код]`
- Live: «unknown category 'legal'» (Magrat, юр-услуги) и «unknown category ''» — паркуются.
- Код: статическая мапа `estonia-country.plugin.ts:47+`; `categories.controller.ts` — только GET; фолбэк-маппинга нет by design (ADR-0002, `propose-draft.service.ts:228-233`).
- Отказ от silent-fallback к EXPENSE_OTHER — правильный. Но: (а) в EE-наборе нет частых категорий — `legal`/`professional_services`, `government_fees`; (б) `''` — это фейл экстракции, а сообщение говорит «unknown category»; (в) рядом с ошибкой не даётся список валидных ключей.
- Фикс: расширить EE-таксономию; отдельный reason для пустой категории; в needs_triage-item отдавать валидные категории.
- **Severity: Medium.**

### C3. Addressee-check есть в данных, но не в гейте `[воспроизведено]`
- В очереди — документы на **чужих** получателей: AWS-инвойс на Pipedev OÜ, счета на Aleksei Revin лично (Tallinna Linnakantselei, ветклиника, Bright Data). Поле `company_addressed_receipt` на expense существует, но триаж не паркует «not addressed to this organization» отдельным reason_type — всё уходит в generic unknown.
- Фикс: сверять bill-to (name+VAT) с организацией; явный reason «addressed to third party» + однокнопочный dismiss.
- **Severity: Medium** (риск провести чужой документ в свои книги).

### C4. Dismiss существует, но замаскирован: `complete-document` ≠ своей документации `[код]`
- `POST /:id/complete` (`triage.controller.ts:126-137`): Swagger обещает «produce a postable item», реализация — только `setStatus('processed')` + очистка pending-результата. Постируемый объект **не требуется** → это и есть «dismiss» для personal/not_a_document. Но: (а) finding остаётся open (в отличие от resolveSupplier/manualClassify, которые зовут `auditFindings.resolve`) — очередь чистится, а findings-гигиена копится; (б) из названия/доки это не выводимо.
- Фикс: переименовать/задокументировать как dismiss; резолвить finding с reason; батч-вариант.
- **Severity: Medium.**

## D. API/CLI поверхность (донакопление к findings.md)

### D1. Несогласованность форм ответов: list = конверт, by-id = голый объект `[воспроизведено+код]`
- `GET /api/expenses` → `{expenses:[...]}`, `GET /api/expenses/:id` → голый Expense; то же `{documents}`, `{reportingPeriods}`. Фильтров у list-эндпоинтов нет вовсе (и это ок для текущих объёмов), но **какой ключ у конверта — нигде не документировано**, и потребитель, ожидающий массив, видит «пусто».
- Честное признание: в этом прогоне я сам дважды сделал ложный вывод «в системе 0 expenses / 0 documents» именно из-за этого — парсил `items`/`data` вместо resource-ключа. Сервер всё отдавал.
- Фикс: единообразие (везде конверт `{data:[...]}` или везде голый массив) + OpenAPI-схемы ответов; фильтры `?status=`, `?period=` — nice-to-have.
- **Severity: Medium** (дешёво, а ложных выводов у агентов — масса).

### D2. Бандленная OpenAPI-спека CLI протухла: команды-призраки и отсутствующие команды `[воспроизведено+код]`
- CLI генерится в рантайме из **закоммиченного** `packages/cli/openapi.json` (`bin.ts:14,25`), не из живого сервера. Итог:
  - `hbk triage debug-document` зовёт `GET /:id/debug`, которого больше нет (роут разбит на `details` `triage.controller.ts:40-49` и `reclassify` `:51-63`) → голый 404;
  - новых команд (`details-document`, `reclassify-document`, `documents retry`) в CLI нет вообще.
- Фикс: `npm run cli:codegen` в CI (drift-check спеки против сервера); или фетчить `/api-json` живьём с кэшем.
- **Severity: Medium-High** (remote-агент слеп ровно на новые/переименованные операции).

### D3. CLI не умеет бинарные ответы `[воспроизведено+код]`
- `hbk documents get-document-file` → «Unexpected token '%', "%PDF-1.4"…»: openapi-fetch дефолтится в `parseAs:"json"` (`client.ts:29-50`), и принтер `builder.ts:487-492` печатает только JSON.stringify. Оба слоя hard-assume JSON → все бинарные эндпоинты (`/file`, `/preview`) из CLI недоступны, обход — curl с ручным Bearer.
- Для агент-флоу скачивание первички — базовая операция (сверка сумм перед постом, см. A2/A3).
- Фикс: `--output <path>` + ветка по content-type в дispatcher.
- **Severity: Medium.**

### D4. Entity identity: strong-key модель мертва на живых данных `[воспроизведено+код]`
- Все 16 живых entities — без `registration_key`. Причина в коде: AI-интейк онбордит через `onboardWithIdentifiers` (`entities.service.ts:173-220`), который **создаёт сущность с нулём идентификаторов**, если все нормализовались в null (явный NOTE `:169-171`) — тогда как ручной `POST /api/entities` reg-key требует (`:43-47`). Матчер же ищет **только** по confirmed strong keys (`propose-draft.service.ts:388-410` → `resolveByIdentifiers` `entities.service.ts:139-161`, kinds: registration_key/email/phone, имя — никогда). Замкнутый круг: слабые сущности → вечный «create proposal carries no strong identifier» (GitHub-квитанции при живом GitHub, Inc.).
- Ремедиация существует, но неочевидна: `POST /api/entities/:id/aliases` добавляет идентификатор (NB: `addAlias` `:276-300` **не нормализует** значение — в отличие от intake-хелпера `:226-248`, отдельный мелкий баг), затем resolve-supplier бэкфилит идентификаторы предложения на поставщика (`intake-workflow.service.ts:724-746`).
- Фикс: (а) экстрагировать VAT/reg-номер из документа при auto-create (CityBee/Hetzner/Paavli печатают его) и сохранять; (б) корроборированный fallback-матч по нормализованному имени+стране; (в) нормализация в `addAlias`; (г) backfill-скрипт по 16 живым сущностям.
- **Severity: High по трению.**

## E. Гигиена прод-состояния (оператору, не в код)
- 4 pending approvals (reconciliation_match 19-22) висят с 14-15.06 — HITL-очередь никто не разбирает; нужен нотификатор (Telegram-дайджест).
- 47 open findings, из них ~12 протухли (C1-галлюцинации по уже разобранным докам) + 2 осиротели (B4) + сколько-то останутся open после complete (C4). Батч-resolve нечем.
- Периоды: 05, 06, 07 open (07 открыт в этом прогоне по подтверждению владельца). Июнь готов к VAT-отчёту после разбора очереди.
- Прод-очередь по классам: 13 галлюцинации entity-id (C1) · 9 HEIC (B5) · 7 гонка storage_path (B1, лечатся `/retry`) · 5 личные/чужие (C3) · 3 not_a_document · прочее — category/correction/low-confidence.

## Сводка приоритетов (новое к findings.md)

| # | Что | Severity | Тип |
|---|---|---|---|
| A1 | Постинг в дату вне всех периодов | High | корректность |
| A3 | Нет `net+vat==gross` → неверные суммы в ledger | High | корректность |
| B4 | DELETE documents теряет первичку, findings сиротеют | High | потеря данных |
| B1 | Гонка upload/claim → ложный «no stored file» | High | конвейер |
| A2 | resolve-supplier постит по кэшу LLM без предпросмотра | High | HITL |
| C1 | Галлюцинированные entity_id паркуют ⅓ очереди | High (трение) | AI-обвязка |
| D4 | Сущности без strong key → вечный unresolved | High (трение) | identity |
| D2 | Протухшая CLI-спека: команды-призраки | Med-High | tooling |
| A4 | tax_point_date — свободный вывод LLM | Med-High | корректность |
| B3 | triage=replay без пометки; retry нет в CLI | Medium | UX |
| C3 | Нет addressee-check (чужие документы) | Medium | корректность |
| C2 | Таксономия: нет legal; пустая '' врёт | Medium | таксономия |
| C4 | complete=скрытый dismiss, finding не резолвится | Medium | UX/гигиена |
| B2 | «transient» без авто-ретрая | Medium | конвейер |
| B5 | HEIC: нет декодера в образе | Medium | deploy |
| D1 | Конверт vs голый объект в ответах | Medium | API-форма |
| D3 | CLI не умеет бинарь | Medium | tooling |

### Пакет «минимальный guardrail для следующего прогона» (рекомендуемый порядок)
1. A1 (период-инвариант) + A3 (gross-проверка) — прямые ошибки книг;
2. A2 (resolve-supplier → draft) — закрывает канал, через который A3/A4 попадают в ledger;
3. B1+B2 (атомарный upload + retry transient) — разлочит 7 документов и прекратит пополнение класса;
4. C1 (валидация entity_id на выходе Pass-2) — уберёт основную массу мусорного needs_triage;
5. D2 (regen CLI-спеки в CI) — дёшево, возвращает агенту зрение.

> Все «воспроизведено» — на живом bk.010.ee в этом прогоне; строки кода — `main@3a71a66`. Побочные эффекты прогона на проде (все — по явному подтверждению владельца, не отменялись): период 2026-07; expenses 74-76 + vouchers V-2026-000027/28/29 (V-…27 забукан с суммой по A3 — владелец решил оставить; кандидат на correction). Прочая работа — read-only.
