# Triage agent evals (promptfoo)

Two focused checks of the **triage** agent against the configured OpenAI-compatible
inference endpoint. They isolate the two capabilities the kernel relies on:

| Eval | Config | Question it answers |
|------|--------|---------------------|
| **tools** | `toolcall.yaml` | Does the model actually **call tools** (`listCategories`, `getClassificationContext`, …) through this endpoint? If not, the agent never gets categories/supplier context and falls back to `unknown`. |
| **classify** | `classify.yaml` | Given **clean OCR text**, does the model emit a **schema-valid classification** with the right `kind` and amounts (e.g. parses `6 157,00` as `615700` cents, not `61.57`), and extract the supplier's identifiers into `supplier_proposal` — every identifier the document prints (reg/VAT, email, phone, address) and **null (never fabricated)** when one is absent? |

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
npm run eval:triage:tools      # function-calling capability
npm run eval:triage:classify   # structured classification
npm run eval:view              # open the web report of the last run
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
  document (e.g. an outgoing sales invoice — not a triage `kind`).

> All sample documents here are synthetic — no real company/personal data.

## Files

- `prompt.json` — triage system prompt (tool-using) + `{{markdown}}` user turn.
- `prompt-classify.json` — direct-classification prompt (no tools).
- `tools.json` — OpenAI function defs mirroring `src/ai/tools`.
- `schema.json` — `triage_result` JSON schema mirroring `triageResultSchema`.
