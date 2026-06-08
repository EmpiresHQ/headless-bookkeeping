import { Injectable, OnModuleInit } from '@nestjs/common';
import { EntitiesService } from '../entities/entities.service';
import { ExpensesService } from '../expenses/expenses.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { OrganizationService } from '../organization/organization.service';
import {
  createSearchSuppliersTool,
  createListCategoriesTool,
  createGetClassificationMemoryTool,
  createPreviewCategoryMappingTool,
} from './tools';

// Types for the dynamically imported Mastra modules.
type MastraInstance = any;
type AgentInstance = any;

/**
 * MastraService — NestJS provider that loads @mastra/core via dynamic import()
 * and creates an embedded agent with read-only tools.
 *
 * The agent has NO write tools (no post, createDraft, proposeDraft).
 * All tools are read-only wrappers over kernel services.
 *
 * Mastra storage uses SQLite (LibSQL) at ./data/mastra.sqlite.
 */
@Injectable()
export class MastraService implements OnModuleInit {
  private mastra: MastraInstance | null = null;
  private agent: AgentInstance | null = null;

  constructor(
    private readonly entitiesService: EntitiesService,
    private readonly expensesService: ExpensesService,
    private readonly pluginLoader: PluginLoader,
    private readonly organizationService: OrganizationService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.initialize();
  }

  /**
   * Initialize Mastra by dynamically importing @mastra/core.
   * This avoids ESM/CJS conflicts since the project uses CJS with nodenext resolution.
   *
   * Accepts optional overrides for testing (mocked Mastra/Agent/LibSQLStore).
   */
  async initialize(overrides?: {
    MastraClass: any;
    AgentClass: any;
    LibSQLStoreClass: any;
  }): Promise<void> {
    let MastraClass: any;
    let AgentClass: any;
    let LibSQLStoreClass: any;

    if (overrides) {
      ({ MastraClass, AgentClass, LibSQLStoreClass } = overrides);
    } else {
      // Dynamic import to handle ESM module at runtime.
      // Mastra is exported from the main entry; Agent from the agent subpath.
      const [{ Mastra }, { Agent }] = await Promise.all([
        import('@mastra/core'),
        import('@mastra/core/agent'),
      ]);
      const { LibSQLStore } = await import('@mastra/libsql');
      MastraClass = Mastra;
      AgentClass = Agent;
      LibSQLStoreClass = LibSQLStore;
    }

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

    // Configure LibSQL storage for Mastra's operational tables (memory, threads).
    const storage = new LibSQLStoreClass({
      id: 'bookkeeping-mastra-storage',
      url: 'file:./data/mastra.sqlite',
    });

    // Create the triage agent with read-only tools.
    const triageAgent = new AgentClass({
      id: 'triage-agent',
      name: 'Triage Agent',
      instructions:
        'You are a document triage agent for an accounting system. ' +
        'Analyze incoming documents (receipts, invoices) and classify them. ' +
        'Use the available tools to look up suppliers, check categories, ' +
        'review classification memory, and preview category mappings. ' +
        'You are READ-ONLY — you cannot post vouchers or modify the ledger. ' +
        'Always return structured output with kind, document_type, gross_amount, ' +
        'vat_amount, currency, tax_point_date, category, document_vat_marking, ' +
        'confidence, and optionally supplier_proposal.',
      model: 'openai/gpt-4o-mini',
      tools: {
        searchSuppliers,
        listCategories,
        getClassificationMemory,
        previewCategoryMapping,
      },
    });

    // Create the Mastra orchestrator.
    this.mastra = new MastraClass({
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
  getMastra(): MastraInstance | null {
    return this.mastra;
  }

  /**
   * Get the triage agent.
   * Returns null if not yet initialized.
   */
  getAgent(): AgentInstance | null {
    return this.agent;
  }

  /**
   * Check if Mastra is initialized.
   */
  isInitialized(): boolean {
    return this.mastra !== null && this.agent !== null;
  }
}
