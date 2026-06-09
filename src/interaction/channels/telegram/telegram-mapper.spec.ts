// src/interaction/channels/telegram/telegram-mapper.spec.ts
import { toEnvelope, toSendPayload } from './telegram-mapper';
import { TelegramUpdate } from './telegram.types';

const textUpdate: TelegramUpdate = {
  update_id: 1,
  message: {
    message_id: 5,
    chat: { id: 999 },
    from: { id: 999 },
    text: 'invoice acme',
  },
};

const callbackUpdate: TelegramUpdate = {
  update_id: 2,
  callback_query: {
    id: 'c1',
    from: { id: 999 },
    message: { chat: { id: 999 } },
    data: 'approve:42',
  },
};

describe('telegram-mapper', () => {
  it('maps a text message to a verified envelope (transportVerified set by caller=true)', () => {
    const env = toEnvelope(textUpdate, true);
    expect(env.channel).toBe('telegram');
    expect(env.convKey).toBe('tg:999');
    expect(env.message).toBe('invoice acme');
    expect(env.auth).toEqual({ senderId: '999', transportVerified: true });
    expect(env.metadata.callbackData).toBeUndefined();
  });

  it('maps a button tap to a message-less envelope carrying callbackData', () => {
    const env = toEnvelope(callbackUpdate, true);
    expect(env.message).toBeNull();
    expect(env.convKey).toBe('tg:999');
    expect(env.metadata.callbackData).toBe('approve:42');
  });

  it('renders an outbound message to a sendMessage payload', () => {
    const payload = toSendPayload({
      channel: 'telegram',
      convKey: 'tg:999',
      text: 'Which customer?',
    });
    expect(payload).toEqual({ chat_id: 999, text: 'Which customer?' });
  });

  it('renders an action point as an inline keyboard button', () => {
    const payload = toSendPayload({
      channel: 'telegram',
      convKey: 'tg:999',
      text: 'Approve this?',
      actionPoint: { id: 'approve:42', label: 'Approve' },
    });
    expect(payload.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Approve', callback_data: 'approve:42' }]],
    });
  });
});
