/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import { MastraService } from './mastra.service';
import { triageResultSchema, TriageResult } from '../triage/types';

const MAX_RETRIES = 3;

/**
 * Why Pass 2 failed to produce a validated TriageResult. Surfaced to the
 * workflow (ADR-0024) so it can route/observe appropriately instead of
 * receiving a bare `null` that erases the distinction between an unconfigured
 * runtime, a model that never emitted valid structure, and a transient blip.
 *
 *  - 'agent-unavailable':  the Mastra agent was not initialized (config/runtime
 *                          fault) — no attempt was even made.
 *  - 'invalid-output':     the agent ran but never produced schema-valid output
 *                          within the bounded retry (the ADR-0024 "invalid
 *                          output → bounded retry → needs_triage" case).
 *  - 'transient':         every attempt threw (timeouts/rate-limits) and never
 *                          returned parseable output — likely retryable later.
 */
export type Pass2FailureCategory =
  | 'agent-unavailable'
  | 'invalid-output'
  | 'transient';

/** A successfully validated Pass-2 classification. */
export interface Pass2Success {
  ok: true;
  result: TriageResult;
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
 * Pass2AgentService — runs the Pass 2 Mastra agent over Pass-1 markdown
 * and emits a Zod-validated TriageResult.
 *
 * Flow:
 * 1. Gets the Mastra agent from MastraService.
 * 2. Calls the agent with the markdown as input via structuredOutput.
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
   * @returns A {@link Pass2Outcome} — success with a validated TriageResult,
   *          or failure with an explicit category.
   */
  async classify(markdown: string): Promise<Pass2Outcome> {
    const agent = this.mastraService.getAgent();
    if (!agent) {
      this.logger.error('Mastra agent not initialized');
      return {
        ok: false,
        category: 'agent-unavailable',
        detail: 'Mastra agent not initialized',
      };
    }

    const agentAny = agent;
    // Track whether any attempt produced parseable-but-invalid output (vs.
    // every attempt throwing). The former is an `invalid-output` (the model
    // ran but never satisfied the schema); the latter is `transient`.
    let sawThrow = false;
    let sawInvalidOutput = false;
    let lastDetail = 'classification failed';

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      let rawOutput: unknown;
      try {
        rawOutput = await agentAny.structuredOutput(markdown, {
          schema: triageResultSchema,
        });
      } catch (error) {
        sawThrow = true;
        const err = error instanceof Error ? error : new Error(String(error));
        lastDetail = err.message;
        this.logger.warn(
          `Pass 2 classification attempt ${attempt}/${MAX_RETRIES} threw: ${err.message}`,
        );
        continue;
      }

      // The call returned — explicit Zod parse in case structuredOutput
      // returns unvalidated data (model-dependent behavior).
      const parsed = triageResultSchema.safeParse(rawOutput);
      if (parsed.success) {
        return { ok: true, result: parsed.data };
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
    return { ok: false, category, detail: lastDetail };
  }
}
