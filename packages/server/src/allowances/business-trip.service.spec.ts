import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { BusinessTripService } from './business-trip.service';
import { EntitiesService } from '../entities/entities.service';

describe('BusinessTripService', () => {
  let db: Kysely<Database>;
  let service: BusinessTripService;
  let entitiesService: EntitiesService;

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
        BusinessTripService,
        EntitiesService,
      ],
    }).compile();

    service = module.get(BusinessTripService);
    entitiesService = module.get(EntitiesService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('createBusinessTrip', () => {
    it('persists a trip and returns it', async () => {
      const claimant = await entitiesService.onboard({
        role: 'employee',
        country: 'DK',
        name: 'John Doe',
        email: 'john@example.com',
      });
      const dto = {
        claimantId: claimant.id,
        departureDate: '2026-06-10',
        returnDate: '2026-06-15',
        destinationCountry: 'DE',
        purpose: 'Client meeting Berlin',
      };
      const trip = await service.createBusinessTrip(dto);
      expect(trip.id).toBeDefined();
      expect(trip.claimant_id).toBe(claimant.id);
      expect(trip.departure_date).toBe('2026-06-10');
      expect(trip.destination_country).toBe('DE');
    });

    it('throws 422 if returnDate is before departureDate', async () => {
      const claimant = await entitiesService.onboard({
        role: 'employee',
        country: 'DK',
        name: 'John Doe',
        email: 'john@example.com',
      });
      await expect(
        service.createBusinessTrip({
          claimantId: claimant.id,
          departureDate: '2026-06-15',
          returnDate: '2026-06-10',
          destinationCountry: 'DE',
        }),
      ).rejects.toThrow();
    });
  });

  describe('findBusinessTrip', () => {
    it('finds a trip by id', async () => {
      const claimant = await entitiesService.onboard({
        role: 'employee',
        country: 'DK',
        name: 'John Doe',
        email: 'john@example.com',
      });
      const created = await service.createBusinessTrip({
        claimantId: claimant.id,
        departureDate: '2026-06-10',
        returnDate: '2026-06-15',
        destinationCountry: 'DE',
        purpose: 'Meeting',
      });
      const found = await service.findBusinessTrip(created.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.purpose).toBe('Meeting');
    });
  });

  describe('listBusinessTrips', () => {
    it('lists all trips', async () => {
      const claimant1 = await entitiesService.onboard({
        role: 'employee',
        country: 'DK',
        name: 'John Doe',
        email: 'john@example.com',
      });
      const claimant2 = await entitiesService.onboard({
        role: 'employee',
        country: 'DK',
        name: 'Jane Doe',
        email: 'jane@example.com',
      });
      await service.createBusinessTrip({
        claimantId: claimant1.id,
        departureDate: '2026-06-10',
        returnDate: '2026-06-15',
        destinationCountry: 'DE',
      });
      await service.createBusinessTrip({
        claimantId: claimant2.id,
        departureDate: '2026-07-01',
        returnDate: '2026-07-05',
        destinationCountry: 'FR',
      });
      const trips = await service.listBusinessTrips();
      expect(trips).toHaveLength(2);
    });

    it('filters trips by claimantId', async () => {
      const claimant1 = await entitiesService.onboard({
        role: 'employee',
        country: 'DK',
        name: 'John Doe',
        email: 'john@example.com',
      });
      const claimant2 = await entitiesService.onboard({
        role: 'employee',
        country: 'DK',
        name: 'Jane Doe',
        email: 'jane@example.com',
      });
      await service.createBusinessTrip({
        claimantId: claimant1.id,
        departureDate: '2026-06-10',
        returnDate: '2026-06-15',
        destinationCountry: 'DE',
      });
      await service.createBusinessTrip({
        claimantId: claimant2.id,
        departureDate: '2026-07-01',
        returnDate: '2026-07-05',
        destinationCountry: 'FR',
      });
      const trips = await service.listBusinessTrips(claimant1.id);
      expect(trips).toHaveLength(1);
      expect(trips[0].claimant_id).toBe(claimant1.id);
    });

    it('orders trips by departure_date descending', async () => {
      const claimant = await entitiesService.onboard({
        role: 'employee',
        country: 'DK',
        name: 'John Doe',
        email: 'john@example.com',
      });
      const trip1 = await service.createBusinessTrip({
        claimantId: claimant.id,
        departureDate: '2026-06-10',
        returnDate: '2026-06-15',
        destinationCountry: 'DE',
      });
      const trip2 = await service.createBusinessTrip({
        claimantId: claimant.id,
        departureDate: '2026-07-01',
        returnDate: '2026-07-05',
        destinationCountry: 'FR',
      });
      const trips = await service.listBusinessTrips();
      expect(trips[0].id).toBe(trip2.id);
      expect(trips[1].id).toBe(trip1.id);
    });
  });
});
