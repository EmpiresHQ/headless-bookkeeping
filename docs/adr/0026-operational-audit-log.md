# An append-only operational Audit log, distinct from the ledger hash-chain

ADR-0014/0015/0016 all assert "every action is logged," but no first-class action log existed — the "audit trail" was scattered across the `approval` lifecycle fields, the `finding_transition_audit` columns (ADR-0018), and `conversation`/`message` rows, with security-relevant interaction-layer events (who was gated in/out, who committed an **Action point**, a failed webhook secret-token) going only to an ephemeral `Logger`. Wave 8 surfaced the gap: the interaction layer makes access decisions that must be durably attributable. This ADR introduces a single, general **Audit log**.

## Decision

- **One append-only `audit_log` table**, kernel infrastructure: `{ id, occurred_at (unix-s), actor, action, target_type?, target_id?, outcome, detail? (JSON) }`. `actor` is the resolved **Principal**'s sender id (or `'system'`); `action` is a dotted event name (`interaction.gate.converse_denied`, `interaction.action_point.commit`, `interaction.webhook.auth_failed`, `interaction.ingest`, …); `outcome` is `allowed | denied | accepted | rejected | quarantined | …`.
- **Append-only via SQL immutability triggers** (`BEFORE UPDATE`/`BEFORE DELETE`, the same mechanism that protects posted vouchers) — but **NOT hash-chained**. The audit log is an **operational** record (like the **Conversation** aggregate — CONTEXT.md: "an auditable operational record … but **NOT** part of the hash-chained ledger"). ADR-0013's hash chain proves the *ledger* was not altered; mixing operational interaction events into it would conflate operational logging with accounting integrity.
- **`AuditLogService.record(entry)`** is the sole write path. The **interaction layer is the first writer** (Wave 8a): the router records gating decisions, action-point commits, and ingest dispositions; the Telegram webhook records secret-token failures. Other subsystems (Approval commit/reject, period lock, corrections) adopt it incrementally — the table and service are general, not interaction-specific.
- **Distinct from `AuditFinding`** (ADR-0018): an **AuditFinding** is a forward-looking *attention item* the SecretaryAgent nags about; the **Audit log** is a backward-looking *record of what happened*. They share the word "audit" and nothing else.

## Why

Chosen over (a) leaving each subsystem to log its own way (the status quo — no queryable trail, ADR-0015's promise unmet), (b) folding interaction events into the hash-chained ledger (conflates operational events with accounting integrity; pollutes the voucher chain with non-postings), and (c) an interaction-only log (would be re-invented the moment Approval/period-lock need the same trail). A general append-only operational log, immutable but not hash-chained, matches what the events are: durable, attributable operational facts that are not accounting postings.

## Consequences

- New kernel module `src/audit-log/` (`AuditLogService` + types) and migration `033_create_audit_log` (table + immutability triggers).
- New domain term (CONTEXT.md): **Audit log**.
- Wave 8a writes the first entries; the per-subsystem rollout (Approval, corrections, period lock) is follow-up work, tracked but not retrofitted here.
- The log is queryable by `actor` / `action` / `target` for forensic review; the Admin API may expose a read endpoint later (out of 8a scope).
