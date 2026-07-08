// src/interaction/channels/telegram/telegram-mapper.ts
import { UnifiedEnvelope } from '../../envelope/types';
import { OutboundMessage } from '../../transport/types';
import { TelegramSendPayload, TelegramUpdate } from './telegram.types';

/** Pure: a Telegram Update → the channel-agnostic envelope. `transportVerified`
 * is decided by the webhook controller (secret-token check) and passed in. */
export function toEnvelope(
  update: TelegramUpdate,
  transportVerified: boolean,
): UnifiedEnvelope {
  if (update.callback_query) {
    const chatId =
      update.callback_query.message?.chat.id ?? update.callback_query.from.id;
    const senderId = String(update.callback_query.from.id);
    const metadata: Record<string, string> = {};
    if (update.callback_query.data)
      metadata.callbackData = update.callback_query.data;
    return {
      channel: 'telegram',
      sender: senderId,
      convKey: `tg:${chatId}`,
      message: null,
      attachments: [],
      metadata,
      auth: { senderId, transportVerified },
    };
  }
  const msg = update.message;
  const chatId = msg?.chat.id ?? 0;
  const senderId = String(msg?.from?.id ?? chatId);
  return {
    channel: 'telegram',
    sender: senderId,
    convKey: `tg:${chatId}`,
    message: msg?.text ?? null,
    attachments: [],
    metadata: {},
    auth: { senderId, transportVerified },
  };
}

/** Pure: an abstract outbound message → the Telegram sendMessage body. */
export function toSendPayload(out: OutboundMessage): TelegramSendPayload {
  const chatId = Number(out.convKey.replace(/^tg:/, ''));
  const payload: TelegramSendPayload = { chat_id: chatId, text: out.text };
  if (out.actionPoints && out.actionPoints.length > 0) {
    payload.reply_markup = {
      inline_keyboard: [
        out.actionPoints.map((actionPoint) => ({
          text: actionPoint.label,
          callback_data: actionPoint.id,
        })),
      ],
    };
  }
  return payload;
}
