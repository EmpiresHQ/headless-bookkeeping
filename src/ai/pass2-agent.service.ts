import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { MastraService } from './mastra.service';
import { triageResultSchema, TriageResult } from '../triage/types';

const MAX_RETRIES = 3;

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
   * @param markdown - The Pass-1 markdown text (receipt/invoice content).
   * @returns A validated TriageResult, or null if classification fails after retries.
   */
  async classify(markdown: string): Promise<TriageResult | null> {
    const agent = this.mastraService.getAgent();
    if (!agent) {
      this.logger.error('Mastra agent not initialized');
      return null;
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const rawOutput = await agent.structuredOutput(markdown, {
          schema: triageResultSchema,
        });

        // Extra safety: explicit Zod parse in case structuredOutput
        // returns unvalidated data (model-dependent behavior).
        const validated = triageResultSchema.parse(rawOutput);
        return validated;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(
          `Pass 2 classification attempt ${attempt}/${MAX_RETRIES} failed: ${lastError.message}`,
        );
      }
    }

    this.logger.error(
      `Pass 2 classification failed after ${MAX_RETRIES} attempts, returning null`,
    );
    return null;
  }
}
