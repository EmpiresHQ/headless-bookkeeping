import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';

/**
 * Builds the cleaned OpenAPI document (Zod-derived schemas inlined, Bearer
 * scheme applied to every operation). Shared by the HTTP `setupSwagger` mount
 * and the offline emitter (src/openapi-emit.ts) so the spec is identical in
 * both paths.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('headless-bookkeeping API')
    .setDescription(
      'AI-native bookkeeping kernel — remote HTTP API. ' +
        'Authenticate with a Bearer API token (mint one via POST /admin/tokens).',
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'token' },
      'bearer',
    )
    .addTag('accounts', 'Chart of accounts — read account definitions')
    .addTag('admin', 'Administrative read/ops: API tokens, accounts, vouchers, periods, approvals, findings, health')
    .addTag('approvals', 'Human-in-the-loop approval lifecycle for drafts before they post')
    .addTag('audit-findings', 'Audit findings raised by automated checks — list, resolve, snooze')
    .addTag('bank', 'Bank statements and transaction ingestion')
    .addTag('categories', 'Expense category definitions')
    .addTag('conversations', 'Agent conversation threads, messages, artifacts and object associations')
    .addTag('corrections', 'Post correcting entries for expenses and sales invoices')
    .addTag('credit-notes', 'Credit notes against sales invoices')
    .addTag('dividends', 'Declare dividends and settle them against bank transactions')
    .addTag('documents', 'Source documents — upload, fetch, download files, delete')
    .addTag('entities', 'Counterparties (suppliers/customers) and their identifiers/aliases')
    .addTag('expenses', 'Record supplier expenses (purchase invoices) and post them to the ledger')
    .addTag('health', 'Service health probe')
    .addTag('interaction', 'Inbound channel webhooks (e.g. Telegram)')
    .addTag('organization', 'Organization profile and reporting-period configuration')
    .addTag('overrides', 'Policy override audit trail')
    .addTag('policy-config', 'Posting-policy configuration')
    .addTag('prepayments', 'Prepayments from bank transactions and their draw-downs')
    .addTag('reconciliation', 'Match bank transactions to ledger items; FX-realized and personal disposition')
    .addTag('reporting-periods', 'Reporting periods — list, create, advance, lock, warnings')
    .addTag('sales-invoices', 'Issue sales invoices, generate drafts, send, and post')
    .addTag('settings', 'Key/value system settings')
    .addTag('statutory-reports', 'Statutory report rendering (annual accounts, etc.)')
    .addTag('triage', 'Triage inbound documents into postable items')
    .addTag('vat-report', 'VAT reports and KMD export per reporting period')
    .addTag('vouchers', 'Ledger vouchers — read and post (updates/deletes are rejected)')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  document.security = [{ bearer: [] }];
  return cleanupOpenApiDoc(document);
}

/**
 * Mounts Swagger UI at `/api` and the OpenAPI JSON at `/api-json`.
 *
 * The Swagger routes are raw HTTP routes (not Nest controller handlers), so the
 * global ApiTokenGuard does not gate them — the docs are reachable without a
 * token, while the documented endpoints still require the Bearer token.
 */
export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup('api', app, buildOpenApiDocument(app));
}
