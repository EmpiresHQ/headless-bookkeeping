import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AllowanceLimitService } from './allowance-limit.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { splitByMonth } from './date-utils';
import { seedEntity } from '../../test/helpers/seed-entity';
import { seedAllowance } from '../../test/helpers/seed-allowance';

describe('splitByMonth (unit)', () => {
  it('single month — 6 days June 10–15', () => {
    const segs = splitByMonth('2026-06-10', '2026-06-15');
    expect(segs).toHaveLength(1);
    expect(segs[0].month).toBe('2026-06');
    expect(segs[0].days).toBe(6);
  });

  it('two months — June 25 → July 5', () => {
    const segs = splitByMonth('2026-06-25', '2026-07-05');
    expect(segs).toHaveLength(2);
    expect(segs[0].month).toBe('2026-06');
    expect(segs[0].days).toBe(6); // 25,26,27,28,29,30
    expect(segs[1].month).toBe('2026-07');
    expect(segs[1].days).toBe(5); // 1,2,3,4,5
  });

  it('single day', () => {
    const segs = splitByMonth('2026-06-15', '2026-06-15');
    expect(segs).toHaveLength(1);
    expect(segs[0].days).toBe(1);
  });

  it('end < start returns empty array', () => {
    const segs = splitByMonth('2026-06-15', '2026-06-10');
    expect(segs).toHaveLength(0);
  });
});

describe('AllowanceLimitService', () => {
  let db: Kysely<Database>;
  let service: AllowanceLimitService;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });

    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('Migration failed');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        NullCountryPlugin,
        AllowanceLimitService,
      ],
    }).compile();

    service = module.get(AllowanceLimitService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('computeSplit — daily_allowance', () => {
    it('all days at 75€ when accumulated < 15 days in month', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });
      // No prior allowances seeded

      const split = await service.computeSplit({
        claimantId: claimant.id,
        type: 'daily_allowance',
        days: 6,
        periodStart: '2026-06-10',
        periodEnd: '2026-06-15',
        domestic: false,
        year: 2026,
      });

      expect(split.grossAmount).toBe(45000); // 6 × 7500
      expect(split.taxFreeAmount).toBe(45000);
      expect(split.taxableAmount).toBe(0);
      expect(split.breakdown).toHaveLength(1); // single month
    });

    it('splits at 15-day boundary when accumulated = 13 days and trip = 5 days', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });
      // Seed an existing posted allowance: 13 days in June
      await seedAllowance(db, {
        claimantId: claimant.id,
        type: 'daily_allowance',
        taxFreeDays: 13,
        taxFreeAmount: 13 * 7500,
        taxableAmount: 0,
        periodStart: '2026-06-01',
        periodEnd: '2026-06-13',
        status: 'posted',
      });

      const split = await service.computeSplit({
        claimantId: claimant.id,
        type: 'daily_allowance',
        days: 5,
        periodStart: '2026-06-20',
        periodEnd: '2026-06-24',
        domestic: false,
        year: 2026,
      });

      // 2 days at 75€ (remaining quota) + 3 days at 40€ (fallback, taxable)
      expect(split.taxFreeAmount).toBe(2 * 7500); // 15000
      expect(split.taxableAmount).toBe(3 * 4000); // 12000
      expect(split.grossAmount).toBe(split.taxFreeAmount + split.taxableAmount);
    });

    it('handles trip spanning two calendar months', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });

      const split = await service.computeSplit({
        claimantId: claimant.id,
        type: 'daily_allowance',
        days: 11, // June 25 → July 5
        periodStart: '2026-06-25',
        periodEnd: '2026-07-05',
        domestic: false,
        year: 2026,
      });

      // June: 6 days (June 25–30), July: 5 days (July 1–5)
      // Both months: 0 accumulated → all at 75€
      expect(split.taxFreeAmount).toBe(11 * 7500);
      expect(split.taxableAmount).toBe(0);
      expect(split.breakdown).toHaveLength(2);
    });
  });

  describe('computeSplit — mileage', () => {
    it('fully tax-free when accumulated amount < 550€', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });
      const split = await service.computeSplit({
        claimantId: claimant.id,
        type: 'mileage',
        km: 200,
        periodStart: '2026-06-15',
        domestic: false,
        year: 2026,
      });
      expect(split.grossAmount).toBe(200 * 50); // 10000
      expect(split.taxFreeAmount).toBe(10000);
      expect(split.taxableAmount).toBe(0);
    });

    it('splits when accumulated + new amount exceeds 550€ ceiling', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });
      // Seed 500€ already accumulated
      await seedAllowance(db, {
        claimantId: claimant.id,
        type: 'mileage',
        taxFreeAmount: 50000,
        taxableAmount: 0,
        periodStart: '2026-06-01',
        status: 'posted',
      });

      const split = await service.computeSplit({
        claimantId: claimant.id,
        type: 'mileage',
        km: 200, // 10000 cents = 100€ → 50€ tax-free (remaining), 50€ taxable
        periodStart: '2026-06-20',
        domestic: false,
        year: 2026,
      });

      expect(split.taxFreeAmount).toBe(5000); // 50€ remaining
      expect(split.taxableAmount).toBe(5000); // 50€ over ceiling
    });
  });
});
