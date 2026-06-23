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
| 3. **OCR + Pass-2** | **expensive** | existing pipeline via the **serialized intake queue**; extracts fields incl. `recipient_signals` | `needs_triage` |
| 4. **Recipient check** | cheap | our-Organization match (name/VAT) — *owned by the concurrent recipient-check session* | per Ingest profile |
| 5. **Disposition** | cheap | source-aware layer over `IntakeWorkflowResult` | — |

Attachment is mandatory (invoices often have empty bodies); the invoice-mention only raises priority. "Is it really an invoice" is decided by Pass-2 (`document_type`), not by a pre-OCR LLM on the firehose.

### Disposition (step 5), by Ingest profile

- **Invoice, recipient = us** → normal triage routing (auto-post / Approval via existing **Policy**).
- **Invoice, recipient = another party** (positive conflict) → `needs_triage` (the operator's "остальные в триаж"). Divert **only on a positive conflict** — an absent recipient (a receipt) is **not** a conflict.
- **Confidently not an invoice / no-recipient receipt under a strict profile** → `discarded` on ambient channels, `needs_triage` on deliberate channels.

For `email_push` (deliberate, reserved mailbox) the permissive profile means everything that lands there is meant to be an accounting document → non-matches go to `needs_triage`, not silently dropped.

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

Harvest goes through `DocumentsService.upload()`, which already sets `pending` and calls `kick()` for all channels. The connector **only fetches from IMAP**; the existing `IntakeQueueWorker` serializes OCR (concurrency = 1), and its poison-guard / crash-recovery / dedup apply unchanged. Email-sync adds **no** OCR worker of its own.

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

## Coordination seam (concurrent recipient-check session)

Another session is building Pass-2 `recipient_signals` + our-Organization matching. Split of ownership:

- **They own:** extraction of the recipient/bill-to block and the name/VAT match → a signal on the Pass-2 result.
- **We own:** the *disposition* of that signal, as a source-aware layer **over** `IntakeWorkflowResult` (driven by the channel's Ingest profile).

Kept as two layers (extraction vs disposition) so the efforts do not collide in `IntakeWorkflowService` routing.

## Migrations

- New `mailbox_connector` table (encrypted secret, ingest-profile overrides, sync cursor) — next free migration (053 is taken by the intake-queue poison counter; use the next free number at implementation time).
- New `document.status` terminal value `discarded` + retention timestamp for byte-purge.

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
