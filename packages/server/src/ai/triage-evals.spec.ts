import {
  evaluateTriageCase,
  triageEvalCases,
} from '../../test/triage-evals/cases';
import { triageResultSchema } from '../triage/types';
import { TriageEvidence } from './triage-context';
import { Pass2Outcome } from './pass2-agent.service';

describe('prompt eval assertions (negative controls)', () => {
  const known = triageEvalCases[0];
  const evidence: TriageEvidence = {
    kind: 'new_expense',
    category: 'software',
    evidence: {
      registrationKey: 'EE100000001',
      country: 'EE',
      name: 'Example Cloud',
      goodsVsServices: 'services',
    },
  };
  const good = (): Pass2Outcome => ({
    ok: true,
    result: triageResultSchema.parse({
      kind: 'new_expense',
      category: 'software',
      gross_amount: 2480,
      vat_amount: 480,
      tax_point_date: '2026-09-10',
      supplier_proposal: { mode: 'match', match_entity_id: 37 },
    }),
    enrichment: { summary: '', supplier: { matchEntityId: 37 } },
  });
  it('accepts the expected classification and rejects a schema-valid fabricated ID', () => {
    const outcome = good();
    expect(evaluateTriageCase(known, outcome, evidence)).toEqual([]);
    if (!outcome.ok) throw new Error('fixture');
    outcome.result.supplier_proposal = {
      mode: 'match',
      match_entity_id: 705731,
    };
    expect(evaluateTriageCase(known, outcome, evidence)).toContain(
      'lost deterministic supplier identity',
    );
  });
  it('fails on a plausible but wrong amount/category/kind', () => {
    const outcome = good();
    if (!outcome.ok) throw new Error('fixture');
    outcome.result.gross_amount = 24;
    outcome.result.category = 'meals';
    outcome.result.kind = 'correction';
    expect(evaluateTriageCase(known, outcome, evidence)).toHaveLength(3);
  });
  it('rejects fabricated evidence and pipeline failures', () => {
    const missing = triageEvalCases.find(
      (test) => test.id === 'missing-registration',
    )!;
    expect(evaluateTriageCase(missing, good(), evidence)).toContain(
      'wrong or invented supplier registration key',
    );
    expect(
      evaluateTriageCase(known, {
        ok: false,
        category: 'context-failed',
        detail: 'offline',
      }),
    ).toEqual(['pipeline failed: context-failed']);
  });
  it('rejects invented accounting facts even when the irrelevant kind is correct', () => {
    const newsletter = triageEvalCases.find(
      (test) => test.id === 'newsletter',
    )!;
    const outcome = good();
    if (!outcome.ok) throw new Error('fixture');
    outcome.result.kind = 'not_a_document';
    outcome.enrichment = { summary: '' };
    outcome.result.supplier_proposal = undefined;
    expect(evaluateTriageCase(newsletter, outcome)).toContain(
      'irrelevant document contains fabricated accounting facts',
    );
  });

  it('requires the specific missing-country hold, never counting timeouts as a negative-eval pass', () => {
    const missing = triageEvalCases.find(
      (test) => test.id === 'missing-country',
    )!;
    const unknown = {
      ...evidence,
      evidence: { ...evidence.evidence, country: null, registrationKey: null },
    };
    expect(
      evaluateTriageCase(
        missing,
        {
          ok: false,
          category: 'context-failed',
          detail: 'Supplier country missing; manual triage required',
        },
        unknown,
      ),
    ).toEqual([]);
    expect(
      evaluateTriageCase(
        missing,
        { ok: false, category: 'transient', detail: 'timeout' },
        unknown,
      ),
    ).toEqual(['expected explicit manual-triage hold']);
    expect(evaluateTriageCase(missing, good(), unknown)).toEqual([
      'expected explicit manual-triage hold',
    ]);
  });

  it('catches rejecting an accounting document solely for its order heading and catches wrong VAT', () => {
    const test = triageEvalCases.find(
      (entry) => entry.id === 'order-heading-accounting-document',
    )!;
    const outcome = good();
    if (!outcome.ok) throw new Error('fixture');
    outcome.result.kind = 'not_a_document';
    expect(evaluateTriageCase(test, outcome, evidence)).toContain(
      'kind: not_a_document',
    );
    outcome.result.kind = 'new_expense';
    outcome.result.gross_amount = 9100;
    outcome.result.vat_amount = 0;
    expect(evaluateTriageCase(test, outcome, evidence)).toContain('vat: 0');
  });

  it('rejects confusing a settled invoice with its payment balance, order number or proforma route', () => {
    const test = triageEvalCases.find(
      (entry) => entry.id === 'prepaid-final-invoice',
    )!;
    const outcome = good();
    if (!outcome.ok) throw new Error('fixture');
    outcome.result.gross_amount = 0;
    outcome.result.supplier_invoice_number = 'W76155';
    outcome.result.document_type = 'proforma';
    const errors = evaluateTriageCase(test, outcome, evidence);
    expect(errors).toContain('amount: 0');
    expect(errors).toContain('invoice number: W76155');
    expect(errors).toContain('wrong downstream intake route');
    const proforma = triageEvalCases.find(
      (entry) => entry.id === 'prepaid-proforma-stays-proforma',
    )!;
    outcome.result.document_type = 'invoice';
    expect(evaluateTriageCase(proforma, outcome, evidence)).toContain(
      'wrong downstream intake route',
    );
  });

  it('includes explicit negative scenarios in the live corpus', () => {
    expect(
      triageEvalCases.filter((test) => test.negative).length,
    ).toBeGreaterThanOrEqual(7);
  });
});
