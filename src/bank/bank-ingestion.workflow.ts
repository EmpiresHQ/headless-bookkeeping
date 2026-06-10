import { createWorkflow, createStep } from '@mastra/core/workflows';
import type { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { mappingRulesetSchema } from './bank-mapping.types';
import { applyRules } from './apply-rules';
import { createStatementSchema } from './bank-statement.types';

const ingestInput = z.object({ csvText: z.string(), accountHint: z.string() });

/**
 * The Mastra workflow: inferMapping (LLM → ruleset) → applyRules (deterministic
 * → CreateStatementInput). Built per call with the bank-mapping agent injected,
 * so it carries no NestJS coupling. Run via `(await wf.createRun()).start(...)`.
 */
export function buildBankIngestionWorkflow(agent: Agent) {
  const inferMapping = createStep({
    id: 'inferMapping',
    inputSchema: ingestInput,
    outputSchema: z.object({
      ruleset: mappingRulesetSchema,
      csvText: z.string(),
    }),
    execute: async ({ inputData }) => {
      const headerAndSamples = inputData.csvText.split('\n').slice(0, 6).join('\n');
      const res = await agent.generate(
        `Account hint: ${inputData.accountHint}\nCSV (header + samples):\n${headerAndSamples}`,
        { structuredOutput: { schema: mappingRulesetSchema } },
      );
      const parsed = mappingRulesetSchema.safeParse(
        (res as { object?: unknown }).object,
      );
      if (!parsed.success) {
        throw new Error(`bank_mapping agent returned an invalid ruleset: ${parsed.error.message}`);
      }
      return { ruleset: parsed.data, csvText: inputData.csvText };
    },
  });

  const apply = createStep({
    id: 'applyRules',
    inputSchema: z.object({ ruleset: mappingRulesetSchema, csvText: z.string() }),
    outputSchema: createStatementSchema,
    execute: async ({ inputData }) =>
      applyRules(inputData.ruleset, inputData.csvText),
  });

  return createWorkflow({
    id: 'bank-ingestion',
    inputSchema: ingestInput,
    outputSchema: createStatementSchema,
  })
    .then(inferMapping)
    .then(apply)
    .commit();
}
