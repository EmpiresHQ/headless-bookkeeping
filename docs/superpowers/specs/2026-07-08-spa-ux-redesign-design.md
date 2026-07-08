# Operator SPA UX redesign — design

**Date:** 2026-07-08
**Status:** Approved (design), pending implementation plan
**Author:** brainstorming session (aleksei@verifi.finance)
**Visual previews:** style directions and approved screen mockups live as Claude
artifacts (style comparison: `first-three-directions`; approved screens:
`mobile-and-desktop-screens`). The token values below are canonical.

## Problem

The current `packages/web` SPA is a flat set of 14 CRUD tabs bolted onto the
headless kernel. A code audit and an ADR/product-doc review agree on the
diagnosis:

- **Navigation is broken.** react-router is mounted but only the tab is in the
  URL; all inner state (selected statement, expanded document, KMD period)
  lives in `useState` — F5 loses context, deep links are impossible, browser
  back does nothing inside a screen. The Document→Expense link is dead
  (`#expense-N` anchor that doesn't exist). ApprovalsView is a dead end: no
  way to reach the object being approved; approve/reject go through
  `window.prompt`. `window.confirm/alert` are used as UI in ~10 places.
- **Feedback is inconsistent.** Half the screens have no loading state (a
  false "Nothing here yet." flashes), OCR takes minutes with no polling, no
  optimistic updates (every mutation refetches and collapses the table),
  copy-link has no success feedback.
- **No design system.** Empty `tailwind.config`, zero tokens, no reusable
  Button, no dark-mode story, raw `<table>`s in Bank/KMD/Categories that are
  unreadable on mobile.
- **CRUD paradigm contradicts the docs.** ADRs mandate flow-first UX (intake→
  triage→posting, approvals, filing-with-guard, reconciliation dispositions,
  correction-as-reversal) — not isolated tables. Categories as a CRUD tab
  contradicts plugin ownership; the Kmd tab ignores the submission lifecycle
  (ADR-0037); nothing surfaces roadmap items (fixed assets, annual accounts,
  claimant, discarded view).
- **A real bug:** CreditNotesView takes amounts in raw cents while
  Expenses/Invoices take euros — typing "100.00" creates a 1-cent note.

## Decisions (locked with the operator)

1. **Unified Inbox**: needs_triage documents + pending approvals in one queue.
2. **Everything fully functional on the phone**, including bank reconciliation
   and period lock. Desktop is a first-class citizen too (two-pane layouts).
3. **Flow-first IA**: 14 tabs collapse into 5 sections.
4. **Visual style "A+C"**: iOS-neutral skeleton (large titles, inset grouped
   lists, system font stack) + fintech-tonal accents (period hero card, status
   chips, ink-green brand accent instead of default blue).
5. **Dark theme later** — but all colors go through semantic tokens from day
   one so it becomes a token swap.
6. **Strategy: new shell in place** — new app shell in `packages/web`, every
   screen rebuilt on it, old View components deleted as replaced. `api.ts` is
   reused (wrapped in query hooks).

## Information architecture

Five sections; bottom tab bar on mobile, sidebar on `lg:`. Entities get push
routes (deep-linkable); actions get bottom sheets; irreversible operations get
confirm dialogs. List filters/segments live in query params. Same route tree
on both form factors — desktop renders list+detail as two panes via nested
routes and `<Outlet/>`.

```
/inbox                              unified queue (segments: All | Triage | Approvals)
/inbox/doc/:id                      triage detail (resolve supplier / manual classify /
                                    ocr-failed / retry / dismiss; forms as fullscreen sheets)
/inbox/approval/:id                 approval detail (facts + document preview + Approve/Reject)

/books                              segments: Expenses | Invoices | Documents | Credit notes
/books/expenses, /books/expenses/:id        detail: facts, linked document, correction chain,
                                            bank-match status; Correct via sheet
/books/invoices, /books/invoices/:id        same + credit-note creation entry point
/books/documents, /books/documents/:id      archive incl. discarded filter (ADR-0038);
                                            details strictly from persisted intake artifacts (ADR-0039)
/books/credit-notes, /books/credit-notes/:id
  (+ create flows: new expense / new invoice / upload document — FAB / header "+";
   upload sheet includes optional claimant dropdown, ADR-0036)

/bank                               statements list + async import status
/bank/import                        import flow (file + account; async Mastra run with
                                    progress polling and explicit failure state, ADR-0031)
/bank/statements/:id                transactions (segments: All | Unmatched | Matched);
                                    propose-matches; multi-select bulk "Book selected"
/bank/statements/:id/tx/:txId       tx detail: N:M match candidates, manual match,
                                    dispositions (prepayment / personal / bank fee) with
                                    plugin advisory text (ADR-0017, ADR-0011)

/reports                            periods list: open/locked + folded submission state
/reports/periods/:id                KMD boxes (expandable), review flags, INF gaps with
                                    fix-link, unresolved in-period items, downloads (XML/CSV)
/reports/periods/:id/lock           filing guard: warn-and-confirm with stragglers list
                                    (pending approvals, drafts) — modal/sheet flow (ADR-0015)
/reports/periods/:id/submissions    event log: prepared → submitted → accepted/rejected,
                                    operator-attested, with refs (ADR-0037)

/settings                           grouped list (iOS Settings idiom):
/settings/organization              org form (country, type, VAT, IBAN, base currency)
/settings/entities, /settings/entities/:id   suppliers/customers/claimants + aliases
/settings/mailbox                   connectors, sync, OAuth, IMAP
/settings/policy                    intake policy + risk gate (euro inputs, not cents)
/settings/llm                       LLM agent settings
/settings/enroll                    device enrollment QR
/settings/categories                READ-ONLY category reference (plugin-owned)
```

Tab-bar order: **Inbox (badge) · Books · Bank · Reports · Settings**.

**Dissolution map (all 14 old tabs):** Intake+Approvals→Inbox; Expenses,
Invoices, Documents, CreditNotes→Books; Bank→Bank; Kmd+Periods→Reports; Org,
Entities, Categories, Enroll, Mailbox, Settings→Settings.

**Cross-links (fixing dead ends):** approval→object→document; document→expense;
expense→its document and bank match; bank match→object; INF warning→the
expense missing an invoice number. Every one is a real route navigation.

## Navigation shell

- Migrate to **`createBrowserRouter`** (data mode) — prerequisite for view
  transitions; lazy route modules per section.
- Mobile: bottom tab bar, visible inside section stacks, hidden in fullscreen
  tasks (document viewer, long forms). Real `history.back()` for back buttons.
- Desktop (`lg:`): narrow sidebar; list routes render a two-pane master-detail
  (list pane + `<Outlet/>` detail pane); ⌘K command palette (cmdk) and j/k/e/r
  hotkeys in queue screens.
- **View transitions**: react-router `viewTransition` links; directional
  slide for push/pop + one shared-element transition (list→detail);
  `prefers-reduced-motion` disables them. Graceful no-op on old browsers.
- Rule of thumb: *object with identity → push route; action on an object →
  bottom sheet (vaul); irreversible → confirm dialog.*

## Design system

Semantic tokens in `tailwind.config` (light values now; dark theme is a later
token swap — no scattered `dark:` classes):

| Token | Value (light) | Use |
|---|---|---|
| `bg` | `#F2F3F1` | app background (green-biased neutral) |
| `surface` | `#FFFFFF` | cards, grouped lists |
| `ink` | `#191C1A` | primary text |
| `ink-2` | `#6E756F` | secondary text |
| `line` | `#EEF0EC` | hairline dividers |
| `accent` | `#0E5A3C` | brand ink-green: primary buttons, links, active tab |
| `accent-deep` | `#0E3B2C` | hero card background |
| `signal` | `#3DDC97` | mint — hero CTA only |
| `ok` / `warn` / `err` | `#14713F` / `#8A5A00` / `#A83A2C` | status chips (with tonal backgrounds `#E3F2E9` / `#FDF0D3` / `#FBE9E5`) |
| `alert` | `#E8590C` | badge counts |

Type/shape: system font stack; large titles `text-3xl font-extrabold
tracking-tight`; body 15px; secondary 13px; amounts `tabular-nums font-bold`;
groups/cards `rounded-2xl`; chips `rounded-full`; buttons `rounded-xl`.

**UI kit** (own components, shadcn-style copy-paste, built on Radix
primitives): Button, ListGroup + ListRow, Chip, Sheet (vaul), ConfirmDialog,
Toast (sonner, with Undo), SegmentedControl, LargeTitleHeader, NavStack
header, TabBar, Sidebar, EmptyState, Skeleton, KeyValue, AmountText, Field
(label + validation + error), SearchInput, FAB, HeroCard, Timeline.
**Banned:** `window.prompt/confirm/alert`.

Dependencies added: `@tanstack/react-query`, `radix-ui` primitives (as needed),
`vaul`, `sonner`, `cmdk`, `motion` (via LazyMotion, gestures/list animations
only), `lucide-react`. Not adopted: Konsta (needs Tailwind 4), Ionic.

Tables: one `Row` component renders as a card row on mobile and a
priority-column table row on `md:`+. Horizontal-scroll tables are not used;
low-priority columns hide per breakpoint and remain in the detail route.

## Data layer

- **TanStack Query** for all reads/mutations: cache across tab switches,
  invalidation after mutations, `refetchInterval` polling for intake
  processing and the bank-import job, skeletons instead of false empty
  states, explicit error states.
- **Optimistic updates + Undo toast (≈5s)** for reversible actions (approve,
  dismiss, match, sync). **Plan→confirm→receipt** for irreversible ones
  (period lock, delete, finalize) — never optimistic.
- Global 401 handling: query-layer error boundary clears the token and
  returns to TokenGate immediately (fixes the current desync).
- Forms: single `Field` pattern with per-field validation; **all money inputs
  in euros** (fixes the credit-note cents bug); submit disabled until valid;
  currency/country inputs constrained.
- `api.ts` is kept as the transport layer; a new `queries.ts` layer exposes
  typed hooks per resource.

## Data display rules (global, all screens)

Canonical visual reference: `assets/2026-07-09-screens-data-redesign.html`.

1. **IDs are not data.** The leading column/title always answers "what is
   this" (counterparty, document subject) — raw IDs live in URLs and detail
   screens only.
2. **Every object has a detail route.** No dead ends: approval → object →
   document; expense → document, bank match, supplier; all links are real
   navigations.
3. **Reasons in human language with numbers.** Never `amount_over_ceiling`;
   always "89,00 € выше лимита 50,00 €" — threshold and fact from config.
4. **Progressive disclosure.** List answers "what needs deciding"; detail
   answers "what are the facts"; expansion answers "where do facts come
   from" (OCR markdown, classification).
5. **Money and dates by standard.** Amounts: tabular-nums, right-aligned,
   never wrap (`flex:none; white-space:nowrap`), inflows green with "+";
   VAT belongs to detail, not lists. Dates: relative in lists, absolute in
   details.
6. **Sections with totals instead of pagination.** Time-grouped lists
   (month / today-yesterday) with per-section totals recomputed under the
   active filter.
7. **Forms: prefill → confirm.** Everything the system knows (OCR, supplier
   memory, country VAT rate, last-used category) is pre-filled; the operator
   verifies, not types. Submit buttons state the outcome with the amount
   ("Создать расход · −48,20 €"), never "Submit".
8. **Object selection is never ID entry.** Searchable pickers with context
   (number · counterparty · amount · outstanding), not "enter object ID".

## Screen-level UX decisions

- **Inbox**: hero card (open period, month total, "Разобрать" CTA); queue
  rows with type icon, one-line reason, amount, chip; swipe right = primary
  action, swipe left = more (with visible button fallbacks on detail and
  desktop hover); progress "N of M" in detail nav; inbox-zero state; polling
  keeps the queue live. Approve is one tap + Undo; Reject opens a sheet with
  a reason field (no `window.prompt`). Triage forms (resolve supplier, manual
  classify expense/invoice, OCR-failed) are fullscreen sheets reusing current
  form logic, restyled. Approvals show all `object_type`s and link to the
  object. **The approval path uses `POST /api/approvals` → approve — never
  `/post` for held objects** (documented API trap).
- **Books**: month section headers with totals; status chips
  (draft/pending/posted + corrected marker); detail shows linked document
  thumbnail (persisted preview), correction provenance chain
  (`reverses`/`corrects_object`), bank-reconciliation status; Correct = sheet
  with kind selection (cosmetic/financial/credit-note per ADR-0009 branching);
  Delete only for drafts, blocked for posted-linked documents (ADR-0012).
  Documents segment includes a `discarded` filter (ADR-0038).
- **Bank** — THE core section; ~90% of operator time. Detailed screen states
  are canonical in `assets/2026-07-09-tx-screen-states.html` (pixel grid,
  state routing matrix, gestures/hotkeys, invariants) and
  `assets/2026-07-09-screens-data-redesign.html` §6/6★/6★b. Summary:
  - **The core inversion — "bank line → expense".** The dominant real case is
    a statement line with NO matching object in the books (the receipt lives
    in some vendor's app, or doesn't exist at all). Instead of hunting the
    receipt first, the expense is created FROM the line in one tap:
    counterparty resolved via aliases (ADR-0014), category from
    classification memory, VAT auto-computed by country rate, tax point from
    the line; expense is created and matched atomically (composable today:
    `POST /api/expenses` + `POST /match`). Document policy is a choice:
    **"чек будет позже"** → expense enters a "Ждут документ" queue and a
    later-arriving document (email/photo/connector) is auto-suggested for
    attachment by supplier+amount±date; **"чека не будет"** (croissant case)
    → the statement line itself is the source record, **VAT auto-set to 0
    (non-deductible without an invoice — the form knows this rule)**, no
    nags; optional Policy guardrail: no-doc expenses above a threshold go to
    approval.
  - **Tx screen state routing** (first match wins, alternatives always
    visible below): already-matched → match card + Unmatch; AI proposal
    ≥0.85 → preselected confirm; candidates exist → N:M checkboxes with live
    remainder (remainder never lost: invoice / prepayment / owner-debt);
    recurring counterparty → "как в прошлом месяце" one-tap repeat; alias
    hit → prefilled create; unknown counterparty → inline supplier
    mini-create (line text becomes the alias); incoming with no invoices →
    prepayment or owner-debt repayment; fee-heuristic → one-tap Bank fee.
  - **Personal disposition** — never shows chart of accounts (ADR-0001/0017):
    sheet explains consequences in human terms (not in P&L, no VAT
    deduction, becomes owner's debt) + live owner-debt balance
    ("сейчас 217,80 € → станет 236,40 €"); approve-on-the-spot (operator is
    the approver — one attributable tap records disposition + approval);
    repayment closes via the same statement flow (incoming line offers
    "закрыть долг владельца").
  - **Statement list color coding**: matched = 3px green left stripe + ✓
    icon + dimmed text with object link in subtitle; AI proposal = checkbox
    + amber confidence chip; unmatched = normal weight; waiting-for-document
    = 📎 marker. Status readable at a glance without reading text.
  - Import is an explicit async flow (upload → LLM mapping → applied rules →
    created) with a status stepper and explicit failure + re-upload CTA;
    bulk Book with server-side cap enforcement (client stops duplicating cap
    math); every action optimistic with 5s Undo; NO irreversible actions on
    this screen at all.
  - **Known server gaps** (deliberate scope extension, flagged for the Bank
    plan): alias-lookup by statement-line counterparty string; "waiting for
    document" marker + late-document auto-attach suggestion; recurring
    detection. Client flows degrade gracefully where these are missing.
- **Reports**: period rows show open/locked + folded submission state; KMD
  preview clearly labeled *live draft* vs *frozen snapshot*; INF gaps link to
  the metadata fix (`PATCH .../document-metadata`); lock flow lists stragglers
  and requires typed-out confirm; submissions screen is an append-only
  timeline with "add event" (submitted/accepted/rejected + ref). Layout
  reserves room for annual accounts and fixed assets (roadmap).
- **Settings**: iOS grouped-list hub; entities detail merges aliases (no more
  bottom-of-page panel); policy amounts in euros; categories read-only with
  explanation; enrollment QR unchanged functionally.

## ADR compliance checklist (design-time)

- Ledger never surfaces: no vouchers, accounts, debit/credit anywhere
  (ADR-0001/0030). Category is the only accounting word users see.
- Document details render only persisted intake artifacts; AI recompute only
  via explicit Retry in Inbox (ADR-0039).
- Corrections only through correction flow; posted objects read-only
  (ADR-0009).
- Filing guard warn-and-confirm, not hard block; stranded items keep nagging
  (ADR-0015).
- Submission lifecycle is operator-attested events over immutable snapshots
  (ADR-0037).
- Bank import is async with fresh LLM inference per upload (ADR-0031).
- Claimant dropdown on upload; claimant expenses always held (ADR-0036).
- Settings only exposes what `/api` + `/admin/settings` actually offer
  (ADR-0028) — no fake surface.

## Testing

Vitest + RTL stay. Tests are rewritten per screen against the new components
(existing test files die with their views). Query-layer tests mock fetch as
today. Router tests use `createMemoryRouter`. The UI kit gets its own
component tests (Sheet, ConfirmDialog, Field validation, Row responsive
rendering).

## Out of scope

- Chat/intent-routing surface (ADR-0016 is channel-side; not in this SPA).
- New backend endpoints — the redesign is client-only and consumes the
  existing API surface as documented in the audit.
- Dark theme palette tuning (tokens land now, palette later).
- Fixed assets / annual accounts screens (layout reserves space; screens come
  with their PRDs).
- PWA/offline, push notifications.

## Delivery shape (for the implementation plan)

1. Foundation: tokens, UI kit, router shell (tabs/sidebar, route tree,
   transitions), query layer, TokenGate/401. **[DONE — plan 01, branch
   `spa-redesign-foundation`]**
2. **Bank** (statements, tx-screen state machine, line→expense, dispositions,
   import) — promoted to first: it is the core pain and ~90% of operator
   time. Client-first on the existing API; server gaps (alias lookup,
   waiting-doc, recurring) follow as a dedicated step.
3. Inbox (triage + approvals).
4. Books (expenses/invoices/documents/credit-notes + corrections + "Ждут
   документ" queue).
5. Reports (periods, KMD drill-down, lock guard, submissions).
6. Settings (all subsections, entity cards with aliases + classification
   memory) + final cleanup: delete dead components, `window.*` dialogs;
   every old screen removed.
