import { validateEtGaapInstance } from '../../../test/xbrl/validate-xbrl-instance';
import { etGaapConcepts } from '../../../test/xbrl/et-gaap-taxonomy';

/**
 * Negative coverage for the taxonomy validator itself. Without these, a
 * validator that silently accepted everything would make the renderer's
 * "validates clean" assertions worthless.
 */
const SCHEMA_REF =
  'http://xbrl.eesti.ee/taxonomy/et-gaap_2026-01-01/et-gaap-cor_2026-01-01.xsd';

function instance(body: string, contexts?: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" ' +
      'xmlns:link="http://www.xbrl.org/2003/linkbase" ' +
      'xmlns:xlink="http://www.w3.org/1999/xlink" ' +
      'xmlns:et-gaap="http://xbrl.eesti.ee/taxonomy/et-gaap_2026-01-01/" ' +
      'xmlns:iso4217="http://www.xbrl.org/2003/iso4217">',
    `  <link:schemaRef xlink:type="simple" xlink:href="${SCHEMA_REF}"/>`,
    contexts ??
      [
        '  <xbrli:context id="i-2026-12-31">',
        '    <xbrli:entity><xbrli:identifier scheme="https://ariregister.rik.ee/">17499653</xbrli:identifier></xbrli:entity>',
        '    <xbrli:period><xbrli:instant>2026-12-31</xbrli:instant></xbrli:period>',
        '  </xbrli:context>',
        '  <xbrli:context id="d-2026-01-01_2026-12-31">',
        '    <xbrli:entity><xbrli:identifier scheme="https://ariregister.rik.ee/">17499653</xbrli:identifier></xbrli:entity>',
        '    <xbrli:period><xbrli:startDate>2026-01-01</xbrli:startDate><xbrli:endDate>2026-12-31</xbrli:endDate></xbrli:period>',
        '  </xbrli:context>',
      ].join('\n'),
    '  <xbrli:unit id="EUR"><xbrli:measure>iso4217:EUR</xbrli:measure></xbrli:unit>',
    body,
    '</xbrli:xbrl>',
  ].join('\n');
}

const CASH =
  '  <et-gaap:CashAndCashEquivalents contextRef="i-2026-12-31" unitRef="EUR" decimals="2">1200.00</et-gaap:CashAndCashEquivalents>';

describe('the pinned taxonomy is the one we think it is', () => {
  it('declares the concepts this renderer relies on, with the expected period types', () => {
    const c = etGaapConcepts();
    expect(c.size).toBeGreaterThan(3000);
    expect(c.get('CashAndCashEquivalents')).toMatchObject({
      type: 'xbrli:monetaryItemType',
      periodType: 'instant',
      balance: 'debit',
      abstract: false,
    });
    expect(c.get('Revenue')).toMatchObject({
      periodType: 'duration',
      balance: 'credit',
    });
    // The two profit lines are genuinely different concepts: the balance-sheet
    // equity line is instant, the income-statement total is duration.
    expect(c.get('AnnualPeriodProfitLoss')?.periodType).toBe('instant');
    expect(c.get('TotalAnnualPeriodProfitLoss')?.periodType).toBe('duration');
    // Presentation-only nodes are marked abstract and may not be reported.
    expect(c.get('AssetsAbstract')?.abstract).toBe(true);
  });
});

