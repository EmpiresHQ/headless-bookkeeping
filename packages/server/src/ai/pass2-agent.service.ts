import { normalizeIdentifier } from '../entities/identifier-normalization';
import {
  classificationPrompt,
  enrichmentFromContext,
  triageEvidenceSchema,
  triageContextSchema,
  TriageEvidence,
  TriageContext,
} from './triage-context';
import { Injectable, Logger } from '@nestjs/common';
import { MastraService } from './mastra.service';
import {
  triageResultSchema,
  TriageResult,
  Pass2Enrichment,
} from '../triage/types';
import { OrgIdentityContext } from './triage-instructions';
const MAX_RETRIES = 3;
const ENRICHMENT_MAX_ATTEMPTS = 2;

/** Legacy enrichment categories remain readable for persisted intake findings. */
export type Pass2FailureCategory =
  | 'agent-unavailable'
  | 'enrichment-failed'
  | 'enrichment-incomplete'
  | 'enrichment-tool-not-called'
  | 'evidence-invalid'
  | 'context-failed'
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

/** Extract evidence → application lookup → tool-free classification. */
@Injectable()
export class Pass2AgentService {
  private readonly logger = new Logger(Pass2AgentService.name);
  constructor(private readonly mastraService: MastraService) {}

  async classify(markdown: string, ctx?: Pass2Context): Promise<Pass2Outcome> {
    const orgIdentityContext: OrgIdentityContext | undefined = ctx
      ? { ...ctx.orgContext, directionHint: ctx.directionHint }
      : undefined;
    let extractionAgent: Awaited<
      ReturnType<MastraService['buildTriageEnrichmentAgent']>
    >;
    try {
      extractionAgent =
        await this.mastraService.buildTriageEnrichmentAgent(orgIdentityContext);
    } catch (error) {
      return {
        ok: false,
        category: 'agent-unavailable',
        detail: `evidence agent unavailable: ${String(error)}`,
      };
    }
    let evidence: TriageEvidence | undefined;
    let evidenceFailure: Pass2Failure = {
      ok: false,
      category: 'evidence-invalid',
      detail: 'No evidence',
    };
    for (let attempt = 0; attempt < ENRICHMENT_MAX_ATTEMPTS; attempt++) {
      try {
        const response = await extractionAgent.generate(
          JSON.stringify({ document: markdown }),
          {
            structuredOutput: { schema: triageEvidenceSchema },
            modelSettings: { temperature: 0, maxOutputTokens: 4096 },
            abortSignal: AbortSignal.timeout(180_000),
          },
        );
        if (response.error) throw response.error;
        const parsed = triageEvidenceSchema.safeParse(response.object);
        if (parsed.success) {
          evidence = parsed.data;
          break;
        }
        evidenceFailure = {
          ok: false,
          category: 'evidence-invalid',
          detail: `Invalid extracted evidence (finishReason=${response.finishReason ?? 'unknown'}): ${parsed.error.message}`,
        };
      } catch (error) {
        evidenceFailure = {
          ok: false,
          category: 'enrichment-failed',
          detail: `Evidence extraction failed: ${String(error)}`,
        };
      }
    }
    if (!evidence) return evidenceFailure;

    let context: TriageContext;
    try {
      context = triageContextSchema.parse(
        await this.mastraService.resolveTriageContext(evidence),
      );
    } catch (error) {
      // Never interpret a failed lookup/invalid response as "no supplier found".
      return {
        ok: false,
        category: 'context-failed',
        detail: `Context retrieval failed: ${String(error)}`,
      };
    }
    const enrichment = enrichmentFromContext(evidence, context);
    let agent: Awaited<
      ReturnType<MastraService['buildTriageClassificationAgent']>
    >;
    try {
      agent =
        await this.mastraService.buildTriageClassificationAgent(
          orgIdentityContext,
        );
    } catch (error) {
      return {
        ok: false,
        category: 'agent-unavailable',
        detail: `Classification agent unavailable: ${String(error)}`,
      };
    }
    let failure: Pass2Failure = {
      ok: false,
      category: 'invalid-output',
      detail: 'No classification',
    };
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await agent.generate(
          classificationPrompt(markdown, evidence, context),
          {
            structuredOutput: { schema: triageResultSchema },
            modelSettings: { temperature: 0, maxOutputTokens: 4096 },
            abortSignal: AbortSignal.timeout(180_000),
          },
        );
        if (response.error) throw response.error;
        const parsed = triageResultSchema.safeParse(response.object);
        if (!parsed.success) {
          failure = {
            ok: false,
            category: 'invalid-output',
            detail: parsed.error.message,
          };
          continue;
        }
        const result = parsed.data;
        if (result.kind === 'new_expense') {
          if (evidence.kind !== 'new_expense') {
            failure = {
              ok: false,
              category: 'invalid-output',
              detail: 'Expense classification has no purchase evidence context',
            };
            continue;
          }
          // Database IDs never originate from the final model response. Keep
          // observed identity from extraction for downstream contradiction checks.
          if (context.supplier.resolution === 'matched') {
            const proposal = result.supplier_proposal;
            const finalKey =
              proposal?.mode === 'match'
                ? proposal.observed_registration_key
                : proposal?.create_registration_key;
            const finalCountry =
              proposal?.mode === 'match'
                ? proposal.observed_country
                : proposal?.create_country;
            if (
              (finalKey &&
                normalizeIdentifier('registration_key', finalKey) !==
                  normalizeIdentifier(
                    'registration_key',
                    evidence.evidence.registrationKey ?? '',
                  )) ||
              (finalCountry && finalCountry !== context.supplier.country)
            ) {
              failure = {
                ok: false,
                category: 'invalid-output',
                detail:
                  'Final supplier evidence contradicts deterministic lookup',
              };
              continue;
            }
            result.supplier_proposal = {
              mode: 'match',
              match_entity_id: context.supplier.matchEntityId,
              observed_country: evidence.evidence.country,
              observed_registration_key: evidence.evidence.registrationKey,
            };
          } else if (result.supplier_proposal?.mode === 'match') {
            failure = {
              ok: false,
              category: 'invalid-output',
              detail:
                'Model proposed an existing supplier without a deterministic match',
            };
            continue;
          } else if (result.supplier_proposal?.mode === 'create') {
            const proposal = result.supplier_proposal;
            const observed = evidence.evidence;
            const proposedKey = normalizeIdentifier(
              'registration_key',
              proposal.create_registration_key ?? '',
            );
            const observedKey = normalizeIdentifier(
              'registration_key',
              observed.registrationKey ?? '',
            );
            if (
              proposedKey !== observedKey ||
              !observed.country ||
              proposal.create_country !== observed.country
            ) {
              failure = {
                ok: false,
                category: 'invalid-output',
                detail:
                  'New supplier identifiers contradict extracted evidence',
              };
              continue;
            }
          }
        }
        return { ok: true, result, enrichment };
      } catch (error) {
        failure = {
          ok: false,
          category: 'transient',
          detail: `Classification failed: ${String(error)}`,
        };
      }
    }
    this.logger.warn(failure.detail);
    return failure;
  }
}
