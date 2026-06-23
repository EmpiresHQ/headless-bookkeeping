import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PolicyService } from './policy.service';
import { OverrideRecord } from './types';

/**
 * Read-only controller for override audit records.
 * Overrides are logged atomically with posting (AC-6); there is no
 * free-standing POST endpoint.
 */
@ApiTags('overrides')
@Controller('api/overrides')
export class OverrideController {
  constructor(private readonly policyService: PolicyService) {}

  @Get()
  @ApiOperation({
    summary: 'List policy overrides',
    description: 'Return the policy override audit trail.',
  })
  async getOverrides(): Promise<{ overrides: OverrideRecord[] }> {
    const overrides = await this.policyService.getOverrides();
    return { overrides };
  }
}
