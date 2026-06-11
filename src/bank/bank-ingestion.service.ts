import { Injectable, Inject, Optional, forwardRef } from '@nestjs/common';
import { MastraService } from '../ai/mastra.service';
import { BankStatementService } from './bank-statement.service';
import { BankImportJobRepository } from './bank-import-job.repository';
import { buildBankIngestionWorkflow } from './bank-ingestion.workflow';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import type { CreateStatementInput } from './bank-statement.types';

@Injectable()
export class BankIngestionService {
  constructor(
    private readonly mastra: MastraService,
    private readonly statements: BankStatementService,
    private readonly jobs: BankImportJobRepository,
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
    csvText: string,
    accountHint: string,
  ): Promise<{ jobId: number }> {
    const job = await this.jobs.create(accountHint);
    // Fire-and-forget: run in the background, never reject the caller.
    void this.process(job.id, csvText, accountHint);
    return { jobId: job.id };
  }

  private async process(
    jobId: number,
    csvText: string,
    accountHint: string,
  ): Promise<void> {
    try {
      const input = await this.runWorkflow(csvText, accountHint);
      const { statement } = await this.statements.createStatement(input);
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
