# Email intake — design

**Date:** 2026-06-23
**Status:** Approved (design), pending implementation plan
**Author:** grill-with-docs session (aleksei@verifi.finance)
**Related:** ADR-0038 (delivery channel as intake-policy axis), ADR-0025 (channel-adapter seam), ADR-0024 (two-pass OCR ingestion), ADR-0016 (intent routing + email tracks, amended), intake-queue-design.md

## Problem

We want documents to enter intake from email. Two distinct shapes:

- **Pull** — connect the Organization owner's *own* mailbox(es) (Gmail/Outlook via OAuth, or any IMAP via credentials), read-only, and harvest invoice attachments out of the firehose.
- **Push** — a single dedicated, reserved accounting mailbox a counterparty/operator forwards invoices to deliberately.

The firehose is the hard part: most messages are not invoices, some are personal, some are invoices addressed to *other* parties. We must harvest the real invoices for *our* Organization without flooding the expensive OCR pipeline or burying the operator under noise.

## Two delivery channels, one transport

Per ADR-0038 the **delivery channel** carries an **intent prior** that drives an **Ingest profile**. Email splits into two channels with opposite priors but the **same IMAP transport**:

| | `email_sync` (pull) | `email_push` (pull, dedicated) |
|---|---|---|
| Mailbox | owner's general inbox(es) | one reserved accounting mailbox |
| Intent prior | ambient firehose | deliberate send |
| Cardinality | many connectors | **≤ 1** connector |
| Resolve **Principal** from sender | no | yes (for gating; DKIM/SPF from `Authentication-Results`) |
| `accept_without_recipient` (receipts) | off (default) | on |
| `accept_photos` (images vs PDF-only) | off | on |
| Non-match disposition | `discarded` (silent) | `needs_triage` |

A connector is configured as **exactly one** mode (push xor sync). Defaults are per-channel, overridable per-company and per-connector.

**Transport is orthogonal to treatment.** Both channels use one IMAP engine; `email_push` is not a webhook (self-hosted has no guaranteed public URL). An inbound-parse webhook (Postmark/SendGrid) is an optional alternative transport for a later wave, not v1.

## Per-message admission funnel (cheap → expensive)

| Step | Cost | Action | Fail → |
|---|---|---|---|
| 1. **Candidate gate** | cheap (headers/body, no OCR) | document-like attachment present? (**mandatory**) invoice-mention = **soft** priority signal only | skip — no `Document` created |
| 1b. **Attachment hygiene** | cheap | drop inline/cid images, logos, files < ~10–20 KB, non-document MIME (`.ics`, `.vcf`) | skip |
| 2. **Harvest** | cheap | `DocumentsService.upload(channel)` → `status='pending'` → `kick()` | — |
| 3. **OCR + Pass-2** | **expensive** | existing pipeline via the **serialized intake queue**; extracts fields incl. `recipient_match` (3-valued, **email-sync owns this extraction** — see coordination) | `needs_triage` |
| 4. **Recipient check** | cheap | `recipient_match ∈ {ours, other_party, none}` against our **Organization** | per Ingest profile |
| 5. **Disposition** | cheap | source-aware layer over `IntakeWorkflowResult` | — |

Attachment is mandatory (invoices often have empty bodies); the invoice-mention only raises priority. "Is it really an invoice" is decided by Pass-2 (`document_type`), not by a pre-OCR LLM on the firehose.

### Disposition (step 5), by Ingest profile

Decided by a **source-aware layer over `IntakeWorkflowResult`**, in this precedence order:

