import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { OrganizationModule } from '../organization/organization.module';
import { PluginsModule } from '../plugins/plugins.module';
import { PostingModule } from '../ledger/posting/posting.module';
import { AccountModule } from '../ledger/account/account.module';
import { FixedAssetRegistrarService } from './fixed-asset-registrar.service';
import { FixedAssetsService } from './fixed-assets.service';

@Module({
  imports: [DatabaseModule, OrganizationModule, PluginsModule, PostingModule, AccountModule],
  providers: [FixedAssetRegistrarService, FixedAssetsService],
  exports: [FixedAssetRegistrarService, FixedAssetsService],
})
export class FixedAssetsModule {}
