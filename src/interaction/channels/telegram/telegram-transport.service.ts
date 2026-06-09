// src/interaction/channels/telegram/telegram-transport.service.ts
import { Injectable } from '@nestjs/common';
import { InteractionChannel } from '../../envelope/types';
import { InteractionTransport, OutboundMessage } from '../../transport/types';
import { TelegramApi } from './telegram-api.port';
import { toSendPayload } from './telegram-mapper';

@Injectable()
export class TelegramTransportService implements InteractionTransport {
  readonly channel: InteractionChannel = 'telegram';

  constructor(private readonly api: TelegramApi) {}

  async send(out: OutboundMessage): Promise<void> {
    await this.api.sendMessage(toSendPayload(out));
  }
}
