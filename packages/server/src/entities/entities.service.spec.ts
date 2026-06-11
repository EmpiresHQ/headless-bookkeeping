import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { EntitiesService } from './entities.service';

/**
 * Integration test for the Entity aggregate (ADR-0014).
 *
 * Exercises the REAL DI graph against an in-memory SQLite DB seeded by the
 * real migration. Tests entity onboarding, alias resolution, and FK constraints.
 */
describe('Entity aggregate (integration)', () => {
  let db: Kysely<Database>;
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
        EntitiesService,
      ],
    }).compile();

    entitiesService = module.get(EntitiesService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('onboard + findByRegistrationKey', () => {
    it('onboards a supplier with registration key and finds it back', async () => {
      const onboarded = await entitiesService.onboard({
        role: 'supplier',
        country: 'DK',
        name: 'Acme Supplies ApS',
        registrationKey: 'DK12345678',
        goodsVsServices: 'goods',
      });

      expect(onboarded.name).toBe('Acme Supplies ApS');
      expect(onboarded.role).toBe('supplier');
      expect(onboarded.country).toBe('DK');
      expect(onboarded.goods_vs_services).toBe('goods');
      expect(onboarded.identifiers).toHaveLength(1);
      expect(onboarded.identifiers[0].kind).toBe('registration_key');
      expect(onboarded.identifiers[0].value).toBe('DK12345678');
      expect(onboarded.identifiers[0].confirmed).toBe(true);

      const found = await entitiesService.findByRegistrationKey('DK12345678');
      expect(found).toBeDefined();
      expect(found!.id).toBe(onboarded.id);
      expect(found!.name).toBe('Acme Supplies ApS');
    });

    it('returns undefined for a non-existent registration key', async () => {
      const found = await entitiesService.findByRegistrationKey('NOPE');
      expect(found).toBeUndefined();
    });

    it('onboards a customer entity', async () => {
      const onboarded = await entitiesService.onboard({
        role: 'customer',
        country: 'IE',
        name: 'Client Corp',
        registrationKey: 'IE9876543X',
      });

      expect(onboarded.role).toBe('customer');
      expect(onboarded.country).toBe('IE');
    });
  });

  describe('addAlias + resolveByIdentifier', () => {
    it('resolves an entity by confirmed IBAN', async () => {
      const onboarded = await entitiesService.onboard({
        role: 'supplier',
        country: 'DK',
        name: 'Acme Supplies ApS',
        registrationKey: 'DK12345678',
      });

      await entitiesService.addAlias(onboarded.id, {
        kind: 'iban',
        value: 'DK5000401234567890',
        confirmed: true,
      });

      const resolved = await entitiesService.resolveByIdentifier(
        'iban',
        'DK5000401234567890',
      );
      expect(resolved).toBeDefined();
      expect(resolved!.id).toBe(onboarded.id);
      expect(resolved!.identifiers).toHaveLength(2);
    });

    it('does NOT resolve by unconfirmed identifier', async () => {
      const onboarded = await entitiesService.onboard({
        role: 'supplier',
        country: 'DK',
        name: 'Acme Supplies ApS',
        registrationKey: 'DK12345678',
      });

      // merchant_descriptor starts unconfirmed (simulating raw bank statement data)
      await entitiesService.addAlias(onboarded.id, {
        kind: 'merchant_descriptor',
        value: 'ACME SUPPLIES',
        confirmed: false,
      });

      const resolved = await entitiesService.resolveByIdentifier(
        'merchant_descriptor',
        'ACME SUPPLIES',
      );
      expect(resolved).toBeUndefined();
    });

    it('resolves by name_alias after user confirms it', async () => {
      const onboarded = await entitiesService.onboard({
        role: 'supplier',
        country: 'DK',
        name: 'Acme Supplies ApS',
        registrationKey: 'DK12345678',
      });

      // User teaches the system that "ACME APS" is an alias for this supplier
      await entitiesService.addAlias(onboarded.id, {
        kind: 'name_alias',
        value: 'ACME APS',
        confirmed: true,
      });

      const resolved = await entitiesService.resolveByIdentifier(
        'name_alias',
        'ACME APS',
      );
      expect(resolved).toBeDefined();
      expect(resolved!.id).toBe(onboarded.id);
    });
  });

  describe('findById', () => {
    it('returns entity with all identifiers', async () => {
      const onboarded = await entitiesService.onboard({
        role: 'supplier',
        country: 'DK',
        name: 'Acme Supplies ApS',
        registrationKey: 'DK12345678',
      });

      await entitiesService.addAlias(onboarded.id, {
        kind: 'iban',
        value: 'DK5000401234567890',
        confirmed: true,
      });

      const found = await entitiesService.findById(onboarded.id);
      expect(found.identifiers).toHaveLength(2);
    });

    it('throws NotFoundException for non-existent id', async () => {
      await expect(entitiesService.findById(9999)).rejects.toThrow(
        'Entity 9999 not found',
      );
    });
  });

  describe('list', () => {
    it('returns all entities ordered by id', async () => {
      await entitiesService.onboard({
        role: 'supplier',
        country: 'DK',
        name: 'Supplier A',
        registrationKey: 'DK111',
      });
      await entitiesService.onboard({
        role: 'customer',
        country: 'IE',
        name: 'Customer B',
        registrationKey: 'IE222',
      });

      const list = await entitiesService.list();
      expect(list).toHaveLength(2);
      expect(list[0].name).toBe('Supplier A');
      expect(list[1].name).toBe('Customer B');
    });
  });

  describe('update (C4)', () => {
    it('updates intrinsic facts and preserves identifiers', async () => {
      const onboarded = await entitiesService.onboard({
        role: 'supplier',
        country: 'DK',
        name: 'Old Name ApS',
        registrationKey: 'DK999',
        goodsVsServices: 'unknown',
      });

      const updated = await entitiesService.update(onboarded.id, {
        name: 'New Name ApS',
        goodsVsServices: 'services',
      });

      expect(updated.name).toBe('New Name ApS');
      expect(updated.goods_vs_services).toBe('services');
      // Country left untouched; strong-key identifier preserved.
      expect(updated.country).toBe('DK');
      expect(
        updated.identifiers.find((i) => i.kind === 'registration_key')?.value,
      ).toBe('DK999');
    });

    it('throws NotFoundException for a missing id', async () => {
      await expect(entitiesService.update(9999, { name: 'x' })).rejects.toThrow(
        'Entity 9999 not found',
      );
    });
  });

  describe('FK constraints (G6)', () => {
    it('rejects inserting expense with non-existent supplier_id', async () => {
      await expect(
        db
          .insertInto('expense')
          .values({
            supplier_id: 9999,
            category: 'software',
            gross_amount: 10000,
            vat_amount: 2500,
            currency: 'EUR',
            tax_point_date: '2025-01-15',
            status: 'draft',
            voucher_id: null,
            document_id: null,
            created_at: Math.floor(Date.now() / 1000),
            updated_at: Math.floor(Date.now() / 1000),
          })
          .execute(),
      ).rejects.toThrow();
    });

    it('rejects inserting sales_invoice with non-existent customer_id', async () => {
      await expect(
        db
          .insertInto('sales_invoice')
          .values({
            customer_id: 9999,
            invoice_number: 'INV-001',
            gross_amount: 50000,
            vat_amount: 10000,
            currency: 'EUR',
            tax_point_date: '2025-01-15',
            due_date: '2025-02-15',
            status: 'draft',
            voucher_id: null,
            sent_at: null,
            created_at: Math.floor(Date.now() / 1000),
            updated_at: Math.floor(Date.now() / 1000),
          })
          .execute(),
      ).rejects.toThrow();
    });

    it('accepts expense with valid supplier_id FK', async () => {
      const supplier = await entitiesService.onboard({
        role: 'supplier',
        country: 'DK',
        name: 'Valid Supplier',
        registrationKey: 'DK99999',
      });

      const result = await db
        .insertInto('expense')
        .values({
          supplier_id: supplier.id,
          category: 'software',
          gross_amount: 10000,
          vat_amount: 2500,
          currency: 'EUR',
          tax_point_date: '2025-01-15',
          status: 'draft',
          voucher_id: null,
          document_id: null,
          created_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      expect(result.supplier_id).toBe(supplier.id);
    });

    it('accepts sales_invoice with valid customer_id FK', async () => {
      const customer = await entitiesService.onboard({
        role: 'customer',
        country: 'IE',
        name: 'Valid Customer',
        registrationKey: 'IE88888',
      });

      const result = await db
        .insertInto('sales_invoice')
        .values({
          customer_id: customer.id,
          invoice_number: 'INV-002',
          gross_amount: 50000,
          vat_amount: 10000,
          currency: 'EUR',
          tax_point_date: '2025-01-15',
          due_date: '2025-02-15',
          status: 'draft',
          voucher_id: null,
          sent_at: null,
          created_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      expect(result.customer_id).toBe(customer.id);
    });
  });

  describe('migration 043 — entity_identifier kinds', () => {
    it('accepts email, phone, and address identifier kinds', async () => {
      const supplier = await entitiesService.onboard({
        role: 'supplier',
        country: 'US',
        name: 'Anomaly',
        registrationKey: 'REG-1',
      });

      // Direct inserts: the CHECK must now admit the three new kinds.
      await expect(
        db
          .insertInto('entity_identifier')
          .values([
            {
              entity_id: supplier.id,
              kind: 'email',
              value: 'help@anoma.ly',
              confirmed: 1,
            },
            {
              entity_id: supplier.id,
              kind: 'phone',
              value: '+1555',
              confirmed: 1,
            },
            {
              entity_id: supplier.id,
              kind: 'address',
              value: '1 main st',
              confirmed: 1,
            },
          ])
          .execute(),
      ).resolves.toBeDefined();
    });
  });

  describe('multi-key resolution', () => {
    it('resolveByIdentifiers matches on ANY identifier and dedups entity ids', async () => {
      const s = await entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: 'US',
        name: 'Anomaly',
        identifiers: [
          { kind: 'email', value: 'Help@Anoma.LY' },
          { kind: 'phone', value: '+1 555 0000' },
        ],
      });

      // Match by email alone (different casing) and by phone alone.
      expect(
        await entitiesService.resolveByIdentifiers([
          { kind: 'email', value: 'help@anoma.ly' },
        ]),
      ).toEqual([s.id]);
      expect(
        await entitiesService.resolveByIdentifiers([
          { kind: 'phone', value: '+15550000' },
        ]),
      ).toEqual([s.id]);

      // Two candidates that both hit the same entity → single, deduped id.
      expect(
        await entitiesService.resolveByIdentifiers([
          { kind: 'email', value: 'help@anoma.ly' },
          { kind: 'phone', value: '+15550000' },
        ]),
      ).toEqual([s.id]);

      // No match → empty array.
      expect(
        await entitiesService.resolveByIdentifiers([
          { kind: 'email', value: 'nobody@x.io' },
        ]),
      ).toEqual([]);
    });

    it('onboardWithIdentifiers writes every present identifier and skips empties', async () => {
      const s = await entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: 'US',
        name: 'Anomaly',
        identifiers: [
          { kind: 'registration_key', value: '   ' }, // normalizes to null → skipped
          { kind: 'email', value: 'help@anoma.ly' },
          { kind: 'address', value: '1 Main St' },
        ],
      });

      const found = await entitiesService.findById(s.id);
      const kinds = found.identifiers.map((i) => i.kind).sort();
      expect(kinds).toEqual(['address', 'email']);
    });

    it('addIdentifierIfAbsent inserts once and is idempotent', async () => {
      const s = await entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: 'US',
        name: 'Anomaly',
        identifiers: [{ kind: 'email', value: 'help@anoma.ly' }],
      });

      await entitiesService.addIdentifierIfAbsent(s.id, 'phone', '+1 555 0000');
      await entitiesService.addIdentifierIfAbsent(s.id, 'phone', '+15550000'); // same after normalize

      const phones = (await entitiesService.findById(s.id)).identifiers.filter(
        (i) => i.kind === 'phone',
      );
      expect(phones).toHaveLength(1);
      expect(phones[0].value).toBe('+15550000');
    });

    it('resolveByIdentifiers returns DISTINCT ids when candidates hit different entities', async () => {
      const a = await entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: 'US',
        name: 'Supplier A',
        identifiers: [{ kind: 'email', value: 'a@x.io' }],
      });
      const b = await entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: 'US',
        name: 'Supplier B',
        identifiers: [{ kind: 'phone', value: '+1 555 1111' }],
      });

      const ids = await entitiesService.resolveByIdentifiers([
        { kind: 'email', value: 'a@x.io' },
        { kind: 'phone', value: '+15551111' },
      ]);
      expect(ids.sort()).toEqual([a.id, b.id].sort());
    });

    it('resolveByIdentifiers ignores non-match kinds like address', async () => {
      const s = await entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: 'US',
        name: 'Addressed Co',
        identifiers: [{ kind: 'address', value: '1 Main St' }],
      });
      // address is stored but must never be a match key
      expect(
        await entitiesService.resolveByIdentifiers([
          { kind: 'address', value: '1 main st' },
        ]),
      ).toEqual([]);
      // sanity: the entity DOES carry the stored address
      const found = await entitiesService.findById(s.id);
      expect(found.identifiers.some((i) => i.kind === 'address')).toBe(true);
    });
  });

  describe('delete', () => {
    it('removes an unreferenced entity', async () => {
      const e = await entitiesService.onboard({
        role: 'supplier',
        country: 'US',
        name: 'OpenRouter',
        registrationKey: 'US-OR-1',
      });
      await entitiesService.delete(e.id);
      expect(await entitiesService.list()).toHaveLength(0);
    });

    it('refuses to delete a referenced entity', async () => {
      const e = await entitiesService.onboard({
        role: 'customer',
        country: 'DK',
        name: 'ACME',
        registrationKey: 'DK99999999',
      });
      await db
        .insertInto('sales_invoice')
        .values({
          customer_id: e.id,
          invoice_number: 'INV-REF',
          gross_amount: 615700,
          vat_amount: 0,
          currency: 'EUR',
          tax_point_date: '2026-05-31',
          due_date: null,
          status: 'draft',
          voucher_id: null,
          sent_at: null,
          created_at: 0,
          updated_at: 0,
        })
        .execute();
      await expect(entitiesService.delete(e.id)).rejects.toThrow(/referenced/i);
    });

    it('throws NotFound for a missing id', async () => {
      await expect(entitiesService.delete(9999)).rejects.toThrow(
        'Entity 9999 not found',
      );
    });
  });
});
