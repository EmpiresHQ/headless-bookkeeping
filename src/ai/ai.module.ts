import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { EntitiesModule } from '../entities/entities.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { PluginsModule } from '../plugins/plugins.module';
import { OrganizationModule } from '../organization/organization.module';
import { PostingPipelineModule } from '../ledger/pipeline/posting-pipeline.module';
import { MastraService } from './mastra.service';
import { ProposeDraftService } from './propose-draft.service';
import { Pass2AgentService } from './pass2-agent.service';

/**
 * AiModule — registers the Mastra runtime + tool layer, the Pass 2 agent
 * service, and the deterministic propose-draft service.
 *
 * MastraService loads @mastra/core via dynamic import() and creates an agent
 * with read-only tools (searchSuppliers, listCategories, getClassificationMemory,
 * previewCategoryMapping). No write tools are exposed.
 *
 * Pass2AgentService runs the Mastra agent over Pass-1 markdown and emits a
 * Zod-validated TriageResult with bounded retry.
 *
 * ProposeDraftService takes a validated TriageResult and runs it through the
 * existing posting pipeline (createExpense → generateDraftVoucher → Rules →
 * Policy → post/hold).
 */
@Module({
  imports: [
    DatabaseModule,
    EntitiesModule,
    ExpensesModule,
    PluginsModule,
    OrganizationModule,
    PostingPipelineModule,
  ],
  providers: [MastraService, ProposeDraftService, Pass2AgentService],
  exports: [MastraService, ProposeDraftService, Pass2AgentService],
})
export class AiModule {}
