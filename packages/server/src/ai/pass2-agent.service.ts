import { normalizeIdentifier } from '../entities/identifier-normalization';
import {
  classificationPrompt,
  enrichmentFromContext,
  triageEvidenceSchema,
  triageContextSchema,
  triageRelevanceSchema,
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

/** A validated gate rejection: the normal not_a_document classification the
 *  workflow routes to needs_triage with the standard human reason. Built via
 *  parse so every safely-defaultable field (currency, outgoing_signals,
 *  document_type) carries the same defaults as a model-produced rejection. */
function gateRejectedResult(): TriageResult {
  return triageResultSchema.parse({
    kind: 'not_a_document',
    gross_amount: 0,
    vat_amount: 0,
    tax_point_date: '',
    category: '',
  });
}

const MAX_RETRIES = 3;
const ENRICHMENT_MAX_ATTEMPTS = 2;

/**
 * Finish reasons that mean the model REFUSED to process the input — a
 * model-level event, not an intake fault (issue #406). `tripwire` is the
 * @mastra/core TripWire shape (any processor may abort processing with it);
 * `content-filter` is the AI SDK provider refusal shape. Any other value is
 * an ordinary generation outcome and flows through the existing validation.
 */
const REFUSAL_FINISH_REASONS = new Set(['tripwire', 'content-filter']);

function isModelRefusal(finishReason: unknown): boolean {
  return (
    typeof finishReason === 'string' && REFUSAL_FINISH_REASONS.has(finishReason)
  );
}

/** Plain-language operator reason for a refused generation. Never carries
 *  validation-stack or finish-reason detail — the operator can only retry once
 *  (the intake Retry AI path) or archive the file as not a business document. */
const MODEL_REFUSAL_DETAIL =
  'The AI model declined to read this file, so automatic classification did not run';

/** Legacy enrichment categories remain readable for persisted intake findings. */
export type Pass2FailureCategory =
  | 'agent-unavailable'
  | 'enrichment-failed'
  | 'enrichment-incomplete'
  | 'enrichment-tool-not-called'
  | 'evidence-invalid'
  | 'model-refusal'
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
    // ── Cheap application-owned relevance gate (issue #406) ───────
    // Run BEFORE the expensive enrichment/classification pipeline so obvious
    // non-business files (privacy policies, terms of sale, marketing — the
    // production documents 272/273 class of input) never reach it. Only a
    // VALIDATED explicit `not_a_document` rejection short-circuits with the
    // normal not_a_document routing; anything else (accepted, ambiguous,
    // refused, failed gate) proceeds to the full pipeline, so the gate can
    // never fabricate a classification and order/proforma/non-postable routing
    // invariants are preserved downstream.
    if ((await this.relevanceGate(markdown, orgIdentityContext)) === 'reject') {
      return { ok: true, result: gateRejectedResult() };
    }
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
        // A recognized refusal takes PRECEDENCE over parsing and error
        // handling (issue #406): a refused generation must never become
        // accepted evidence, and must not be flattened into a provider
        // error or a schema-validation failure. No retry — it will refuse
        // again.
        if (isModelRefusal(response.finishReason)) {
          this.logger.warn(
            `Evidence extraction refused by the model (finishReason=${response.finishReason})`,
          );
          return {
            ok: false,
            category: 'model-refusal',
            detail: MODEL_REFUSAL_DETAIL,
          };
        }
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
    if (
      evidence.kind === 'new_expense' &&
      context.supplier.resolution === 'unmatched' &&
      !evidence.evidence.country
    ) {
      return {
        ok: false,
        category: 'context-failed',
        detail: 'Supplier country missing; manual triage required',
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
        // Same precedence as extraction: a refusal in the final phase is a
        // typed, plain-language outcome before any schema/throw handling —
        // a refused final response must never become an accepted proposal
        // nor an invalid-output retry (issue #406).
        if (isModelRefusal(response.finishReason)) {
          this.logger.warn(
            `Final classification refused by the model (finishReason=${response.finishReason})`,
          );
          return {
            ok: false,
            category: 'model-refusal',
            detail: MODEL_REFUSAL_DETAIL,
          };
        }
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
        if (result.kind === 'not_a_document') {
          // Non-accounting files carry no actionable accounting proposals,
          // even when the model fills optional fields from document text.
          result.gross_amount = 0;
          result.vat_amount = 0;
          result.category = '';
          delete result.supplier_proposal;
          delete result.customer_proposal;
        }

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

  /**
   * The cheap relevance pass BEFORE enrichment (issue #406). The gate is
   * ADVISORY: only a validated explicit `not_a_document` answer short-circuits
   * ("reject"). Every other outcome — accepted, ambiguous, refused, invalid
   * or failed output, even an unavailable gate — returns "proceed" so the
   * full, schema-validated pipeline runs unchanged. The gate therefore can
   * never fabricate not_a_document, and a junk file whose gate answer is
   * missing still gets the ordinary refusal/evidence handling downstream.
   */
  private async relevanceGate(
    markdown: string,
    orgIdentityContext: OrgIdentityContext | undefined,
  ): Promise<'reject' | 'proceed'> {
    try {
      const agent =
        await this.mastraService.buildTriageRelevanceAgent(orgIdentityContext);
      const response = await agent.generate(markdown, {
        structuredOutput: { schema: triageRelevanceSchema },
        modelSettings: { temperature: 0, maxOutputTokens: 512 },
        abortSignal: AbortSignal.timeout(60_000),
      });
      // A refused gate is never trusted — even a residual object that looks
      // like a rejection must not become the gate's decision (issue #406
      // root review): fall through to the full pipeline.
      if (isModelRefusal(response.finishReason)) return 'proceed';
      if (response.error) return 'proceed';
      const parsed = triageRelevanceSchema.safeParse(response.object);
      if (parsed.success && parsed.data.kind === 'not_a_document') {
        this.logger.warn(
          'Relevance gate rejected the file as not a business document — skipping enrichment',
        );
        return 'reject';
      }
      return 'proceed';
    } catch (error) {
      this.logger.debug(
        `Relevance gate unavailable — proceeding with the full pipeline: ${String(error)}`,
      );
      return 'proceed';
    }
  }
}
