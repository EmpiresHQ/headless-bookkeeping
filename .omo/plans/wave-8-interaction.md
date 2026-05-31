# Wave 8: Interaction layer — channels, router, conversational flows, outreach

> **STATUS: SCOPE STUB — not yet grilled into TDD tasks.** This file collects everything the Wave 4-7 grilling deliberately deferred to Wave 8. It is the canonical "what Wave 8 covers"; the per-task breakdown (numbered tasks, acceptance, QA) is produced in a dedicated grilling/`make-plan` session before execution. Do NOT dispatch agents from this stub.

## Overview
Wave 8 is the **interaction layer**: the channels (email/Telegram/Slack/Drive) and the intent **router** that let a human talk to the system, plus the conversational flows that ride on the Wave-7 Mastra runtime. The deterministic kernel (Waves 1-6) and the AI ingestion brain (Wave 7) already exist; Wave 8 connects humans to them. The ledger remains SoR; the router is not a security boundary (ADR-0016).

## Decisions so far (grilled — not yet TDD tasks)

- **Channel-adapter boundary:** adapters are the ONLY channel-specific code (inbound raw → unified envelope `{channel, sender, conv-key, message, attachments, metadata, auth}`; outbound abstract action-point → channel delivery). The core (router/flows/Conversation/pipeline) is **channel-agnostic**. Access gating (whitelist / DKIM-SPF) lives **once in the core** over the adapter's `auth` signals — not duplicated per adapter.
- **Router per inbound envelope:** (1) resolve Conversation (deterministic, by conv-key); (2) ingest attachments per the ingest policy; (3) if gated-in (whitelist + auth) and there's a message → classify intent (probabilistic) → dispatch flow. The router is **not a security boundary** — a misroute only yields a *draft* gated by Rules→Policy (ADR-0016/0012). Ingest and a dispatched intent are not mutually exclusive.
- **Ingest is sender-gated (reverses ADR-0016 "open"):** a deterministic sender allowlist configured at **initial setup** (editable via admin/config); **unknown → reject** by default (`ingest_policy: known-only | quarantine | open`). Anti-spam/hygiene only — the kernel never auto-books an unknown-supplier doc anyway (Wave-7 → `needs_triage`). Amended in ADR-0016 / CONTEXT.md / CONFIG / VISION.

## Scope (deferred here from earlier waves)

### Channels (ADR-0016, CONFIG §5)
- **Telegram**: bot + webhook; inline **action-point buttons** carrying `callback_data` (conversation/approval id — un-skippable commit signal).
- **Email**: ingest **sender-gated** by a deterministic allowlist (configured at setup; `ingest_policy: known-only [default] | quarantine | open` — unknown rejected by default, ADR-0016 Wave-8 amendment); conversation/commands whitelist-only; action/approval via **confirmation-loop** ("YES"/re-ask) + **DKIM/SPF**; outbound **SMTP** (invoices/replies/reports). Embeds the **Conversation id in the body** (`[conv:…]`) since threading headers can be stripped.
- **Slack** (buttons, like Telegram); **Google Drive** watcher (passive intake); HTTP/webhooks.

### Intent router (ADR-0016)
- **Deterministic Conversation resolution FIRST** (channel + thread key; email body `conv:` token / TG `callback_data`), then **probabilistic** intent classification (`advisory | action | report | reconciliation`). Wires the **Conversation aggregate** (Wave-6 Task 36, built service-level) to live channels.

### Conversational flows (on the Wave-7 Mastra runtime)
- **Outbound sales-invoice issuance** (the gap surfaced in W7 grilling): router intent `create_sales_invoice` → a Mastra **interview** flow (agent + tools: `searchCustomers` [Entity role=customer], `listCategories`, plugin for output VAT) collects customer/amount/date/lines → `SalesInvoice` draft (the Wave-3 kernel path already exists) → `generateDraftVoucher → Rules → Policy → post`. **No OCR** here — it is interview/collect, not extract. Then **SEND** the invoice (email/PDF) — a high-stakes **Action point**, approval-required (ADR-0016), outbound SMTP.
- **Advisory chat** (the `advisory` LLM profile) — read-only Q&A over the books.

### Human-in-the-loop delivery (the Wave-7 deferral)
- Deliver the durable **Approval** (held draft) and **AuditFinding(needs_triage)** (uncertain no-draft) to the user over a channel; the user's confirm/correct resolves the Approval → `approve → post`, or supplies triage → re-run. (Wave 7 builds the durable wait on our aggregates; Wave 8 is the transport.)

### SecretaryAgent outreach (ADR-0018)
- The only proactive, user-facing agent: cron + working-hours; reads the severity-ranked open **AuditFinding** queue; nags via Telegram respecting `last_nagged_at` anti-spam. Read-only (never posts).

## Prerequisites
- Waves 4-7 complete (kernel + AI ingestion + Conversation aggregate + Approval/AuditFinding + API token).
- **Re-review** the Wave-7 plan first (its post-Wave-5 gate) — Wave 8 leans on Wave-7 contracts.

## To grill before tasks
- Email confirmation-loop exact state machine; DKIM/SPF failure handling.
- Router intent taxonomy + misroute recovery (ADR-0016 says misroute is harmless — verify under real channels).
- Issuance interview: which fields are mandatory vs plugin-defaulted; multi-line invoices; customer onboarding mid-flow (mirror of supplier-at-intake, Wave-5 Task 35).
- SEND idempotency + the action-point/approval contract for outbound.
- Outbound artifacts (sent invoice PDF) as Conversation `Artifact` (`outbound_output` kind).
