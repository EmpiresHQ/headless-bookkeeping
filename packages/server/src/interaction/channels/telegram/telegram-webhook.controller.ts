// src/interaction/channels/telegram/telegram-webhook.controller.ts
import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../auth/api-token.guard';
import { InteractionConfigService } from '../../config/interaction-config.service';
import { InteractionRouterService } from '../../router/interaction-router.service';
import { AuditLogService } from '../../../audit-log/audit-log.service';
import { TelegramApi } from './telegram-api.port';
import { toEnvelope } from './telegram-mapper';
import type { TelegramUpdate } from './telegram.types';

@ApiTags('interaction')
@Controller('api/channels/telegram')
export class TelegramWebhookController {
  constructor(
    private readonly config: InteractionConfigService,
    private readonly router: InteractionRouterService,
    private readonly audit: AuditLogService,
    private readonly telegramApi: TelegramApi,
  ) {}

  // Telegram has no bearer token; it authenticates via the secret-token header.
  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Telegram webhook',
    description: 'Inbound Telegram update webhook (channel ingestion).',
  })
  async handle(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: TelegramUpdate,
  ): Promise<{ ok: true }> {
    const expected = await this.config.getTelegramWebhookSecret();
    const verified = !!expected && secret === expected;
    if (!verified) {
      await this.audit.record({
        actor: 'unknown',
        action: 'interaction.webhook.auth_failed',
        outcome: 'denied',
        detail: { channel: 'telegram' },
      });
      throw new ForbiddenException('invalid telegram secret token');
    }
    // reached only when verified === true (we 403'd above); the envelope is thus transport-verified.
    const callbackQuery = update.callback_query;
    if (callbackQuery) {
      await Promise.allSettled([
        this.telegramApi.answerCallbackQuery(callbackQuery.id),
      ]);
    }
    const envelope = toEnvelope(update, verified);
    const outcome = await this.router.handle(envelope);
    if (callbackQuery?.message && outcome.callbackSucceeded) {
      await Promise.allSettled([
        this.telegramApi.editMessageReplyMarkup(
          callbackQuery.message.chat.id,
          callbackQuery.message.message_id,
        ),
      ]);
    }
    return { ok: true };
  }
}
