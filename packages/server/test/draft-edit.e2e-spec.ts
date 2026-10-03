import { FX_RATE_SOURCE } from '../src/fx/fx-rate.types';
import { ECB_FIXTURE_RATES, FixtureFxRateSource } from './fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, INestApplication } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../src/database/types';
import { migrations } from '../src/database/migrations';
import { DOCUMENT_STORAGE_ROOT } from '../src/documents/document-storage.service';
import { AppModule } from '../src/app.module';
import { MastraService } from '../src/ai/mastra.service';
import { fauxMastraService } from './faux-mastra.service';
import { CategoryService } from '../src/categories/category.service';
import { ZodValidationPipe } from '../src/common/pipes/zod-validation.pipe';
import { buildOpenApiDocument } from '../src/swagger';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

/**
 * Issue #247: a new or rejected draft is fixed IN PLACE and submitted again.
 *
 * Exercised over HTTP against an isolated in-memory database: the rejection
 * history and the source document survive the edit, the edit never posts, a
 * posted object is refused (it has its own correction flow), and the payload
 * contract refuses provenance fields by name instead of dropping them.
 */
describe('Draft edit (issue #247) E2E', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let root: string;
  const token = 'test-token-draft-edit-247';
  const auth = { Authorization: `Bearer ${token}` };

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

    root = mkdtempSync(join(tmpdir(), 'draft-edit-e2e-'));
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
      .useValue(db)
      .overrideProvider(DOCUMENT_STORAGE_ROOT)
      .useValue(root)
      .overrideProvider(MastraService)
      .useValue(fauxMastraService)
      .overrideProvider(CategoryService)
      .useValue({
        list: () => Promise.resolve([]),
        isValid: (c: string) => Promise.resolve(c !== 'bogus'),
        assertValid: (c: string) =>
          c === 'bogus'
            ? Promise.reject(new BadRequestException(`Unknown category '${c}'`))
            : Promise.resolve(),
      })
      .overrideProvider(FX_RATE_SOURCE)
      .useValue(new FixtureFxRateSource(ECB_FIXTURE_RATES))
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();

    await db
      .insertInto('api_token')
      .values({
        token_hash: createHash('sha256').update(token).digest('hex'),
        label: 'e2e-test',
      })
      .execute();
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  const http = () => request(app.getHttpServer());

  async function setAutoPost(enabled: boolean) {
    await http()
      .put('/api/policy-config')
      .set(auth)
      .send({ auto_post_enabled: enabled })
      .expect(200);
  }

  async function seedDocument(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const doc = await db
      .insertInto('document')
      .values({
        filename: 'receipt-247.pdf',
        mime_type: 'application/pdf',
        size_bytes: 10,
        hash: 'a'.repeat(64),
        storage_path: 'x/receipt-247.pdf',
        status: 'processed',
        created_at: now,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    return doc.id;
  }

  async function entity(role: string, name: string): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const row = await db
      .insertInto('entity')
      .values({
        role,
        country: 'EE',
        name,
        goods_vs_services: 'goods',
        tax_status: 'taxable_business',
        created_at: now,
        updated_at: now,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function holdAndReject(
    type: 'expense' | 'sales_invoice',
    id: number,
  ): Promise<number> {
    const path =
      type === 'expense'
        ? `/api/expenses/${id}/post`
        : `/api/sales-invoices/${id}/post`;
    const held = await http().post(path).set(auth).send({}).expect(201);
    expect(held.body.policy.action).toBe('hold-for-approval');
    const approval = await db
      .selectFrom('approval')
      .select('id')
      .where('object_type', '=', type)
      .where('object_id', '=', id)
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();
    await http()
      .post(`/api/approvals/${approval.id}/reject`)
      .set(auth)
      .send({ rejected_reason: 'Wrong amount and category' })
      .expect(201);
    return approval.id;
  }

  /** Submit; if policy holds it, approve — the object ends up posted. */
  async function postAndApprove(
    type: 'expense' | 'sales_invoice',
    id: number,
  ): Promise<void> {
    const path =
      type === 'expense'
        ? `/api/expenses/${id}/post`
        : `/api/sales-invoices/${id}/post`;
    const res = await http().post(path).set(auth).send({}).expect(201);
    if (res.body.policy.action === 'hold-for-approval') {
      const approval = await db
        .selectFrom('approval')
        .select('id')
        .where('object_type', '=', type)
        .where('object_id', '=', id)
        .where('status', '=', 'pending')
        .executeTakeFirstOrThrow();
      await http()
        .post(`/api/approvals/${approval.id}/approve`)
        .set(auth)
        .send({ approved_by: 'e2e' })
        .expect(201);
    }
  }

  it('publishes CLOSED edit bodies — the OpenAPI contract matches the runtime refusal', () => {
    const doc = buildOpenApiDocument(app) as unknown as {
      paths: Record<string, Record<string, { requestBody?: unknown }>>;
      components?: { schemas?: Record<string, unknown> };
    };
    const resolve = (body: unknown): Record<string, unknown> => {
      const schema = (
        body as { content: { 'application/json': { schema: unknown } } }
      ).content['application/json'].schema as Record<string, unknown>;
      const ref = schema.$ref as string | undefined;
      return ref
        ? (doc.components!.schemas![ref.split('/').pop()!] as Record<
            string,
            unknown
          >)
        : schema;
    };
    for (const path of ['/api/expenses/{id}', '/api/sales-invoices/{id}']) {
      const schema = resolve(doc.paths[path].patch.requestBody);
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties as object)).not.toContain(
        'document_id',
      );
    }
  });

  describe('expense', () => {
    it('rejected draft: edit → save the SAME draft → resubmit; history and source survive', async () => {
      const documentId = await seedDocument();
      const supplierA = await entity('supplier', 'Supplier A');
      const supplierB = await entity('supplier', 'Supplier B');
      const created = await http()
        .post('/api/expenses')
        .set(auth)
        .send({
          document_id: documentId,
          supplier_id: supplierA,
          category: 'office',
          gross_amount: 12400,
          vat_amount: 2400,
          currency: 'EUR',
          tax_point_date: '2026-05-10',
          ai_confidence: 0.91,
          ai_document_type: 'receipt',
        })
        .expect(201);
      const id = created.body.id as number;

      await setAutoPost(false);
      const approvalId = await holdAndReject('expense', id);
      expect(
        (await http().get(`/api/expenses/${id}`).set(auth)).body.status,
      ).toBe('draft');

      const saved = await http()
        .patch(`/api/expenses/${id}`)
        .set(auth)
        .send({
          category: 'software',
          supplier_id: supplierB,
          gross_amount: 6150,
          vat_amount: 1150,
          currency: 'EUR',
          tax_point_date: '2026-05-12',
          supplier_invoice_number: '  INV-9 ',
          claimant_id: null,
          company_addressed_receipt: null,
        })
        .expect(200);
      expect(saved.body).toMatchObject({
        id,
        status: 'draft',
        voucher_id: null,
        category: 'software',
        supplier_id: supplierB,
        gross_amount: 6150,
        vat_amount: 1150,
        tax_point_date: '2026-05-12',
        supplier_invoice_number: 'INV-9',
        // Provenance untouched.
        document_id: documentId,
        ai_confidence: 0.91,
        ai_document_type: 'receipt',
      });

      // Saving never posts: no voucher, and the rejection is still on record.
      const vouchers = await db.selectFrom('voucher').select('id').execute();
      expect(vouchers).toHaveLength(0);
      const rejected = await db
        .selectFrom('approval')
        .selectAll()
        .where('id', '=', approvalId)
        .executeTakeFirstOrThrow();
      expect(rejected.status).toBe('rejected');
      expect(rejected.rejected_reason).toBe('Wrong amount and category');

      // Resubmit deliberately: the prepared entry is built from the NEW facts.
      await setAutoPost(true);
      const posted = await http()
        .post(`/api/expenses/${id}/post`)
        .set(auth)
        .send({})
        .expect(201);
      expect(posted.body.expense.id).toBe(id);
      const lines = await db
        .selectFrom('voucher_line')
        .select(['amount', 'is_debit'])
        .execute();
      const debit = lines
        .filter((l) => Boolean(l.is_debit))
        .reduce((s, l) => s + Number(l.amount), 0);
      expect(debit).toBe(6150);
    });

    it('refuses to edit a posted expense (409) and leaves it untouched', async () => {
      const created = await http()
        .post('/api/expenses')
        .set(auth)
        .send({
          category: 'office',
          gross_amount: 1240,
          vat_amount: 240,
          currency: 'EUR',
          tax_point_date: '2026-05-10',
        })
        .expect(201);
      const id = created.body.id as number;
      await postAndApprove('expense', id);
      const before = (await http().get(`/api/expenses/${id}`).set(auth)).body;
      expect(before.status).toBe('posted');

      const res = await http()
        .patch(`/api/expenses/${id}`)
        .set(auth)
        .send({ gross_amount: 999 })
        .expect(409);
      expect(res.body.message).toMatch(/correct/);
      const after = (await http().get(`/api/expenses/${id}`).set(auth)).body;
      expect(after).toEqual(before);
    });

    it('validates deterministically and refuses provenance fields by name', async () => {
      const created = await http()
        .post('/api/expenses')
        .set(auth)
        .send({
          category: 'office',
          gross_amount: 1240,
          vat_amount: 240,
          currency: 'EUR',
          tax_point_date: '2026-05-10',
        })
        .expect(201);
      const id = created.body.id as number;
      const bad = async (body: object, key: string) => {
        const r = await http()
          .patch(`/api/expenses/${id}`)
          .set(auth)
          .send(body)
          .expect(400);
        // Field errors are keyed by field; a refused (non-editable) key is
        // named with its reason under `_errors`.
        expect(JSON.stringify(r.body)).toContain(key);
      };
      await bad({ gross_amount: 12.5 }, 'gross_amount');
      await bad({ gross_amount: 0 }, 'gross_amount');
      await bad({ vat_amount: -1 }, 'vat_amount');
      await bad({ tax_point_date: '2026-02-30' }, 'tax_point_date');
      await bad({ currency: 'eur' }, 'currency');
      await bad({ document_id: 5 }, 'document_id is the source document');
      await bad({ ai_confidence: 1 }, 'AI classification facts are preserved');
      await bad({ status: 'posted' }, 'status changes only through');
      await bad({ foo: 1 }, "'foo' is not an editable draft field");
      await bad({}, 'Supply at least one field');
      // Merged check: VAT above the stored gross.
      await http()
        .patch(`/api/expenses/${id}`)
        .set(auth)
        .send({ vat_amount: 5000 })
        .expect(400);
      await http()
        .patch(`/api/expenses/${id}`)
        .set(auth)
        .send({ category: 'bogus' })
        .expect(400);
      await http()
        .patch(`/api/expenses/${id}`)
        .set(auth)
        .send({ supplier_id: 99999 })
        .expect(422);
      const customer = await entity('customer', 'A customer');
      await http()
        .patch(`/api/expenses/${id}`)
        .set(auth)
        .send({ supplier_id: customer })
        .expect(422);
      const after = (await http().get(`/api/expenses/${id}`).set(auth)).body;
      expect(after).toMatchObject({
        gross_amount: 1240,
        vat_amount: 240,
        category: 'office',
        supplier_id: null,
      });
    });

    it('duplicate key: re-checked only when its VALUES change, excluding self; override audited with the edit', async () => {
      const supplier = await entity('supplier', 'Dup supplier');
      const base = {
        supplier_id: supplier,
        category: 'office',
        gross_amount: 5000,
        vat_amount: 968,
        currency: 'EUR',
        tax_point_date: '2026-05-10',
      };
      const a = await http()
        .post('/api/expenses')
        .set(auth)
        .send({ ...base, supplier_invoice_number: 'A-1' })
        .expect(201);
      const b = await http()
        .post('/api/expenses')
        .set(auth)
        .send({ ...base, supplier_invoice_number: 'B-1' })
        .expect(201);

      // A full-payload save that re-sends the SAME key values is not a
      // duplicate of itself.
      await http()
        .patch(`/api/expenses/${a.body.id}`)
        .set(auth)
        .send({ ...base, supplier_invoice_number: 'A-1', vat_amount: 900 })
        .expect(200);

      // Moving B onto A's number is refused and writes nothing …
      const dup = await http()
        .patch(`/api/expenses/${b.body.id}`)
        .set(auth)
        .send({ supplier_invoice_number: 'a 1' })
        .expect(409);
      expect(dup.body.existingExpenseId).toBe(a.body.id);
      expect(
        (await http().get(`/api/expenses/${b.body.id}`).set(auth)).body
          .supplier_invoice_number,
      ).toBe('B-1');

      // … unless deliberately allowed; the override is audited with the edit.
      await http()
        .patch(`/api/expenses/${b.body.id}`)
        .set(auth)
        .send({ supplier_invoice_number: 'A-1', allow_duplicate: true })
        .expect(200);
      const audit = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('action', '=', 'expense.duplicate_guard.override')
        .where('target_id', '=', b.body.id)
        .execute();
      expect(audit).toHaveLength(1);

      // The accepted duplicate can still have its category/VAT fixed without
      // tripping the guard again.
      await http()
        .patch(`/api/expenses/${b.body.id}`)
        .set(auth)
        .send({ ...base, supplier_invoice_number: 'A-1', category: 'software' })
        .expect(200);
      expect(
        await db
          .selectFrom('audit_log')
          .select('id')
          .where('action', '=', 'expense.duplicate_guard.override')
          .execute(),
      ).toHaveLength(1);
    });

    it('a claimant change alone re-runs the numberless fallback key', async () => {
      const supplier = await entity('supplier', 'Kiosk');
      const alice = await entity('employee', 'Alice');
      const bob = await entity('employee', 'Bob');
      const base = {
        supplier_id: supplier,
        category: 'office',
        gross_amount: 500,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-05-10',
      };
      await http()
        .post('/api/expenses')
        .set(auth)
        .send({ ...base, claimant_id: alice })
        .expect(201);
      const other = await http()
        .post('/api/expenses')
        .set(auth)
        .send({ ...base, claimant_id: bob })
        .expect(201);
      await http()
        .patch(`/api/expenses/${other.body.id}`)
        .set(auth)
        .send({ claimant_id: alice })
        .expect(409);
    });
  });

  describe('sales invoice', () => {
    async function createInvoice(extra: object = {}) {
      const res = await http()
        .post('/api/sales-invoices')
        .set(auth)
        .send({
          invoice_number: 'INV-247',
          gross_amount: 12400,
          vat_amount: 2400,
          currency: 'EUR',
          tax_point_date: '2026-05-10',
          ...extra,
        })
        .expect(201);
      return res.body.id as number;
    }

    it('rejected draft: edit identity + facts → save → resubmit; rejection survives', async () => {
      const customer = await entity('customer', 'Customer B');
      const documentId = await seedDocument();
      const id = await createInvoice({ document_id: documentId });
      await setAutoPost(false);
      const approvalId = await holdAndReject('sales_invoice', id);

      const saved = await http()
        .patch(`/api/sales-invoices/${id}`)
        .set(auth)
        .send({
          invoice_number: 'INV-247-A',
          customer_id: customer,
          gross_amount: 6200,
          vat_amount: 1200,
          currency: 'EUR',
          tax_point_date: '2026-05-11',
          due_date: '2026-06-11',
          supply_type: 'goods',
          service_place_rule: 'general',
        })
        .expect(200);
      expect(saved.body).toMatchObject({
        id,
        status: 'draft',
        invoice_number: 'INV-247-A',
        customer_id: customer,
        gross_amount: 6200,
        due_date: '2026-06-11',
        // Provenance untouched.
        document_id: documentId,
      });
      expect(await db.selectFrom('voucher').select('id').execute()).toEqual([]);
      expect(
        (
          await db
            .selectFrom('approval')
            .selectAll()
            .where('id', '=', approvalId)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe('rejected');

      await setAutoPost(true);
      const posted = await http()
        .post(`/api/sales-invoices/${id}/post`)
        .set(auth)
        .send({})
        .expect(201);
      expect(posted.body.invoice).toMatchObject({
        status: 'posted',
        document_id: documentId,
        invoice_number: 'INV-247-A',
      });
      await http()
        .patch(`/api/sales-invoices/${id}`)
        .set(auth)
        .send({ gross_amount: 1 })
        .expect(409);
    });

    it('keeps invoice numbers unique and locks identity once sent', async () => {
      const customer = await entity('customer', 'Sent-to customer');
      await createInvoice({ invoice_number: 'TAKEN-1' });
      const id = await createInvoice({
        invoice_number: 'MINE-1',
        customer_id: customer,
      });
      await http()
        .patch(`/api/sales-invoices/${id}`)
        .set(auth)
        .send({ invoice_number: 'TAKEN-1' })
        .expect(409);
      // Re-sending its own number is not a conflict.
      await http()
        .patch(`/api/sales-invoices/${id}`)
        .set(auth)
        .send({ invoice_number: 'MINE-1', vat_amount: 2000 })
        .expect(200);

      await http().post(`/api/sales-invoices/${id}/send`).set(auth).expect(201);
      const sent = await http()
        .patch(`/api/sales-invoices/${id}`)
        .set(auth)
        .send({ invoice_number: 'MINE-2' })
        .expect(409);
      expect(sent.body.message).toMatch(/already been sent/);
      await http()
        .patch(`/api/sales-invoices/${id}`)
        .set(auth)
        .send({ customer_id: null })
        .expect(409);
      // A full form save re-sends the UNCHANGED identity alongside the
      // amount/date fixes a sent draft still allows (issue #209 behaviour).
      const saved = await http()
        .patch(`/api/sales-invoices/${id}`)
        .set(auth)
        .send({
          invoice_number: 'MINE-1',
          customer_id: customer,
          gross_amount: 12500,
          vat_amount: 2419,
          tax_point_date: '2026-05-15',
          due_date: '2026-06-15',
        })
        .expect(200);
      expect(saved.body).toMatchObject({
        invoice_number: 'MINE-1',
        customer_id: customer,
        gross_amount: 12500,
        vat_amount: 2419,
        tax_point_date: '2026-05-15',
        due_date: '2026-06-15',
      });
    });

    it('refuses provenance and invalid values by name', async () => {
      const id = await createInvoice();
      const supplier = await entity('supplier', 'Not a customer');
      for (const [body, key] of [
        [{ document_id: 1 }, 'document_id is the source document'],
        [{ category: 'x' }, 'always posts to revenue'],
        [{ sent_at: 1 }, 'sent_at changes only through'],
        [{ due_date: '2026-13-01' }, 'due_date'],
        [{ gross_amount: 10.5 }, 'gross_amount'],
        [{ invoice_number: '   ' }, 'invoice_number'],
      ] as const) {
        const r = await http()
          .patch(`/api/sales-invoices/${id}`)
          .set(auth)
          .send(body)
          .expect(400);
        expect(JSON.stringify(r.body)).toContain(key);
      }
      await http()
        .patch(`/api/sales-invoices/${id}`)
        .set(auth)
        .send({ customer_id: supplier })
        .expect(422);
    });
  });
});
