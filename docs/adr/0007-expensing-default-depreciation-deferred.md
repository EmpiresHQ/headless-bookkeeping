# Expense by default; depreciation engine deferred; year-end AI capitalization sweep

## Status
**Superseded by ADR-0035** (2026-06-13). The depreciation deferral below no longer
holds: the väikeettevõtja annual-accounts work (ADR-0034) requires capitalization
and depreciation, implemented per ADR-0035. The **system-generated Voucher** class
introduced here is retained and reused by ADR-0035 for the period-close
depreciation charge.

In v1 every purchase is expensed immediately. The Asset / depreciation concept is modeled but the depreciation engine is deferred past v1 — the target user (freelancer / micro-SMB) is almost always below the country's capitalization threshold, and supporting capitalization at all obliges us to run a depreciation engine (an asset must not sit un-depreciated forever).

The architecture does introduce the **system-generated Voucher** class now (deterministic, no document, no AI, posted on schedule or at period close) because FX year-end revaluation and VAT settlement need it regardless.

The intended (deferred) capitalization flow is AI-native but accounting-safe by a strict split:

- **AI proposes which posted expenses to capitalize, and suggests parameters** (method, useful life per plugin rules) — a triage/judgment task.
- **Depreciation amounts are computed deterministically** (cost / life per the country plugin's method). The LLM never picks a depreciation figure.
- Reclassifying an already-posted Expense into an Asset is a **correction** (reversal + repost), so it is approval-required.

Capitalization threshold, depreciation method, and useful life are all country-plugin rules.
