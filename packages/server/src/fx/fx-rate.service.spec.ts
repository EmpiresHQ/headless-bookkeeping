import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { FxLookupPolicy, FxRateService } from './fx-rate.service';
import { FxRateUnavailableError } from './fx-rate.types';
import {
  FixtureFxRateSource,
  FixtureRate,
  fixtureFxRateService,
} from '../../test/fx-fixtures';

/**
 * FxRateService is the mechanism behind a country plugin's rate rule: the
 * cache, the single upstream fetch, the bounded non-publication fallback and
 * the direction / cross-rate arithmetic. These tests drive it directly, with a
 * fixture authority, against a real migrated database.
 */
describe('FxRateService', () => {
  const ON_OR_BEFORE: FxLookupPolicy = {
    source: 'ECB',
    fallback: 'on-or-before',
    maxLookbackDays: 7,
  };
  const EXACT: FxLookupPolicy = {
    source: 'ECB',
    fallback: 'exact',
    maxLookbackDays: 0,
  };

  // Mon 2026-03-02 … Fri 2026-03-06, then a weekend, then Mon 2026-03-09.
  const RATES: FixtureRate[] = [
    { quoteCurrency: 'USD', rateDate: '2026-03-02', rate: 1.1 },
    { quoteCurrency: 'USD', rateDate: '2026-03-06', rate: 1.2 },
    { quoteCurrency: 'USD', rateDate: '2026-03-09', rate: 1.25 },
    { quoteCurrency: 'GBP', rateDate: '2026-03-06', rate: 0.8 },
    { quoteCurrency: 'GBP', rateDate: '2026-03-09', rate: 0.85 },
  ];

  let service: FxRateService;
  let db: Kysely<Database>;
  let source: FixtureFxRateSource;

  beforeEach(async () => {
    source = new FixtureFxRateSource(RATES);
    const wired = await fixtureFxRateService(RATES, source);
    service = wired.service;
    db = wired.db;
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('identity', () => {
    it('is answered without consulting the authority at all', async () => {
      await expect(
        service.resolve('USD', 'USD', '2026-03-07', ON_OR_BEFORE),
      ).resolves.toEqual({
        rate: 1.0,
        rateDate: '2026-03-07',
        source: 'identity',
      });
      expect(source.calls).toEqual([]);
    });
  });

  describe('direction', () => {
    it('anchor → quote is the published quotation itself', async () => {
      const r = await service.resolve('EUR', 'USD', '2026-03-06', ON_OR_BEFORE);
      expect(r.rate).toBeCloseTo(1.2, 12);
    });

    it('quote → anchor is its reciprocal', async () => {
      const r = await service.resolve('USD', 'EUR', '2026-03-06', ON_OR_BEFORE);
      expect(r.rate).toBeCloseTo(1 / 1.2, 12);
    });

    it('quote → quote crosses through the anchor, which cancels', async () => {
      const r = await service.resolve('USD', 'GBP', '2026-03-06', ON_OR_BEFORE);
      // 1 USD = (1/1.2) EUR = (1/1.2) × 0.8 GBP
      expect(r.rate).toBeCloseTo(0.8 / 1.2, 12);
      expect(r.rateDate).toBe('2026-03-06');
    });

    it('refuses a cross whose two legs come from different publication days', async () => {
      // GBP was published on 03-06 but not 03-02; USD has 03-02. Asking on
      // 03-02 would pair a 03-02 USD with... nothing, so use a window where
      // the two legs genuinely land on different days.
      const skewed: FixtureRate[] = [
        { quoteCurrency: 'USD', rateDate: '2026-03-05', rate: 1.15 },
        { quoteCurrency: 'GBP', rateDate: '2026-03-04', rate: 0.79 },
      ];
      const wired = await fixtureFxRateService(skewed);
      await expect(
        wired.service.resolve('USD', 'GBP', '2026-03-05', ON_OR_BEFORE),
      ).rejects.toThrow(/would mix publications/);
      await wired.db.destroy();
    });
  });

  describe('non-publication fallback', () => {
    it('on-or-before uses the most recent publication, and reports ITS date', async () => {
      // Sunday 2026-03-08: nothing published; Friday 03-06 is in force.
      const r = await service.resolve('USD', 'EUR', '2026-03-08', ON_OR_BEFORE);
      expect(r.rateDate).toBe('2026-03-06');
      expect(r.rate).toBeCloseTo(1 / 1.2, 12);
    });

    it('is BOUNDED — a rate older than the lookback is stale, not "in force"', async () => {
      // 2026-03-05 has no publication; the nearest is 03-02, three days back —
      // inside a 7-day window, outside a 2-day one.
      await expect(
        service.resolve('USD', 'EUR', '2026-03-05', ON_OR_BEFORE),
      ).resolves.toMatchObject({ rateDate: '2026-03-02' });

      await expect(
        service.resolve('USD', 'EUR', '2026-03-05', {
          ...ON_OR_BEFORE,
          maxLookbackDays: 2,
        }),
      ).rejects.toThrow(FxRateUnavailableError);
    });

    it('exact refuses a non-publication day outright', async () => {
      await expect(
        service.resolve('USD', 'EUR', '2026-03-08', EXACT),
      ).rejects.toThrow(/published no EUR\/USD rate on 2026-03-08/);
      await expect(
        service.resolve('USD', 'EUR', '2026-03-06', EXACT),
      ).resolves.toMatchObject({ rateDate: '2026-03-06' });
    });

    it('never falls FORWARD to a later publication', async () => {
      // 2026-03-01 precedes everything in the fixture. The 03-02 rate exists,
      // but it was not in force yet, so the conversion is refused.
      await expect(
        service.resolve('USD', 'EUR', '2026-03-01', ON_OR_BEFORE),
      ).rejects.toThrow(FxRateUnavailableError);
    });
  });

  describe('coverage: the cache answers only for dates actually asked about', () => {
    it('asks upstream again for an ADJACENT day it has never asked about', async () => {
      const friday = await service.resolve(
        'USD',
        'EUR',
        '2026-03-06',
        ON_OR_BEFORE,
      );
      expect(friday.rateDate).toBe('2026-03-06');

      // Monday. A cache keyed only on "newest row at or before" would hand
      // back Friday here and never look — the very date-blindness #203 removes.
      const monday = await service.resolve(
        'USD',
        'EUR',
        '2026-03-09',
        ON_OR_BEFORE,
      );
      expect(monday.rateDate).toBe('2026-03-09');
      expect(monday.rate).toBeCloseTo(1 / 1.25, 12);
      expect(source.calls.length).toBe(2);
    });

    it('does not re-ask for a date it has already asked about', async () => {
      await service.resolve('USD', 'EUR', '2026-03-09', ON_OR_BEFORE);
      const after = source.calls.length;
      await service.resolve('USD', 'EUR', '2026-03-09', ON_OR_BEFORE);
      expect(source.calls.length).toBe(after);
    });

    it('does not re-ask for a covered weekend either — the window was probed', async () => {
      await service.resolve('USD', 'EUR', '2026-03-08', ON_OR_BEFORE);
      const after = source.calls.length;
      const again = await service.resolve(
        'USD',
        'EUR',
        '2026-03-08',
        ON_OR_BEFORE,
      );
      expect(source.calls.length).toBe(after);
      expect(again.rateDate).toBe('2026-03-06');
    });
  });

  describe('reproducibility', () => {
    it('persists what it fetched, as published', async () => {
      await service.resolve('USD', 'EUR', '2026-03-06', ON_OR_BEFORE);

      const cached = await db
        .selectFrom('fx_reference_rate')
        .selectAll()
        .where('quote_currency', '=', 'USD')
        .where('rate_date', '=', '2026-03-06')
        .executeTakeFirstOrThrow();

      // Stored in the AUTHORITY's convention (units per 1 EUR), not inverted.
      expect(cached.rate).toBeCloseTo(1.2, 12);
      expect(cached.source).toBe('ECB');
      expect(cached.base_currency).toBe('EUR');
    });

    it('an upstream revision does NOT revalue an observation already cached', async () => {
      const first = await service.resolve(
        'USD',
        'EUR',
        '2026-03-06',
        ON_OR_BEFORE,
      );

      // A different service instance, same database, upstream now disagrees.
      const revised = new FxRateService(
        db,
        new FixtureFxRateSource([
          { quoteCurrency: 'USD', rateDate: '2026-03-06', rate: 99 },
        ]),
      );
      const second = await revised.resolve(
        'USD',
        'EUR',
        '2026-03-06',
        ON_OR_BEFORE,
      );
      expect(second.rate).toBeCloseTo(first.rate, 12);
    });

    it('a cached observation cannot be edited, even directly', async () => {
      await service.resolve('USD', 'EUR', '2026-03-06', ON_OR_BEFORE);
      await expect(
        db
          .updateTable('fx_reference_rate')
          .set({ rate: 42 })
          .where('quote_currency', '=', 'USD')
          .execute(),
      ).rejects.toThrow(/immutable/);
    });
  });

  describe('an unusable upstream answer does not poison the date', () => {
    // The failure this guards is quiet and long-lived: if a malformed 200 were
    // read as "nothing published", the probe window would be recorded as
    // covered and the older cached Friday would answer every later Monday
    // question — including after the authority recovered.

    it('refuses the malformed day, keeps no coverage for it, and yields the real rate on retry', async () => {
      // Friday is fetched and cached normally.
      const friday = await service.resolve(
        'USD',
        'EUR',
        '2026-03-06',
        ON_OR_BEFORE,
      );
      expect(friday.rateDate).toBe('2026-03-06');

      // Monday: upstream answers unusably.
      source.setFailure('200 with an unparseable body');
      await expect(
        service.resolve('USD', 'EUR', '2026-03-09', ON_OR_BEFORE),
      ).rejects.toThrow(FxRateUnavailableError);

      // Crucially: Monday was NOT recorded as answered. Friday's row must not
      // be allowed to stand in for it.
      const probes = await db
        .selectFrom('fx_rate_probe')
        .select(['from_date', 'to_date'])
        .execute();
      expect(probes.some((p) => p.to_date >= '2026-03-09')).toBe(false);

      // Upstream recovers; the retry gets Monday's own publication.
      source.setFailure(null);
      const monday = await service.resolve(
        'USD',
        'EUR',
        '2026-03-09',
        ON_OR_BEFORE,
      );
      expect(monday.rateDate).toBe('2026-03-09');
      expect(monday.rate).toBeCloseTo(1 / 1.25, 12);
    });

    it('still honours a GENUINE non-publication: the weekend keeps falling back', async () => {
      // The fix must not turn every empty window into a refusal. Saturday has
      // no publication and legitimately resolves to Friday.
      const saturday = await service.resolve(
        'USD',
        'EUR',
        '2026-03-07',
        ON_OR_BEFORE,
      );
      expect(saturday.rateDate).toBe('2026-03-06');
    });

    it('a rate published later is picked up once the day has been answered', async () => {
      // 2026-03-10 has no publication in the fixture: Monday's stands in.
      const before = await service.resolve(
        'USD',
        'EUR',
        '2026-03-10',
        ON_OR_BEFORE,
      );
      expect(before.rateDate).toBe('2026-03-09');

      // A genuinely answered window stays answered — this is the cache doing
      // its job, and is distinct from the malformed case above.
      source.publish({
        quoteCurrency: 'USD',
        rateDate: '2026-03-10',
        rate: 1.3,
      });
      const after = await service.resolve(
        'USD',
        'EUR',
        '2026-03-10',
        ON_OR_BEFORE,
      );
      expect(after.rateDate).toBe('2026-03-09');
    });
  });

  describe('refusal', () => {
    it('propagates an unsupported currency as unavailability', async () => {
      const err = await service
        .resolve('JPY', 'EUR', '2026-03-06', ON_OR_BEFORE)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FxRateUnavailableError);
      expect((err as FxRateUnavailableError).reason).toBe('unsupported_pair');
      expect((err as FxRateUnavailableError).getStatus()).toBe(422);
    });

    it('classifies "published nothing for this date" as unprocessable, not an outage', async () => {
      const err = await service
        .resolve('USD', 'EUR', '2026-03-01', ON_OR_BEFORE)
        .catch((e: unknown) => e);
      expect((err as FxRateUnavailableError).reason).toBe('no_rate_for_date');
      expect((err as FxRateUnavailableError).retryable).toBe(false);
      expect((err as FxRateUnavailableError).getStatus()).toBe(422);
    });

    it('propagates an upstream failure rather than substituting a rate', async () => {
      const down = await fixtureFxRateService(
        RATES,
        new FixtureFxRateSource(RATES, 'ECB', ['USD'], 'upstream unreachable'),
      );
      await expect(
        down.service.resolve('USD', 'EUR', '2026-03-06', ON_OR_BEFORE),
      ).rejects.toThrow(/upstream unreachable/);
      await down.db.destroy();
    });

    it('refuses when the wired authority is not the one the policy names', async () => {
      await expect(
        service.resolve('USD', 'EUR', '2026-03-06', {
          ...ON_OR_BEFORE,
          source: 'SOME_OTHER_CENTRAL_BANK',
        }),
      ).rejects.toThrow(/but "ECB" is wired/);
    });

    it('an upstream outage is reported as retryable, distinctly from an unsupported pair', async () => {
      source.setFailure('connection reset');
      const err = await service
        .resolve('USD', 'EUR', '2026-03-06', ON_OR_BEFORE)
        .catch((e: unknown) => e);
      expect((err as FxRateUnavailableError).reason).toBe(
        'upstream_unavailable',
      );
      expect((err as FxRateUnavailableError).retryable).toBe(true);
      expect((err as FxRateUnavailableError).getStatus()).toBe(503);
    });
  });
});
