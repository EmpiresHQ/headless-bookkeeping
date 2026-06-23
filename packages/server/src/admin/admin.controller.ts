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
import { ApiTags, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Public } from '../auth/api-token.guard';
import { ApiTokenService } from '../auth/api-token.service';
import { AdminService } from './admin.service';

// An absent body (undefined/null) is treated as an empty object so a plain
// POST /admin/tokens with no JSON body still validates.
const createTokenSchema = z.preprocess(
  (v) => v ?? {},
  z.object({ label: z.string().optional() }),
);

export class CreateTokenDto extends createZodDto(createTokenSchema) {}

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
  @ApiOperation({
    summary: 'Create an API token',
    description: 'Mint a new Bearer API token.',
  })
  @Post('tokens')
  @HttpCode(HttpStatus.CREATED)
  async createToken(@Body() body?: CreateTokenDto) {
    return this.apiTokenService.create(body?.label ?? 'api');
  }

  /** GET /admin/tokens — list tokens (metadata only, never the secret). */
  @ApiOperation({
    summary: 'List API tokens',
    description: 'Return all API tokens.',
  })
  @Get('tokens')
  async listTokens() {
    return { tokens: await this.apiTokenService.list() };
  }

  /** POST /admin/tokens/:id/revoke — revoke a token by id. */
  @ApiOperation({
    summary: 'Revoke an API token',
    description: 'Revoke an API token.',
  })
  @ApiParam({ name: 'id', description: 'API token id' })
  @Post('tokens/:id/revoke')
  async revokeToken(@Param('id', ParseIntPipe) id: number) {
    await this.apiTokenService.revoke(id);
    return { id, revoked: true };
  }

  /**
   * GET /admin/accounts — list all accounts with computed balances.
   */
  @ApiOperation({
    summary: 'List accounts (admin)',
    description: 'Return the chart of accounts.',
  })
  @Get('accounts')
  async getAccounts() {
    return this.adminService.getAccountsWithBalances();
  }

  /**
   * GET /admin/vouchers — list vouchers with optional date range.
   */
  @ApiOperation({
    summary: 'List vouchers (admin)',
    description: 'Return vouchers, optionally within a date range.',
  })
  @ApiQuery({
    name: 'from',
    description: 'Start of date range (ISO 8601)',
    required: false,
  })
  @ApiQuery({
    name: 'to',
    description: 'End of date range (ISO 8601)',
    required: false,
  })
  @Get('vouchers')
  async getVouchers(@Query('from') from?: string, @Query('to') to?: string) {
    return this.adminService.getVouchers(from, to);
  }

  /**
   * GET /admin/vouchers/:id — single voucher with lines.
   */
  @ApiOperation({
    summary: 'Get a voucher (admin)',
    description: 'Fetch a single voucher.',
  })
  @ApiParam({ name: 'id', description: 'Voucher id' })
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
  @ApiOperation({
    summary: 'List periods (admin)',
    description: 'Return all reporting periods.',
  })
  @Get('periods')
  async getPeriods() {
    return this.adminService.getPeriods();
  }

  /**
   * POST /admin/periods/:id/lock — lock a reporting period.
   */
  @ApiOperation({
    summary: 'Lock a period (admin)',
    description: 'Lock a reporting period.',
  })
  @ApiParam({ name: 'id', description: 'Reporting period id' })
  @Post('periods/:id/lock')
  async lockPeriod(@Param('id', ParseIntPipe) id: number) {
    return this.adminService.lockPeriod(id);
  }

  /**
   * GET /admin/approvals — list approvals.
   */
  @ApiOperation({
    summary: 'List approvals (admin)',
    description: 'Return approvals, optionally filtered by status.',
  })
  @ApiQuery({
    name: 'status',
    description: 'Filter by approval status',
    required: false,
  })
  @Get('approvals')
  async getApprovals(@Query('status') status?: string) {
    return this.adminService.getApprovals(status);
  }

  /**
   * GET /admin/approvals/pending — list only pending approvals.
   */
  @ApiOperation({
    summary: 'List pending approvals (admin)',
    description: 'Return approvals awaiting a decision.',
  })
  @Get('approvals/pending')
  async getPendingApprovals() {
    return this.adminService.getApprovals('pending');
  }

  /**
   * GET /admin/findings — list audit findings.
   */
  @ApiOperation({
    summary: 'List findings (admin)',
    description: 'Return audit findings, optionally filtered.',
  })
  @ApiQuery({
    name: 'status',
    description: 'Filter by finding status',
    required: false,
  })
  @Get('findings')
  async getFindings(@Query('status') status?: string) {
    return this.adminService.getFindings(status);
  }

  /**
   * GET /admin/findings/open — list only open findings.
   */
  @ApiOperation({
    summary: 'List open findings (admin)',
    description: 'Return unresolved audit findings.',
  })
  @Get('findings/open')
  async getOpenFindings() {
    return this.adminService.getFindings('open');
  }

  /**
   * GET /admin/health — public health check with DB probe.
   */
  @ApiOperation({
    summary: 'Admin health',
    description: 'Return an administrative health summary.',
  })
  @Public()
  @Get('health')
  async getHealth() {
    return this.adminService.getHealth();
  }
}
