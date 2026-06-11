// src/interaction/transport/transport-registry.service.spec.ts
import {
  TransportRegistry,
  InteractionTransport,
  OutboundMessage,
} from './types';
import { TransportRegistryService } from './transport-registry.service';

class FakeTransport implements InteractionTransport {
  readonly channel = 'telegram' as const;
  readonly sent: OutboundMessage[] = [];
  send(out: OutboundMessage): Promise<void> {
    this.sent.push(out);
    return Promise.resolve();
  }
}

describe('TransportRegistryService', () => {
  it('routes an outbound message to the transport for its channel', async () => {
    const tg = new FakeTransport();
    const registry: TransportRegistry = new TransportRegistryService([tg]);
    await registry.send({
      channel: 'telegram',
      convKey: 'tg:999',
      text: 'hello',
    });
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toBe('hello');
  });

  it('throws for a channel with no registered transport', async () => {
    const registry: TransportRegistry = new TransportRegistryService([]);
    await expect(
      registry.send({ channel: 'slack', convKey: 'x', text: 'y' }),
    ).rejects.toThrow(/no transport/i);
  });
});
