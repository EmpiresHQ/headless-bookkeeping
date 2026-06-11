export type PrincipalRole = 'approver' | 'known_counterparty' | 'unknown';

/** Who the core decides an inbound interaction is from (ADR-0025). */
export interface Principal {
  role: PrincipalRole;
  /** True only when the channel's transport proved authenticity AND the sender is an approver. */
  authVerified: boolean;
  senderId: string;
}
