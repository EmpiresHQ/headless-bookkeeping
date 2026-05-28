# Supplier memory: LLM always classifies; memory is context; identity anchored on a strong key

Classification (Category, VAT code, deductibility) is decided **per line item by the LLM, every time** — a single supplier can span many categories (you buy software *and* a pastry at Walmart), so a per-supplier "default category" short-circuit is wrong and error-prone. We don't optimize the LLM call away; calls are cheap, accuracy is not.

Memory splits in two, by authority:

- **Classification memory** (what this supplier's purchases tend to be, prior user corrections) is fed to the LLM as **context / a prior**, never a deterministic gate. Corrections accumulate as facts rather than overwriting a single default; the model weighs them. Retrieval (what to put in context) is deterministic; the decision is the model's. Accuracy guards stay at Policy (low-confidence / unknown supplier → approval), not at a skip.
- **Transactional memory** (identity keys, aliases, dedup keys, AR/AP/prepayment balances) stays **structured and authoritative**, feeding deterministic guards. It is never demoted to advisory "LLM context".

Supplier **identity is anchored on a strong registration key**, not a name: DK uses CVR (generally the VAT number). One legal entity can have many legitimate registered names (DK *binavne*) plus OCR variants, so name matching alone is unreliable — all names are aliases hanging off the key. What counts as the identity key, and an optional registry lookup (CVR → canonical name + binavne + address) to enrich aliases, are country-plugin responsibilities. Name-based fuzzy matching is only a fallback when no strong key is present (e.g. a foreign supplier without a VAT number), and then Policy gates anything uncertain.
