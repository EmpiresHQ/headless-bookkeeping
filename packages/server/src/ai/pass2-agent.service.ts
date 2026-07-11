import { Injectable, Logger } from '@nestjs/common';
import { MastraService } from './mastra.service';
import {
  triageResultSchema,
  TriageResult,
  pass2EnrichmentSchema,
  Pass2Enrichment,
} from '../triage/types';
import { OrgIdentityContext } from './triage-instructions';
import { getClassificationContextOutputSchema } from './tools/tool-schemas';

const MAX_RETRIES = 3;
const ENRICHMENT_SECTION_HEADING = 'Deterministic enrichment summary';

/** The one tool the enrichment phase MUST call — the deterministic supplier
 * lookup whose result is the ONLY trusted source of `matchEntityId` (issue
 * #179's trust boundary). Forced via `toolChoice` when the runtime supports
 * it; the missing-tool-call diagnostic below is the belt-and-braces check for
 * when it does not run anyway. */
export const GET_CLASSIFICATION_CONTEXT_TOOL = 'getClassificationContext';

// The minimal shape of a Mastra `ToolResultChunk` we read. Kept local (rather
// than importing @mastra/core's ToolResultChunk) so this module stays
// decoupled from the exact runtime type and easy to construct in tests.
export interface EnrichmentToolResultChunk {
  payload: {
    toolName: string;
    result: unknown;
    isError?: boolean;
  };
}

/** The subset of `agent.generate()`'s FullOutput the enrichment phase reads:
 * the free-text summary plus whichever tools it actually called. */
export interface EnrichmentGenerateResult {
  object: unknown;
  text: string;
  toolResults?: EnrichmentToolResultChunk[];
}

/** Pure-function result of reading `getClassificationContext` out of an
 * enrichment turn's `toolResults` — see {@link extractPass2EnrichmentSupplier}. */
export interface Pass2SupplierExtraction {
  supplier: Pass2Enrichment['supplier'];
  toolCalled: boolean;
  calledMultipleTimes: boolean;
  invalidToolResult: boolean;
}

/**
 * Extract the trusted supplier match (if any) from an enrichment turn's
 * `toolResults` — the deterministic half of issue #179's trust boundary. A
 * PURE function (no logging, no class state) so:
 *  - `Pass2AgentService` can wrap it with logging/category decisions, and
 *  - tests elsewhere (e.g. `propose-draft.service.spec.ts`'s guard tests) can
 *    exercise the SAME production extraction code against a synthetic
 *    `toolResults` array — instead of hand-constructing the resulting
 *    `Pass2Enrichment` shape and risking it drifting from what this module
 *    actually produces.
 *
 * "Exactly once" (acceptance criterion 2): when the tool was called more than
 * once in a single turn, the FIRST result wins (`calledMultipleTimes` tells
 * the caller to log a warning — this is never a failure by itself).
 */
export function extractPass2EnrichmentSupplier(
  toolResults: EnrichmentToolResultChunk[] | undefined,
): Pass2SupplierExtraction {
  const calls = (toolResults ?? []).filter(
    (tr) =>
      tr?.payload?.toolName === GET_CLASSIFICATION_CONTEXT_TOOL &&
      !tr.payload.isError,
  );
  if (calls.length === 0) {
    return {
      supplier: undefined,
      toolCalled: false,
      calledMultipleTimes: false,
      invalidToolResult: false,
    };
  }

  const calledMultipleTimes = calls.length > 1;
  const parsed = getClassificationContextOutputSchema.safeParse(
    calls[0].payload.result,
  );
  if (!parsed.success) {
    return {
      supplier: undefined,
      toolCalled: true,
      calledMultipleTimes,
      invalidToolResult: true,
    };
  }

  const { supplier: toolSupplier } = parsed.data;
  const supplier: Pass2Enrichment['supplier'] =
    toolSupplier.resolution === 'matched' &&
    toolSupplier.matchEntityId !== undefined
      ? { matchEntityId: toolSupplier.matchEntityId }
      : undefined;
  return {
    supplier,
    toolCalled: true,
    calledMultipleTimes,
    invalidToolResult: false,
  };
}

