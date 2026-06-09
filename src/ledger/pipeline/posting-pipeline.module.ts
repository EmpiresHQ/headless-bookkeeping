import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccountModule } from '../account/account.module';
import { PostingModule } from '../posting/posting.module';
import { StatusTransitionModule } from '../status/status-transition.module';
import { RulesModule } from '../../rules/rules.module';
import { PolicyModule } from '../../policy/policy.module';
import { OrganizationModule } from '../../organization/organization.module';
import { PostingPipelineService } from './posting-pipeline.service';

@Module({
  imports: [
    DatabaseModule,
    AccountModule,
    PostingModule,
    StatusTransitionModule,
    RulesModule,
    PolicyModule,
    OrganizationModule,
  ],
  providers: [PostingPipelineService],
  exports: [PostingPipelineService],
})
export class PostingPipelineModule {}
