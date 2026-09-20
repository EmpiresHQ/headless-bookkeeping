import { fxTestProviders } from '../../../../test/fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../../../database/types';
import { migrations } from '../../../database/migrations';
import { AllowanceService } from '../../../allowances/allowance.service';
import { AllowanceLimitService } from '../../../allowances/allowance-limit.service';
import { BusinessTripService } from '../../../allowances/business-trip.service';
import { NullCountryPlugin } from '../../../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../../../plugins/estonia-country.plugin';
import { OrgContextResolver } from '../../../organization/org-context.resolver';
import { OrganizationService } from '../../../organization/organization.service';
import { PluginLoader } from '../../../plugins/plugin-loader.service';
import { AuditFindingsService } from '../../../audit-findings/audit-findings.service';
import { StatusTransitionService } from '../../../ledger/status/status-transition.service';
import { AllowanceFlow } from './allowance-flow';
import { DispatchContext } from '../flow-dispatcher';
import { RoutedIntent } from '../types';
import { seedEntity } from '../../../../test/helpers/seed-entity';

describe('AllowanceFlow', () => {
  let db: Kysely<Database>;
  let flow: AllowanceFlow;

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
        ...fxTestProviders(),
        PluginLoader,
        AllowanceLimitService,
        BusinessTripService,
        OrganizationService,
        OrgContextResolver,
        AuditFindingsService,
        StatusTransitionService,
        AllowanceService,
        AllowanceFlow,
      ],
    }).compile();

    flow = module.get(AllowanceFlow);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('health — the exemption facts (issue #212)', () => {
    const ctxFor = (claimantId: number): DispatchContext => ({
      conversation_id: 1,
      principal: {
        role: 'known_counterparty',
        authVerified: false,
        senderId: `entity:${claimantId}`,
      },
    });

    beforeEach(async () => {
      await db
        .updateTable('organization')
        .set({ country: 'EE', vat_registered: 1 })
        .where('id', '=', 1)
        .execute();
    });

    it('asks for the eligibility facts by name instead of creating a claim it cannot classify', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });
      const intent: RoutedIntent = {
        kind: 'action',
        actionIntent: 'create_allowance',
        fields: { type: 'health', input_amount: '100000' },
      };

      const result = await flow.dispatch(intent, ctxFor(claimant.id));

      expect(result.handled).toBe(true);
      expect(result.reply).toContain('health_category');
      expect(result.reply).toContain('claimant_relation');
      expect(result.reply).toContain('supporting_document_ref');
      expect(result.reply).toContain('offered_to_all_employees');
      // Nothing half-made was left behind for someone to approve later.
      expect(await db.selectFrom('allowance').selectAll().execute()).toEqual(
        [],
      );
    });

    it('creates the claim once the facts arrive, and says what was decided', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });
      const intent: RoutedIntent = {
        kind: 'action',
        actionIntent: 'create_allowance',
        fields: {
          type: 'health',
          input_amount: '100000',
          period_start: '2026-09-01',
          health_category: 'sports_facility_fee',
          claimant_relation: 'employee',
          supporting_document_ref: 'INV-2026-0042',
          offered_to_all_employees: 'yes',
        },
      };

      const result = await flow.dispatch(intent, ctxFor(claimant.id));

      expect(result.handled).toBe(true);
      expect(result.reply).toContain('400.00 is tax-exempt');
      expect(result.reply).toContain('600.00 is a taxable fringe benefit');

      const rows = await db.selectFrom('allowance').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'needs_triage',
        tax_free_amount: 40000,
        taxable_amount: 60000,
        health_category: 'sports_facility_fee',
        claimant_relation: 'employee',
        supporting_document_ref: 'INV-2026-0042',
        offered_to_all_employees: 1,
      });
    });

    it('reads anything but an explicit yes as not offered to all employees', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });
      const intent: RoutedIntent = {
        kind: 'action',
        actionIntent: 'create_allowance',
        fields: {
          type: 'health',
          input_amount: '10000',
          period_start: '2026-09-01',
          health_category: 'sports_facility_fee',
          claimant_relation: 'employee',
          supporting_document_ref: 'INV-9',
          offered_to_all_employees: 'only me',
        },
      };

      await flow.dispatch(intent, ctxFor(claimant.id));

      const row = await db
        .selectFrom('allowance')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(row.offered_to_all_employees).toBe(0);
      expect(row.tax_free_amount).toBe(0);
      expect(row.taxable_amount).toBe(10000);
      expect(row.exemption_basis).toBe('ineligible');
    });
  });

  describe('daily_allowance — complete fields', () => {
    it('creates allowance, submits to needs_triage, and returns confirmation', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });

      const intent: RoutedIntent = {
        kind: 'action',
        actionIntent: 'create_allowance',
        fields: {
          type: 'daily_allowance',
          departure_date: '2026-06-10',
          return_date: '2026-06-15',
          destination_country: 'DE',
        },
      };

      const ctx: DispatchContext = {
        conversation_id: 1,
        principal: {
          role: 'known_counterparty',
          authVerified: false,
          senderId: `entity:${claimant.id}`,
        },
      };

      const result = await flow.dispatch(intent, ctx);

      expect(result.handled).toBe(true);
      expect(result.reply).toContain('päevaraha');

      const allowances = await db
        .selectFrom('allowance')
        .selectAll()
        .where('claimant_id', '=', claimant.id)
        .execute();
      expect(allowances).toHaveLength(1);
      expect(allowances[0].status).toBe('needs_triage');
      expect(allowances[0].type).toBe('daily_allowance');
      expect(allowances[0].days).toBe(6);
    });
  });

  describe('daily_allowance — incomplete fields', () => {
    it('returns clarify reply when dates are missing', async () => {
      const intent: RoutedIntent = {
        kind: 'action',
        actionIntent: 'create_allowance',
        fields: { type: 'daily_allowance' },
      };

      const ctx: DispatchContext = {
        conversation_id: 1,
        principal: {
          role: 'known_counterparty',
          authVerified: false,
          senderId: 'entity:1',
        },
      };

      const result = await flow.dispatch(intent, ctx);

      expect(result.handled).toBe(true);
      expect(result.reply).toMatch(/departure_date|return_date|dates/i);
    });

    it('returns clarify reply when destination_country is missing', async () => {
      const intent: RoutedIntent = {
        kind: 'action',
        actionIntent: 'create_allowance',
        fields: {
          type: 'daily_allowance',
          departure_date: '2026-06-10',
          return_date: '2026-06-15',
        },
      };

      const ctx: DispatchContext = {
        conversation_id: 1,
        principal: {
          role: 'known_counterparty',
          authVerified: false,
          senderId: 'entity:1',
        },
      };

      const result = await flow.dispatch(intent, ctx);

      expect(result.handled).toBe(true);
      expect(result.reply).toContain('destination_country');
    });
  });

  describe('mileage — complete fields', () => {
    it('creates mileage allowance, submits to needs_triage, and returns confirmation', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });

      const intent: RoutedIntent = {
        kind: 'action',
        actionIntent: 'create_allowance',
        fields: {
          type: 'mileage',
          km: '150',
          period_start: '2026-06-20',
          route_description: 'Tallinn → Tartu',
        },
      };

      const ctx: DispatchContext = {
        conversation_id: 1,
        principal: {
          role: 'known_counterparty',
          authVerified: false,
          senderId: `entity:${claimant.id}`,
        },
      };

      const result = await flow.dispatch(intent, ctx);

      expect(result.handled).toBe(true);
      expect(result.reply?.toLowerCase()).toContain('mileage');

      const allowances = await db
        .selectFrom('allowance')
        .selectAll()
        .where('claimant_id', '=', claimant.id)
        .execute();
      expect(allowances).toHaveLength(1);
      expect(allowances[0].status).toBe('needs_triage');
      expect(allowances[0].km).toBe(150);
    });
  });

  describe('mileage — incomplete fields', () => {
    it('returns clarify reply when km is missing', async () => {
      const intent: RoutedIntent = {
        kind: 'action',
        actionIntent: 'create_allowance',
        fields: { type: 'mileage', period_start: '2026-06-20' },
      };

      const ctx: DispatchContext = {
        conversation_id: 1,
        principal: {
          role: 'known_counterparty',
          authVerified: false,
          senderId: 'entity:1',
        },
      };

      const result = await flow.dispatch(intent, ctx);

      expect(result.handled).toBe(true);
      expect(result.reply).toContain('km');
    });
  });

  describe('phone allowance — complete fields', () => {
    it('creates phone allowance, submits to needs_triage, and returns confirmation', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });

      const intent: RoutedIntent = {
        kind: 'action',
        actionIntent: 'create_allowance',
        fields: {
          type: 'phone',
          input_amount: '2000',
          period_start: '2026-06-01',
        },
      };

      const ctx: DispatchContext = {
        conversation_id: 1,
        principal: {
          role: 'known_counterparty',
          authVerified: false,
          senderId: `entity:${claimant.id}`,
        },
      };

      const result = await flow.dispatch(intent, ctx);

      expect(result.handled).toBe(true);
      expect(result.reply?.toLowerCase()).toContain('phone');

      const allowances = await db
        .selectFrom('allowance')
        .selectAll()
        .where('claimant_id', '=', claimant.id)
        .execute();
      expect(allowances).toHaveLength(1);
      expect(allowances[0].status).toBe('needs_triage');
      expect(allowances[0].type).toBe('phone');
    });
  });

  describe('no type provided', () => {
    it('returns clarify reply asking for type', async () => {
      const intent: RoutedIntent = {
        kind: 'action',
        actionIntent: 'create_allowance',
        fields: {},
      };

      const ctx: DispatchContext = {
        conversation_id: 1,
        principal: {
          role: 'known_counterparty',
          authVerified: false,
          senderId: 'entity:1',
        },
      };

      const result = await flow.dispatch(intent, ctx);

      expect(result.handled).toBe(true);
      expect(result.reply?.toLowerCase()).toContain('type');
    });
  });

  describe('unknown allowance type', () => {
    it('returns error reply for unsupported type', async () => {
      const intent: RoutedIntent = {
        kind: 'action',
        actionIntent: 'create_allowance',
        fields: { type: 'lunch' },
      };

      const ctx: DispatchContext = {
        conversation_id: 1,
        principal: {
          role: 'known_counterparty',
          authVerified: false,
          senderId: 'entity:1',
        },
      };

      const result = await flow.dispatch(intent, ctx);

      expect(result.handled).toBe(true);
      expect(result.reply).toContain('lunch');
    });
  });
});
