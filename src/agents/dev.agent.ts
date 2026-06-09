import { Injectable } from '@nestjs/common';

/**
 * DevAgent — stub, disabled by default.
 *
 * Future role: developer-facing diagnostic agent (schema introspection,
 * ledger health checks, test data generation). Not active in production
 * deployments.
 *
 * Enabled via environment variable DEV_AGENT_ENABLED=true.
 */
@Injectable()
export class DevAgent {
  /**
   * Check whether this agent should be active.
   * Returns false by default — set DEV_AGENT_ENABLED=true to enable.
   */
  isEnabled(): boolean {
    return process.env.DEV_AGENT_ENABLED === 'true';
  }

  // TODO: implement developer diagnostic tools
}
