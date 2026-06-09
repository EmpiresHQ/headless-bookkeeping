// src/interaction/channels/telegram/telegram-transport.service.spec.ts
import { TelegramApi } from './telegram-api.port';
import { TelegramTransportService } from './telegram-transport.service';
import { TelegramSendPayload } from './telegram.types';

class FakeTelegramApi implements TelegramApi {
  readonly calls: TelegramSendPayload[] = [];
  sendMessage(payload: TelegramSendPayload): Promise<void> {
    this.calls.push(payload);
    return Promise.resolve();
  }
}

describe('TelegramTransportService', () => {
  it('renders an outbound message and calls the Bot API port', async () => {
    const api = new FakeTelegramApi();
    const transport = new TelegramTransportService(api);
    expect(transport.channel).toBe('telegram');
    await transport.send({
      channel: 'telegram',
      convKey: 'tg:999',
      text: 'hi',
    });
    expect(api.calls).toEqual([{ chat_id: 999, text: 'hi' }]);
  });
});
