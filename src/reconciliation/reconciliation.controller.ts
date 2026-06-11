import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ReconciliationService } from './reconciliation.service';
import { ExecuteMatchInput } from './reconciliation.types';
import type {
  ExecuteMatchResult,
  MatchProposalView,
  ReconciliationStatusRow,
} from './reconciliation.types';

@ApiTags('reconciliation')
@Controller('api/bank-statements')
export class ReconciliationController {
  constructor(private readonly service: ReconciliationService) {}

  /**
   * Propose matches for all open transactions in a bank statement.
   * Returns ranked MatchProposalView[] by signal hierarchy.
   */
  @Post(':id/propose-matches')
  async proposeMatches(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<MatchProposalView[]> {
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
  ): Promise<ExecuteMatchResult> {
    return this.service.executeMatch(input.matches);
  }

  /** Per-transaction reconciliation state for a statement (UI badges + caps). */
  @Get(':id/reconciliation')
  async getStatementReconciliation(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ReconciliationStatusRow[]> {
    return this.service.getStatementReconciliation(id);
  }

  /**
   * Undo a reconciliation match — deletes the sub-ledger link and reverses its
   * realized-FX voucher (if any). The statement id scopes the route; the match
   * id identifies the link.
   */
  @Delete(':id/matches/:matchId')
  async unmatch(
    @Param('id', ParseIntPipe) _id: number,
    @Param('matchId', ParseIntPipe) matchId: number,
  ) {
    return this.service.unmatch(matchId);
  }
}
