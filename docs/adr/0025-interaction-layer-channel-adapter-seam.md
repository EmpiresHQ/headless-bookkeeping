# Wave-8 interaction layer: channel-adapter seam, unified envelope, channel-agnostic Principal gating

Wave 8 connects humans to the kernel (Waves 1-6) and the AI ingestion brain (Wave 7) over channels (Telegram, email, Slack, Drive). The risk is that channel quirks (Telegram webhooks, email DKIM/SPF + threading, Slack blocks) leak into the router, the conversational flows, and the gating logic — duplicating rules per channel and making the core untestable without live network. This ADR fixes the architectural shape of the interaction layer. It extends ADR-0016 (intent routing) and ADR-0014 (channels/approvers); it does not change the kernel, which remains the sole system of record, nor the rule that the router is **not** a security boundary (a misroute only ever yields a draft, gated by Rules → Policy, ADR-0012/0019).

## The cut

- **Channel adapters are the only channel-specific code.** Inbound, an adapter maps a raw channel payload into a **unified envelope** `{ channel, sender, conv-key, message, attachments, metadata, auth }`; outbound, it renders an abstract **Action point** / dialogue reply into the channel's wire form. The core — router, flows, **Conversation** aggregate, posting pipeline — is **channel-agnostic** and never sees a raw payload.

- **Each adapter splits at a transport seam.** A pure **mapper** (raw payload ↔ envelope, no I/O, unit-testable in isolation) plus a thin injectable **transport port** (the live Telegram Bot API / SMTP / webhook-send edge). Tests **mock the port**, so the whole interaction core runs under the established real-DI in-memory-SQLite harness with **no live network**. The inbound webhook is a real-but-thin NestJS controller that hands the raw update to the mapper and does nothing else.

- **The router emits a discriminated `RoutedIntent`.** Deterministic **Conversation** resolution (by `conv-key`) happens first; then a Mastra+Zod classification agent produces `{advisory} | {action, actionIntent, fields} | {report,…} | {reconciliation,…} | {clarify, question}` (the four ADR-0016 classes plus a `clarify` branch the agent itself chooses when unsure). Non-`clarify` intents are handed to an injectable **`FlowDispatcher`** port (stubbed in 8a; real flows for 8b); `clarify` emits an outbound question via the transport port and leaves the Conversation open. The flows depend on the router, not the other way round, and can be built and swapped independently.

- **Access gating lives once in the core over a channel-agnostic Principal.** The adapter normalizes auth signals onto `envelope.auth`; the core resolves a **Principal** (role `approver/owner | known-counterparty | unknown` + an `authVerified` flag) and gates per track: converse/command → approver; ingest → known-counterparty per `ingest_policy`; an Action-point commit → approver **and** `authVerified`. This generalizes ADR-0016's email-only gating (`email_whitelist`, DKIM/SPF) to every channel. Telegram realizes it as a `telegram_allowlist` (chat-id; = `approvers` for the single-owner deployment) plus a **webhook secret-token** verified at the transport port (transport-level authenticity, not a core concern).

## Why

Chosen over (a) **per-channel handlers** that each route, gate, and call the pipeline — which would duplicate the gating rules and the Conversation/intent logic N times and rot out of sync; and over (b) **live-integration adapters** with no port seam — which would force every interaction test onto a real Telegram/SMTP endpoint (secrets, network, flakiness), breaking the repo's in-memory real-DI discipline. The port indirection and the `Principal`/`RoutedIntent`/`FlowDispatcher` abstractions look like over-engineering for a single channel, which is exactly why this is recorded: they exist so that 8b (flows) and 8c (email adapter + HITL outreach) slot in **without touching the core**, and so a future Slack/Drive adapter is a new mapper + port, nothing else.

## Consequences

- New domain terms (CONTEXT.md): **Channel adapter**, **Unified envelope**, **Principal**.
- New config (CONFIG.md): `ingest_policy`, `telegram_allowlist`; the stale "ingest open to any sender" note on `email_whitelist` is corrected (ingest is sender-gated — the Wave-8 amendment to ADR-0016).
- 8b/8c inherit these seams: `FlowDispatcher` implementations (8b) and the email confirmation-loop Action point + findings-as-outreach (8c) are additive, not core rewrites.
