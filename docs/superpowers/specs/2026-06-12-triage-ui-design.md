# Triage UI — полноценный разбор needs_triage документов

**Дата:** 2026-06-12  
**Ветка:** feat/triage-ui (создать от main)

## Проблема

IntakeView сейчас обрабатывает только один сценарий триажа: `supplier-unresolved`. Все остальные причины (`low confidence`, `category-unresolved`, `OCR failed`, `correction`, `duplicate`) оставляют оператора без действий — документ висит навечно или его можно только отклонить.

Также не видна причина, по которой документ застрял.

## Решения по дизайну

| Вопрос | Решение |
|--------|---------|
| Лейаут | Раскрывающиеся строки (expandable rows) — контекст не теряется |
| Manual classification | Редактируемая форма, предзаполненная данными AI |
| OCR failed | Кнопка загрузить другой файл + Dismiss |
| VAT marking | Включить в форму ручной классификации |
| Correction/Duplicate | Только Dismiss (Task 43 — отдельная фича) |

## Архитектура

### Backend — 2 новых эндпоинта

#### `GET /api/triage/needs-triage`

Возвращает документы в статусе `needs_triage` вместе с причиной и машиночитаемым типом причины.

```typescript
// Response
{
  items: Array<{
    id: number;
    filename: string;
    created_at: number;
    reason: string;          // человекочитаемое из audit_finding.description
    reason_type:             // машиночитаемый enum — фронтенд выбирает форму по нему
      | 'supplier_unresolved'
      | 'low_confidence'
      | 'category_unresolved'
      | 'ocr_failed'
      | 'unimplemented'      // correction/duplicate
      | 'unknown';
  }>
}
```

`reason_type` вычисляется на сервере из `audit_finding.description` и/или из `IntakeFailure` категории (если есть). Фронтенд не парсит строки.

Реализация: JOIN `document` с `audit_finding` по `referenced_object_type='document'`, `finding_type='needs_triage'`, `status='open'`.

#### `POST /api/documents/:id/manual-classify`

Для случаев `low confidence` и `category-unresolved`. Оператор передаёт все поля вручную.

```typescript
// Request body
{
  supplier_id: number;
  category: string;
  document_vat_marking: string | null; // 'S' | 'Z' | 'E' | null
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string; // ISO date
  supplier_invoice_number?: string | null;
}

// Response: TriageOutcome (same shape as /resolve-supplier)
```

Реализация (в `TriageController` + `TriageService` + `IntakeWorkflowService`):
1. Проверить документ в статусе `needs_triage`
2. Создать expense через `ExpensesService.createExpense()`
3. Запустить `PostingPipelineService.runPipeline()` с `supplierKnown: true`, без `confidence` (manual override — не гейтить по AI confidence)
4. Перевести документ в `triaged`, закрыть `needs_triage` audit finding
5. Вернуть `TriageOutcome`

### Frontend

#### Новый API-вызов в `api.ts`

```typescript
// GET /api/triage/needs-triage
export interface NeedsTriageItem {
  id: number;
  filename: string;
  created_at: number;
  reason: string;
}
export const getNeedsTriageItems = () =>
  apiFetch<{ items: NeedsTriageItem[] }>('/api/triage/needs-triage')
    .then(r => r.items);

// POST /api/documents/:id/manual-classify
export const manualClassify = (id: number, body: ManualClassifyBody) =>
  apiFetch<TriageOutcome>(`/api/documents/${id}/manual-classify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
```

#### Новые компоненты

**`TriageManualForm.tsx`**
- При mount вызывает `getDocumentDebug(id)` для предзаполнения полей
- Поля: supplier (dropdown существующих), category (dropdown из плагина), document_vat_marking (S/Z/E/null), gross_amount, vat_amount, currency, tax_point_date, supplier_invoice_number
- Submit → `manualClassify()` → колбэк `onDone()`

**`TriageOcrFailedForm.tsx`**
- `<input type="file">` → `uploadDocument(file)` → `triageDocument(newId)` → `completeDocument(oldId)` → `onDone()`
- Кнопка Dismiss → `completeDocument(id)` → `onDone()`

**`TriageSupplierForm.tsx`**
- Существующий `ResolveSupplierForm.tsx` адаптировать под inline-режим (убрать модальную обёртку, принять `onDone` колбэк)

#### Рефактор `IntakeView.tsx`

```
needs_triage секция:
  state: expandedId: number | null
  state: needsTriageItems: NeedsTriageItem[]

  на mount: getNeedsTriageItems()

  каждая строка:
    клик → expandedId = item.id (или null если уже открыт)
    показывает reason badge
    если expandedId === item.id:
      рендерит форму по типу причины (см. ниже)

  определение типа формы по reason_type:
    'supplier_unresolved'            → <TriageSupplierForm>
    'low_confidence'
      | 'category_unresolved'        → <TriageManualForm>
    'ocr_failed'                     → <TriageOcrFailedForm>
    'unimplemented' | 'unknown'      → только кнопка Dismiss
```

Все формы принимают `documentId` и `onDone` (закрывает строку + обновляет список).

## Категории и поставщики для форм

**Категории** зависят от country plugin. Проверить есть ли `GET /api/categories` — если нет, добавить как шаг 3. Возвращает `string[]` валидных категорий для текущей организации.

**Поставщики** (для `TriageSupplierForm` и `TriageManualForm`) — уже есть `GET /api/entities?role=supplier`, возвращает список supplier-entities.

## Что не входит в скоуп

- Correction / Duplicate handling (Task 43)
- Редактирование expense после создания
- Пагинация списка needs_triage

## Порядок реализации

1. Backend: `GET /api/triage/needs-triage`
2. Backend: `POST /api/documents/:id/manual-classify`
3. Backend: проверить/добавить `GET /api/categories`
4. Frontend: `api.ts` — новые типы и вызовы
5. Frontend: `TriageManualForm.tsx`
6. Frontend: `TriageOcrFailedForm.tsx`
7. Frontend: адаптировать `ResolveSupplierForm` → `TriageSupplierForm`
8. Frontend: рефактор `IntakeView.tsx` — expandable rows + getNeedsTriageItems
