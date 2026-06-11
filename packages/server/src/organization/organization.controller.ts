import { Controller, Get, Put, Body } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
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
  async getOrganization(): Promise<Organization> {
    return this.organizationService.getOrganization();
  }

  @Get('period-config')
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
  async updateOrganization(
    @Body() dto: UpdateOrganizationDto,
  ): Promise<Organization> {
    return this.organizationService.updateOrganization(dto);
  }
}
