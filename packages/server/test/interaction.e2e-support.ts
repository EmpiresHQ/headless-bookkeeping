import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import SqliteDb from 'better-sqlite3';
import { Kysely, SqliteDialect, type Selectable } from 'kysely';
import { Migrator } from 'kysely/migration';
import { mkdtempSync, rmSync } from 'fs';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { z } from 'zod';
import { fauxMastraService } from './faux-mastra.service';
import { AppModule } from '../src/app.module';
import { MastraService } from '../src/ai/mastra.service';
import { SecretaryAgent } from '../src/agents/secretary.agent';
import { ApiTokenService } from '../src/auth/api-token.service';
import { Database } from '../src/database/types';
import { DOCUMENT_STORAGE_ROOT } from '../src/documents/document-storage.service';
import { migrations } from '../src/database/migrations';
import { TelegramApi } from '../src/interaction/channels/telegram/telegram-api.port';
import type {
  TelegramSendPayload,
  TelegramUpdate,
} from '../src/interaction/channels/telegram/telegram.types';

const salesInvoiceSchema = z.object({
  id: z.number().int().positive(),
  invoice_number: z.string(),
  status: z.string(),
  voucher_id: z.number().int().nullable(),
});

const postInvoiceResponseSchema = z.object({
  invoice: salesInvoiceSchema,
  voucher: z.object({ id: z.number().int().positive() }).nullable(),
  policy: z.object({ action: z.string(), reason: z.string() }),
});

export type TestSalesInvoice = z.infer<typeof salesInvoiceSchema>;
export type HeldInvoiceResult = z.infer<typeof postInvoiceResponseSchema>;

export const approverUpdate: TelegramUpdate = {
  update_id: 1,
  message: {
    message_id: 5,
    chat: { id: 999 },
    from: { id: 999 },
    text: 'what is my VAT due?',
  },
};

export class FakeTelegramApi extends TelegramApi {
  readonly sentMessages: TelegramSendPayload[] = [];
  readonly callbackAnswers: string[] = [];
  readonly clearedMarkups: Array<{
    readonly chatId: number;
    readonly messageId: number;
  }> = [];

  sendMessage(payload: TelegramSendPayload): Promise<void> {
    this.sentMessages.push(payload);
    return Promise.resolve();
  }

  setWebhook(): Promise<void> {
    return Promise.resolve();
  }

  answerCallbackQuery(callbackQueryId: string): Promise<void> {
    this.callbackAnswers.push(callbackQueryId);
    return Promise.resolve();
  }

  editMessageReplyMarkup(chatId: number, messageId: number): Promise<void> {
    this.clearedMarkups.push({ chatId, messageId });
    return Promise.resolve();
  }

  reset(): void {
    this.sentMessages.length = 0;
    this.callbackAnswers.length = 0;
    this.clearedMarkups.length = 0;
  }
}

export type InteractionE2eHarness = {
  readonly app: INestApplication<App>;
  readonly db: Kysely<Database>;
  readonly secretary: SecretaryAgent;
  readonly telegramApi: FakeTelegramApi;
  readonly authorizationHeader: string;
  readonly root: string;
  close(): Promise<void>;
  seedPrivateApproverChat(): Promise<void>;
  forceHoldPolicy(): Promise<void>;
  createDraftSalesInvoice(
    invoiceNumber: string,
    grossAmount?: number,
  ): Promise<TestSalesInvoice>;
  holdSalesInvoice(id: number): Promise<HeldInvoiceResult>;
  getPendingApprovalForInvoice(
    invoiceId: number,
  ): Promise<Selectable<Database['approval']>>;
  getFindingForApproval(
    approvalId: number,
  ): Promise<Selectable<Database['audit_finding']>>;
};

