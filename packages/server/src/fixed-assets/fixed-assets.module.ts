import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { OrganizationModule } from '../organization/organization.module';
import { PluginsModule } from '../plugins/plugins.module';
import { FixedAssetRegistrarService } from './fixed-asset-registrar.service';

@Module({
  imports: [DatabaseModule, OrganizationModule, PluginsModule],
  providers: [FixedAssetRegistrarService],
  exports: [FixedAssetRegistrarService],
})
export class FixedAssetsModule {}
