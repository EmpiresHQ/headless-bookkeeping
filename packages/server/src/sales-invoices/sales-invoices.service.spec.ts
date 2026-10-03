import { fxTestProviders } from '../../test/fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CurrencyService } from '../currency/currency.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { EntitiesService } from '../entities/entities.service';
import { UnresolvedVatTreatmentError } from '../plugins/vat-treatment.errors';
import { SalesInvoicesService } from './sales-invoices.service';
import { CreateSalesInvoiceDto } from './types';

describe('SalesInvoicesService (integration)', () => {
  let db: Kysely<Database>;
  let service: SalesInvoicesService;
  let entitiesService: EntitiesService;
  let organizationService: OrganizationService;
  // The underlying connection, so a test can write from OUTSIDE Kysely — the
  // only way to interleave a state change into an open transaction on a
  // single-connection SQLite (used by the stale-interleaving test below).
  let rawDb: SqliteDb.Database;

  beforeEach(async () => {
    rawDb = new SqliteDb(':memory:');
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
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        ...fxTestProviders(),
        PluginLoader,
        OrgContextResolver,
        CurrencyService,
        VoucherProjectionService,
        EntitiesService,
        SalesInvoicesService,
      ],
    }).compile();

    service = module.get(SalesInvoicesService);
    entitiesService = module.get(EntitiesService);
    organizationService = module.get(OrganizationService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  const createDto = (
    overrides?: Partial<CreateSalesInvoiceDto>,
  ): CreateSalesInvoiceDto => ({
    invoice_number: 'INV-2026-001',
    gross_amount: 12300,
    vat_amount: 2300,
    currency: 'EUR',
    tax_point_date: '2026-03-15',
    ...overrides,
  });

  it('creates an invoice with status draft', async () => {
    const invoice = await service.createInvoice(createDto());
    expect(invoice.id).toBeGreaterThan(0);
    expect(invoice.status).toBe('draft');
    expect(invoice.sent_at).toBeNull();
    expect(invoice.voucher_id).toBeNull();
  });

  it('lists created invoices', async () => {
    await service.createInvoice(createDto({ invoice_number: 'INV-001' }));
    await service.createInvoice(createDto({ invoice_number: 'INV-002' }));
    const invoices = await service.getInvoices();
    expect(invoices).toHaveLength(2);
  });

  it('flags an invoice whose voucher is matched to a bank transaction as reconciled', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Relax FKs so we can stage a posted invoice + a match against its voucher
    // without the whole voucher/bank chain — getInvoices joins on voucher_id.
    await sql`PRAGMA foreign_keys = OFF`.execute(db);
    const posted = await db
      .insertInto('sales_invoice')
      .values({
        invoice_number: 'INV-RECON',
        gross_amount: 1000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-05-01',
        status: 'posted',
        voucher_id: 4242,
        customer_id: null,
        due_date: null,
        sent_at: null,
        document_vat_marking: null,
        created_at: now,
        updated_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('reconciliation_match')
      .values({
        bank_transaction_id: 1,
        voucher_id: 4242,
        match_type: 'exact',
        amount_matched: 1000,
        created_at: now,
      })
      .execute();
    await sql`PRAGMA foreign_keys = ON`.execute(db);

    const draft = await service.createInvoice(createDto());

    const list = await service.getInvoices();
    expect(list.find((i) => i.id === posted.id)?.reconciled).toBe(true);
    expect(list.find((i) => i.id === draft.id)?.reconciled).toBe(false);
  });

  it('finds an invoice by id', async () => {
    const created = await service.createInvoice(createDto());
    const found = await service.getInvoiceById(created.id);
    expect(found).not.toBeNull();
    expect(found?.invoice_number).toBe('INV-2026-001');
  });

  it('throws NotFoundException for unknown invoice id', async () => {
    await expect(service.getInvoiceById(999)).rejects.toThrow(
      'SalesInvoice 999 not found',
    );
  });

  it('rejects duplicate invoice_number', async () => {
    await service.createInvoice(createDto());
    await expect(service.createInvoice(createDto())).rejects.toThrow(
      'already exists',
    );
  });

  it('generate-draft returns a transient balanced voucher (Dr AR / Cr Revenue / Cr VAT_PAYABLE)', async () => {
    const invoice = await service.createInvoice(createDto());
    const draft = await service.generateDraftVoucher(invoice.id);

    expect(draft.voucher_number).toBe('PENDING');
    expect(draft.tax_point_date).toBe('2026-03-15');
    expect(draft.lines).toHaveLength(3);

    const arLine = draft.lines.find((l) => l.account_code === 'AR');
    const revenueLine = draft.lines.find((l) => l.account_code === 'REVENUE');
    const vatLine = draft.lines.find((l) => l.account_code === 'VAT_PAYABLE');

    expect(arLine).toBeDefined();
    expect(arLine?.is_debit).toBe(true);
    expect(arLine?.amount).toBe(12300);
    expect(arLine?.vat_code).toBeNull();

    expect(revenueLine).toBeDefined();
    expect(revenueLine?.is_debit).toBe(false);
    expect(revenueLine?.amount).toBe(10000); // net
    expect(revenueLine?.vat_code).toBe('IE_OUTPUT_23');

    expect(vatLine).toBeDefined();
    expect(vatLine?.is_debit).toBe(false);
    expect(vatLine?.amount).toBe(2300);
    expect(vatLine?.vat_code).toBe('IE_OUTPUT_23');

    // Balanced in base currency
    const totalDebits = draft.lines
      .filter((l) => l.is_debit)
      .reduce((sum, l) => sum + l.base_amount, 0);
    const totalCredits = draft.lines
      .filter((l) => !l.is_debit)
      .reduce((sum, l) => sum + l.base_amount, 0);
    expect(totalDebits).toBe(totalCredits);

    // EUR: fx_rate=1, base_amount=amount
    draft.lines.forEach((line) => {
      expect(line.fx_rate).toBe(1);
      expect(line.base_amount).toBe(line.amount);
    });
  });

  it('generate-draft throws NotFoundException for missing invoice', async () => {
    await expect(service.generateDraftVoucher(999)).rejects.toThrow(
      'SalesInvoice 999 not found',
    );
  });

  it('send sets sent_at without changing status', async () => {
    const invoice = await service.createInvoice(createDto());
    expect(invoice.sent_at).toBeNull();

    const sent = await service.sendInvoice(invoice.id);
    expect(sent.sent_at).not.toBeNull();
    expect(sent.status).toBe('draft');
    expect(sent.sent_at).toBeGreaterThanOrEqual(invoice.created_at);
  });

  it('send throws NotFoundException for missing invoice', async () => {
    await expect(service.sendInvoice(999)).rejects.toThrow(
      'SalesInvoice 999 not found',
    );
  });

  it('generate-draft uses resolveCategoryMapping for revenue account + VAT code', async () => {
    const invoice = await service.createInvoice(createDto());
    const draft = await service.generateDraftVoucher(invoice.id);

    const revenueLine = draft.lines.find((l) => l.account_code === 'REVENUE');
    expect(revenueLine?.account_code).toBe('REVENUE');
    expect(revenueLine?.vat_code).toBe('IE_OUTPUT_23');
  });

  describe('deleteDraft', () => {
    it('removes a draft invoice', async () => {
      const invoice = await service.createInvoice(createDto());
      await service.deleteDraft(invoice.id);
      expect(await service.getInvoices()).toHaveLength(0);
    });

    it('refuses to delete a non-draft invoice', async () => {
      const invoice = await service.createInvoice(createDto());
      await db
        .updateTable('sales_invoice')
        .set({ status: 'pending' })
        .where('id', '=', invoice.id)
        .execute();
      await expect(service.deleteDraft(invoice.id)).rejects.toThrow(
        /only a draft/i,
      );
    });
  });

  it('stores document_id on create and finds the invoice by document_id', async () => {
    const inv = await service.createInvoice({
      invoice_number: 'INV-1',
      gross_amount: 12200,
      vat_amount: 2200,
      currency: 'EUR',
      tax_point_date: '2026-06-01',
      customer_id: null,
      document_id: 42,
    });
    expect(inv.document_id).toBe(42);

    const found = await service.findByDocumentId(42);
    expect(found?.id).toBe(inv.id);
    expect(await service.findByDocumentId(999)).toBeUndefined();
  });

  describe('updateDraft', () => {
    it('moves a pending invoice back to draft and supersedes its pending approval', async () => {
      const invoice = await service.createInvoice(createDto());
      const now = Math.floor(Date.now() / 1000);
      await db
        .updateTable('sales_invoice')
        .set({ status: 'pending' })
        .where('id', '=', invoice.id)
        .execute();
      const approval = await db
        .insertInto('approval')
        .values({
          object_type: 'sales_invoice',
          object_id: invoice.id,
          status: 'pending',
          requested_by: 'policy',
          approved_by: null,
          rejected_reason: null,
          superseded_by: null,
          created_at: now,
          resolved_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const finding = await db
        .insertInto('audit_finding')
        .values({
          finding_type: 'pending_approval',
          severity: 'medium',
          description: `Approval ${approval.id} is waiting for a decision`,
          referenced_object_type: 'approval',
          referenced_object_id: approval.id,
          status: 'open',
          created_at: now,
          resolved_at: null,
          snoozed_at: null,
          transitioned_by: null,
          transition_reason: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const updated = await service.updateDraft(invoice.id, {
        gross_amount: 15000,
        vat_amount: 2500,
      });

      expect(updated.status).toBe('draft');
      expect(updated.gross_amount).toBe(15000);
      expect(updated.vat_amount).toBe(2500);

      const resolvedApproval = await db
        .selectFrom('approval')
        .selectAll()
        .where('id', '=', approval.id)
        .executeTakeFirstOrThrow();
      expect(resolvedApproval.status).toBe('superseded');
      expect(resolvedApproval.resolved_at).not.toBeNull();

      const resolvedFinding = await db
        .selectFrom('audit_finding')
        .selectAll()
        .where('id', '=', finding.id)
        .executeTakeFirstOrThrow();
      expect(resolvedFinding.status).toBe('resolved');
      expect(resolvedFinding.resolved_at).not.toBeNull();
    });
  });

  describe('intra-EU B2B service sale (EE org)', () => {
    it('tags revenue 0% intra-EU (EE_OUTPUT_0_EU) for an EU customer of services', async () => {
      await organizationService.updateOrganization({ country: 'EE' });

      const customer = await entitiesService.onboard({
        role: 'customer',
        country: 'DK',
        name: 'ACME',
        registrationKey: 'DK99999999',
        goodsVsServices: 'services',
        // The fact that makes this the Art. 44/196 case rather than a supply
        // to a Danish consumer (issue #209).
        taxStatus: 'taxable_business',
      });

      const invoice = await service.createInvoice({
        invoice_number: 'INV-EU-1',
        gross_amount: 615700,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-05-31',
        customer_id: customer.id,
      });

      const draft = await service.generateDraftVoucher(invoice.id);
      const revenue = draft.lines.find((l) => l.account_code === 'REVENUE');
      expect(revenue?.vat_code).toBe('EE_OUTPUT_0_EU');
      expect(revenue?.amount).toBe(615700); // whole gross is 0%-rated käive

      // No output VAT on a 0% supply — the VAT leg is dropped (a 0-amount line
      // cannot post).
      const vatLine = draft.lines.find((l) => l.account_code === 'VAT_PAYABLE');
      expect(vatLine).toBeUndefined();
    });

    it('REFUSES to draft the same invoice while the tax status is unknown', async () => {
      await organizationService.updateOrganization({ country: 'EE' });

      const customer = await entitiesService.onboard({
        role: 'customer',
        country: 'DK',
        name: 'Unknown Status OY',
        registrationKey: 'DK11111111',
        goodsVsServices: 'services',
      });

      const invoice = await service.createInvoice({
        invoice_number: 'INV-EU-UNKNOWN',
        gross_amount: 615700,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-05-31',
        customer_id: customer.id,
      });

      await expect(
        service.generateDraftVoucher(invoice.id),
      ).rejects.toBeInstanceOf(UnresolvedVatTreatmentError);

      // Recording the fact is all it takes — no other change to the invoice.
      await entitiesService.update(customer.id, {
        taxStatus: 'taxable_business',
      });
      const draft = await service.generateDraftVoucher(invoice.id);
      expect(
        draft.lines.find((l) => l.account_code === 'REVENUE')?.vat_code,
      ).toBe('EE_OUTPUT_0_EU');
    });

    it('persists supply_type and service_place_rule as given', async () => {
      const invoice = await service.createInvoice({
        invoice_number: 'INV-FACTS',
        gross_amount: 10000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-05-31',
        supply_type: 'services',
        service_place_rule: 'immovable_property',
      });
      expect(invoice.supply_type).toBe('services');
      expect(invoice.service_place_rule).toBe('immovable_property');

      const reread = await service.getInvoiceById(invoice.id);
      expect(reread.service_place_rule).toBe('immovable_property');
    });

    it('defaults service_place_rule to the residual general rule', async () => {
      const invoice = await service.createInvoice({
        invoice_number: 'INV-DEFAULT-RULE',
        gross_amount: 10000,
        vat_amount: 2400,
        currency: 'EUR',
        tax_point_date: '2026-05-31',
      });
      expect(invoice.service_place_rule).toBe('general');
      expect(invoice.supply_type).toBeNull();
    });
  });

  describe('patching a draft (issue #209 remedy)', () => {
    async function draftInvoice(
      over: Partial<CreateSalesInvoiceDto> = {},
    ): Promise<number> {
      const inv = await service.createInvoice({
        invoice_number: `INV-PATCH-${Math.random().toString(36).slice(2, 8)}`,
        gross_amount: 12400,
        vat_amount: 2400,
        currency: 'EUR',
        tax_point_date: '2026-05-15',
        ...over,
      } as CreateSalesInvoiceDto);
      return inv.id;
    }

    /** A real voucher row, so `sales_invoice.voucher_id`'s FK is satisfied. */
    async function makeVoucher(number: string): Promise<number> {
      const v = await db
        .insertInto('voucher')
        .values({
          voucher_number: number,
          tax_point_date: '2026-05-15',
          posted_at: 1,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return v.id;
    }

    it('patches the supply facts and amounts of a draft', async () => {
      const id = await draftInvoice();
      const patched = await service.updateDraft(id, {
        gross_amount: 10000,
        vat_amount: 0,
        supply_type: 'services',
        service_place_rule: 'general',
      });
      expect(patched).toMatchObject({
        gross_amount: 10000,
        vat_amount: 0,
        supply_type: 'services',
        service_place_rule: 'general',
        status: 'draft',
      });
    });

    it('validates the amounts the invoice would HAVE, not just the fields sent', async () => {
      const id = await draftInvoice({ gross_amount: 10000, vat_amount: 2400 });
      // vat_amount alone is a perfectly valid non-negative number; merged with
      // the existing gross it is a VAT charge larger than the invoice.
      await expect(
        service.updateDraft(id, { vat_amount: 50000 }),
      ).rejects.toThrow(/would exceed gross_amount/);
      // …and the same holds the other way round: shrinking the gross under an
      // existing VAT amount.
      await expect(
        service.updateDraft(id, { gross_amount: 1000 }),
      ).rejects.toThrow(/would exceed gross_amount/);

      const untouched = await service.getInvoiceById(id);
      expect(untouched).toMatchObject({
        gross_amount: 10000,
        vat_amount: 2400,
      });
    });

    it('refuses a posted invoice and leaves it byte-for-byte alone', async () => {
      const id = await draftInvoice();
      await service.updateInvoiceStatus(id, 'posted', await makeVoucher('V-1'));
      const before = await db
        .selectFrom('sales_invoice')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      await expect(
        service.updateDraft(id, { supply_type: 'goods', vat_amount: 0 }),
      ).rejects.toThrow(/is posted/);
      expect(
        await db
          .selectFrom('sales_invoice')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      ).toEqual(before);
    });

    it('does NOT overwrite an invoice that gets posted mid-edit (conditional claim)', async () => {
      const id = await draftInvoice({ gross_amount: 12400, vat_amount: 2400 });
      const voucherId = await makeVoucher('V-MID-EDIT');

      // Interleave a post between the in-transaction read and the update: the
      // raw connection is the same one the transaction holds, so this write
      // lands where a real concurrent poster's would.
      const flip = jest
        .spyOn(
          service as unknown as { assertPatchedAmounts: () => void },
          'assertPatchedAmounts',
        )
        .mockImplementation(() => {
          rawDb
            .prepare(
              "UPDATE sales_invoice SET status = 'posted', voucher_id = ? WHERE id = ?",
            )
            .run(voucherId, id);
        });

      await expect(
        service.updateDraft(id, {
          gross_amount: 99900,
          vat_amount: 0,
          supply_type: 'goods',
        }),
      ).rejects.toThrow(/changed while this edit was being applied/);
      flip.mockRestore();

      // NOTHING from the patch was written: the amounts and supply facts are
      // the ones the invoice had. (The simulated post shares this single
      // connection, so it rolls back with the refused transaction and the row
      // reads as the original draft again — the point of the assertion is that
      // 99900 / goods never reached the row that the poster had claimed.)
      const after = await db
        .selectFrom('sales_invoice')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(after).toMatchObject({
        gross_amount: 12400,
        vat_amount: 2400,
        supply_type: null,
      });
      expect(after.gross_amount).not.toBe(99900);
      expect(voucherId).toBeGreaterThan(0);
    });

    it('supersedes a pending approval only when the edit actually wins the row', async () => {
      const id = await draftInvoice();
      // A real pending approval, exactly as the policy hold creates it.
      await db
        .updateTable('sales_invoice')
        .set({ status: 'pending' })
        .where('id', '=', id)
        .execute();
      const approval = await db
        .insertInto('approval')
        .values({
          object_type: 'sales_invoice',
          object_id: id,
          status: 'pending',
          requested_by: 'system',
          approved_by: null,
          rejected_reason: null,
          policy_reason: 'exceeds ceiling',
          superseded_by: null,
          created_at: 1,
          resolved_at: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const patched = await service.updateDraft(id, {
        supply_type: 'services',
      });
      expect(patched.status).toBe('draft');
      expect(
        (
          await db
            .selectFrom('approval')
            .selectAll()
            .where('id', '=', approval.id)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe('superseded');

      // A second pending approval on a POSTED invoice is left alone: the edit
      // must not resolve an approval for a row it did not win.
      await service.updateInvoiceStatus(
        id,
        'posted',
        await makeVoucher('V-SECOND'),
      );
      const stillPending = await db
        .insertInto('approval')
        .values({
          object_type: 'sales_invoice',
          object_id: id,
          status: 'pending',
          requested_by: 'system',
          approved_by: null,
          rejected_reason: null,
          policy_reason: 'second',
          superseded_by: null,
          created_at: 2,
          resolved_at: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await expect(
        service.updateDraft(id, { supply_type: 'goods' }),
      ).rejects.toThrow(/is posted/);
      expect(
        (
          await db
            .selectFrom('approval')
            .selectAll()
            .where('id', '=', stillPending.id)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe('pending');
    });
  });
  describe('the draft-facts guard sees OUR OWN registration (issue #211)', () => {
    it('changes the fingerprint when the VAT registration kind changes', async () => {
      await organizationService.updateOrganization({
        country: 'EE',
        vat_registered: true,
      });
      const customer = await entitiesService.onboard({
        role: 'customer',
        country: 'EE',
        name: 'Domestic OÜ',
        registrationKey: 'EE900000001',
        goodsVsServices: 'services',
        taxStatus: 'taxable_business',
      });
      const invoice = await service.createInvoice(
        createDto({ customer_id: customer.id }),
      );

      // The fingerprint a caller takes before generating a draft.
      const before = await service.draftFactsFingerprint(invoice.id);

      // Neither the invoice nor the customer moves — only WE do. A limited
      // registration charges no Estonian VAT on its own supplies, so the
      // prepared entry no longer describes a sale this organisation can make.
      await organizationService.updateOrganization({
        vat_registration_kind: 'limited',
        input_vat_entitlement: 'none',
      });

      const after = await service.draftFactsFingerprint(invoice.id);
      expect(after).not.toBe(before);

      // …and the guard refuses on it, rather than posting the stale draft.
      await expect(
        service.assertDraftFactsUnchangedTx(db, invoice.id, before),
      ).rejects.toThrow(/organisation's VAT registration/);
    });
  });
});