describe('validateEtGaapInstance rejects', () => {
  it('a concept the official taxonomy does not declare', () => {
    const res = validateEtGaapInstance(
      instance(
        '  <et-gaap:TotalAssets contextRef="i-2026-12-31" unitRef="EUR" decimals="2">1200.00</et-gaap:TotalAssets>',
      ),
    );
    expect(res.valid).toBe(false);
    expect(res.errors).toEqual([
      'concept et-gaap:TotalAssets is not declared by the pinned taxonomy',
    ]);
  });

  it('an abstract concept reported as a fact', () => {
    const res = validateEtGaapInstance(
      instance(
        '  <et-gaap:AssetsAbstract contextRef="i-2026-12-31" unitRef="EUR" decimals="2">1200.00</et-gaap:AssetsAbstract>',
      ),
    );
    expect(res.errors).toContain(
      'concept et-gaap:AssetsAbstract is abstract and cannot be reported',
    );
  });

  it('a duration concept tagged against an instant context', () => {
    const res = validateEtGaapInstance(
      instance(
        '  <et-gaap:Revenue contextRef="i-2026-12-31" unitRef="EUR" decimals="2">600.00</et-gaap:Revenue>',
      ),
    );
    expect(res.errors).toContain(
      'et-gaap:Revenue is a duration concept but context i-2026-12-31 is a instant period',
    );
  });

  it('an instant concept tagged against a duration context', () => {
    const res = validateEtGaapInstance(
      instance(
        '  <et-gaap:CashAndCashEquivalents contextRef="d-2026-01-01_2026-12-31" unitRef="EUR" decimals="2">1200.00</et-gaap:CashAndCashEquivalents>',
      ),
    );
    expect(res.errors).toContain(
      'et-gaap:CashAndCashEquivalents is a instant concept but context d-2026-01-01_2026-12-31 is a duration period',
    );
  });

  it('the endDate-only context shape issue #204 reported', () => {
    const res = validateEtGaapInstance(
      instance(
        CASH.replace('i-2026-12-31', 'C-2026'),
        [
          '  <xbrli:context id="C-2026">',
          '    <xbrli:entity><xbrli:identifier scheme="http://www.rik.ee">17499653</xbrli:identifier></xbrli:entity>',
          '    <xbrli:period><xbrli:endDate>2026-12-31</xbrli:endDate></xbrli:period>',
          '  </xbrli:context>',
        ].join('\n'),
      ),
    );
    expect(res.errors).toContain(
      'context C-2026: duration period needs both startDate and endDate ' +
        '(startDate=null, endDate="2026-12-31")',
    );
  });

  it('a context whose entity identifier is empty', () => {
    const res = validateEtGaapInstance(
      instance(
        CASH,
        [
          '  <xbrli:context id="i-2026-12-31">',
          '    <xbrli:entity><xbrli:identifier scheme="https://ariregister.rik.ee/"></xbrli:identifier></xbrli:entity>',
          '    <xbrli:period><xbrli:instant>2026-12-31</xbrli:instant></xbrli:period>',
          '  </xbrli:context>',
        ].join('\n'),
      ),
    );
    expect(res.errors).toContain(
      'context i-2026-12-31: empty entity identifier',
    );
  });

  it('a context dated to a day that does not exist', () => {
    const res = validateEtGaapInstance(
      instance(
        CASH.replace('i-2026-12-31', 'i-2026-02-30'),
        [
          '  <xbrli:context id="i-2026-02-30">',
          '    <xbrli:entity><xbrli:identifier scheme="https://ariregister.rik.ee/">17499653</xbrli:identifier></xbrli:entity>',
          '    <xbrli:period><xbrli:instant>2026-02-30</xbrli:instant></xbrli:period>',
          '  </xbrli:context>',
        ].join('\n'),
      ),
    );
    expect(res.errors).toContain(
      'context i-2026-02-30: instant "2026-02-30" is not a date',
    );
  });

  it('but accepts a real leap day', () => {
    const res = validateEtGaapInstance(
      instance(
        CASH.replace('i-2026-12-31', 'i-2024-02-29'),
        [
          '  <xbrli:context id="i-2024-02-29">',
          '    <xbrli:entity><xbrli:identifier scheme="https://ariregister.rik.ee/">17499653</xbrli:identifier></xbrli:entity>',
          '    <xbrli:period><xbrli:instant>2024-02-29</xbrli:instant></xbrli:period>',
          '  </xbrli:context>',
        ].join('\n'),
      ),
    );
    expect(res.errors).toEqual([]);
  });

  it('a duration context running backwards', () => {
    const res = validateEtGaapInstance(
      instance(
        CASH.replace('i-2026-12-31', 'd-bad'),
        [
          '  <xbrli:context id="d-bad">',
          '    <xbrli:entity><xbrli:identifier scheme="https://ariregister.rik.ee/">17499653</xbrli:identifier></xbrli:entity>',
          '    <xbrli:period><xbrli:startDate>2026-12-31</xbrli:startDate><xbrli:endDate>2026-01-01</xbrli:endDate></xbrli:period>',
          '  </xbrli:context>',
        ].join('\n'),
      ),
    );
    expect(res.errors).toContain(
      'context d-bad: startDate 2026-12-31 is after endDate 2026-01-01',
    );
  });

  it('a duplicate context id', () => {
    const one = [
      '  <xbrli:context id="i-2026-12-31">',
      '    <xbrli:entity><xbrli:identifier scheme="https://ariregister.rik.ee/">17499653</xbrli:identifier></xbrli:entity>',
      '    <xbrli:period><xbrli:instant>2026-12-31</xbrli:instant></xbrli:period>',
      '  </xbrli:context>',
    ].join('\n');
    const res = validateEtGaapInstance(instance(CASH, `${one}\n${one}`));
    expect(res.errors).toContain('duplicate context id i-2026-12-31');
  });

  it('a fact pointing at a context that does not exist', () => {
    const res = validateEtGaapInstance(
      instance(CASH.replace('i-2026-12-31', 'i-nope')),
    );
    expect(res.errors).toContain(
      'et-gaap:CashAndCashEquivalents: contextRef "i-nope" resolves to no context',
    );
  });

  it('a monetary fact with no unit, or an unresolvable one', () => {
    expect(
      validateEtGaapInstance(instance(CASH.replace(' unitRef="EUR"', '')))
        .errors,
    ).toContain('et-gaap:CashAndCashEquivalents: numeric item has no unitRef');
    expect(
      validateEtGaapInstance(
        instance(CASH.replace('unitRef="EUR"', 'unitRef="USD"')),
      ).errors,
    ).toContain(
      'et-gaap:CashAndCashEquivalents: unitRef "USD" resolves to no unit',
    );
  });

  it('a monetary fact with no accuracy claim', () => {
    expect(
      validateEtGaapInstance(instance(CASH.replace(' decimals="2"', '')))
        .errors,
    ).toContain(
      'et-gaap:CashAndCashEquivalents: numeric item declares neither decimals nor precision',
    );
  });

  it('a value more precise than the accuracy it claims', () => {
    expect(
      validateEtGaapInstance(instance(CASH.replace('1200.00', '1200.005')))
        .errors,
    ).toContain(
      'et-gaap:CashAndCashEquivalents: value 1200.005 has 3 decimal places but claims decimals="2"',
    );
  });

  it('a schemaRef pointing somewhere other than the pinned taxonomy', () => {
    const res = validateEtGaapInstance(
      instance(CASH).replace(SCHEMA_REF, 'http://example.invalid/made-up.xsd'),
    );
    expect(res.errors).toContain(
      'link:schemaRef href "http://example.invalid/made-up.xsd" is not the pinned taxonomy ' +
        SCHEMA_REF,
    );
  });

  it('the same concept and context reported with two different values', () => {
    const res = validateEtGaapInstance(
      instance(`${CASH}\n${CASH.replace('1200.00', '1300.00')}`),
    );
    expect(res.errors).toContain(
      'et-gaap:CashAndCashEquivalents reported twice for context i-2026-12-31 with different values (1200.00 vs 1300.00)',
    );
  });

  it('but accepts a minimal well-formed instance', () => {
    expect(validateEtGaapInstance(instance(CASH))).toEqual({
      valid: true,
      errors: [],
    });
  });
});
