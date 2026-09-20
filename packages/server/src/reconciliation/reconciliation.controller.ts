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
  OpenItemReconciliation,
} from './reconciliation.types';

@ApiTags('reconciliation')
@Controller('api/bank-statements')
export class ReconciliationController {
  constructor(private readonly service: ReconciliationService) {}

  /**
   * Propose matches for all open transactions in a bank statement.
   * Returns ranked MatchProposalView[] by signal hierarchy.
   */
  @ApiOperation({
    summary: 'Propose matches for a transaction',
    description: 'Suggest candidate ledger matches for a bank transaction.',
  })
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
  @ApiOperation({
    summary: 'Match a transaction',
    description:
      'Confirm a match between a bank transaction and a ledger item.',
  })
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
  @ApiOperation({
    summary: 'List match candidates',
    description: 'Return candidate matches for a transaction.',
  })
  @ApiParam({ name: 'id', description: 'Bank transaction id' })
  @ApiQuery({
    name: 'bankTransactionId',
    description: 'Bank transaction id to fetch candidates for',
  })
  @Get(':id/match-candidates')
  async getMatchCandidates(
    @Param('id', ParseIntPipe) id: number,
    @Query('bankTransactionId', ParseIntPipe) bankTransactionId: number,
  ): Promise<MatchCandidatesResult> {
    return this.service.getMatchCandidates(id, bankTransactionId);
  }

  /** The recorded matches (draft + active) on a statement's lines. */
  @ApiOperation({
    summary: 'List matches',
    description: 'Return confirmed matches for a transaction.',
  })
  @ApiParam({ name: 'id', description: 'Bank transaction id' })
  @Get(':id/matches')
  async listMatches(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<MatchRowView[]> {
    return this.service.listStatementMatches(id);
  }

  /** Per-transaction reconciliation state for a statement (UI badges + caps). */
  @ApiOperation({
    summary: 'Get reconciliation state',
    description: 'Return reconciliation state for a transaction.',
  })
  @ApiParam({ name: 'id', description: 'Bank transaction id' })
  @Get(':id/reconciliation')
  async getStatementReconciliation(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ReconciliationStatusRow[]> {
    return this.service.getStatementReconciliation(id);
  }

  /**
   * The subledger vs AR/AP control reconciliation: every open or over-settled
   * position (including cancelled documents whose payment is owed back), the
   * cash whose settlement was never booked, and the totals that must tie.
   */
  @ApiOperation({
    summary: 'Open-item reconciliation',
    description:
      'Open and over-settled subledger positions against the AR/AP control accounts.',
  })
  @Get('open-items')
  async getOpenItems(): Promise<OpenItemReconciliation> {
    return this.service.getOpenItemReconciliation();
  }

  /**
   * The ACTIVE matches whose settlement was never booked to the ledger — the
   * finite, attributable list behind any AR/AP control-vs-open-items
   * difference (issue #202). Matches activated before migration 070 carry no
   * settlement voucher and none is invented for them; an operator re-books one
   * by unmatching and re-approving it.
   */
  @ApiOperation({
    summary: 'List unposted settlements',
    description:
      'Active cash matches with no settlement voucher in the ledger.',
  })
  @Get('unposted-settlements')
  async listUnpostedSettlements() {
    return this.service.listUnpostedSettlements();
  }

  /**
   * Undo a reconciliation match — deletes the sub-ledger link and reverses the
   * ledger artifacts it posted (its settlement voucher, and its realized-FX
   * voucher if any). The statement id scopes the route; the match id
   * identifies the link.
   */
  @ApiOperation({
    summary: 'Remove a match',
    description: 'Delete a confirmed match.',
  })
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
