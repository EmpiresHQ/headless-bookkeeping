import { Controller, Get, Put, Body } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { OrganizationService } from './organization.service';
import { Organization } from './types';
import type { UpdateOrganizationDto } from './types';

@ApiTags('organization')
@Controller('api/organization')
export class OrganizationController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Get()
  async getOrganization(): Promise<Organization> {
    return this.organizationService.getOrganization();
  }

  @Put()
  async updateOrganization(
    @Body() dto: UpdateOrganizationDto,
  ): Promise<Organization> {
    return this.organizationService.updateOrganization(dto);
  }
}
