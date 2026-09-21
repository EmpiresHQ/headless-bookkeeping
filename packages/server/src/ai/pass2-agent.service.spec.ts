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
