import { Controller, Get, Put, Body } from '@nestjs/common';
import { PolicyService } from './policy.service';
import { PolicyConfig } from './types';

/**
 * Operator surface for the risk-gate configuration (A3). Previously the
 * policy_config table had no HTTP route, so auto-post thresholds could only be
 * read/changed at deploy time. Guarded by the global Bearer guard.
 */
@Controller('api/policy-config')
export class PolicyConfigController {
  constructor(private readonly policyService: PolicyService) {}

  /** GET /api/policy-config — the fully-resolved active configuration. */
  @Get()
  async getConfig(): Promise<PolicyConfig> {
    return this.policyService.getConfig();
  }

  /** PUT /api/policy-config — update one or more config keys; returns the result. */
  @Put()
  async updateConfig(
    @Body() patch: Partial<PolicyConfig>,
  ): Promise<PolicyConfig> {
    return this.policyService.updateConfig(patch);
  }
}