/**
 * Why Pass 2 failed to produce a validated TriageResult. Surfaced to the
 * workflow (ADR-0024) so it can route/observe appropriately instead of
 * receiving a bare `null` that erases the distinction between an unconfigured
 * runtime, a model that never emitted valid structure, and a transient blip.
 *
 *  - 'agent-unavailable':  the Mastra agent was not initialized (config/runtime
 *                          fault) — no attempt was even made.
 *  - 'enrichment-failed':  the one-shot enrichment phase threw before strict
 *                          classification could start.
 *  - 'enrichment-incomplete': enrichment returned but did not produce the
 *                          reusable deterministic summary the strict phase
 *                          requires.
 *  - 'enrichment-tool-not-called': enrichment completed with a reusable
 *                          summary, but NEVER invoked getClassificationContext
 *                          — the deterministic supplier lookup the trust
 *                          boundary depends on did not run. This is the exact
 *                          production failure mode from issue #179 (the model
 *                          emitting a final answer without the tool call);
 *                          distinct from a thrown error or an empty summary so
 *                          it stays observable instead of silently letting the
 *                          strict phase run with no deterministic anchor.
 *  - 'invalid-output':     the agent ran but never produced schema-valid output
 *                          within the bounded strict-classification retry (the
 *                          ADR-0024 "invalid output → bounded retry →
 *                          needs_triage" case).
 *  - 'transient':         every attempt threw (timeouts/rate-limits) and never
 *                          returned parseable output during strict
 *                          classification — likely retryable later.
 */
export type Pass2FailureCategory =
  | 'agent-unavailable'
  | 'enrichment-failed'
  | 'enrichment-incomplete'
  | 'enrichment-tool-not-called'
  | 'invalid-output'
  | 'transient';

/** A successfully validated Pass-2 classification. */
export interface Pass2Success {
  ok: true;
  result: TriageResult;
  enrichment?: Pass2Enrichment;
}

/** A Pass-2 failure carrying an explicit, observable category. */
export interface Pass2Failure {
  ok: false;
  category: Pass2FailureCategory;
  /** Human-readable detail (last error message, if any). */
  detail: string;
}

/** Discriminated outcome of a Pass-2 classification attempt. */
export type Pass2Outcome = Pass2Success | Pass2Failure;

/**
 * Optional context passed from the intake pipeline into Pass-2 classify().
 * When provided, the agent instructions are augmented with the organization's
 * identity and the pre-decided document direction so the LLM can accurately
 * set `document_type`, `kind`, `customer_proposal`, and `outgoing_signals`.
 *
 * When absent, classify() behavior is identical to before (backward compatible).
 * A later task wires the real context from the intake workflow; this interface
 * keeps Task 8 decoupled from that wiring.
 */
export interface Pass2Context {
  orgContext: Omit<OrgIdentityContext, 'directionHint'>;
  directionHint: 'incoming' | 'outgoing';
}

/**
 * Pass2AgentService — runs the Pass 2 Mastra agent over Pass-1 markdown
 * and emits a Zod-validated TriageResult.
 *
 * Flow — a SPLIT, enrichment-first trust boundary (issue #179 / ADR-0024):
 * 1. Enrichment call: builds the tool-enabled `triage_enrichment` agent and
 *    calls `agent.generate(markdown, { toolChoice: { type: 'tool', toolName:
 *    'getClassificationContext' } })` — NO `structuredOutput`, so
 *    `result.object` is always undefined and is never read. The deterministic
 *    `getClassificationContext` tool result is read from `result.toolResults`
 *    instead; a matched supplier's entity id from THAT tool result is the
 *    ONLY trusted source of `enrichment.supplier.matchEntityId`.
 * 2. Strict classification call: builds the tool-less `triage_classification`
 *    agent, injects the enrichment summary as context, and calls
 *    `agent.generate(prompt, { structuredOutput: { schema } })`, reading the
 *    parsed structured object from `result.object`. A model-emitted
 *    `match_entity_id` here is advisory only — `propose-draft.service.ts`'s
 *    guard rejects it if it disagrees with the deterministic
 *    `enrichment.supplier.matchEntityId` from step 1.
 * 3. Validates the strict output against the TriageResult Zod schema.
 * 4. Bounded retry: if validation fails, retry up to MAX_RETRIES times.
 * 5. After MAX_RETRIES failures, returns an explicit {@link Pass2Failure}.
 *
 * The classification agent has NO tools at all; the enrichment agent has
 * read-only tools only (listCategories, getClassificationMemory,
 * previewCategoryMapping, getClassificationContext). Neither ever outputs an
 * account or VAT code — the country plugin is the sole resolver (ADR-0002).
 */
