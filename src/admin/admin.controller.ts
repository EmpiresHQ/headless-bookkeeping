import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  ParseIntPipe,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { AdminKeyGuard, Public } from './admin-key.guard';
import { AdminService } from './admin.service';

@Controller('admin')
@UseGuards(AdminKeyGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  /**
   * GET /admin/accounts — list all accounts with computed balances.
   */
  @Get('accounts')
  async getAccounts() {
    return this.adminService.getAccountsWithBalances();
  }

  /**
   * GET /admin/vouchers — list vouchers with optional date range.
   */
  @Get('vouchers')
  async getVouchers(@Query('from') from?: string, @Query('to') to?: string) {
    return this.adminService.getVouchers(from, to);
  }

  /**
   * GET /admin/vouchers/:id — single voucher with lines.
   */
  @Get('vouchers/:id')
  async getVoucher(@Param('id', ParseIntPipe) id: number) {
    const voucher = await this.adminService.getVoucherWithLines(id);
    if (!voucher) {
      throw new NotFoundException(`Voucher ${id} not found`);
    }
    return voucher;
  }

  /**
   * GET /admin/periods — list all reporting periods.
   */
  @Get('periods')
  async getPeriods() {
    return this.adminService.getPeriods();
  }

  /**
   * POST /admin/periods/:id/lock — lock a reporting period.
   */
  @Post('periods/:id/lock')
  async lockPeriod(@Param('id', ParseIntPipe) id: number) {
    return this.adminService.lockPeriod(id);
  }

  /**
   * GET /admin/approvals — list approvals.
   */
  @Get('approvals')
  async getApprovals(@Query('status') status?: string) {
    return this.adminService.getApprovals(status);
  }

  /**
   * GET /admin/approvals/pending — list only pending approvals.
   */
  @Get('approvals/pending')
  async getPendingApprovals() {
    return this.adminService.getApprovals('pending');
  }

  /**
   * GET /admin/findings — list audit findings.
   */
  @Get('findings')
  async getFindings(@Query('status') status?: string) {
    return this.adminService.getFindings(status);
  }

  /**
   * GET /admin/findings/open — list only open findings.
   */
  @Get('findings/open')
  async getOpenFindings() {
    return this.adminService.getFindings('open');
  }

  /**
   * GET /admin/health — public health check with DB probe.
   */
  @Public()
  @Get('health')
  async getHealth() {
    return this.adminService.getHealth();
  }
}
