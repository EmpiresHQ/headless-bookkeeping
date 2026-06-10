import { Injectable } from '@nestjs/common';
import { MastraService } from '../ai/mastra.service';
import { BankStatementService } from './bank-statement.service';
import { BankImportJobRepository } from './bank-import-job.repository';
import { buildBankIngestionWorkflow } from './bank-ingestion.workflow';
import type { CreateStatementInput } from './bank-statement.types';

@Injectable()
export class BankIngestionService {
  constructor(
    private readonly mastra: MastraService,
    private readonly statements: BankStatementService,
    private readonly jobs: BankImportJobRepository,
  ) {}

  /** Overridable seam: run the Mastra workflow and return the validated input. */
  async runWorkflow(
    csvText: string,
    accountHint: string,
  ): Promise<CreateStatementInput> {
    const agent = this.mastra.getBankMappingAgent();
    if (!agent)
      throw new Error('Bank mapping agent unavailable (AI not configured)');
    const wf = buildBankIngestionWorkflow(agent);
    const run = await wf.createRun();
    const res = await run.start({ inputData: { csvText, accountHint } });
    if (res.status !== 'success') {
      throw new Error(`Ingestion workflow failed: ${res.status}`);
    }
    return res.result as CreateStatementInput;
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
