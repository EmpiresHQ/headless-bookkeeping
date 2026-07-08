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
- **Bank**: import is an explicit async flow (upload → LLM mapping → applied
  rules → created), with status card and explicit failure + re-upload CTA;
  statement screen has unmatched counter, proposal chips with confidence,
  auto-selected high-confidence proposals, bulk Book with server-side cap
  enforcement (client stops duplicating cap math); tx detail offers N:M
  candidate selection with running remainder, manual match, and disposition
  actions with plugin advisory copy; personal disposition routes through
  approval (ADR-0017).
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
   transitions), query layer, TokenGate/401.
2. Inbox (triage + approvals) — the flagship flow.
3. Books (expenses/invoices/documents/credit-notes + corrections).
4. Bank (import, statements, matching, dispositions).
5. Reports (periods, KMD, lock guard, submissions).
6. Settings (all subsections) + final cleanup: delete dead components, old
   tabs.tsx, `window.*` dialogs; every old screen removed.
