# V2 Roadmap — deferred domain plugins

Capabilities deliberately **out of v1 scope**, to be added post-v1 as **domain plugins** (ADR-0022): out-of-process bounded contexts with their own database, integrating over an API, owning a sub-domain end-to-end, and posting only **summarized vouchers through the pipeline** (Rules → Policy → post) — never writing the ledger directly (ADR-0012/0019). The kernel SQLite ledger stays the sole accounting system of record.

> This is a backlog of *bounded contexts*, not a task list. Each becomes its own wave/plan when picked up.

## Self-billing (incoming document = our revenue)

**What:** Under a **self-billing agreement** (EU VAT Directive Art. 224) the *customer* issues the invoice on our behalf — e.g. a platform paying a creator/contractor (Uber, YouTube, affiliate networks, marketplaces). We *receive* a document that represents *our* sale (revenue + output VAT), the one case where an incoming document is sales-side rather than a purchase.

**Why a domain plugin (not kernel intake):**
- Owns its own data: the registry of self-billing agreements (which counterparties may self-bill us, under what terms), and the inbound self-billed-document handling.
- Composes with the **country plugin** (output-VAT treatment of the self-billed revenue) and the **Entity** identity (the self-billing customer).
- Posts a summarized revenue voucher (`Dr AR/Bank / Cr Revenue / Cr output VAT`) **through the pipeline**; never writes the ledger directly.

**Why deferred:** niche for the v1 persona (consultant/freelancer/micro-SMB), and it inverts the normal intake direction (incoming → revenue) — handling it in v1 intake would muddy the "intake = purchase side" model (ADR-0010). In v1, intake produces only `new_expense | correction | duplicate | unknown`.

## Payroll

**What:** Employees, payroll runs (gross → withholdings → net), employer contributions / pension, filing artifacts, payroll-internal reconciliation. (See DOMAIN-MODEL.md "Open structural gaps".)

**Why a domain plugin:** a sub-domain on the scale of VAT/intake with its own operational store and lifecycle; heavily country-specific (IE PAYE/PRSI, DK A-skat/AM-bidrag). The kernel holds only a `SALARIES` account + payables and receives a summarized payroll voucher through the pipeline (ADR-0022). The net-pay bank line reconciles kernel-side against net-pay-payable; per-employee detail stays in the plugin.

**Why deferred:** for v1 the owner-withdrawal path is **dividends**, not salary (ADR-0023).

---

## Invoice rendering + delivery (domain plugin)

**What:** Render a registered **SalesInvoice** to a document (PDF) and **deliver** it to the customer (email/portal). v1 only **registers** the invoice as the accounting record (business object → Voucher); it does **not** render or send — there is no PDF renderer and no invoice-send path.

**Why a domain plugin:** rendering (templates, branding, locale/format) + delivery (SMTP/portal, bounce handling, idempotent at-most-once send) is a self-contained sub-domain with its own concerns; the kernel just holds the registered invoice. Posts nothing new to the ledger — it reads a registered invoice and produces/sends a document. The **SEND** is a high-stakes, irreversible action (action-point/approval, ADR-0016) and idempotent — but all of that lives in the plugin, deferred to v2.

**Why deferred:** v1's job is the *ledger record* of what will be billed; actual document production/delivery is out of scope.

## Other deferred (not domain plugins)

- **RBAC / roles / per-route permissions** — *uncertain*. v1 ships a single table-backed owner API token (Wave-6 Task 39): `Authorization: Bearer <token>`, hash-stored, NestJS guard over `/api`+`/admin`. Multiple roles/scopes are deferred to v2 and may never be needed for a single-owner, self-hosted, single-tenant deployment (ADR-0003). Revisit only if multi-user access becomes a real requirement.

---

_Add further deferred bounded contexts here as they surface during grilling. The test for "domain plugin vs kernel feature": does it carry its own operational data + lifecycle (→ domain plugin), or is it ledger-native rules/accounts (→ kernel + country plugin)? (ADR-0022)_
