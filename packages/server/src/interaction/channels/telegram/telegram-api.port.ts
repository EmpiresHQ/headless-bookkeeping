// src/interaction/channels/telegram/telegram-api.port.ts
import { Injectable, Logger } from '@nestjs/common';
import { TelegramSendPayload } from './telegram.types';

/** The live Bot API edge. Mocked in every test; only the real impl does network I/O. */
export abstract class TelegramApi {
  abstract sendMessage(payload: TelegramSendPayload): Promise<void>;
}

/** Real implementation — uses global fetch (Node 24). Not exercised in unit tests. */
@Injectable()
export class HttpTelegramApi extends TelegramApi {
  private readonly logger = new Logger(HttpTelegramApi.name);

  constructor(private readonly botTokenProvider: () => Promise<string | null>) {
    super();
  }

  async sendMessage(payload: TelegramSendPayload): Promise<void> {
    const token = await this.botTokenProvider();
    if (!token) {
      this.logger.warn('telegram_bot_token unset — dropping outbound message');
      return;
    }
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
}
