import {
  Injectable,
  Inject,
  Optional,
  Logger,
  forwardRef,
} from '@nestjs/common';
import { MastraService } from '../ai/mastra.service';
import { BankStatementService } from './bank-statement.service';
import { BankImportJobRepository } from './bank-import-job.repository';
import { BankMappingProfileRepository } from './bank-mapping-profile.repository';
import { buildBankIngestionWorkflow } from './bank-ingestion.workflow';
import {
  applyRules,
  headerColumns,
  headerSignature,
  sourceFingerprint,
  validateRuleset,
} from './apply-rules';
import type { MappingRuleset } from './bank-mapping.types';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { DocumentStorageService } from '../documents/document-storage.service';
import type { CreateStatementInput } from './bank-statement.types';

/** What the inference workflow returns: rules + the applied statement input. */
export interface BankIngestionWorkflowResult {
  ruleset: MappingRuleset;
  input: CreateStatementInput;
}

@Injectable()
export class BankIngestionService {
  private readonly logger = new Logger(BankIngestionService.name);

  constructor(
    private readonly mastra: MastraService,
    private readonly statements: BankStatementService,
    private readonly jobs: BankImportJobRepository,
    // Durable raw-source storage (issue #403): the SAME storage seam document
    // intake uses — the raw CSV is saved BYTE-EXACT under the BANK'S OWN
    // namespace (`bank-statements/{jobId}/{filename}`, root-relative), so an
    // import job's id can never collide with a real document's id and existing
    // document bytes stay immutable, whichever root this seam owns. Linked
    // from the imported statement's `file_path` — never merely held in
    // workflow memory or a parsed description.
    private readonly storage: DocumentStorageService,
    // Successful mappings, keyed by (account, header signature): a repeat
    // upload of the same bank's export format skips the LLM entirely.
    private readonly profiles: BankMappingProfileRepository,
    // Optional so a bank-only test harness need not wire reconciliation; the
    // forwardRef breaks the Bank↔Reconciliation module cycle.
    @Optional()
    @Inject(forwardRef(() => ReconciliationService))
    private readonly reconciliation?: ReconciliationService,
  ) {}

  /**
   * Overridable seam: run the Mastra workflow (infer → validate → apply) and
   * return both the validated ruleset and the statement input it produced.
   */
  async runWorkflow(
    csvText: string,
    accountHint: string,
  ): Promise<BankIngestionWorkflowResult> {
    // Build the agent on demand so the current settings-backed model + inference
    // endpoint apply to this import (no restart needed after changing Settings).
    const agent = await this.mastra.buildBankMappingAgent();
    const wf = buildBankIngestionWorkflow(agent);
    const run = await wf.createRun();
    const res = await run.start({ inputData: { csvText, accountHint } });
    if (res.status !== 'success') {
      throw new Error(`Ingestion workflow failed: ${res.status}`);
    }
    return res.result as BankIngestionWorkflowResult;
  }

  async startImport(
    // The uploaded CSV: its text (what the workflow parses) AND its ORIGINAL
    // buffer, so the raw source is preserved durably BYTE-EXACT (issue #403:
    // re-encoding the text would mutate the archive — a non-UTF8 byte in an
    // unmapped column must survive verbatim). The import ALWAYS archives its
    // own bank-owned copy — an intake document's lifetime must never govern
    // an imported statement's raw source.
    file: { text: string; buffer: Buffer; filename?: string },
    accountHint: string,
  ): Promise<{ jobId: number }> {
    const job = await this.jobs.create(accountHint);
    // Fire-and-forget: run in the background, never reject the caller.
    void this.process(job.id, file, accountHint);
    return { jobId: job.id };
  }

