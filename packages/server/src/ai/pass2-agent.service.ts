import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { MastraService } from './mastra.service';
import { triageResultSchema, TriageResult } from '../triage/types';
import { OrgIdentityContext } from './triage-instructions';

const MAX_RETRIES = 3;
const ENRICHMENT_SECTION_HEADING = 'Deterministic enrichment summary';

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
  | 'invalid-output'
  | 'transient';

const pass2EnrichmentSupplierSchema = z.object({
  matchEntityId: z.number().int().positive().optional(),
});

const pass2EnrichmentToolContextSchema = z.object({
  supplier: pass2EnrichmentSupplierSchema.optional(),
});

export const pass2EnrichmentSchema = z.object({
  summary: z.string(),
  supplier: pass2EnrichmentSupplierSchema.optional(),
});

export type Pass2Enrichment = z.infer<typeof pass2EnrichmentSchema>;

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
 * Flow:
 * 1. Gets the Mastra agent from MastraService.
 * 2. Calls `agent.generate(markdown, { structuredOutput: { schema } })` and
 *    reads the parsed structured object from `result.object`.
 * 3. Validates the output against the TriageResult Zod schema.
 * 4. Bounded retry: if validation fails, retry up to MAX_RETRIES times.
 * 5. After MAX_RETRIES failures, returns null (signals needs_triage).
 *
 * The agent uses read-only tools only (searchSuppliers, listCategories,
 * getClassificationMemory, previewCategoryMapping). It never outputs
 * an account or VAT code — the country plugin is the sole resolver (ADR-0002).
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

  private parseEnrichmentSupplier(
    enrichmentObject: unknown,
  ): Pass2Enrichment['supplier'] | undefined {
    const parsed = pass2EnrichmentToolContextSchema.safeParse(enrichmentObject);
    return parsed.success ? parsed.data.supplier : undefined;
  }

  private parseEnrichment(result: {
    object: unknown;
    text: string;
  }): Pass2Enrichment | null {
    const supplier = this.parseEnrichmentSupplier(result.object);
    const summary = result.text.trim();
    if (summary.length > 0) {
      return pass2EnrichmentSchema.parse({ summary, supplier });
    }

    if (result.object === undefined) {
      return null;
    }

    return pass2EnrichmentSchema.parse({
      summary: JSON.stringify(result.object),
      supplier,
    });
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
      const enrichmentResult = await enrichmentAgent.generate(markdown);
      const parsedEnrichment = this.parseEnrichment(enrichmentResult);
      if (parsedEnrichment === null) {
        this.logger.error('Pass 2 enrichment produced no reusable summary');
        return {
          ok: false,
          category: 'enrichment-incomplete',
          detail: 'enrichment phase returned no reusable summary',
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
