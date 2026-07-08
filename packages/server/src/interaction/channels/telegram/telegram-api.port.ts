// src/interaction/channels/telegram/telegram-api.port.ts
import { Injectable, Logger } from '@nestjs/common';
import { TelegramSendPayload } from './telegram.types';

/** The live Bot API edge. Mocked in every test; only the real impl does network I/O. */
export abstract class TelegramApi {
  abstract sendMessage(payload: TelegramSendPayload): Promise<void>;

  abstract setWebhook(url: string, secretToken: string): Promise<void>;

  abstract answerCallbackQuery(callbackQueryId: string): Promise<void>;

  abstract editMessageReplyMarkup(
    chatId: number,
    messageId: number,
  ): Promise<void>;
}

/** Real implementation — uses global fetch (Node 24). Not exercised in unit tests. */
@Injectable()
export class HttpTelegramApi extends TelegramApi {
  private readonly logger = new Logger(HttpTelegramApi.name);

  constructor(private readonly botTokenProvider: () => Promise<string | null>) {
    super();
  }

  async sendMessage(payload: TelegramSendPayload): Promise<void> {
    await this.callMethod('sendMessage', payload);
  }

  async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.callMethod('setWebhook', {
      url,
      secret_token: secretToken,
    });
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    await this.callMethod('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
    });
  }

  async editMessageReplyMarkup(
    chatId: number,
    messageId: number,
  ): Promise<void> {
    await this.callMethod('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  }

  private async callMethod(method: string, payload: object): Promise<void> {
    const token = await this.botTokenProvider();
    if (!token) {
      this.logger.warn(
        'telegram_bot_token unset — dropping telegram bot api call',
      );
      return;
    }
    await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
}
