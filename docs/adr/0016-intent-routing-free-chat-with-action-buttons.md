# Intent routing: free natural-language chat, with buttons at action points

Free natural-language chat is the product's selling point — users talk to the system like a person, not via forms. Routing is therefore done by a strong, context-rich LLM; cost is explicitly not a concern.

- **Rich per-channel context feeds the router.** Channel adapters extract the full conversational context: the last N messages of a Telegram thread, the entire `>`-quoted nesting of an email, etc. The router classifies free text into `advisory | action | report | reconciliation` (and clarifies in-chat when uncertain — a natural part of the UX, not friction).
- **Conversation resolution is deterministic and precedes routing.** Before classifying intent, the router binds the inbound message to its **Conversation** by channel + thread key (email `Message-ID`/`References`; chat thread id) — a key lookup, not an LLM guess — creating a new Conversation only when none matches. This is what lets a bare reply (no re-attached document) reuse the original **Document** and business-object context of the thread (client → agent → client → agent). Identity binding (deterministic) is kept separate from intent classification (probabilistic). The **Conversation** is a persisted, auditable aggregate (messages + artifacts), distinct from Mastra's transient working memory (ADR-0018).
  - **Channel-level realization of the key (Wave 8):** email `Message-ID`/`References` headers can be stripped or rewritten, so an outbound email also **embeds the Conversation id in the body** (e.g. a `[conv:CONV-…]` marker) — the router parses it to match a reply deterministically even when threading headers are lost. Telegram carries the id in inline-button **`callback_data`** (the Action-point button — un-skippable). The body token / callback_data is the primary deterministic key; threading headers are a fallback.
- **The router is not a security boundary.** A misroute is harmless: an action intent only ever produces a *draft* (the pipeline still gates posting, ADR-0012). This is why the router can be probabilistic.

The one place that is deterministic is the **action point**:

- **Committing a concrete action is a button, not parsed free text.** "Confirm — post this", "Send invoice", "Approve" are structured button taps (Telegram inline keyboards / Slack interactive blocks). The tap is the authoritative, attributable, unambiguous approval signal. Free chat gets the user *to* the action point; the button commits it. High-stakes actions (invoice send, corrections into a filed period, large amounts, bad-debt) naturally surface this confirm step.
- This relocates commit-time safety onto the button (its strongest place), while the surrounding conversation stays free-form.

## Email: whitelisted conversation, open ingest, confirmation-loop commit

Email behaves on three distinct tracks, gated differently:

- **Ingest is open to any sender.** Suppliers email invoices/receipts from arbitrary addresses, so document intake accepts everyone: attachment → triage → draft. The system does not converse back; it just pulls the document in. Gating ingest by whitelist would kill the core email-intake feature.
- **Conversation and commands are whitelist-only.** The system only holds an advisory dialogue with, and takes commands from, addresses on a configured **email whitelist**. A non-whitelisted sender's non-document email is ignored — no dialogue. (A non-whitelisted sender *with* a document is still ingested; we just don't talk back.)
- **Action / approval** is for an approver, who is a subset of the whitelist. Email has no buttons, so its action point is a **confirmation loop**: commit only on an explicit, unambiguous "YES"; any hedge ("ok I think so", "yes but change the amount") triggers a re-ask; never commit on a maybe. This is the dialogue equivalent of a button — "100% confidence" implemented as "require an explicit affirmative, re-ask on any doubt", with reversibility + Rules + logging as backstop (an LLM cannot literally guarantee 100%).

Because email is spoofable, action/approval over email also requires a **DKIM/SPF pass** — on top of the whitelist, to prove the mail really came from the whitelisted address rather than a spoof. The deployment is self-hosted, so the threat model is relaxed, but DKIM/SPF is still checked.

Outbound email over SMTP (sending invoices, replies, reports) is a *system* action; when it needs approval it is confirmed on whatever channel initiated it (a button on TG/Slack, or the email confirmation loop).
