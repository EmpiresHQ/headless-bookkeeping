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

## Online-shop module (resale goods, B2C e-commerce)

**What:** The bundle of capabilities a goods-reselling online shop needs that the services solo-OÜ persona does not: **inventory** for resale goods (periodic method — purchases hit `EXPENSE_GOODS`, a period-end physical count posts `Dr INVENTORY / Cr EXPENSE_GOODS` so the balance sheet shows varud and COGS is correct), **OSS** (One Stop Shop — B2C distance-sales VAT at the destination member state's rate), **payment-processor reconciliation** (Stripe/PayPal payouts booked net of fees), and **bulk order ingestion** (marketplace/cart exports rather than one-off sales invoices).

**Why a separate module:** none of this touches the services persona, and each piece is self-contained — inventory has its own count/valuation lifecycle, OSS is a parallel VAT regime to KMD with per-country rates, processor reconciliation is a banking concern with fee splitting. Bundling them keeps the v1 kernel and the annual-accounts work (ADR-0034) focused on services. The annual report already leaves the varud line empty until this module supplies the resale-goods accounts.

**Why deferred:** the v1 persona is the **services** solo-OÜ (consulting, IT). Goods resale is a distinct go-to-market we tackle as a dedicated module later. (Periodic-inventory design was drafted as a proposed ADR and folded here; perpetual inventory, per-SKU/lot valuation, and COGS-on-sale remain further out.)

## Other deferred (not domain plugins)

These are **kernel-native** capabilities (ledger rules + accounts, possibly a country-plugin hook) that the domain model already names but v1 does not build. Each becomes a kernel + country-plugin wave, not a domain plugin.

- **Bad debt write-off** — modeled (ADR-0008, CONTEXT.md "Bad debt write-off"); the `BAD_DEBT_EXPENSE` account is seeded, but there is no flow. Needs: an approval-required action that posts `Dr bad-debt expense / Cr AR` against an outstanding **Receivable**, plus the country-plugin rule for reclaiming already-paid output VAT (EU VAT Directive Art. 90; conditions vary). Loss recognition → **Policy** gates it. **Deferred** — not needed for the v1 happy path.

- **Asset depreciation engine** — modeled, engine deferred past v1 (ADR-0007, CONTEXT.md "Asset"). v1 expenses everything immediately. Needs: an **Asset** record (capitalization threshold/method/useful-life are **country-plugin** rules), a year-end AI sweep that *proposes* which posted Expenses to reclassify (AI proposes candidates + parameters; depreciation amounts computed **deterministically**), reclassification as a **correction** (reversal + repost, approval-required), and scheduled **system-generated** depreciation Vouchers. **Deferred** — capitalization is rare for the v1 persona.

- **Year-end close engine** — deferred (CONTEXT.md "Dividend", ADR-0023). v1 has **no** close: net income is never swept into Retained-earnings, so distributable profits is **computed live** by the kernel and Retained-earnings may be **interim-negative** for a profitable company. A close engine would sweep ΣRevenue − ΣExpense into Retained-earnings at period end (a **system-generated** Voucher) and remove the interim-negative artifact. **Deferred** — the live computation is correct without it; the close is a cosmetic/structural convenience until assets or multi-year reporting demand it.

- **Cash-basis report view** — deferred (CONTEXT.md "Accrual basis"). The ledger is accrual-only and stays so; a cash-basis report would be a *read-path projection* (recognize revenue/expense/VAT at settlement, not at invoice), derived from settlement Vouchers + **ReconciliationMatch**es. **Deferred** — accrual is the only basis the ledger supports in v1; cash-basis is a later view, never a second ledger.

- **RBAC / roles / per-route permissions** — *uncertain*. v1 ships a single table-backed owner API token (Wave-6 Task 39): `Authorization: Bearer <token>`, hash-stored, NestJS guard over `/api`+`/admin`. Multiple roles/scopes are deferred to v2 and may never be needed for a single-owner, self-hosted, single-tenant deployment (ADR-0003). Revisit only if multi-user access becomes a real requirement.

---

_Add further deferred bounded contexts here as they surface during grilling. The test for "domain plugin vs kernel feature": does it carry its own operational data + lifecycle (→ domain plugin), or is it ledger-native rules/accounts (→ kernel + country plugin)? (ADR-0022)_