@Injectable()
export class Pass2AgentService {
  private readonly logger = new Logger(Pass2AgentService.name);

  constructor(private readonly mastraService: MastraService) {}

  private toOrgIdentityContext(
    ctx?: Pass2Context,
  ): OrgIdentityContext | undefined {
    return ctx
      ? { ...ctx.orgContext, directionHint: ctx.directionHint }
      : undefined;
  }

  private buildClassificationPrompt(
    markdown: string,
    enrichment: Pass2Enrichment,
  ): string {
    return `${markdown}\n\n## ${ENRICHMENT_SECTION_HEADING}\n${enrichment.summary}`;
  }

  /**
   * Read the deterministic `getClassificationContext` tool result out of the
   * enrichment call's `toolResults` — the ONLY trusted source of
   * `matchEntityId` (issue #179). `result.object` is NEVER read here: the
   * enrichment agent is built without `structuredOutput`, so per @mastra/core's
   * `generate()` overloads `result.object` is always `undefined` for this
   * call — reading it would silently accept a model-invented value.
   *
   * "Exactly once" (acceptance criterion 2): if the tool was somehow invoked
   * more than once in a single enrichment turn, the FIRST result wins and a
   * warning is logged — this does not fail the run.
   */
  private extractSupplierFromToolResults(
    toolResults: EnrichmentToolResultChunk[] | undefined,
  ): { supplier: Pass2Enrichment['supplier']; toolCalled: boolean } {
    const extraction = extractPass2EnrichmentSupplier(toolResults);
    if (extraction.calledMultipleTimes) {
      this.logger.warn(
        `Pass 2 enrichment called ${GET_CLASSIFICATION_CONTEXT_TOOL} multiple times in one turn — using the first result`,
      );
    }
    if (extraction.invalidToolResult) {
      this.logger.warn(
        `Pass 2 enrichment's ${GET_CLASSIFICATION_CONTEXT_TOOL} result failed schema validation`,
      );
    }
    return { supplier: extraction.supplier, toolCalled: extraction.toolCalled };
  }

  private parseEnrichment(result: EnrichmentGenerateResult): {
    enrichment: Pass2Enrichment | null;
    toolCalled: boolean;
  } {
    const { supplier, toolCalled } = this.extractSupplierFromToolResults(
      result.toolResults,
    );
    const summary = result.text.trim();
    if (summary.length === 0) {
      return { enrichment: null, toolCalled };
    }
    return {
      enrichment: pass2EnrichmentSchema.parse({ summary, supplier }),
      toolCalled,
    };
  }

