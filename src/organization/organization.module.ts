import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PluginsModule } from '../plugins/plugins.module';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';
import { OrgContextResolver } from './org-context.resolver';

@Module({
  imports: [DatabaseModule, PluginsModule],
  controllers: [OrganizationController],
  providers: [OrganizationService, OrgContextResolver],
  exports: [OrganizationService, OrgContextResolver],
})
export class OrganizationModule {}
