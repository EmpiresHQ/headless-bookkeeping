import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { Database } from './../src/database/types';
import { MastraService } from './../src/ai/mastra.service';
import { setupSwagger } from './../src/swagger';
import { fauxMastraService } from './faux-mastra.service';
import { createHash } from 'crypto';

type JsonSchema = {
  readonly type?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly items?: JsonSchema;
  readonly $ref?: string;
};

type ResponseDoc = {
  readonly content?: Record<string, { readonly schema?: JsonSchema }>;
};

type OperationDoc = {
  readonly responses?: Record<string, ResponseDoc>;
};

type OpenApiDoc = {
  readonly paths: Record<string, { readonly get?: OperationDoc }>;
};

describe('Swagger (e2e)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let apiToken: string;

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
      .useValue(db)
      .overrideProvider(MastraService)
      .useValue(fauxMastraService)
      .compile();

    app = moduleFixture.createNestApplication();
    setupSwagger(app); // same setup as bootstrap (main.ts)
    await app.init();

    apiToken = 'test-token-e2e-12345';
    const tokenHash = createHash('sha256').update(apiToken).digest('hex');
    await db
      .insertInto('api_token')
      .values({ token_hash: tokenHash, label: 'e2e-test' })
      .execute();
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves the Swagger UI at /api (public, no token)', async () => {
    const res = await request(app.getHttpServer()).get('/api').expect(200);
    expect(res.text).toContain('Swagger UI');
  });

  it('serves the OpenAPI document at /api-json with Bearer security', async () => {
    const res = await request(app.getHttpServer()).get('/api-json').expect(200);
    const doc = res.body as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, unknown> };
      security: Array<Record<string, unknown>>;
    };
    expect(doc.openapi).toMatch(/^3\./);
    // Real endpoints are documented.
    expect(doc.paths['/api/expenses']).toBeDefined();
    expect(doc.paths['/health']).toBeDefined();
    // Bearer auth scheme is defined and applied globally.
    expect(doc.components.securitySchemes.bearer).toBeDefined();
    expect(doc.security).toEqual([{ bearer: [] }]);
  });

  it('groups endpoints by @ApiTags and inlines Zod (createZodDto) schemas', async () => {
    const res = await request(app.getHttpServer()).get('/api-json').expect(200);
    const doc = res.body as {
      paths: Record<string, { post?: { tags?: string[] } }>;
      components: {
        schemas?: Record<string, { properties?: Record<string, unknown> }>;
      };
    };
    // @ApiTags grouping shows up on operations.
    expect(doc.paths['/api/expenses'].post?.tags).toContain('expenses');
    // A createZodDto body produced a real component schema with its fields.
    expect(
      doc.components.schemas?.SetSettingDto?.properties?.value,
    ).toBeDefined();
  });

  it('documents list envelopes and by-id response schemas for core archive endpoints', async () => {
    // Given: the generated OpenAPI document from the same setup used by main.ts.
    const res = await request(app.getHttpServer()).get('/api-json').expect(200);
    const doc = res.body as OpenApiDoc;

    const listCases = [
      { path: '/api/expenses', envelope: 'expenses', itemField: 'category' },
      { path: '/api/documents', envelope: 'documents', itemField: 'filename' },
      {
        path: '/api/reporting-periods',
        envelope: 'reportingPeriods',
        itemField: 'name',
      },
    ];

    for (const listCase of listCases) {
      // When: a client inspects a list endpoint response schema.
      const schema =
        doc.paths[listCase.path]?.get?.responses?.['200']?.content?.[
          'application/json'
        ]?.schema;

      // Then: the documented top-level envelope matches the real API shape.
      expect(schema?.type).toBe('object');
      expect(Object.keys(schema?.properties ?? {}).sort()).toEqual([
        listCase.envelope,
      ]);
      expect(schema?.properties?.items).toBeUndefined();
      expect(schema?.properties?.data).toBeUndefined();
      expect(schema?.properties?.[listCase.envelope]?.type).toBe('array');
      expect(
        schema?.properties?.[listCase.envelope]?.items?.properties?.id,
      ).toBeDefined();
      expect(
        schema?.properties?.[listCase.envelope]?.items?.properties?.[
          listCase.itemField
        ],
      ).toBeDefined();
    }

    const byIdCases = [
      { path: '/api/expenses/{id}', field: 'category' },
      { path: '/api/documents/{id}', field: 'sources' },
      { path: '/api/reporting-periods/{id}', field: 'name' },
    ];

    for (const byIdCase of byIdCases) {
      // When: a client inspects a by-id endpoint response schema.
      const schema =
        doc.paths[byIdCase.path]?.get?.responses?.['200']?.content?.[
          'application/json'
        ]?.schema;

      // Then: the endpoint documents a concrete object payload.
      expect(schema?.type).toBe('object');
      expect(schema?.properties?.id).toBeDefined();
      expect(schema?.properties?.[byIdCase.field]).toBeDefined();
    }
  });

  it('does NOT shadow business routes under /api (e.g. /api/organization)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/organization')
      .set('Authorization', `Bearer ${apiToken}`)
      .expect(200);
    // Still the org payload, not the Swagger UI.
    expect((res.body as { country: string }).country).toBe('IE');
  });
});
