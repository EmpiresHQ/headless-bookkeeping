import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { ConflictException } from '@nestjs/common';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AllowanceService } from './allowance.service';
import { AllowanceLimitService } from './allowance-limit.service';
import { BusinessTripService } from './business-trip.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { OrganizationService } from '../organization/organization.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { StatusTransitionService } from '../ledger/status/status-transition.service';
import { seedEntity } from '../../test/helpers/seed-entity';

describe('AllowanceService', () => {
  let db: Kysely<Database>;
  let service: AllowanceService;
  let tripService: BusinessTripService;

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
        EstoniaCountryPlugin,
        PluginLoader,
        AllowanceLimitService,
        BusinessTripService,
        OrganizationService,
        OrgContextResolver,
        AuditFindingsService,
        StatusTransitionService,
        AllowanceService,
      ],
    }).compile();

    service = module.get(AllowanceService);
    tripService = module.get(BusinessTripService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('createAllowance — daily_allowance', () => {
    it('creates a draft with correct preliminary split', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });
      const trip = await tripService.createBusinessTrip({
        claimantId: claimant.id,
        departureDate: '2026-06-10',
        returnDate: '2026-06-15',
        destinationCountry: 'DE',
      });

      const allowance = await service.createAllowance({
        claimantId: claimant.id,
        tripId: trip.id,
        type: 'daily_allowance',
      });

      expect(allowance.status).toBe('draft');
      expect(allowance.days).toBe(6); // system calculates from trip dates
      expect(allowance.gross_amount).toBe(6 * 7500);
      expect(allowance.tax_free_amount).toBe(6 * 7500);
      expect(allowance.taxable_amount).toBe(0);
      expect(allowance.period_start).toBe('2026-06-10');
      expect(allowance.period_end).toBe('2026-06-15');
    });

    it('creates mileage allowance with manual km', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });
      const allowance = await service.createAllowance({
        claimantId: claimant.id,
        type: 'mileage',
        km: 150,
        routeDescription: 'Tallinn → Tartu',
        periodStart: '2026-06-20',
      });

      expect(allowance.km).toBe(150);
      expect(allowance.gross_amount).toBe(150 * 50); // 7500
      expect(allowance.route_description).toBe('Tallinn → Tartu');
    });

    it('throws 409 when duplicate daily_allowance for same trip', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });
      const trip = await tripService.createBusinessTrip({
        claimantId: claimant.id,
        departureDate: '2026-06-10',
        returnDate: '2026-06-15',
        destinationCountry: 'DE',
      });
      await service.createAllowance({
        claimantId: claimant.id,
        tripId: trip.id,
        type: 'daily_allowance',
      });

      await expect(
        service.createAllowance({
          claimantId: claimant.id,
          tripId: trip.id,
          type: 'daily_allowance',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('findAllowance', () => {
    it('returns the allowance by id', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });
      const trip = await tripService.createBusinessTrip({
        claimantId: claimant.id,
        departureDate: '2026-06-10',
        returnDate: '2026-06-12',
        destinationCountry: 'DE',
      });

      const created = await service.createAllowance({
        claimantId: claimant.id,
        tripId: trip.id,
        type: 'daily_allowance',
      });

      const found = await service.findAllowance(created.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
    });

    it('returns undefined for non-existent id', async () => {
      const result = await service.findAllowance(99999);
      expect(result).toBeUndefined();
    });
  });

  describe('listAllowances', () => {
    it('lists all allowances', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });
      const trip1 = await tripService.createBusinessTrip({
        claimantId: claimant.id,
        departureDate: '2026-06-10',
        returnDate: '2026-06-12',
        destinationCountry: 'DE',
      });
      const trip2 = await tripService.createBusinessTrip({
        claimantId: claimant.id,
        departureDate: '2026-07-01',
        returnDate: '2026-07-03',
        destinationCountry: 'FR',
      });

      await service.createAllowance({
        claimantId: claimant.id,
        tripId: trip1.id,
        type: 'daily_allowance',
      });
      await service.createAllowance({
        claimantId: claimant.id,
        tripId: trip2.id,
        type: 'daily_allowance',
      });

      const all = await service.listAllowances();
      expect(all).toHaveLength(2);
    });

    it('filters by claimantId', async () => {
      const claimant1 = await seedEntity(db, { role: 'employee' });
      const claimant2 = await seedEntity(db, { role: 'employee' });

      const trip1 = await tripService.createBusinessTrip({
        claimantId: claimant1.id,
        departureDate: '2026-06-10',
        returnDate: '2026-06-12',
        destinationCountry: 'DE',
      });
      const trip2 = await tripService.createBusinessTrip({
        claimantId: claimant2.id,
        departureDate: '2026-07-01',
        returnDate: '2026-07-03',
        destinationCountry: 'FR',
      });

      await service.createAllowance({
        claimantId: claimant1.id,
        tripId: trip1.id,
        type: 'daily_allowance',
      });
      await service.createAllowance({
        claimantId: claimant2.id,
        tripId: trip2.id,
        type: 'daily_allowance',
      });

      const results = await service.listAllowances({
        claimantId: claimant1.id,
      });
      expect(results).toHaveLength(1);
      expect(results[0].claimant_id).toBe(claimant1.id);
    });

    it('filters by tripId', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });
      const trip1 = await tripService.createBusinessTrip({
        claimantId: claimant.id,
        departureDate: '2026-06-10',
        returnDate: '2026-06-12',
        destinationCountry: 'DE',
      });

      await service.createAllowance({
        claimantId: claimant.id,
        tripId: trip1.id,
        type: 'daily_allowance',
      });
      // Mileage with no trip
      await service.createAllowance({
        claimantId: claimant.id,
        type: 'mileage',
        km: 100,
        periodStart: '2026-06-15',
      });

      const results = await service.listAllowances({ tripId: trip1.id });
      expect(results).toHaveLength(1);
      expect(results[0].trip_id).toBe(trip1.id);
    });
  });

  describe('submitAllowance', () => {
    it('transitions status from draft to needs_triage', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });
      const allowance = await service.createAllowance({
        claimantId: claimant.id,
        type: 'mileage',
        km: 100,
        periodStart: '2026-06-20',
      });

      await service.submitAllowance(allowance.id);

      const updated = await service.findAllowance(allowance.id);
      expect(updated?.status).toBe('needs_triage');
    });

    it('creates an AuditFinding when submitted', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });
      const allowance = await service.createAllowance({
        claimantId: claimant.id,
        type: 'mileage',
        km: 100,
        periodStart: '2026-06-20',
      });

      await service.submitAllowance(allowance.id);

      const findings = await db
        .selectFrom('audit_finding')
        .selectAll()
        .where('referenced_object_type', '=', 'allowance')
        .where('referenced_object_id', '=', allowance.id)
        .execute();
      expect(findings).toHaveLength(1);
      expect(findings[0].finding_type).toBe('needs_triage');
      expect(findings[0].severity).toBe('medium');
    });

    it('creates a pending Approval when submitted', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });
      const allowance = await service.createAllowance({
        claimantId: claimant.id,
        type: 'mileage',
        km: 100,
        periodStart: '2026-06-20',
      });

      await service.submitAllowance(allowance.id);

      const approvals = await db
        .selectFrom('approval')
        .selectAll()
        .where('object_type', '=', 'allowance')
        .where('object_id', '=', allowance.id)
        .execute();
      expect(approvals).toHaveLength(1);
      expect(approvals[0].status).toBe('pending');
      expect(approvals[0].requested_by).toBe('claimant');
    });

    it('throws ConflictException when submitted twice', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });
      const allowance = await service.createAllowance({
        claimantId: claimant.id,
        type: 'mileage',
        km: 100,
        periodStart: '2026-06-20',
      });

      await service.submitAllowance(allowance.id);

      await expect(service.submitAllowance(allowance.id)).rejects.toThrow(
        ConflictException,
      );
    });
  });
});
