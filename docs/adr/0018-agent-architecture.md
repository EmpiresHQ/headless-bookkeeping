# Agent architecture: five agents, split by zone + capability, detection decoupled from outreach

Agents are separated by responsibility zone and risk/capability, not cosmetically. Each gets a minimal toolset; all share the same `controller → service ← tool` services and reach the ledger only through the pipeline (Rules → Policy). Mastra is the orchestration / conversational-state / middleware layer *above* the services — it can "think" freely but has no access to `post()` (ADR-0012); every output funnels through the pipeline.

**Conversational state is two layers, not one.** Mastra's "conversational-state" above is *transient working memory* (the model's scratchpad for a turn). It is distinct from the **Conversation** — a persisted, auditable domain aggregate (the thread's **Message**s + **Artifact**s, associated M:N to the **Document**(s) and business object(s) it processes). The router resolves the Conversation deterministically by channel + thread key (ADR-0016); a bare reply reuses the original Document via that binding. The Conversation is the durable audit record (not part of the hash-chained ledger — that stays the accounting system of record); Mastra memory is ephemeral and rebuildable from it.

**Runtime choice (Wave-7, ADR-0024): Mastra, embedded in-process.** `@earendil-works/pi-agent-core` was evaluated and rejected — it lacks first-class structured output and durable suspend/resume, both central here; Mastra provides both, is Zod-native (matching the kernel), and its workflow engine fits the 2-pass intake. Agents reach the ledger ONLY through tools that are thin wrappers over kernel services: read-tools are free, the sole write-tool funnels through Rules→Policy→post, there is **no `post()` tool**, and each agent gets a minimal toolset. Human-in-the-loop is a Mastra Workflow `suspend()` (durable snapshot, survives restarts) correlated with a domain **Approval** (the SoR; resume fires when the Approval resolves). AI confidence is a Policy input, never Rules; the AI proposal + model id/version are persisted for audit, outside the hash chain.

| Agent | Trigger | Ledger | Messages user |
|---|---|---|---|
| **AccountingAgent** | reactive (intake / command) | draft/submit via pipeline | on request |
| **ReconciliationAgent** | reactive (bank statement) | proposes match/disposition → approval | on request |
| **AuditAgent** | trigger + cron | none; **writes AuditFindings** | **no** |
| **SecretaryAgent** | cron | none | **yes — working hours only** |
| **DevAgent** | on request, off by default | outside the ledger entirely | — |

- **AuditAgent is structurally read-only on the ledger** — it cannot even create a draft. Its sole output is the persisted **AuditFinding** (anomaly + severity + reference). It runs on triggers and on cron (e.g. nightly), at any hour, and never messages the user directly. If an auditor could write, it would not be an auditor.
- **ReconciliationAgent proposes**, never commits: matches and dispositions (including the "personal" disposition, ADR-0017) go through approval.
- **SecretaryAgent is the only proactive, user-facing agent.** Cron-driven but constrained to configurable **working hours** (it stays silent at night). Read-only; it never posts. Its worklist is the open queue needing user action: pending approvals (the reminders of ADR-0014/0015), unresolved AuditFindings, missing receipts, approaching VAT deadlines, unmatched bank lines, aging unpaid invoices, personal-disposition repayments. It nags via Telegram (buttons → the user can act immediately), with anti-spam discipline: batch into a digest, escalate only the urgent, respect snooze.

The key decoupling: **detection and outreach are separated by the persisted AuditFinding buffer.** AuditAgent may run at 2am and fill the findings table; SecretaryAgent reads that table during working hours and does the nagging. Findings are never lost, and the user is never pinged at night.

## Severity drives nag cadence

The SecretaryAgent's worklist is the severity-ranked set of AuditFindings (the things needing attention are materialized as findings: long-pending approval, missing receipt, approaching VAT deadline, etc.). **AuditAgent assigns and re-scores `severity`; the SecretaryAgent's nag cadence is a function of it** — low → ~daily, high → ~hourly (mapping configurable). It never re-asks the same finding more often than its severity allows (tracks last-nagged per finding), so the same invoice is chased once a day, not hourly.

**Severity is dynamic, not static** — deadline-driven findings escalate as the deadline nears ("period closes in 30 days" is low; "in 2 days" is high). AuditAgent re-scores on each cron sweep, so escalation falls out of the existing sweep — no separate escalation timer. The Secretary just reads the current severity.