  private async process(
    jobId: number,
    file: { text: string; buffer: Buffer; filename?: string },
    accountHint: string,
  ): Promise<void> {
    try {
      // The export-format identity. An existing profile means the same bank
      // format already imported successfully: apply its ruleset directly, no
      // LLM. Otherwise infer once, validate it, and only cache it after this
      // import has actually created its statement.
      const headerHash = headerSignature(file.text);
      const stored = await this.profiles.findProfile(accountHint, headerHash);

      let input: CreateStatementInput;
      let inferredRuleset: MappingRuleset | null = null;
      let profileId: number | null = null;
      let mappingSource: 'profile' | 'inferred';

      if (stored) {
        mappingSource = 'profile';
        profileId = stored.id;
        try {
          input = applyRules(stored.ruleset, file.text);
        } catch (e) {
          // Never silently fall back to the LLM: a broken stored profile is the
          // cause, and the operator should reset it (DELETE the profile).
          throw new Error(
            `stored bank mapping profile failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
            { cause: e },
          );
        }
      } else {
        mappingSource = 'inferred';
        const inferred = await this.runWorkflow(file.text, accountHint);
        // The workflow validates too; validating at this seam keeps an
        // overridden/retried seam from handing an unchecked ruleset straight to
        // the import.
        validateRuleset(inferred.ruleset, file.text);
        inferredRuleset = inferred.ruleset;
        input = inferred.input;
      }

      // The authoritative raw-source identity (issue #399): the fingerprint
      // over the ORIGINAL buffer's FULL raw rows — mapped columns or not,
      // byte-preserved (never the lossy UTF-8 re-decode of file.text). It
      // travels with the statement so a merely-similar export (same mapped
      // rows, different unmapped memo) is a DIFFERENT source, never silently
      // collapsed into an "exact replay" of the first.
      const fingerprint = sourceFingerprint(file.buffer);
      // The durable raw source: a BYTE-EXACT, BANK-OWNED archive of the
      // original upload, saved in the bank's own namespace and linked from
      // the statement row. Always the import's own copy — including when the
      // upload arrived as an intake document whose bytes are already stored
      // elsewhere: that document's lifetime is its own (it can be deleted
      // mid-import or after), and the imported statement's raw source must
      // survive it (issue #403's preserve-raw-source acceptance).
      const storagePath = await this.storage.saveNamespacedFile(
        'bank-statements',
        jobId,
        file.filename || 'statement.csv',
        file.buffer,
      );
      const { statement, summary } = await this.statements.createStatement({
        ...input,
        source_fingerprint: fingerprint,
        file_path: storagePath,
      });

      // The import has succeeded (the statement exists), so this mapping is
      // safe to reuse. Best-effort: a profile write must never fail an import.
      await this.rememberMapping({
        jobId,
        accountCode: accountHint,
        headerHash,
        csvText: file.text,
        inferredRuleset,
        profileId,
      });

      await this.jobs.markDone(jobId, statement.id, {
        newCount: summary.newCount,
        knownCount: summary.knownCount,
        conflictCount: summary.conflictCount,
        conflicts: summary.conflicts.map((c) => ({
          id: c.id,
          kind: c.kind,
          external_id: c.external_id,
          statement_id: c.statement_id,
          source_row_number: c.source_row_number,
        })),
        mappingSource,
      });

      // Best-effort: auto-stage unambiguous high-confidence matches as drafts
      // (behind approvals). The import itself has already succeeded, so a
      // failure here must never fail the job.
      try {
        await this.reconciliation?.autoStageStatement(statement.id);
      } catch {
        // Swallow — auto-staging is an optimisation, not part of the import.
      }
    } catch (e) {
      await this.jobs.markFailed(
        jobId,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  /**
   * Record the successful mapping. A newly inferred ruleset is saved for next
   * time; a reused profile is touched. Best-effort by contract: an import that
   * already created its statement must not fail because the cache write did.
   */
  private async rememberMapping(input: {
    jobId: number;
    accountCode: string;
    headerHash: string;
    csvText: string;
    inferredRuleset: MappingRuleset | null;
    profileId: number | null;
  }): Promise<void> {
    try {
      if (input.inferredRuleset) {
        await this.profiles.save({
          accountCode: input.accountCode,
          headerHash: input.headerHash,
          headerColumns: headerColumns(input.csvText),
          ruleset: input.inferredRuleset,
          sourceJobId: input.jobId,
        });
      } else if (input.profileId !== null) {
        await this.profiles.touch(input.profileId);
      }
    } catch (e) {
      this.logger.warn(
        `Could not persist bank mapping profile for import job ${input.jobId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  getImportStatus(jobId: number) {
    return this.jobs.get(jobId);
  }
}