export async function createInteractionE2eHarness(): Promise<InteractionE2eHarness> {
  const rawDb = new SqliteDb(':memory:');
  rawDb.pragma('foreign_keys = ON');
  const db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: rawDb }),
  });
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
  });
  const { error } = await migrator.migrateToLatest();
  if (error)
    throw error instanceof Error ? error : new Error('Migration failed');

  const root = mkdtempSync(join(tmpdir(), 'interaction-e2e-'));
  const telegramApi = new FakeTelegramApi();
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
    .useValue(db)
    .overrideProvider(DOCUMENT_STORAGE_ROOT)
    .useValue(root)
    .overrideProvider(MastraService)
    .useValue(fauxMastraService)
    .overrideProvider(TelegramApi)
    .useValue(telegramApi)
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  await db
    .insertInto('setting')
    .values({ key: 'telegram_webhook_secret', value: 'sek', updated_at: 0 })
    .execute();
  await db
    .insertInto('setting')
    .values({ key: 'telegram_allowlist', value: '999', updated_at: 0 })
    .execute();
  await db
    .insertInto('setting')
    .values({ key: 'approvers', value: '999', updated_at: 0 })
    .execute();

  const createdToken = await app.get(ApiTokenService).create('interaction-e2e');
  const authorizationHeader = `Bearer ${createdToken.token}`;

  const authorizedPost = (path: string) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', authorizationHeader);

  return {
    app,
    db,
    secretary: app.get(SecretaryAgent),
    telegramApi,
    authorizationHeader,
    root,
    async close(): Promise<void> {
      await app.close();
      await db.destroy();
      rmSync(root, { recursive: true, force: true });
    },
    async seedPrivateApproverChat(): Promise<void> {
      await request(app.getHttpServer())
        .post('/api/channels/telegram/webhook')
        .set('x-telegram-bot-api-secret-token', 'sek')
        .send(approverUpdate)
        .expect(200)
        .expect({ ok: true });
    },
    async forceHoldPolicy(): Promise<void> {
      await db
        .updateTable('policy_config')
        .set({ value: '1' })
        .where('key', '=', 'auto_post_amount_ceiling')
        .execute();
    },
    async createDraftSalesInvoice(
      invoiceNumber: string,
      grossAmount = 200000,
    ): Promise<TestSalesInvoice> {
      const response = await authorizedPost('/api/sales-invoices')
        .send({
          invoice_number: invoiceNumber,
          gross_amount: grossAmount,
          vat_amount: 0,
          currency: 'EUR',
          tax_point_date: '2026-03-15',
        })
        .expect(201);
      return salesInvoiceSchema.parse(response.body);
    },
    async holdSalesInvoice(id: number): Promise<HeldInvoiceResult> {
      const response = await authorizedPost(`/api/sales-invoices/${id}/post`)
        .send({})
        .expect(201);
      return postInvoiceResponseSchema.parse(response.body);
    },
    async getPendingApprovalForInvoice(
      invoiceId: number,
    ): Promise<Selectable<Database['approval']>> {
      return db
        .selectFrom('approval')
        .selectAll()
        .where('object_type', '=', 'sales_invoice')
        .where('object_id', '=', invoiceId)
        .where('status', '=', 'pending')
        .executeTakeFirstOrThrow();
    },
    async getFindingForApproval(
      approvalId: number,
    ): Promise<Selectable<Database['audit_finding']>> {
      return db
        .selectFrom('audit_finding')
        .selectAll()
        .where('finding_type', '=', 'pending_approval')
        .where('referenced_object_type', '=', 'approval')
        .where('referenced_object_id', '=', approvalId)
        .executeTakeFirstOrThrow();
    },
  };
}

export function buildCallbackUpdate(
  approvalId: number,
  callbackQueryId: string,
  senderId: number,
  messageId: number,
  action: 'approve' | 'reject' = 'approve',
): TelegramUpdate {
  return {
    update_id: messageId,
    callback_query: {
      id: callbackQueryId,
      from: { id: senderId },
      message: { message_id: messageId, chat: { id: senderId } },
      data: `${action}:${approvalId}`,
    },
  };
}

export function expectNagForApproval(
  telegramApi: FakeTelegramApi,
  approvalId: number,
  description: string,
): void {
  expect(telegramApi.sentMessages).toEqual([
    {
      chat_id: 999,
      text: `Approval needed — ${description} (approval #${approvalId})`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Approve', callback_data: `approve:${approvalId}` },
            { text: 'Reject', callback_data: `reject:${approvalId}` },
          ],
        ],
      },
    },
  ]);
}
