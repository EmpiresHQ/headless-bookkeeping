/* eslint-disable @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unsafe-assignment */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { EntitiesService } from '../entities/entities.service';
import { ExpensesService } from '../expenses/expenses.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { OrganizationService } from '../organization/organization.service';
import {
  createSearchSuppliersTool,
  createListCategoriesTool,
  createGetClassificationMemoryTool,
  createPreviewCategoryMappingTool,
  createGetClassificationContextTool,
} from './tools';

// Types for the dynamically imported Mastra modules.
// These are opaque runtime values from dynamic ESM imports.

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
    @InjectKysely() private readonly db: Kysely<Database>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.initialize();
    } catch (err) {
      // Graceful degradation: in test environments (Jest without
      // --experimental-vm-modules) dynamic ESM imports fail. Tests that
      // mock Pass2AgentService directly never need the real Mastra runtime.
      const msg = `Mastra initialization skipped: ${err instanceof Error ? err.message : String(err)}`;

      console.debug(msg);
    }
  }

  /**
   * Initialize Mastra by dynamically importing @mastra/core.
   * This avoids ESM/CJS conflicts since the project uses CJS with nodenext resolution.
   *
   * Accepts optional overrides for testing (mocked Mastra/Agent/LibSQLStore).
   */
  async initialize(overrides?: {
    MastraClass: new (...args: any[]) => any;

    AgentClass: new (...args: any[]) => any;

    LibSQLStoreClass: new (...args: any[]) => any;
  }): Promise<void> {
    let MastraClass: new (...args: any[]) => any;

    let AgentClass: new (...args: any[]) => any;

    let LibSQLStoreClass: new (...args: any[]) => any;

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
    // Primary path: one deep read that composes supplier resolve/propose +
    // classification memory + mapping preview (with the memory actually flowing
    // through to the plugin). The granular tools above are retained as a fallback.
    const getClassificationContext = createGetClassificationContextTool(
      this.entitiesService,
      this.expensesService,
      this.pluginLoader,
      this.organizationService,
    );

    // Configure LibSQL storage for Mastra's operational tables (memory, threads).
    const storage = new LibSQLStoreClass({
      id: 'bookkeeping-mastra-storage',
      url: 'file:./data/mastra.sqlite',
    });

    // Resolve model from settings table (propagated via NestJS Kysely module).
    const settingRow = await this.db
      .selectFrom('setting')
      .select('value')
      .where('key', '=', 'ai_model')
      .executeTakeFirst();
    const model = settingRow?.value ?? 'openai/gpt-4o-mini';

    // Create the triage agent with read-only tools.
    const triageAgent = new AgentClass({
      id: 'triage-agent',
      name: 'Triage Agent',
      instructions:
        'You are a document triage agent for an accounting system. ' +
        'Analyze incoming documents (receipts, invoices) and classify them. ' +
        'Call listCategories to see the available categories, then call ' +
        'getClassificationContext ONCE with the supplier evidence and your ' +
        'candidate category — it resolves or proposes the supplier, gathers its ' +
        'classification memory (an advisory prior, not a rule), and previews the ' +
        'account + VAT code mapping in a single read. Prefer it over chaining ' +
        'searchSuppliers, getClassificationMemory, and previewCategoryMapping ' +
        '(those remain available as fallbacks). ' +
        'You are READ-ONLY — you cannot post vouchers or modify the ledger. ' +
        'Always return structured output with kind, document_type, gross_amount, ' +
        'vat_amount, currency, tax_point_date, category, document_vat_marking, ' +
        'confidence, and optionally supplier_proposal.',
      model,
      tools: {
        searchSuppliers,
        listCategories,
        getClassificationMemory,
        previewCategoryMapping,
        getClassificationContext,
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
