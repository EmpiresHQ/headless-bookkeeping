# Triage agent evals (promptfoo)

Two focused checks of the **triage** agent against the configured OpenAI-compatible
inference endpoint. They isolate the two capabilities the kernel relies on:

| Eval | Config | Question it answers |
|------|--------|---------------------|
| **tools** | `toolcall.yaml` | Does the model actually **call tools** (`listCategories`, `getClassificationContext`, …) through this endpoint? If not, the agent never gets categories/supplier context and falls back to `unknown`. |
| **classify** | `classify.yaml` | Given **clean OCR text**, does the model emit a **schema-valid classification** with the right `kind` and amounts (e.g. parses `6 157,00` as `615700` cents, not `61.57`), and extract the supplier's identifiers into `supplier_proposal` — every identifier the document prints (reg/VAT, email, phone, address) and **null (never fabricated)** when one is absent? |
| **classify-outgoing** | `classify-outgoing.yaml` | Given an **OUTGOING direction hint** + org identity injected into the system prompt, does the model emit `kind="new_sales_invoice"` with truthful `outgoing_signals` booleans and a `customer_proposal` identifying the **buyer** (not the seller)? Tests amount parsing and `supplier_invoice_number` extraction for outgoing documents. Note: IBAN-direction detection and intake routing are covered by server unit tests; this eval tests the LLM-classification half only. |

These mirror what `MastraService` wires up (prompt = `AGENT_PROMPTS.triage`, tools =
`src/ai/tools`, schema = `triageResultSchema`), but talk to the raw endpoint so a
red result points at the **endpoint/model**, not our orchestration.

## Run

Configure the endpoint via a local `.env` (gitignored — nothing about the
inference deployment is committed):

```bash
cp evals/triage/.env.example evals/triage/.env
# edit it: EVAL_BASE_URL, EVAL_MODEL, OPENAI_API_KEY
```

Then (from a host that can reach the endpoint — it's on the tailnet):

```bash
npm run eval:triage:tools              # function-calling capability
npm run eval:triage:classify           # structured classification (incoming)
npm run eval:triage:classify-outgoing  # outgoing-invoice classification
npm run eval:view                      # open the web report of the last run
```

promptfoo is invoked via `npx` — nothing is added to the project's dependencies,
and these evals are **not run in CI** (they need a live endpoint).

## Reading the results

- **tools FAIL** (assertion `is-valid-openai-tools-call`): the model answered in
  plain text instead of calling a tool → function-calling is broken for this
  model/endpoint. The triage agent will keep producing `unknown`. Fix: enable
  tool/function-calling on the endpoint, or switch `ai_model.triage` to a model
  that supports it.
- **classify FAIL** on the amount assertion: the model misreads European number
  formats (`6 157,00`) or the cents convention. If `response_format: json_schema`
  itself errors, the endpoint doesn't support it — change it to
  `{ type: json_object }` in `classify.yaml` and drop the `json_schema` block.
- **both PASS**: the model is fine; any remaining bad classifications were the
  OCR (see `fix(ocr): reconstruct word spacing …`) or a genuinely out-of-scope
  document (e.g. a bank statement without a matching CSV import route).
- **classify-outgoing FAIL** on `kind` or `outgoing_signals`: with the direction
  hint in the prompt the model should unconditionally emit `new_sales_invoice` —
  a failure here means the org-identity guidance isn't being followed. Check that
  `prompt-classify-outgoing.json` is being loaded (not the base classify prompt).
  Note: outgoing sales invoices are a first-class triage `kind` (`new_sales_invoice`);
  see `classify-outgoing.yaml` and the server's `classifyDocumentClass` router.

> All sample documents here are synthetic — no real company/personal data.

## Files

- `prompt.json` — triage system prompt (tool-using) + `{{markdown}}` user turn.
- `prompt-classify.json` — direct-classification prompt (no tools, incoming documents).
- `prompt-classify-outgoing.json` — direct-classification prompt with org-identity + outgoing direction hint injected (for `classify-outgoing` eval).
- `tools.json` — OpenAI function defs mirroring `src/ai/tools`.
- `schema.json` — `triage_result` JSON schema for incoming documents (mirrors `triageResultSchema`, incoming-only `kind` enum).
- `schema-outgoing.json` — extended `triage_result` JSON schema including `new_sales_invoice` kind, `customer_proposal`, `outgoing_signals`, `supplier_invoice_number`, and the full `document_type` enum — used by the `classify-outgoing` eval.
