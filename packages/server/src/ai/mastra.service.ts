import { Injectable } from '@nestjs/common';
import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import { EntitiesService } from '../entities/entities.service';
import { ExpensesService } from '../expenses/expenses.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { OrganizationService } from '../organization/organization.service';
import { AgentConfigService } from './agent-config.service';
import { CategoryService } from '../categories/category.service';
import {
  withCategoryList,
  withOrgIdentity,
  OrgIdentityContext,
} from './triage-instructions';
import {
  createSearchSuppliersTool,
  createListCategoriesTool,
  createGetClassificationMemoryTool,
  createPreviewCategoryMappingTool,
  createGetClassificationContextTool,
} from './tools';

/**
 * MastraService — factory for the kernel's @mastra/core agents.
 *
 * Agents are built ON DEMAND (one per call), NOT cached at boot. Every build
 * re-resolves the model + instructions from AgentConfigService (the settings
 * table), so operator changes to the inference endpoint / model / prompt in
 * Settings take effect on the very next classification or import — no process
 * restart required. (A boot-time singleton froze the config at startup, which
 * meant settings saved after boot were silently ignored.)
 *
 * The triage agent has NO write tools (no post, createDraft, proposeDraft) —
 * all tools are read-only wrappers over kernel services. The bank-mapping agent
 * has no tools at all.
 *
 * The @mastra/* packages are real ESM dependencies, statically imported here and
 * resolved via `require(esm)` at runtime on Node 24. Jest's CJS runtime cannot
 * load them, so the test suite maps the package specifiers to a stub module (see
 * `test/mastra-stub.ts` + the `moduleNameMapper` entries in `package.json` and
 * `test/jest-e2e.json`).
 */
@Injectable()
export class MastraService {
  constructor(
    private readonly entitiesService: EntitiesService,
    private readonly expensesService: ExpensesService,
    private readonly pluginLoader: PluginLoader,
    private readonly organizationService: OrganizationService,
    private readonly config: AgentConfigService,
    private readonly categoryService: CategoryService,
  ) {}

  /**
   * The read-only tool set for the triage agent. Config-independent, so it is
   * rebuilt cheaply on each agent build (the tools are thin wrappers over
   * already-injected services).
   */
  private buildTools(): ToolsInput {
    const searchSuppliers = createSearchSuppliersTool(this.entitiesService);
    const listCategories = createListCategoriesTool(this.categoryService);
    const getClassificationMemory = createGetClassificationMemoryTool(
      this.expensesService,
    );
    const previewCategoryMapping = createPreviewCategoryMappingTool(
      this.pluginLoader,
      this.organizationService,
    );
    // Primary path: one deep read that composes supplier resolve/propose +
    // classification memory + mapping preview (with the memory actually flowing
    // through to the plugin). The granular tools above are retained as a fallback.
    const getClassificationContext = createGetClassificationContextTool(
      this.entitiesService,
      this.expensesService,
      this.pluginLoader,
      this.organizationService,
    );

    return {
      searchSuppliers,
      listCategories,
      getClassificationMemory,
      previewCategoryMapping,
      getClassificationContext,
    };
  }

  private buildEnrichmentTools(): ToolsInput {
    const {
      listCategories,
      getClassificationMemory,
      previewCategoryMapping,
      getClassificationContext,
    } = this.buildTools();

    return {
      listCategories,
      getClassificationMemory,
      previewCategoryMapping,
      getClassificationContext,
    };
  }

  /**
   * Build the Pass-2 triage agent fresh from current settings. Read-only tools,
   * endpoint-aware model config. Throws if the @mastra runtime cannot construct
   * the agent (missing model credentials, ESM load failure) — callers map that
   * to an `agent-unavailable` outcome.
   *
   * @param orgContext - Optional org identity + direction hint. When provided,
   *   the agent instructions are augmented so the LLM knows which organization
   *   issued/received the document and can set `document_type`, `kind`,
   *   `customer_proposal`, and `outgoing_signals` accurately. When absent,
   *   behavior is identical to before this parameter was added.
   */
  async buildTriageAgent(orgContext?: OrgIdentityContext): Promise<Agent> {
    const { instructions } = await this.config.resolve('triage');
    const model = await this.config.resolveModelConfig('triage');
    const categories = await this.categoryService.list();
    const baseInstructions = withCategoryList(instructions, categories);
    const finalInstructions = orgContext
      ? withOrgIdentity(baseInstructions, orgContext)
      : baseInstructions;
    return new Agent({
      id: 'triage-agent',
      name: 'Triage Agent',
      instructions: finalInstructions,
      model,
      tools: this.buildTools(),
    });
  }

  async buildTriageEnrichmentAgent(
    orgContext?: OrgIdentityContext,
  ): Promise<Agent> {
    const instructions =
      await this.config.resolveInstructions('triage_enrichment');
    const model = await this.config.resolveModelConfig('triage_enrichment');
    const categories = await this.categoryService.list();
    const baseInstructions = withCategoryList(instructions, categories);
    const finalInstructions = orgContext
      ? withOrgIdentity(baseInstructions, orgContext)
      : baseInstructions;

    return new Agent({
      id: 'triage-enrichment-agent',
      name: 'Triage Enrichment Agent',
      instructions: finalInstructions,
      model,
      tools: this.buildEnrichmentTools(),
    });
  }

  async buildTriageClassificationAgent(
    orgContext?: OrgIdentityContext,
  ): Promise<Agent> {
    const instructions = await this.config.resolveInstructions(
      'triage_classification',
    );
    const model = await this.config.resolveModelConfig('triage_classification');
    const categories = await this.categoryService.list();
    const baseInstructions = withCategoryList(instructions, categories);
    const finalInstructions = orgContext
      ? withOrgIdentity(baseInstructions, orgContext)
      : baseInstructions;

    return new Agent({
      id: 'triage-classification-agent',
      name: 'Triage Classification Agent',
      instructions: finalInstructions,
      model,
    });
  }

  /**
   * Build the bank-statement CSV-mapping agent fresh from current settings.
   * Tool-less and standalone (it only emits a structured mapping ruleset).
   */
  async buildBankMappingAgent(): Promise<Agent> {
    const instructions = await this.config.resolveInstructions('bank_mapping');
    const model = await this.config.resolveModelConfig('bank_mapping');
    return new Agent({
      id: 'bank-mapping-agent',
      name: 'Bank Mapping Agent',
      instructions,
      model,
    });
  }
}
