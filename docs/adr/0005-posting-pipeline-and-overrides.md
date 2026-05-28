# Posting pipeline: AI suggests → Rules validate → Policy decides → Voucher posts

The LLM never posts to the ledger. Every posting flows through four layers:

1. **AI suggests** (probabilistic) — OCR/triage produces a draft (category, supplier guess, amounts, candidate VAT code, confidence).
2. **Rules validate** (deterministic) — three sorts: **structural invariants** (kernel: voucher balances to zero, account exists, amounts numeric) — pure double-entry arithmetic; **hard process rules** (kernel: the period containing the voucher's tax-point date must not be locked) — legal/process, not arithmetic, but equally non-overridable; and **semantic rules** (country plugin: VAT code applicability, deductibility) — overridable via a logged Override.
3. **Policy decides** (configurable risk gate) — auto-post vs require human approval, based on amount, known/unknown supplier, confidence, operation type.
4. **Voucher posts** (deterministic, atomic, immutable).

Two boundaries are deliberate:

- **A human bypasses the AI/OCR layer, not the Rules.** Manual entry exists precisely because OCR can produce valid-but-wrong data; the corrected manual data still passes Rules. "Manual entry" never means posting a structurally-invalid voucher, nor posting into a locked period — structural invariants (arithmetic) and hard process rules (locked-period) hold for everyone.
- **Semantic (country) rules are overridable; structural invariants are not.** A human may override a semantic rule (historical migration, a too-strict or buggy plugin rule) only via an explicit, logged Override carrying a reason. Structural invariants can never be overridden.

Confidence is an input to Policy, never to Rules — a 0.99-confidence AI suggestion still passes through Rules unchanged.
