import { Controller, Get, Put, Body } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { OrganizationService } from './organization.service';
import { Organization } from './types';
import type { UpdateOrganizationDto } from './types';
import { PluginLoader } from '../plugins/plugin-loader.service';

@ApiTags('organization')
@Controller('api/organization')
export class OrganizationController {
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly pluginLoader: PluginLoader,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Get the organization',
    description: 'Return the organization profile.',
  })
  async getOrganization(): Promise<Organization> {
    return this.organizationService.getOrganization();
  }

  @Get('period-config')
  @ApiOperation({
    summary: 'Get reporting-period config',
    description: 'Return the reporting-period configuration.',
  })
  async getPeriodConfig(): Promise<{
    frequency_options: string[];
    default_frequency: string;
  }> {
    const org = await this.organizationService.getOrganization();
    const plugin = this.pluginLoader.resolve(org.country);
    return {
      frequency_options: plugin.getPeriodFrequencyOptions(),
      default_frequency: plugin.getDefaultPeriodFrequency(),
    };
  }

  @Put()
  @ApiOperation({
    summary: 'Update the organization',
    description: 'Update the organization profile.',
  })
  async updateOrganization(
    @Body() dto: UpdateOrganizationDto,
  ): Promise<Organization> {
    return this.organizationService.updateOrganization(dto);
  }
}
