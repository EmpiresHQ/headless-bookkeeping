// src/interaction/transport/types.ts
import { InteractionChannel } from '../envelope/types';

/** An abstract commit step the user must take (rendered per channel: TG button / email YES). */
export interface ActionPoint {
  id: string;
  label: string;
}

export interface OutboundMessage {
  channel: InteractionChannel;
  convKey: string;
  text: string;
  actionPoints?: ActionPoint[];
}

/** One channel's outbound edge. Implemented by each adapter (e.g. TelegramTransport). */
export interface InteractionTransport {
  readonly channel: InteractionChannel;
  send(out: OutboundMessage): Promise<void>;
}

/** Resolves the right transport for an outbound message's channel. */
export interface TransportRegistry {
  send(out: OutboundMessage): Promise<void>;
}
