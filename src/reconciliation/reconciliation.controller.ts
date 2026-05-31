import {
  Controller,
  Post,
  Body,
  Param,
  ParseIntPipe,
} from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';
import type { ExecuteMatchInput, MatchProposal, ReconciliationMatchRecord } from './reconciliation.types';

@Controller('api/bank-statements')
export class ReconciliationController {
  constructor(private readonly service: ReconciliationService) {}

  /**
   * Propose matches for all open transactions in a bank statement.
   * Returns ranked MatchProposal[] by signal hierarchy.
   */
  @Post(':id/propose-matches')
  async proposeMatches(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<MatchProposal[]> {
    return this.service.proposeMatches(id);
  }

  /**
   * Execute proposed matches by creating reconciliation_match records.
   * Does NOT auto-post settlement vouchers.
   */
  @Post(':id/match')
  async executeMatch(
    @Param('id', ParseIntPipe) _id: number,
    @Body() input: ExecuteMatchInput,
  ): Promise<ReconciliationMatchRecord[]> {
    return this.service.executeMatch(input.matches);
  }
}
