import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  ParseIntPipe,
  NotFoundException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/api-token.guard';
import { ApiTokenService } from '../auth/api-token.service';
import { AdminService } from './admin.service';

@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly apiTokenService: ApiTokenService,
  ) {}

  // ── API token management (A1) ────────────────────────────────────
  // No HTTP route existed to provision tokens; the only token was the
  // bootstrap one logged once at first boot. These let an operator mint,
  // list, and revoke tokens over the API (under the same Bearer guard).

  /** POST /admin/tokens — mint a new API token. Plaintext returned ONCE. */
  @Post('tokens')
  @HttpCode(HttpStatus.CREATED)
  async createToken(@Body() body: { label?: string }) {
    return this.apiTokenService.create(body?.label ?? 'api');
  }

  /** GET /admin/tokens — list tokens (metadata only, never the secret). */
  @Get('tokens')
  async listTokens() {
    return { tokens: await this.apiTokenService.list() };
  }

  /** POST /admin/tokens/:id/revoke — revoke a token by id. */
  @Post('tokens/:id/revoke')
  async revokeToken(@Param('id', ParseIntPipe) id: number) {
    await this.apiTokenService.revoke(id);
    return { id, revoked: true };
  }

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
