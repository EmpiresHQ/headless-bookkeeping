import { Injectable } from '@nestjs/common';
import { InteractionConfigService } from '../config/interaction-config.service';
import { UnifiedEnvelope } from '../envelope/types';
import { Principal, PrincipalRole } from './types';

@Injectable()
export class PrincipalResolverService {
  constructor(private readonly config: InteractionConfigService) {}

  async resolve(envelope: UnifiedEnvelope): Promise<Principal> {
    const senderId = envelope.auth.senderId;
    const approvers = await this.approverSetFor(envelope.channel);
    const role: PrincipalRole = approvers.has(senderId)
      ? 'approver'
      : 'unknown';
    // known_counterparty resolution (a known Entity email) lands with the email
    // adapter in 8c; telegram has no counterparties.
    const authVerified = role === 'approver' && envelope.auth.transportVerified;
    return { role, authVerified, senderId };
  }

  private async approverSetFor(channel: string): Promise<Set<string>> {
    const approvers = await this.config.getApprovers();
    if (channel === 'telegram') {
      const allowlist = await this.config.getTelegramAllowlist();
      // approver ⊆ allowlist: a telegram approver must be on both.
      return new Set([...approvers].filter((id) => allowlist.has(id)));
    }
    return approvers;
  }
}
