import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import type {
  CreateApprovalDto,
  ApproveDto,
  RejectDto,
  SupersedeDto,
  ListApprovalsQuery,
  Approval,
} from './types';
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
@Controller('api/approvals')
export class ApprovalsController {
  constructor(private readonly approvalsService: ApprovalsService) {}

  @Post()
  async createApproval(
    @Body() dto: CreateApprovalDto,
  ): Promise<{ approval: Approval }> {
    const approval = await this.approvalsService.createApproval(dto);
    return { approval };
  }

  @Post(':id/approve')
  async approveApproval(
    @Param('id') id: string,
    @Body() dto: ApproveDto,
  ): Promise<{ approval: Approval; voucher: PostedVoucher | null }> {
    return this.approvalsService.approveApproval(Number(id), dto.approved_by);
  }

  @Post(':id/reject')
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
  async listApprovals(
    @Query() query: ListApprovalsQuery,
  ): Promise<{ approvals: Approval[] }> {
    const approvals = await this.approvalsService.listApprovals(query);
    return { approvals };
  }

  @Get('pending')
  async listPendingApprovals(): Promise<{ approvals: Approval[] }> {
    const approvals = await this.approvalsService.listPendingApprovals();
    return { approvals };
  }
}
