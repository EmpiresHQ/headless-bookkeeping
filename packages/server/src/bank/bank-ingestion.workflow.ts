import { createWorkflow, createStep } from '@mastra/core/workflows';
import type { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { mappingRulesetSchema } from './bank-mapping.types';
import { applyRules, validateRuleset } from './apply-rules';
import { createStatementSchema } from './bank-statement.types';

const ingestInput = z.object({ csvText: z.string(), accountHint: z.string() });

/**
 * The Mastra workflow: inferMapping (LLM → ruleset) → validateRuleset
 * (deterministic sanity check) → applyRules (deterministic →
 * CreateStatementInput). Built per call with the bank-mapping agent injected,
 * so it carries no NestJS coupling. Run via `(await wf.createRun()).start(...)`.
 *
 * A repeat import with a stored profile never reaches this workflow: the
 * service applies the stored ruleset directly. An inferred ruleset, by
 * contrast, is never applied until it has passed validation.
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
      const headerAndSamples = inputData.csvText
        .split('\n')
        .slice(0, 6)
        .join('\n');
      const res = await agent.generate(
        `Account hint: ${inputData.accountHint}\nCSV (header + samples):\n${headerAndSamples}`,
        { structuredOutput: { schema: mappingRulesetSchema } },
      );
      const parsed = mappingRulesetSchema.safeParse(
        (res as { object?: unknown }).object,
      );
      if (!parsed.success) {
        throw new Error(
          `bank_mapping agent returned an invalid ruleset: ${parsed.error.message}`,
        );
      }
      return { ruleset: parsed.data, csvText: inputData.csvText };
    },
  });

  const validate = createStep({
    id: 'validateRuleset',
    inputSchema: z.object({
      ruleset: mappingRulesetSchema,
      csvText: z.string(),
    }),
    outputSchema: z.object({
      ruleset: mappingRulesetSchema,
      csvText: z.string(),
    }),
    execute: ({ inputData }) => {
      validateRuleset(inputData.ruleset, inputData.csvText);
      return Promise.resolve(inputData);
    },
  });

  const apply = createStep({
    id: 'applyRules',
    inputSchema: z.object({
      ruleset: mappingRulesetSchema,
      csvText: z.string(),
    }),
    outputSchema: z.object({
      ruleset: mappingRulesetSchema,
      input: createStatementSchema,
    }),
    // applyRules is synchronous; wrap in a resolved promise to satisfy the
    // step's Promise-returning execute contract without an empty `async`.
    execute: ({ inputData }) =>
      Promise.resolve({
        ruleset: inputData.ruleset,
        input: applyRules(inputData.ruleset, inputData.csvText),
      }),
  });

  return createWorkflow({
    id: 'bank-ingestion',
    inputSchema: ingestInput,
    outputSchema: z.object({
      ruleset: mappingRulesetSchema,
      input: createStatementSchema,
    }),
  })
    .then(inferMapping)
    .then(validate)
    .then(apply)
    .commit();
}
