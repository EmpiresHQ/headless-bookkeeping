import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { ReconciliationService } from './reconciliation.service';
import { ExecuteMatchInput } from './reconciliation.types';
import type {
  ExecuteMatchResult,
  MatchProposalView,
  ReconciliationStatusRow,
  MatchCandidatesResult,
  MatchRowView,
} from './reconciliation.types';

@ApiTags('reconciliation')
@Controller('api/bank-statements')
export class ReconciliationController {
  constructor(private readonly service: ReconciliationService) {}

  /**
   * Propose matches for all open transactions in a bank statement.
   * Returns ranked MatchProposalView[] by signal hierarchy.
   */
  @ApiOperation({ summary: 'Propose matches for a transaction', description: 'Suggest candidate ledger matches for a bank transaction.' })
  @ApiParam({ name: 'id', description: 'Bank transaction id' })
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
  @ApiOperation({ summary: 'Match a transaction', description: 'Confirm a match between a bank transaction and a ledger item.' })
  @ApiParam({ name: 'id', description: 'Bank transaction id' })
  @Post(':id/match')
  async executeMatch(
    @Param('id', ParseIntPipe) _id: number,
    @Body() input: ExecuteMatchInput,
  ): Promise<ExecuteMatchResult> {
    return this.service.executeMatch(input.matches);
  }

  /**
   * Open business objects a bank line can be manually matched against, plus the
   * line's remaining unallocated amount. Direction is derived from the line.
   */
  @ApiOperation({ summary: 'List match candidates', description: 'Return candidate matches for a transaction.' })
  @ApiParam({ name: 'id', description: 'Bank transaction id' })
  @ApiQuery({ name: 'bankTransactionId', description: 'Bank transaction id to fetch candidates for' })
  @Get(':id/match-candidates')
  async getMatchCandidates(
    @Param('id', ParseIntPipe) id: number,
    @Query('bankTransactionId', ParseIntPipe) bankTransactionId: number,
  ): Promise<MatchCandidatesResult> {
    return this.service.getMatchCandidates(id, bankTransactionId);
  }

  /** The recorded matches (draft + active) on a statement's lines. */
  @ApiOperation({ summary: 'List matches', description: 'Return confirmed matches for a transaction.' })
  @ApiParam({ name: 'id', description: 'Bank transaction id' })
  @Get(':id/matches')
  async listMatches(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<MatchRowView[]> {
    return this.service.listStatementMatches(id);
  }

  /** Per-transaction reconciliation state for a statement (UI badges + caps). */
  @ApiOperation({ summary: 'Get reconciliation state', description: 'Return reconciliation state for a transaction.' })
  @ApiParam({ name: 'id', description: 'Bank transaction id' })
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
  @ApiOperation({ summary: 'Remove a match', description: 'Delete a confirmed match.' })
  @ApiParam({ name: 'id', description: 'Bank transaction id' })
  @ApiParam({ name: 'matchId', description: 'Match id' })
  @Delete(':id/matches/:matchId')
  async unmatch(
    @Param('id', ParseIntPipe) _id: number,
    @Param('matchId', ParseIntPipe) matchId: number,
  ) {
    return this.service.unmatch(matchId);
  }
}
