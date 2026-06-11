import { Injectable } from '@nestjs/common';
import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import { EntitiesService } from '../entities/entities.service';
import { ExpensesService } from '../expenses/expenses.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { OrganizationService } from '../organization/organization.service';
import { AgentConfigService } from './agent-config.service';
import { CategoryService } from '../categories/category.service';
import { withCategoryList } from './triage-instructions';
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

  /**
   * Build the Pass-2 triage agent fresh from current settings. Read-only tools,
   * endpoint-aware model config. Throws if the @mastra runtime cannot construct
   * the agent (missing model credentials, ESM load failure) — callers map that
   * to an `agent-unavailable` outcome.
   */
  async buildTriageAgent(): Promise<Agent> {
    const { instructions } = await this.config.resolve('triage');
    const model = await this.config.resolveModelConfig('triage');
    const categories = await this.categoryService.list();
    return new Agent({
      id: 'triage-agent',
      name: 'Triage Agent',
      instructions: withCategoryList(instructions, categories),
      model,
      tools: this.buildTools(),
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
