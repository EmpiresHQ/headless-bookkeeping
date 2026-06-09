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
import { Public } from '../../../auth/api-token.guard';
import { InteractionConfigService } from '../../config/interaction-config.service';
import { InteractionRouterService } from '../../router/interaction-router.service';
import { AuditLogService } from '../../../audit-log/audit-log.service';
import { toEnvelope } from './telegram-mapper';
import type { TelegramUpdate } from './telegram.types';

@Controller('api/channels/telegram')
export class TelegramWebhookController {
  constructor(
    private readonly config: InteractionConfigService,
    private readonly router: InteractionRouterService,
    private readonly audit: AuditLogService,
  ) {}

  // Telegram has no bearer token; it authenticates via the secret-token header.
  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
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
    const envelope = toEnvelope(update, verified);
    await this.router.handle(envelope);
    return { ok: true };
  }
}
