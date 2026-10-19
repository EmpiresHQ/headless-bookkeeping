import { MastraService } from './mastra.service';
import { Pass2AgentService } from './pass2-agent.service';
import { triageEvidenceSchema } from './triage-context';

const evidence = {
  kind: 'new_expense',
  category: 'software',
  evidence: {
    registrationKey: 'EE100000001',
    name: 'Seller',
    country: 'EE',
    goodsVsServices: 'services',
  },
};
const context = {
  supplier: {
    resolution: 'matched',
    matchEntityId: 37,
    name: 'Seller',
    country: 'EE',
  },
  classificationMemory: [{ category: 'software', count: 2 }],
};
const classification = {
  kind: 'new_expense',
  category: 'software',
  gross_amount: 400,
  vat_amount: 0,
  currency: 'EUR',
  tax_point_date: '2026-09-10',
  document_type: 'invoice',
  supplier_proposal: { mode: 'match', match_entity_id: 705731 },
};

describe('Pass2 application-owned context', () => {
  const extract = jest.fn();
  const classify = jest.fn();
  const lookup = jest.fn();
  const factory = {
    buildTriageEnrichmentAgent: jest.fn(),
    buildTriageClassificationAgent: jest.fn(),
    resolveTriageContext: lookup,
  };
  let service: Pass2AgentService;
  beforeEach(() => {
    jest.resetAllMocks();
    extract.mockResolvedValue({ object: evidence });
    classify.mockResolvedValue({ object: classification });
    lookup.mockResolvedValue(context);
    factory.buildTriageEnrichmentAgent.mockResolvedValue({ generate: extract });
    factory.buildTriageClassificationAgent.mockResolvedValue({
      generate: classify,
    });
    service = new Pass2AgentService(factory as unknown as MastraService);
  });

  it('extracts without toolChoice, performs one lookup and passes typed context directly', async () => {
    const result = await service.classify('receipt');
    expect(extract).toHaveBeenCalledWith(
      JSON.stringify({ document: 'receipt' }),
      {
        structuredOutput: { schema: triageEvidenceSchema },
        modelSettings: { temperature: 0, maxOutputTokens: 4096 },
        abortSignal: expect.any(AbortSignal),
      },
    );
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(evidence);
    expect(JSON.parse(classify.mock.calls[0][0] as string)).toEqual({
      document: 'receipt',
      extractedEvidence: evidence,
      lookupContext: context,
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        supplier_proposal: {
          mode: 'match',
          match_entity_id: 37,
          observed_registration_key: 'EE100000001',
        },
      },
      enrichment: { supplier: { matchEntityId: 37 } },
    });
  });

  it.each([
    undefined,
    {},
    { ...evidence, matchEntityId: 705731 },
    { ...evidence, evidence: { ...evidence.evidence, country: 'Estonia' } },
    { ...evidence, evidence: { ...evidence.evidence, country: 'EU' } },
  ])('rejects malformed/forged evidence before lookup: %j', async (object) => {
    extract.mockResolvedValue({ object });
    expect(await service.classify('receipt')).toMatchObject({
      ok: false,
      category: 'evidence-invalid',
    });
    expect(extract).toHaveBeenCalledTimes(2);
    expect(lookup).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    {},
    { ...context, supplier: { resolution: 'matched' } },
    { ...context, supplier: { ...context.supplier, matchEntityId: -1 } },
    { ...context, classificationMemory: [{ category: 'software', count: 0 }] },
  ])('fails closed on invalid lookup response: %j', async (response) => {
    lookup.mockResolvedValue(response);
    expect(await service.classify('receipt')).toMatchObject({
      ok: false,
      category: 'context-failed',
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it('distinguishes a failed lookup from an unmatched supplier', async () => {
    lookup.mockRejectedValue(new Error('database unavailable'));
    expect(await service.classify('receipt')).toMatchObject({
      ok: false,
      category: 'context-failed',
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it('holds an unidentified supplier with no country before asking the model to invent one', async () => {
    extract.mockResolvedValue({
      object: {
        ...evidence,
        evidence: {
          ...evidence.evidence,
          country: null,
          registrationKey: null,
        },
      },
    });
    lookup.mockResolvedValue({
      supplier: { resolution: 'unmatched' },
      classificationMemory: [],
    });
    expect(await service.classify('receipt')).toEqual({
      ok: false,
      category: 'context-failed',
      detail: 'Supplier country missing; manual triage required',
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it('rejects a fabricated existing supplier when lookup found no match', async () => {
    lookup.mockResolvedValue({
      supplier: { resolution: 'unmatched' },
      classificationMemory: [],
    });
    expect(await service.classify('receipt')).toMatchObject({
      ok: false,
      category: 'invalid-output',
    });
    expect(classify).toHaveBeenCalledTimes(3);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite contradictory final supplier evidence with an earlier match', async () => {
    classify.mockResolvedValue({
      object: {
        ...classification,
        supplier_proposal: {
          mode: 'match',
          match_entity_id: 37,
          observed_registration_key: 'EE999999999',
          observed_country: 'EE',
        },
      },
    });
    expect(await service.classify('receipt')).toMatchObject({
      ok: false,
      category: 'invalid-output',
      detail: 'Final supplier evidence contradicts deterministic lookup',
    });
  });

  it('allows a new supplier proposal without promoting a model ID', async () => {
    lookup.mockResolvedValue({
      supplier: { resolution: 'unmatched' },
      classificationMemory: [],
    });
    classify.mockResolvedValue({
      object: {
        ...classification,
        supplier_proposal: {
          mode: 'create',
          create_name: 'Seller',
          create_country: 'EE',
          create_registration_key: 'EE100000001',
        },
      },
    });
    expect(await service.classify('receipt')).toMatchObject({
      ok: true,
      result: { supplier_proposal: { mode: 'create' } },
    });
  });

  it('rejects a fabricated registration key in a new supplier proposal', async () => {
    lookup.mockResolvedValue({
      supplier: { resolution: 'unmatched' },
      classificationMemory: [],
    });
    classify.mockResolvedValue({
      object: {
        ...classification,
        supplier_proposal: {
          mode: 'create',
          create_name: 'Seller',
          create_country: 'EE',
          create_registration_key: 'EE999999999',
        },
      },
    });
    expect(await service.classify('receipt')).toMatchObject({
      ok: false,
      category: 'invalid-output',
    });
  });

  it('handles Mastra embedded errors as failures, not missing structured output', async () => {
    extract.mockResolvedValue({
      object: undefined,
      error: new Error('provider timeout'),
    });
    expect(await service.classify('receipt')).toMatchObject({
      ok: false,
      category: 'enrichment-failed',
      detail: expect.stringContaining('provider timeout'),
    });
    extract.mockResolvedValue({ object: evidence });
    classify.mockResolvedValue({
      object: undefined,
      error: new Error('provider timeout'),
    });
    expect(await service.classify('receipt')).toMatchObject({
      ok: false,
      category: 'transient',
    });
  });

  it('retries transient extraction, not a whole agent tool loop', async () => {
    extract.mockRejectedValueOnce(new Error('timeout'));
    expect(await service.classify('receipt')).toMatchObject({ ok: true });
    expect(extract).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable agent and exhausted extraction distinctly', async () => {
    factory.buildTriageEnrichmentAgent.mockRejectedValueOnce(
      new Error('no model'),
    );
    expect(await service.classify('receipt')).toMatchObject({
      ok: false,
      category: 'agent-unavailable',
    });
    extract.mockRejectedValue(new Error('timeout'));
    expect(await service.classify('receipt')).toMatchObject({
      ok: false,
      category: 'enrichment-failed',
    });
  });

  it('retries invalid final output with the same retrieved context', async () => {
    classify.mockResolvedValueOnce({ object: {} });
    expect(await service.classify('receipt')).toMatchObject({ ok: true });
    expect(classify).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('allows irrelevant documents but refuses upgrading them to expenses without context', async () => {
    extract.mockResolvedValue({
      object: { ...evidence, kind: 'not_a_document', category: null },
    });
    lookup.mockResolvedValue({
      supplier: { resolution: 'unmatched' },
      classificationMemory: [],
    });
    expect(await service.classify('newsletter')).toMatchObject({
      ok: false,
      category: 'invalid-output',
    });
    classify.mockResolvedValue({
      object: {
        ...classification,
        kind: 'not_a_document',
        category: '',
        supplier_proposal: undefined,
      },
    });
    expect(await service.classify('newsletter')).toMatchObject({
      ok: true,
      result: { kind: 'not_a_document' },
    });
  });

  it.each([{ currency: 'EURO' }, { confidence: 1.5 }, { kind: 'invalid' }])(
    'preserves final schema validation: %j',
    async (invalid) => {
      classify.mockResolvedValue({ object: { ...classification, ...invalid } });
      expect(await service.classify('receipt')).toMatchObject({
        ok: false,
        category: 'invalid-output',
      });
      expect(classify).toHaveBeenCalledTimes(3);
    },
  );
  it('reports exhausted final generation failures and unavailable classifier', async () => {
    classify.mockRejectedValue(new Error('timeout'));
    expect(await service.classify('receipt')).toMatchObject({
      ok: false,
      category: 'transient',
    });
    factory.buildTriageClassificationAgent.mockRejectedValue(
      new Error('no model'),
    );
    expect(await service.classify('receipt')).toMatchObject({
      ok: false,
      category: 'agent-unavailable',
    });
  });

  it('removes actionable accounting proposals from irrelevant files', async () => {
    extract.mockResolvedValue({
      object: { ...evidence, kind: 'not_a_document', category: null },
    });
    lookup.mockResolvedValue({
      supplier: { resolution: 'unmatched' },
      classificationMemory: [],
    });
    classify.mockResolvedValue({
      object: {
        ...classification,
        kind: 'not_a_document',
        customer_proposal: { mode: 'match', match_entity_id: 999 },
      },
    });
    const outcome = await service.classify('newsletter');
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        kind: 'not_a_document',
        gross_amount: 0,
        vat_amount: 0,
        category: '',
      },
    });
    if (!outcome.ok) throw new Error('expected classification');
    expect(outcome.result.supplier_proposal).toBeUndefined();
    expect(outcome.result.customer_proposal).toBeUndefined();
  });

  it('forwards organization/direction context to both model phases', async () => {
    const ctx = {
      orgContext: {
        name: 'Buyer',
        vatNumber: 'EE100000002',
        iban: null,
      },
      directionHint: 'outgoing' as const,
    };
    // Use the public type rather than relying on optional identity fields here.
    await service.classify(
      'invoice',
      ctx as unknown as Parameters<Pass2AgentService['classify']>[1],
    );
    expect(factory.buildTriageEnrichmentAgent).toHaveBeenCalledWith({
      ...ctx.orgContext,
      directionHint: 'outgoing',
    });
    expect(factory.buildTriageClassificationAgent).toHaveBeenCalledWith({
      ...ctx.orgContext,
      directionHint: 'outgoing',
    });
  });
});

// ── Issue #406: model refusal (finishReason=tripwire) & relevance gate ──
describe('Pass2 model refusal and the application-owned relevance gate', () => {
  const extract = jest.fn();
  const classify = jest.fn();
  const relevance = jest.fn();
  const lookup = jest.fn();
  const factory = {
    buildTriageRelevanceAgent: jest.fn(),
    buildTriageEnrichmentAgent: jest.fn(),
    buildTriageClassificationAgent: jest.fn(),
    resolveTriageContext: lookup,
  };
  let service: Pass2AgentService;
  beforeEach(() => {
    jest.resetAllMocks();
    // The gate accepts by default: existing enrichment/classification flows
    // run unchanged behind an accepted gate.
    relevance.mockResolvedValue({ object: { kind: 'business_document' } });
    factory.buildTriageRelevanceAgent.mockResolvedValue({
      generate: relevance,
    });
    factory.buildTriageEnrichmentAgent.mockResolvedValue({
      generate: extract,
    });
    factory.buildTriageClassificationAgent.mockResolvedValue({
      generate: classify,
    });
    lookup.mockResolvedValue(context);
    extract.mockResolvedValue({ object: evidence });
    classify.mockResolvedValue({ object: classification });
    service = new Pass2AgentService(factory as unknown as MastraService);
  });

  it('a validated gate rejection skips enrichment entirely: a privacy-policy PDF never reaches a refusing enrichment model', async () => {
    relevance.mockResolvedValue({ object: { kind: 'not_a_document' } });
    // The enrichment model WOULD refuse this file (issue #406 production
    // documents 272/273) — the gate rejection must route around it.
    extract.mockResolvedValue({ finishReason: 'tripwire', object: undefined });
    const outcome = await service.classify('Privacy policy PDF text');
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        kind: 'not_a_document',
        gross_amount: 0,
        vat_amount: 0,
        category: '',
      },
    });
    expect(relevance).toHaveBeenCalledTimes(1);
    expect(extract).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('a refusal on a gate-accepted document is a typed, plain-language outcome — never evidence validation detail — and is not retried internally', async () => {
    extract.mockResolvedValue({ finishReason: 'tripwire', object: undefined });
    const outcome = await service.classify(
      'A genuine business invoice which the model declines to read',
    );
    expect(outcome).toMatchObject({
      ok: false,
      category: 'model-refusal',
    });
    if (!outcome.ok) {
      expect(outcome.detail).not.toMatch(
        /Invalid extracted evidence|finishReason=/,
      );
      expect(outcome.detail).toContain('declined to read');
    }
    // A refusal will refuse again: no internal retry loop burns a second call.
    expect(extract).toHaveBeenCalledTimes(1);
    expect(classify).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('recognizes the provider content-filter refusal shape like the Mastra tripwire shape', async () => {
    extract.mockResolvedValue({
      finishReason: 'content-filter',
      object: undefined,
    });
    expect(await service.classify('A business invoice')).toMatchObject({
      ok: false,
      category: 'model-refusal',
    });
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('a refusal in the final classification phase is typed as model-refusal too, distinct from invalid-output', async () => {
    classify.mockResolvedValue({ finishReason: 'tripwire', object: undefined });
    const outcome = await service.classify('A genuine business invoice');
    expect(outcome).toMatchObject({ ok: false, category: 'model-refusal' });
    if (!outcome.ok) expect(outcome.detail).toContain('declined to read');
    expect(classify).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('a gate refusal or ambiguous gate answer must NOT fabricate not_a_document — safe validated processing continues', async () => {
    // The gate itself refuses: fall through to the ordinary pipeline, where
    // the enrichment refusal is reported as the typed model-refusal outcome.
    relevance.mockResolvedValue({
      finishReason: 'tripwire',
      object: undefined,
    });
    extract.mockResolvedValue({ finishReason: 'tripwire', object: undefined });
    expect(await service.classify('Terms of sale PDF text')).toMatchObject({
      ok: false,
      category: 'model-refusal',
    });
    expect(relevance).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);

    // An ambiguous gate answer is equally not a rejection: enrich normally.
    relevance.mockResolvedValue({ object: { kind: 'unknown' } });
    extract.mockResolvedValue({ object: evidence });
    expect(await service.classify('A genuine business invoice')).toMatchObject({
      ok: true,
      result: { kind: 'new_expense' },
    });
  });

  it('keeps ordinary malformed evidence and provider failures distinguishable from refusals', async () => {
    extract.mockResolvedValue({ object: {} });
    expect(await service.classify('receipt')).toMatchObject({
      ok: false,
      category: 'evidence-invalid',
    });
    extract.mockResolvedValue({
      object: undefined,
      error: new Error('provider timeout'),
    });
    expect(await service.classify('receipt')).toMatchObject({
      ok: false,
      category: 'enrichment-failed',
    });
  });

  it('a gate-accepted preliminary document keeps its order_confirmation routing — the coarse gate must not junk it', async () => {
    // Order confirmations/proformas are business_document for the gate and
    // not_a_document for the final classification; the workflow routes them
    // via the specific non-postable hold, NOT the generic junk reason.
    relevance.mockResolvedValue({ object: { kind: 'business_document' } });
    classify.mockResolvedValue({
      object: {
        ...classification,
        kind: 'not_a_document',
        category: '',
        document_type: 'order_confirmation',
        supplier_proposal: undefined,
      },
    });
    const outcome = await service.classify('Order confirmation T42');
    expect(outcome).toMatchObject({
      ok: true,
      result: { kind: 'not_a_document', document_type: 'order_confirmation' },
    });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('refusal takes precedence over a provider error and over valid-looking output in every phase', async () => {
    // Root-review regressions: a recognized refusal is checked FIRST — a
    // refused generation must never become accepted evidence/proposal, and
    // must not be flattened into a provider error or retried.
    // (a) tripwire + valid evidence object → refusal, not accepted evidence.
    extract.mockResolvedValue({ finishReason: 'tripwire', object: evidence });
    expect(await service.classify('invoice')).toMatchObject({
      ok: false,
      category: 'model-refusal',
    });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(classify).not.toHaveBeenCalled();

    // (b) content-filter + valid final proposal → refusal, not an accepted
    // proposal.
    extract.mockResolvedValue({ object: evidence });
    classify.mockResolvedValue({
      finishReason: 'content-filter',
      object: classification,
    });
    expect(await service.classify('invoice')).toMatchObject({
      ok: false,
      category: 'model-refusal',
    });
    expect(classify).toHaveBeenCalledTimes(1);

    // (c) tripwire + embedded provider error → classified refusal, never
    // enrichment-failed, never retried.
    extract.mockResolvedValue({
      finishReason: 'tripwire',
      object: undefined,
      error: new Error('provider timeout'),
    });
    extract.mockClear();
    const outcome = await service.classify('invoice');
    expect(outcome).toMatchObject({ ok: false, category: 'model-refusal' });
    if (!outcome.ok) expect(outcome.detail).toContain('declined to read');
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('a refused gate answer with a residual not_a_document object is never trusted as a rejection', async () => {
    relevance.mockResolvedValue({
      finishReason: 'tripwire',
      object: { kind: 'not_a_document' },
    });
    extract.mockResolvedValue({ object: evidence });
    expect(await service.classify('Terms of sale PDF text')).toMatchObject({
      ok: true,
      result: { kind: 'new_expense' },
    });
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('forwards organization/direction context to the relevance gate', async () => {
    relevance.mockResolvedValue({ object: { kind: 'not_a_document' } });
    await service.classify('Terms of sale PDF text', {
      orgContext: {
        name: 'Buyer',
        vatNumber: 'EE100000002',
        iban: null,
      },
      directionHint: 'outgoing',
    });
    expect(factory.buildTriageRelevanceAgent).toHaveBeenCalledWith({
      name: 'Buyer',
      vatNumber: 'EE100000002',
      iban: null,
      directionHint: 'outgoing',
    });
  });
});
