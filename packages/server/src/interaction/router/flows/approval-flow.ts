import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import type { Kysely } from 'kysely';
import { ApprovalsService } from '../../../approvals/approvals.service';
import type {
  ApprovalObjectType,
  ApprovalStatus,
} from '../../../approvals/types';
import type { Database } from '../../../database/types';
import { TelegramApprovalSupportService } from '../../telegram-approval-support.service';
import type { DispatchContext, DispatchResult } from '../flow-dispatcher';
import type { RoutedIntent } from '../types';

type ApprovalRecord = {
  readonly id: number;
  readonly object_type: ApprovalObjectType;
  readonly object_id: number;
  readonly status: ApprovalStatus;
};

@Injectable()
export class ApprovalFlow {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly approvalsService: ApprovalsService,
    private readonly telegramApprovalSupport: TelegramApprovalSupportService,
  ) {}

  async dispatch(
    intent: RoutedIntent,
    ctx: DispatchContext,
  ): Promise<DispatchResult> {
    if (
      intent.kind !== 'action' ||
      (intent.actionIntent !== 'approve' && intent.actionIntent !== 'reject')
    ) {
      return { handled: false };
    }

    if (ctx.origin !== 'callback') {
      return {
        handled: true,
        reply:
          'Please use the Telegram Approve or Reject button on the original message.',
        callbackSucceeded: false,
      };
    }

    const approvalId = this.parseApprovalId(intent.fields?.ref);
    if (approvalId === null) {
      return {
        handled: true,
        reply:
          'I need a valid approval id from the Telegram button. Please try again from the original message.',
        callbackSucceeded: false,
      };
    }

    try {
      const approval = await this.getApprovalRecord(approvalId);
      const isPendingApproval = approval.status === 'pending';
      if (isPendingApproval) {
        const telegramApprovable =
          await this.telegramApprovalSupport.isTelegramApprovable(approvalId);
        if (!telegramApprovable) {
          return {
            handled: true,
            reply: this.unsupportedApprovalReply(approval.object_type),
            callbackSucceeded: false,
          };
        }
      }

      switch (intent.actionIntent) {
        case 'approve':
          await this.approvalsService.approveApproval(
            approvalId,
            ctx.principal.senderId,
          );
          return {
            handled: true,
            reply: `Approval ${approvalId} approved.`,
            callbackSucceeded: true,
          };
        case 'reject':
          await this.approvalsService.rejectApproval(
            approvalId,
            'Rejected via Telegram',
          );
          return {
            handled: true,
            reply: `Approval ${approvalId} rejected.`,
            callbackSucceeded: true,
          };
      }
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException
      ) {
        return {
          handled: true,
          reply: error.message,
          callbackSucceeded: false,
        };
      }
      throw error;
    }
  }

  private parseApprovalId(rawRef: string | undefined): number | null {
    if (!rawRef || !/^[1-9]\d*$/.test(rawRef)) {
      return null;
    }

    return Number(rawRef);
  }

  private async getApprovalRecord(id: number): Promise<ApprovalRecord> {
    const approval = await this.db
      .selectFrom('approval')
      .select(['id', 'object_type', 'object_id', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!approval) {
      throw new NotFoundException(`Approval ${id} not found`);
    }

    const objectType = approval.object_type;
    const status = approval.status;
    switch (objectType) {
      case 'expense':
      case 'sales_invoice':
      case 'allowance':
      case 'reconciliation_match':
        switch (status) {
          case 'pending':
          case 'approved':
          case 'rejected':
          case 'superseded':
            return {
              id: approval.id,
              object_type: objectType,
              object_id: approval.object_id,
              status,
            };
          default:
            throw new BadRequestException(
              `Approval ${id} has an unsupported status`,
            );
        }
      default:
        throw new BadRequestException(
          `Approval ${id} has an unsupported object type`,
        );
    }
  }

  private unsupportedApprovalReply(objectType: ApprovalObjectType): string {
    switch (objectType) {
      case 'expense':
        return 'Fixed asset expense approvals cannot be handled in Telegram yet.';
      case 'allowance':
        return 'Allowance approvals cannot be handled in Telegram yet.';
      case 'reconciliation_match':
        return 'Reconciliation approvals cannot be handled in Telegram yet.';
      case 'sales_invoice':
        return 'This approval cannot be handled in Telegram yet.';
    }
  }
}
