import { EcbFxRateSource } from './ecb-fx-rate.source';
import { FxRateUnavailableError } from './fx-rate.types';

/**
 * The ECB source's own contract: how a real SDMX `csvdata` response is read,
 * and how the three ways it can fail to yield a rate are reported.
 *
 * `fetch` is stubbed, because the point of these tests is the parsing and the
 * failure semantics — reaching data-api.ecb.europa.eu from a test would make
 * the suite non-deterministic and offline-hostile. The response bodies below
 * are verbatim shapes captured from that endpoint on 2026-09-20.
 */
describe('EcbFxRateSource', () => {
  const HEADER =
    'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,' +
    'OBS_STATUS,OBS_CONF,OBS_PRE_BREAK,OBS_COM,TIME_FORMAT,BREAKS,COLLECTION,' +
    'COMPILING_ORG,DISS_ORG,DOM_SER_IDS,PUBL_ECB,PUBL_MU,PUBL_PUBLIC,' +
    'UNIT_INDEX_BASE,COMPILATION,COVERAGE,DECIMALS,NAT_TITLE,SOURCE_AGENCY,' +
    'SOURCE_PUB,TITLE,TITLE_COMPL,UNIT,UNIT_MULT';

  const row = (date: string, value: string, currency = 'USD') =>
    `EXR.D.${currency}.EUR.SP00.A,D,${currency},EUR,SP00,A,${date},${value},A,F,,,P1D,,A,,,,,,,99Q1=100,,,4,,4F0,,` +
    `US dollar/Euro ECB reference exchange rate,"ECB reference exchange rate, US dollar/Euro, 2.15 pm (C.E.T.)",${currency},0`;

  let source: EcbFxRateSource;
  let fetchMock: jest.Mock;

  const respond = (body: string, status = 200) => {
    fetchMock.mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body),
    } as unknown as Response);
  };

  beforeEach(() => {
    source = new EcbFxRateSource();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('identifies itself as the ECB, quoting against the euro', () => {
    expect(source.sourceId).toBe('ECB');
    expect(source.baseCurrency).toBe('EUR');
  });

  it("parses observations in the ECB's own convention (units per 1 EUR)", async () => {
    respond(
      [HEADER, row('2020-01-02', '1.1193'), row('2020-01-03', '1.1147')].join(
        '\n',
      ),
    );

    const observations = await source.fetchObservations(
      'USD',
      '2020-01-01',
      '2020-01-03',
    );

    expect(observations).toEqual([
      {
        baseCurrency: 'EUR',
        quoteCurrency: 'USD',
        rateDate: '2020-01-02',
        rate: 1.1193,
      },
      {
        baseCurrency: 'EUR',
        quoteCurrency: 'USD',
        rateDate: '2020-01-03',
        rate: 1.1147,
      },
    ]);
  });

  it('asks for exactly the requested closed window on the daily spot series', async () => {
    respond(HEADER);
    await source.fetchObservations('GBP', '2026-08-25', '2026-09-01');

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/EXR/D.GBP.EUR.SP00.A');
    expect(url).toContain('startPeriod=2026-08-25');
    expect(url).toContain('endPeriod=2026-09-01');
  });

  it('reads columns BY NAME, so an upstream column reshuffle cannot shift the rate', async () => {
    // Same data, TIME_PERIOD and OBS_VALUE moved to the front.
    respond(
      ['TIME_PERIOD,OBS_VALUE,CURRENCY', '2026-09-01,1.1655,USD'].join('\n'),
    );

    const [obs] = await source.fetchObservations(
      'USD',
      '2026-09-01',
      '2026-09-01',
    );
    expect(obs).toMatchObject({ rateDate: '2026-09-01', rate: 1.1655 });
  });

  it('an EMPTY BODY is the ECB\'s own "nothing published", and is honoured', async () => {
    // Verified live 2026-09-20: a window that is entirely TARGET closing days
    // (2020-01-01) answers HTTP 200 with a zero-byte body — not a header, not
    // an error. That is the authority saying nothing happened.
    respond('');

    await expect(
      source.fetchObservations('USD', '2020-01-01', '2020-01-01'),
    ).resolves.toEqual([]);
  });

  it('a header-only CSV is also an empty result set', async () => {
    respond(HEADER);

    await expect(
      source.fetchObservations('USD', '2020-01-01', '2020-01-01'),
    ).resolves.toEqual([]);
  });

  it('skips a published-but-blank observation — the one thing SDMX may omit', async () => {
    respond(
      [HEADER, row('2026-09-01', ''), row('2026-09-02', '1.1650')].join('\n'),
    );

    const observations = await source.fetchObservations(
      'USD',
      '2026-09-01',
      '2026-09-02',
    );
    expect(observations).toEqual([
      expect.objectContaining({ rateDate: '2026-09-02', rate: 1.165 }),
    ]);
  });

  describe('a 200 that is not a usable answer is REFUSED, never read as silence', () => {
    // The distinction matters because the two are indistinguishable downstream:
    // "nothing published" lets an older cached rate stand in and records the
    // window as covered, so a junk response would pin a stale rate over a date
    // that was never actually answered.

    it('an HTML error page served with HTTP 200', async () => {
      respond('<html><body>Service temporarily unavailable</body></html>');

      const err = await source
        .fetchObservations('USD', '2026-03-02', '2026-03-09')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FxRateUnavailableError);
      expect((err as FxRateUnavailableError).reason).toBe(
        'upstream_unavailable',
      );
      expect((err as FxRateUnavailableError).retryable).toBe(true);
    });

    it('a body whose header names neither TIME_PERIOD nor OBS_VALUE', async () => {
      respond(['SOMETHING,ELSE', 'a,b'].join('\n'));

      await expect(
        source.fetchObservations('USD', '2026-09-01', '2026-09-01'),
      ).rejects.toThrow(/not the expected CSV/);
    });

    it('a row carrying an unreadable date', async () => {
      respond([HEADER, row('not-a-date', '1.1655')].join('\n'));

      await expect(
        source.fetchObservations('USD', '2026-09-01', '2026-09-01'),
      ).rejects.toThrow(/unreadable date/);
    });

    it('a row carrying a non-numeric value', async () => {
      respond([HEADER, row('2026-09-01', 'n/a')].join('\n'));

      await expect(
        source.fetchObservations('USD', '2026-09-01', '2026-09-01'),
      ).rejects.toThrow(/unusable value/);
    });

    it('a row for a currency we did not ask about', async () => {
      respond([HEADER, row('2026-09-01', '0.8672', 'GBP')].join('\n'));

      await expect(
        source.fetchObservations('USD', '2026-09-01', '2026-09-01'),
      ).rejects.toThrow(/returned currency "GBP"/);
    });

    it('condemns the WHOLE response, not just the bad row', async () => {
      // A partial read is not a safer read: the row we dropped may be the very
      // date the caller asked about, and the caller cannot tell.
      respond(
        [HEADER, row('2026-09-01', '1.1655'), row('2026-09-02', 'oops')].join(
          '\n',
        ),
      );

      await expect(
        source.fetchObservations('USD', '2026-09-01', '2026-09-02'),
      ).rejects.toThrow(FxRateUnavailableError);
    });
  });

  describe('failure classification is actionable', () => {
    it('a currency the ECB does not quote (404) is unsupported, not retryable', async () => {
      // Verified live: D.XYZ.EUR.SP00.A answers 404 "No Series was returned".
      respond('', 404);

      const err = await source
        .fetchObservations('XYZ', '2026-09-01', '2026-09-01')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FxRateUnavailableError);
      expect((err as FxRateUnavailableError).reason).toBe('unsupported_pair');
      expect((err as FxRateUnavailableError).retryable).toBe(false);
      expect((err as FxRateUnavailableError).getStatus()).toBe(422);
    });

    it('an upstream error status is an outage — retryable, 503', async () => {
      respond('', 503);

      const err = await source
        .fetchObservations('USD', '2026-09-01', '2026-09-01')
        .catch((e: unknown) => e);
      expect((err as FxRateUnavailableError).reason).toBe(
        'upstream_unavailable',
      );
      expect((err as FxRateUnavailableError).retryable).toBe(true);
      expect((err as FxRateUnavailableError).getStatus()).toBe(503);
    });

    it('an unreachable endpoint is an outage too, never a substituted rate', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      const err = await source
        .fetchObservations('USD', '2026-09-01', '2026-09-01')
        .catch((e: unknown) => e);
      expect((err as FxRateUnavailableError).reason).toBe(
        'upstream_unavailable',
      );
    });
  });
});
