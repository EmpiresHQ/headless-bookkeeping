// src/interaction/transport/transport-registry.service.ts
import { Inject, Injectable } from '@nestjs/common';
import {
  InteractionTransport,
  OutboundMessage,
  TransportRegistry,
} from './types';

export const INTERACTION_TRANSPORTS = Symbol('INTERACTION_TRANSPORTS');

@Injectable()
export class TransportRegistryService implements TransportRegistry {
  private readonly byChannel = new Map<string, InteractionTransport>();

  constructor(
    @Inject(INTERACTION_TRANSPORTS) transports: InteractionTransport[],
  ) {
    for (const t of transports) this.byChannel.set(t.channel, t);
  }

  async send(out: OutboundMessage): Promise<void> {
    const transport = this.byChannel.get(out.channel);
    if (!transport) {
      throw new Error(`no transport registered for channel ${out.channel}`);
    }
    await transport.send(out);
  }
}
