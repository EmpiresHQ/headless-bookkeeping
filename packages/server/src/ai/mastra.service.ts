import { Injectable } from '@nestjs/common';
import { Agent } from '@mastra/core/agent';
import { EntitiesService } from '../entities/entities.service';
import { ExpensesService } from '../expenses/expenses.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { OrganizationService } from '../organization/organization.service';
import { AgentConfigService } from './agent-config.service';
import { CategoryService } from '../categories/category.service';
import {
  withCategoryList,
  withDocumentHints,
  withOrgIdentity,
  OrgIdentityContext,
} from './triage-instructions';
import { normalizeIdentifier } from '../entities/identifier-normalization';
import {
  EVIDENCE_CONTRACT,
  CLASSIFICATION_CONTEXT_CONTRACT,
  TriageEvidence,
  TriageContext,
  triageContextSchema,
} from './triage-context';

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
 * Automatic triage uses tool-free evidence extraction and classification.
 * Supplier context is retrieved by the application between those calls. No
 * agent can write business objects or choose whether to execute the lookup.
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

  /** Application-owned lookup. No agent loop and no VAT treatment guessed here. */
  async resolveTriageContext(input: TriageEvidence): Promise<TriageContext> {
    const empty: TriageContext = {
      supplier: { resolution: 'unmatched' },
      classificationMemory: [],
    };
    if (input.kind !== 'new_expense') return empty;
    if (
      !input.category ||
      !(await this.categoryService.isValid(input.category))
    ) {
      throw new Error('Unknown candidate category');
    }
    const key = input.evidence.registrationKey;
    if (!key) return empty;
    const normalizedKey = normalizeIdentifier('registration_key', key);
    if (!normalizedKey) return empty;
    const entity = await this.entitiesService.resolveByIdentifier(
      'registration_key',
      normalizedKey,
    );
    if (!entity) return empty;
    if (input.evidence.country && input.evidence.country !== entity.country) {
      throw new Error('Supplier country contradicts observed evidence');
    }
    return triageContextSchema.parse({
      supplier: {
        resolution: 'matched',
        matchEntityId: entity.id,
        name: entity.name,
        country: entity.country,
      },
      classificationMemory: await this.expensesService.getPostedCategoryHistory(
        entity.id,
      ),
    });
  }

  async buildTriageEnrichmentAgent(
    orgContext?: OrgIdentityContext,
  ): Promise<Agent> {
    const instructions =
      await this.config.resolveInstructions('triage_enrichment');
    const model = await this.config.resolveModelConfig('triage_enrichment');
    const categories = await this.categoryService.list();
    const org = await this.organizationService.getOrganization();
    const plugin = this.pluginLoader.resolve(org.country);
    const withHints = withDocumentHints(
      withCategoryList(instructions, categories),
      plugin.getDocumentClassificationHints(),
    );
    const finalInstructions = orgContext
      ? withOrgIdentity(withHints, orgContext)
      : withHints;

    return new Agent({
      id: 'triage-enrichment-agent',
      name: 'Triage Enrichment Agent',
      instructions: finalInstructions + '\n\n' + EVIDENCE_CONTRACT,
      model,
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
    const org = await this.organizationService.getOrganization();
    const plugin = this.pluginLoader.resolve(org.country);
    const withHints = withDocumentHints(
      withCategoryList(instructions, categories),
      plugin.getDocumentClassificationHints(),
    );
    const finalInstructions = orgContext
      ? withOrgIdentity(withHints, orgContext)
      : withHints;

    return new Agent({
      id: 'triage-classification-agent',
      name: 'Triage Classification Agent',
      instructions:
        finalInstructions + '\n\n' + CLASSIFICATION_CONTEXT_CONTRACT,
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
