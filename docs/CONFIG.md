# Configuration surface

A living catalog of everything configurable, organized by tier. Populated as decisions land in `docs/adr/`. This is *what* is configurable and *where* it lives — not the values.

Tiers, from least to most runtime-mutable:

1. **Deployment / env** — set once per container, rarely changed (a change often means a redeploy).
2. **Organization** — the single business's settings (ADR-0003: one Org per deployment).
3. **Policy** — the risk gate; the knob most likely to be tuned over time (ADR-0005).
4. **LLM profiles** — per-task model settings.
5. **Channels** — integration credentials/endpoints.
6. **Feature flags** — deferred/optional capabilities.
7. **Plugin-provided choices** — options the country plugin offers, the Org picks from.

---

## 1. Deployment / env

| Key | Meaning | Source ADR |
|---|---|---|
| `BASE_CURRENCY` | Single reporting currency, fixed per deployment | 0003, 0004 |
| `COUNTRY_PLUGIN` | The one active country plugin | 0002, 0003 |
| `ORG_COUNTRY` | Organization's country | 0003 |
| `ORG_VAT_REGISTERED` | VAT-registration status (drives VAT-code resolution) | 0002, 0003 |
| `LLM_ENDPOINT` | External/self-hosted LLM base URL | vision |
| `DATA_DIR` | `./data` — sqlite, documents, backups | vision |
| `STORAGE_BACKEND` | local \| s3 \| r2 \| gdrive (optional) | vision |
| `DEV_AGENT_ENABLED` | Default `false` | 0007-adjacent / vision |

## 2. Organization

| Key | Meaning | Source ADR |
|---|---|---|
| `vat_period_frequency` | monthly \| quarterly \| half-yearly — chosen from plugin's allowed set (DK depends on turnover) | 0009 |
| `approvers` | Authorized approver identities (TG chat IDs / Slack user IDs / email addresses); email approver ⊆ `email_whitelist` | 0014, 0016 |
| `email_whitelist` | Addresses the system will converse with / take commands from; also the ingest allowlist under the default `known-only` `ingest_policy` (ingest is **sender-gated**, not open — Wave-8 amendment to ADR-0016) | 0016 |
| `ingest_policy` | `known-only` (default) \| `quarantine` \| `open` — gates inbound document ingest by sender allowlist; unknown → reject (known-only) / hold-for-onboarding (quarantine) / accept (open) | 0016 |
| `telegram_allowlist` | Telegram chat/user IDs the system will converse with and take commands from (the channel-agnostic **principal** allowlist for Telegram, mirroring `email_whitelist`); approvers ⊆ this set | 0014, 0016 |
| `approval_reminder_interval` | How often to nudge a pending approval (never auto-resolves) | 0014, 0015 |
| filing guard | warn-and-confirm on locking a period with unresolved in-period items (fixed behavior, not tunable) | 0015 |
| `secretary_working_hours` | Hours the SecretaryAgent may message the user (silent otherwise) | 0018 |
| `secretary_cadence` | Nag batching/snooze policy + `severity → interval` map (e.g. low → daily, high → hourly); severity is re-scored by AuditAgent each sweep, so escalation is automatic | 0018 |
| `audit_cron` | AuditAgent scheduled sweep (in addition to triggers) | 0018 |

## 3. Policy (risk gate)

The configurable gate deciding auto-post vs approval (ADR-0005). Rules are NOT here — Rules are inviolable code/plugin logic; Policy is the tunable risk layer.

| Key | Meaning |
|---|---|
| `auto_post_amount_ceiling` | Above this → approval required |
| `auto_post_min_confidence` | Below this AI confidence → approval required |
| `unknown_supplier_requires_approval` | Default true |
| `always_approve_operations` | Operation types that always need approval: invoice send, correction/reversal, credit note, VAT lock (period filing), bad-debt write-off, large expense, capitalization reclassification |
| `duplicate_fuzzy_flag` | Near-duplicate `(supplier, amount, date±window)` → flag to human (never auto-merge) (ADR-0010) |

## 4. LLM profiles

Per-task profile (vision): `provider, model, temperature, timeout, structured_output`. Tasks: `intent_routing`, `ocr`, `processing`, `advisory`, `audit`, `reconciliation`, `dev_agent`. Note: `intent_routing` is deliberately a strong/expensive model with rich conversational context — cost is not a concern there (ADR-0016).

## 5. Channels

| Channel | Config |
|---|---|
| Telegram | bot token, webhook; approver chat IDs (ADR-0014); supports action-point buttons → approval channel (ADR-0016) |
| Slack | app/bot token; approver user IDs (ADR-0014); supports action-point buttons → approval channel (ADR-0016) |
| Email | Ingest **sender-gated** by `email_whitelist` (deterministic; `ingest_policy: known-only [default] | quarantine | open`, ADR-0016 Wave-8 amendment); conversation/commands whitelist-only; action/approval = approver ⊆ whitelist via confirmation loop (explicit "YES" / re-ask) + DKIM/SPF; SMTP outbound = dialogue only (replies/re-asks/reports) — invoice rendering/delivery is a v2 plugin, not v1 (ADR-0016) |
| Google Drive | watcher folder/credentials (passive intake) |
| HTTP/webhooks | n8n / automation endpoints |

## 6. Feature flags (deferred/optional)

| Flag | Default | Source ADR |
|---|---|---|
| `depreciation_engine` | off (expense-by-default; year-end AI sweep proposes) | 0007 |
| `merkle_external_anchor` | off (per-period Merkle root still computed) | 0013 |
| `cash_basis_report_view` | off (ledger is accrual; cash is only a view) | 0008 |

## 7. Plugin-provided choices

The country plugin owns these as rules; the Org configures only where the plugin offers a choice:

- VAT codes, rates, deductibility, rounding, report export formats — plugin rules, not user settings (0002).
- Capitalization threshold, depreciation method/useful life — plugin rules (0007).
- Identity key (DK: CVR) + optional registry lookup — plugin (0014).
- VAT tax-point definition, advance-VAT (Art. 65), bad-debt VAT relief (Art. 90), correction-vs-amended-return threshold — plugin rules (0004, 0008, 0009, 0011).
