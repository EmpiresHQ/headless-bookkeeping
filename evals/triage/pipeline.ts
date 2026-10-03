/** Live prompt eval: the actual Mastra factories, schemas and Pass2 orchestration.
 * All business reads use synthetic fixtures; there is no database or write path.
 */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { MastraService } from '../../packages/server/src/ai/mastra.service';
import { Pass2AgentService } from '../../packages/server/src/ai/pass2-agent.service';
import {
  AGENT_PROMPTS,
  AgentKey,
  ModelConfig,
} from '../../packages/server/src/ai/agent-config';
import { EstoniaCountryPlugin } from '../../packages/server/src/plugins/estonia-country.plugin';
import {
  triageEvalCases,
  evaluateTriageCase,
} from '../../packages/server/test/triage-evals/cases';
import type { TriageEvidence } from '../../packages/server/src/ai/triage-context';

async function main() {
  const { EVAL_BASE_URL, EVAL_MODEL, OPENAI_API_KEY } = process.env;
  if (!EVAL_BASE_URL || !EVAL_MODEL)
    throw new Error('Set EVAL_BASE_URL, EVAL_MODEL, OPENAI_API_KEY');
  // No FX operation is reached by context retrieval or prompt construction.
  const plugin = new EstoniaCountryPlugin(undefined as never);
  const categories = plugin.getCategories();
  const factory = new MastraService(
    {
      resolveByIdentifier: async (_kind: string, key: string) =>
        key === 'EE100000001'
          ? { id: 37, name: 'Example Cloud OÜ', country: 'EE' }
          : undefined,
    } as never,
    {
      getPostedCategoryHistory: async () => [
        { category: 'software', count: 9 },
      ],
    } as never,
    { resolve: () => plugin } as never,
    {
      getOrganization: async () => ({
        country: 'EE',
        vat_registered: true,
        base_currency: 'EUR',
      }),
    } as never,
    {
      resolveInstructions: async (key: AgentKey) => AGENT_PROMPTS[key],
      resolveModelConfig: async (): Promise<ModelConfig> => ({
        id: (EVAL_MODEL.includes('/')
          ? EVAL_MODEL
          : `openai/${EVAL_MODEL}`) as `${string}/${string}`,
        url: EVAL_BASE_URL,
        apiKey: OPENAI_API_KEY,
      }),
    } as never,
    {
      list: async () => categories,
      isValid: async (key: string) => categories.some((c) => c.key === key),
    } as never,
  );
  let observed: TriageEvidence | undefined;
  const resolve = factory.resolveTriageContext.bind(factory);
  factory.resolveTriageContext = async (input) => {
    observed = input;
    return resolve(input);
  };
  const service = new Pass2AgentService(factory);
  const reports: unknown[] = [];
  let failed = 0;
  const repetitions = Number(process.env.EVAL_REPEATS ?? 1);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10)
    throw new Error('EVAL_REPEATS must be an integer between 1 and 10');
  for (let repeat = 0; repeat < repetitions; repeat++) {
    for (const test of triageEvalCases) {
      if (process.env.EVAL_FILTER && !test.id.includes(process.env.EVAL_FILTER))
        continue;
      observed = undefined;
      const start = Date.now();
      const outcome = await service.classify(test.markdown, {
        orgContext: {
          name: 'Sample Buyer OÜ',
          vatNumber: 'EE100000002',
          iban: 'EE000000000000000000',
        },
        directionHint: test.direction ?? 'incoming',
      });
      const errors = evaluateTriageCase(test, outcome, observed);
      if (errors.length) failed++;
      console.log(
        `${errors.length ? 'FAIL' : 'PASS'} ${test.id} (${Date.now() - start}ms) ${errors.join('; ')}`,
      );
      reports.push({
        id: test.id,
        repeat,
        negative: !!test.negative,
        elapsedMs: Date.now() - start,
        errors,
        evidence: observed,
        outcome,
      });
      if (process.env.EVAL_REPORT)
        writeFileSync(
          process.env.EVAL_REPORT,
          JSON.stringify({ model: EVAL_MODEL, reports }, null, 2),
        );
    }
  }
  if (!reports.length) throw new Error('No eval cases selected');
  console.log(`${reports.length - failed}/${reports.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