1. **Claimant short-circuit** (deliberate channels only) — if the document carries a `claimant_id` (resolved by the router from the sender; see the claimant-reimbursement work), it is **always** `needs_triage` (a human must confirm "did this person pay?"). This **outranks** the Ingest-profile disposition and Policy; a claimant document is **never** `discarded`. `email_sync` never sets `claimant_id` (it resolves no **Principal**), so this branch only fires on `email_push` / Telegram / iOS / upload.
2. **Ingest-profile disposition** on `recipient_match`:
   - `ours` → normal triage routing (auto-post / Approval via existing **Policy**).
   - `other_party` (positive conflict) → `needs_triage` (the operator's "остальные в триаж"). Divert **only on a positive conflict** — `none` (a receipt with no bill-to) is **not** a conflict.
   - `none` / "confidently not an invoice" → `discarded` on ambient channels (`email_sync`), `needs_triage` on deliberate channels.
3. **Policy** — the usual auto-post vs Approval gate.

For `email_push` (deliberate, reserved mailbox) the permissive profile means everything that lands there is meant to be an accounting document → non-matches go to `needs_triage`, not silently dropped.

The chosen terminal and its trigger are persisted as a short `disposition_reason` on the `document` (`other_party | not_invoice | claimant | …`) so the "discarded" view can explain *why*. `recipient_match` itself is **transient** (consumed at routing time, not stored as a column).

## Components

### `MailboxConnector` (new, own module)

A persisted connector row + a runtime sync engine. Stored fields: `channel` (`email_sync | email_push`), `auth_mode` (`oauth | password`), host/port/username, **encrypted** secret (refresh-token or app-password, encrypted at rest with a key from env — never plaintext, not in `setting`), folder (default `INBOX`), `ingest_profile` overrides, and the **sync cursor** (`uidvalidity` + last-processed `uid`). `email_push` is singleton.

### Auth: unified IMAP + XOAUTH2 (Q6/Q7)

One transport, three credential sources:
- IMAP + app-password → plain SASL.
- Gmail-OAuth / Outlook-OAuth → SASL **XOAUTH2** with an access token refreshed from the stored refresh-token.

**BYO OAuth app**: the operator supplies their own `client_id`/`client_secret` in config (self-hosted; we ship no central app). Scope is **read-only** (`gmail.readonly` / Graph `Mail.Read`). OAuth redirect → `{public_api_url}/api/mailbox/oauth/callback`, loopback fallback for pure-local.

### Sync engine: IMAP IDLE over a durable cursor (Q11, amended Q11→IDLE)

- **IDLE = realtime trigger.** On each `EXISTS`, fetch forward from the cursor (the IMAP analogue of intake-queue `kick()`).
- **Durable UID cursor = correctness.** Per-folder `(uidvalidity, last_uid)` in the connector row. On `uidvalidity` change, re-baseline the cursor to the current max UID (going-forward), do not re-harvest the folder.
- **Catch-up on (re)connect** from the cursor, so anything that arrived while the socket was down is harvested.
- **Re-IDLE every ~25 min** (servers drop IDLE at ~29).
- **OAuth reconnect ~hourly** — the XOAUTH2 access token expires (~1 h) and cannot be swapped mid-session; reconnect with a fresh token. App-password sessions persist.
- **Reconnect with exponential backoff** on drops.
- **`@Cron` safety sweep (~15–30 min)** — a cheap backstop `kick` for a missed IDLE signal or a silently dead half-open socket (mirrors the intake-queue cron sweep).
- **N persistent connections** for N mailboxes (units, not hundreds — YAGNI on scaling).

### First connect — harvest window (Q8)

- **Default: new only.** Baseline the cursor at the current max UID; go forward.
- **Optional bounded backfill** ("since date X" / current open period), explicit opt-in. **Never** full-history by default. Backfilled duplicates are caught by SHA-256 (`Document`) and `(supplier, invoice_number)` (transactional memory) dedup.

### Reuse the serialized intake queue (Q9)

Harvest goes through `DocumentsService.upload()` (sets `pending`) **and then explicitly calls `IntakeQueueWorker.kick()`** to drain promptly. NB (verified against merged main): `upload()` does **not** auto-kick — the worker self-drains via `onModuleInit` + a cron safety-sweep, so without an explicit `kick()` a harvested document would wait for the next sweep. The connector **only fetches from IMAP** and enqueues; the existing `IntakeQueueWorker` serializes OCR (concurrency = 1), and its poison-guard / crash-recovery / dedup apply unchanged. Email-sync adds **no** OCR worker of its own.

**Claimant resolution gap (verified against merged main).** `claimant_id` is currently set only on the upload path that knows the sender; the email channel does **not** yet resolve `claimant_id` from the sender (the interaction-router uploads without it; `principal-resolver` returns no entity). For the claimant short-circuit to fire on **email_push**, a task must resolve `claimant_id` from the email sender (`email → Entity(role: employee|director)`) at harvest time and pass it to `upload({ claimantId })`. `email_sync` deliberately does **not** resolve it (no Principal).

### Source-aware disposition layer

A thin layer over `IntakeWorkflowResult`, keyed on the document's delivery channel + its Ingest profile, deciding `discarded` vs `needs_triage` vs normal routing. It sits **over** the workflow result, not inside Pass-2 or the country plugin (see coordination seam).

### Health / lifecycle (Q14-A)

Each connector exposes `connected | auth_failed | disconnected | error` + `last_synced_at` on the settings page. A revoked/expired token or failed app-password → `auth_failed` → raise an **AuditFinding** → **SecretaryAgent** nags "reconnect your mailbox", so a dead sync never silently loses invoices.

### Admin HTTP API + SPA

Connect / list / remove connectors and edit Ingest-profile knobs via the admin settings API (ADR-0028) + operator SPA. A "discarded" view lists silently-dropped documents (retrievable, not nagged).

## Privacy & retention (Q14-B)

- **Non-candidate messages** (no document attachment): store **nothing** but the advanced UID cursor. No subjects/bodies of the owner's personal mail in our DB.
- **Harvested but `discarded`**: store the `Document` (bytes + minimal `document_source` metadata: sender, message-id, date) for audit/anti-re-harvest, with a **retention sweep** that purges the **bytes** after ~30 days (configurable), keeping hash + minimal record for anti-re-harvest.
- **Full email bodies of the firehose are never stored** — only the harvested attachment + minimal headers.

## Crash recovery

- Durable per-connector UID cursor → resume from `last_uid` on restart; catch-up fetch covers the downtime gap.
- Harvest is idempotent: a re-fetched message's attachment hits the existing SHA-256 dedup in `upload()` → returns the existing `Document`, no second `pending`.
- Downstream crash recovery is the intake queue's (`onModuleInit` kick + stale-`processing_since` reclaim).

## Failure handling

- **IMAP connection / auth failure** → `auth_failed`/`disconnected` status + backoff reconnect; `auth_failed` raises an AuditFinding (operator must re-auth).
- **OCR / Pass-2 failure** → existing queue logic → `needs_triage`; no email-specific retry loop.
- **Poison document** → intake-queue poison-guard (bounded retries → park).

## Coordination seam (claimant-reimbursement branch — ADR-0036)

The concurrent work is **claimant-reimbursement** (`docs/adr/0036-…`, `docs/superpowers/plans/2026-06-23-claimant-reimbursement.md`). Reading its plan reconciled five points; the actionable handoff lives in `2026-06-23-email-claimant-sync-coordination.md`.

- **Recipient signal — one fact, two consumers (resolved option A).** Pass-2 emits **both** `recipient_match: ours | other_party | none` (the real extraction, **email-sync owns it**) **and** the derived `company_addressed_receipt = (recipient_match === 'ours')`. The claimant branch's existing consumers (TriageResult read in their Task 8, migration 056 column, `EconomicFacts`, projection `false|null → NULL_VAT_CODE`) read the **derived boolean unchanged** — their plan is **not** rewritten. Our disposition reads the 3-valued field. Single source of truth, derivation done in Pass-2 output assembly.

- **The claimant branch's recipient extraction is a stub.** Their Self-Review lists "Pass 2 prompt update to detect `company_addressed_receipt`" as **out of scope** — so the field exists but is never populated (always `null` → conservative no-reclaim). **Email-sync delivers that extraction** (as `recipient_match` + the derived boolean), which *lights up* their VAT path.

- **Claimant docs must run Pass-2 (a fix to their Task 7).** ADR-0036 assumes "Pass 2 artefacts are already stored", but their Task 7 early-returns to `needs_triage` **before Pass-1 OCR** — a bug: no artefacts, no `company_addressed_receipt`, nothing for `confirm-payment` to rebuild, and our `recipient_match` never runs for claimant docs. Fix: run Pass-1+Pass-2 fully, then **force the routing decision** to `needs_triage` *after* extraction (override confidence), not skip OCR. Communicated via the coordination note; applied on **their** branch before merge (we do not edit their in-flight worktree).

- **Disposition precedence:** `claimant (claimant_id != null → needs_triage)` **>** Ingest-profile disposition **>** Policy. Claimant short-circuits our disposition; claimant docs are never `discarded`. `email_sync` sets no `claimant_id`, so the two only overlap on deliberate channels, where claimant wins.

- **Landing order & migrations:** claimant → `main` first (conservative-safe while extraction is absent); email-sync rebases on updated `main` and layers extraction + boolean derivation + disposition + connector. Migrations: claimant 054–057, email-sync 058–059 (see Migrations).

## Migrations

The claimant-reimbursement branch reserves **054–057** and lands first (see coordination). Email-sync therefore starts at **058**:

- **058** — new `mailbox_connector` table (encrypted secret, `auth_mode`, folder, ingest-profile overrides, sync cursor `uidvalidity`+`last_uid`).
- **059** — `document` rebuild (12-step, since SQLite cannot alter a CHECK): add `discarded` to the `status` CHECK, add `disposition_reason` column, add a byte-retention timestamp. **Must run after 055** and **must carry `claimant_id`** (added by claimant migration 055) through the rebuilt column list, or it will be dropped.

No new migration for the recipient signal: `recipient_match` is transient Pass-2 output; the derived `company_addressed_receipt` boolean persists on `expense` via the claimant branch's migration 056.

## Scope cuts (deferred)

- **No outbound SMTP, no email conversations, no email Action-point confirmation-loop** in v1 — email is **inbound-only** (ADR-0016 amendment). All interactive resolution goes via **Telegram / SecretaryAgent**.
- **No inbound-parse webhook transport** (IMAP only); webhook is an optional later transport.
- **No provider-native Gmail/Graph APIs** (one IMAP+XOAUTH2 engine); Gmail-API `historyId`/label-scope is a later optimization behind the same seam.
- **No Gmail-label scoping** (IMAP folder only).
- **No multi-instance scaling** (single Node process; inherits the intake-queue assumption).

## Testing

- **Candidate gate:** attachment mandatory; inline/logo/tiny/non-document attachments dropped; invoice-mention only reorders priority.
- **Disposition by profile:** non-invoice on `email_sync` → `discarded` (no finding); same on `email_push` → `needs_triage`; invoice-for-another-party → `needs_triage`; no-recipient receipt → not diverted on absence.
- **Cursor / IDLE (mocked IMAP transport):** EXISTS triggers a forward fetch; catch-up on reconnect harvests the gap; `uidvalidity` change re-baselines without re-harvest; safety sweep harvests a missed signal.
- **Idempotent harvest:** a re-fetched attachment hits SHA-256 dedup → no second `pending`.
- **Queue reuse:** harvested documents serialize through the global gate (no concurrent OCR with a burst / backfill).
- **OAuth:** XOAUTH2 token refresh + hourly reconnect; revoked token → `auth_failed` + AuditFinding.
- **Privacy:** non-candidate messages persist nothing but the cursor; discarded bytes purged after retention; no firehose bodies stored.
