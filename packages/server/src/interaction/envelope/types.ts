export type InteractionChannel = 'telegram' | 'email' | 'slack' | 'api';

export interface InboundAttachment {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

/** Normalized authenticity signals lifted out of a channel payload by its adapter. */
export interface EnvelopeAuth {
  /** Email address (email) or Telegram chat id as a string (telegram). */
  senderId: string;
  /** Transport-level proof the sender is who they claim: DKIM+SPF pass (email), secret-token-verified webhook (telegram). */
  transportVerified: boolean;
}

/** The channel-agnostic representation of ONE inbound interaction (ADR-0025). */
export interface UnifiedEnvelope {
  channel: InteractionChannel;
  /** Raw display sender (for the Message record). */
  sender: string;
  /** Channel-scoped thread key → ConversationsService.resolve({ channel, thread_key }). */
  convKey: string;
  /** Text body; null for an attachment-only or a button-tap interaction. */
  message: string | null;
  attachments: InboundAttachment[];
  /** Channel extras the core may read deterministically (e.g. callbackData for a button tap). */
  metadata: Record<string, string>;
  auth: EnvelopeAuth;
}
