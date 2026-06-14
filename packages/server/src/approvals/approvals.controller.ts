import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { ApprovalsService } from './approvals.service';
import type { BatchApproveRow } from './approvals.service';
import {
  CreateApprovalDto,
  ApproveDto,
  ApproveBatchDto,
  RejectDto,
  SupersedeDto,
} from './types';
import type { ListApprovalsQuery, Approval } from './types';
import type { PostedVoucher } from '../ledger/voucher/types';

/**
 * ApprovalsController — REST API for the approval lifecycle.
 *
 * POST /api/approvals              — create an approval
 * POST /api/approvals/:id/approve  — approve and post
 * POST /api/approvals/:id/reject   — reject and return to draft
 * POST /api/approvals/:id/supersede — supersede
 * GET  /api/approvals              — list with filters
 * GET  /api/approvals/pending      — list pending
 */
@ApiTags('approvals')
@Controller('api/approvals')
export class ApprovalsController {
  constructor(private readonly approvalsService: ApprovalsService) {}

  @Post()
  @ApiOperation({ summary: 'Create an approval', description: 'Create an approval request for a draft.' })
  async createApproval(
    @Body() dto: CreateApprovalDto,
  ): Promise<{ approval: Approval }> {
    const approval = await this.approvalsService.createApproval(dto);
    return { approval };
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve and post', description: 'Approve the request and post the underlying voucher.' })
  @ApiParam({ name: 'id', description: 'Approval id' })
  async approveApproval(
    @Param('id') id: string,
    @Body() dto: ApproveDto,
  ): Promise<{ approval: Approval; voucher: PostedVoucher | null }> {
    return this.approvalsService.approveApproval(Number(id), dto.approved_by);
  }

  @Post('approve-batch')
  @ApiOperation({
    summary: 'Approve several approvals at once',
    description:
      'Approve a list of pending approvals in one call (e.g. all reconciliation matches on a statement). Each id is processed independently; a failure on one is reported in its result row without aborting the rest.',
  })
  async approveBatch(
    @Body() dto: ApproveBatchDto,
  ): Promise<{ results: BatchApproveRow[] }> {
    const results = await this.approvalsService.approveBatch(
      dto.ids,
      dto.approved_by,
    );
    return { results };
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject an approval', description: 'Reject the request and return the item to draft.' })
  @ApiParam({ name: 'id', description: 'Approval id' })
  async rejectApproval(
    @Param('id') id: string,
    @Body() dto: RejectDto,
  ): Promise<{ approval: Approval }> {
    const approval = await this.approvalsService.rejectApproval(
      Number(id),
      dto.rejected_reason,
    );
    return { approval };
  }

  @Post(':id/supersede')
  @ApiOperation({ summary: 'Supersede an approval', description: 'Supersede an existing approval request.' })
  @ApiParam({ name: 'id', description: 'Approval id' })
  async supersedeApproval(
    @Param('id') id: string,
    @Body() dto: SupersedeDto,
  ): Promise<{ approval: Approval }> {
    const approval = await this.approvalsService.supersedeApproval(
      Number(id),
      Number(dto.superseded_by),
    );
    return { approval };
  }

  @Get()
  @ApiOperation({ summary: 'List approvals', description: 'List approvals, optionally filtered by status and/or object type.' })
  @ApiQuery({ name: 'status', description: 'Filter by approval status', required: false })
  @ApiQuery({ name: 'object_type', description: 'Filter by approved object type', required: false })
  async listApprovals(
    @Query() query: ListApprovalsQuery,
  ): Promise<{ approvals: Approval[] }> {
    const approvals = await this.approvalsService.listApprovals(query);
    return { approvals };
  }

  @Get('pending')
  @ApiOperation({ summary: 'List pending approvals', description: 'List approvals awaiting a decision.' })
  async listPendingApprovals(): Promise<{ approvals: Approval[] }> {
    const approvals = await this.approvalsService.listPendingApprovals();
    return { approvals };
  }
}