  /**
   * Classify markdown content into a validated TriageResult.
   *
   * Returns a discriminated {@link Pass2Outcome} so the caller can tell an
   * unconfigured runtime (`agent-unavailable`) from a model that never emitted
   * schema-valid output (`invalid-output`) from a string of throws
   * (`transient`) — instead of a bare `null` that loses the category
   * (ADR-0024). The bounded-retry -> needs_triage behavior is preserved; only
   * the reason is now explicit.
   *
   * @param markdown - The Pass-1 markdown text (receipt/invoice content).
   * @param ctx - Optional org identity + direction hint. When provided the
   *   agent instructions are augmented so the LLM accurately classifies
   *   outgoing invoices. When absent, behavior is identical to before this parameter was added.
   * @returns A {@link Pass2Outcome} — success with a validated TriageResult,
   *          or failure with an explicit category.
   */
  async classify(markdown: string, ctx?: Pass2Context): Promise<Pass2Outcome> {
    const orgIdentityContext = this.toOrgIdentityContext(ctx);

    let enrichmentAgent: Awaited<
      ReturnType<MastraService['buildTriageEnrichmentAgent']>
    >;
    try {
      enrichmentAgent =
        await this.mastraService.buildTriageEnrichmentAgent(orgIdentityContext);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Mastra triage enrichment agent unavailable: ${detail}`,
      );
      return {
        ok: false,
        category: 'agent-unavailable',
        detail: `enrichment agent unavailable: ${detail}`,
      };
    }

    let enrichment: Pass2Enrichment;
    try {
      // Force the deterministic supplier lookup rather than leaving it to
      // `tool_choice=auto` (the issue #179 production failure: a model can
      // emit a final answer without ever calling the tool). The missing-tool
      // check below is the belt-and-braces diagnostic for when forcing isn't
      // honored by the runtime.
      const enrichmentResult = (await enrichmentAgent.generate(markdown, {
        toolChoice: { type: 'tool', toolName: GET_CLASSIFICATION_CONTEXT_TOOL },
      })) as unknown as EnrichmentGenerateResult;
      const { enrichment: parsedEnrichment, toolCalled } =
        this.parseEnrichment(enrichmentResult);
      if (parsedEnrichment === null) {
        this.logger.error('Pass 2 enrichment produced no reusable summary');
        return {
          ok: false,
          category: 'enrichment-incomplete',
          detail: 'enrichment phase returned no reusable summary',
        };
      }
      if (!toolCalled) {
        this.logger.error(
          `Pass 2 enrichment completed without calling ${GET_CLASSIFICATION_CONTEXT_TOOL} — the deterministic supplier lookup did not run`,
        );
        return {
          ok: false,
          category: 'enrichment-tool-not-called',
          detail: `enrichment phase completed without invoking ${GET_CLASSIFICATION_CONTEXT_TOOL}`,
        };
      }
      enrichment = parsedEnrichment;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Pass 2 enrichment failed: ${detail}`);
      return {
        ok: false,
        category: 'enrichment-failed',
        detail: `enrichment phase failed: ${detail}`,
      };
    }

    let classificationAgent: Awaited<
      ReturnType<MastraService['buildTriageClassificationAgent']>
    >;
    try {
      classificationAgent =
        await this.mastraService.buildTriageClassificationAgent(
          orgIdentityContext,
        );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Mastra triage classification agent unavailable: ${detail}`,
      );
      return {
        ok: false,
        category: 'agent-unavailable',
        detail: `strict classification agent unavailable: ${detail}`,
      };
    }

    const classificationPrompt = this.buildClassificationPrompt(
      markdown,
      enrichment,
    );

    // Track whether any attempt produced parseable-but-invalid output (vs.
    // every attempt throwing). The former is an `invalid-output` (the model
    // ran but never satisfied the schema); the latter is `transient`.
    let sawThrow = false;
    let sawInvalidOutput = false;
    let lastDetail = 'classification failed';

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      let rawOutput: unknown;
      try {
        // Real Mastra API: generate() with a `structuredOutput.schema` returns
        // a FullOutput whose parsed structured object is on `.object`.
        const result = await classificationAgent.generate(
          classificationPrompt,
          {
            structuredOutput: { schema: triageResultSchema },
          },
        );
        rawOutput = result.object;
      } catch (error) {
        sawThrow = true;
        const err = error instanceof Error ? error : new Error(String(error));
        lastDetail = err.message;
        this.logger.warn(
          `Pass 2 classification attempt ${attempt}/${MAX_RETRIES} threw: ${err.message}`,
        );
        continue;
      }

      // The call returned — explicit Zod parse in case generate()'s structured
      // output returns unvalidated data (model-dependent behavior).
      const parsed = triageResultSchema.safeParse(rawOutput);
      if (parsed.success) {
        return { ok: true, result: parsed.data, enrichment };
      }

      sawInvalidOutput = true;
      lastDetail = parsed.error.message;
      this.logger.warn(
        `Pass 2 classification attempt ${attempt}/${MAX_RETRIES} produced invalid output: ${parsed.error.message}`,
      );
    }

    // Categorize: a run that ever returned (even invalid) output is an
    // invalid-output failure; a run where every attempt threw is transient.
    const category: Pass2FailureCategory = sawInvalidOutput
      ? 'invalid-output'
      : sawThrow
        ? 'transient'
        : 'invalid-output';

    this.logger.error(
      `Pass 2 classification failed after ${MAX_RETRIES} attempts (category=${category})`,
    );
    return {
      ok: false,
      category,
      detail: `strict classification failed after ${MAX_RETRIES} attempts: ${lastDetail}`,
    };
  }
}
