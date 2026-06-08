import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { BadRequestException } from '@nestjs/common';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { PeriodLockService } from './period-lock.service';

describe('PeriodLockService (integration)', () => {
  let db: Kysely<Database>;
  let service: PeriodLockService;

  const seedPeriod = (p: {
    name: string;
    start_date: string;
    end_date: string;
    status: 'open' | 'locked';
  }) =>
    db
      .insertInto('reporting_period')
      .values({ ...p, filed_at: null, created_at: 0 })
      .returningAll()
      .executeTakeFirstOrThrow();

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
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
        PeriodLockService,
      ],
    }).compile();

    service = module.get(PeriodLockService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('findLockedPeriod', () => {
    it('returns the locked period containing the date', async () => {
      await seedPeriod({
        name: 'Q1',
        start_date: '2026-01-01',
        end_date: '2026-03-31',
        status: 'locked',
      });

      const found = await service.findLockedPeriod('2026-02-15');
      expect(found?.name).toBe('Q1');
    });

    it('returns undefined when the date is in an open period', async () => {
      await seedPeriod({
        name: 'Q2',
        start_date: '2026-04-01',
        end_date: '2026-06-30',
        status: 'open',
      });

      expect(await service.findLockedPeriod('2026-05-15')).toBeUndefined();
    });

    it('returns undefined when the date is in no period at all', async () => {
      expect(await service.findLockedPeriod('2026-12-31')).toBeUndefined();
    });
  });

  describe('assertPeriodOpen', () => {
    it('throws BadRequestException for a locked-period date', async () => {
      await seedPeriod({
        name: 'Q1',
        start_date: '2026-01-01',
        end_date: '2026-03-31',
        status: 'locked',
      });

      await expect(service.assertPeriodOpen('2026-02-15')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('passes for an open-period date', async () => {
      await seedPeriod({
        name: 'Q2',
        start_date: '2026-04-01',
        end_date: '2026-06-30',
        status: 'open',
      });

      await expect(
        service.assertPeriodOpen('2026-05-15'),
      ).resolves.toBeUndefined();
    });
  });

  describe('getCurrentOpenPeriod', () => {
    it('returns the latest open period by start_date', async () => {
      await seedPeriod({
        name: 'Q1',
        start_date: '2026-01-01',
        end_date: '2026-03-31',
        status: 'locked',
      });
      await seedPeriod({
        name: 'Q2',
        start_date: '2026-04-01',
        end_date: '2026-06-30',
        status: 'open',
      });
      await seedPeriod({
        name: 'Q3',
        start_date: '2026-07-01',
        end_date: '2026-09-30',
        status: 'open',
      });

      const current = await service.getCurrentOpenPeriod();
      expect(current?.name).toBe('Q3');
    });

    it('returns undefined when no period is open', async () => {
      // Drop the migration-seeded open period so only a locked one remains.
      await db.deleteFrom('reporting_period').execute();
      await seedPeriod({
        name: 'Q1',
        start_date: '2026-01-01',
        end_date: '2026-03-31',
        status: 'locked',
      });

      expect(await service.getCurrentOpenPeriod()).toBeUndefined();
    });
  });
});
