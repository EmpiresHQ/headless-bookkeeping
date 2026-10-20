import { Injectable, Inject, Optional, forwardRef } from '@nestjs/common';
import { MastraService } from '../ai/mastra.service';
import { BankStatementService } from './bank-statement.service';
import { BankImportJobRepository } from './bank-import-job.repository';
import { buildBankIngestionWorkflow } from './bank-ingestion.workflow';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { DocumentStorageService } from '../documents/document-storage.service';
import type { CreateStatementInput } from './bank-statement.types';

@Injectable()
export class BankIngestionService {
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
    // Optional so a bank-only test harness need not wire reconciliation; the
    // forwardRef breaks the Bank↔Reconciliation module cycle.
    @Optional()
    @Inject(forwardRef(() => ReconciliationService))
    private readonly reconciliation?: ReconciliationService,
  ) {}

  /** Overridable seam: run the Mastra workflow and return the validated input. */
  async runWorkflow(
    csvText: string,
    accountHint: string,
  ): Promise<CreateStatementInput> {
    // Build the agent on demand so the current settings-backed model + inference
    // endpoint apply to this import (no restart needed after changing Settings).
    const agent = await this.mastra.buildBankMappingAgent();
    const wf = buildBankIngestionWorkflow(agent);
    const run = await wf.createRun();
    const res = await run.start({ inputData: { csvText, accountHint } });
    if (res.status !== 'success') {
      throw new Error(`Ingestion workflow failed: ${res.status}`);
    }
    return res.result;
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
      const input = await this.runWorkflow(file.text, accountHint);
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
      const { statement } = await this.statements.createStatement({
        ...input,
        file_path: storagePath,
      });
      await this.jobs.markDone(jobId, statement.id);

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

  getImportStatus(jobId: number) {
    return this.jobs.get(jobId);
  }
}
