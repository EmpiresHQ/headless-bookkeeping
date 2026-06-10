import { Injectable, OnModuleInit } from '@nestjs/common';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import { LibSQLStore } from '@mastra/libsql';
import { EntitiesService } from '../entities/entities.service';
import { ExpensesService } from '../expenses/expenses.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { OrganizationService } from '../organization/organization.service';
import { AgentConfigService } from './agent-config.service';
import {
  createSearchSuppliersTool,
  createListCategoriesTool,
  createGetClassificationMemoryTool,
  createPreviewCategoryMappingTool,
  createGetClassificationContextTool,
} from './tools';

/**
 * MastraService — NestJS provider that wires @mastra/core into the kernel and
 * creates an embedded triage agent with read-only tools.
 *
 * The agent has NO write tools (no post, createDraft, proposeDraft).
 * All tools are read-only wrappers over kernel services.
 *
 * Mastra storage uses SQLite (LibSQL) at ./data/mastra.sqlite.
 *
 * The @mastra/* packages are real ESM dependencies; they are statically
 * imported here and resolved via `require(esm)` at runtime on Node 24. Jest's
 * CJS runtime cannot load them, so the test suite maps the package specifiers
 * to a stub module (see `test/mastra-stub.ts` + the `moduleNameMapper` entries
 * in `package.json` and `test/jest-e2e.json`).
 */
@Injectable()
export class MastraService implements OnModuleInit {
  private mastra: Mastra | null = null;
  private agent: Agent | null = null;

  constructor(
    private readonly entitiesService: EntitiesService,
    private readonly expensesService: ExpensesService,
    private readonly pluginLoader: PluginLoader,
    private readonly organizationService: OrganizationService,
    private readonly config: AgentConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.initialize();
    } catch (err) {
      // Graceful degradation: if the Mastra runtime cannot be constructed
      // (missing model credentials, storage failure, etc.) the agent stays
      // null and Pass2AgentService reports `agent-unavailable` rather than the
      // process failing to boot.
      const msg = `Mastra initialization skipped: ${err instanceof Error ? err.message : String(err)}`;

      console.debug(msg);
    }
  }

  /**
   * Initialize Mastra: build the read-only tools, the LibSQL storage, and the
   * triage agent, then register the agent on a Mastra orchestrator.
   */
  async initialize(): Promise<void> {
    // Create read-only tools.
    const searchSuppliers = createSearchSuppliersTool(this.entitiesService);
    const listCategories = createListCategoriesTool();
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

    const tools: ToolsInput = {
      searchSuppliers,
      listCategories,
      getClassificationMemory,
      previewCategoryMapping,
      getClassificationContext,
    };

    // Configure LibSQL storage for Mastra's operational tables (memory, threads).
    const storage = new LibSQLStore({
      id: 'bookkeeping-mastra-storage',
      url: 'file:./data/mastra.sqlite',
    });

    // Resolve instructions + the full model config (endpoint-aware) from
    // AgentConfigService (settings-backed).
    const triage = await this.config.resolve('triage');
    const triageModel = await this.config.resolveModelConfig('triage');

    // Create the triage agent with read-only tools.
    const triageAgent = new Agent({
      id: 'triage-agent',
      name: 'Triage Agent',
      instructions: triage.instructions,
      model: triageModel,
      tools,
    });

    // Create the Mastra orchestrator.
    this.mastra = new Mastra({
      agents: {
        triageAgent,
      },
      storage,
    });

    this.agent = triageAgent;
  }

  /**
   * Get the Mastra instance.
   * Returns null if not yet initialized.
   */
  getMastra(): Mastra | null {
    return this.mastra;
  }

  /**
   * Get the triage agent.
   * Returns null if not yet initialized.
   */
  getAgent(): Agent | null {
    return this.agent;
  }

  /**
   * Check if Mastra is initialized.
   */
  isInitialized(): boolean {
    return this.mastra !== null && this.agent !== null;
  }
}
