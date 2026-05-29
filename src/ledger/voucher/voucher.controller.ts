import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  NotFoundException,
  BadRequestException,
  ConflictException,
  MethodNotAllowedException,
} from '@nestjs/common';
import { PostingService } from '../posting/posting.service';
import { ValidationError } from '../posting/types';
import { VoucherRepository } from './voucher.repository';
import { VoucherLineRepository } from './voucher-line.repository';
import type { DraftVoucher, PostedVoucher, Voucher } from './types';
import { DraftVoucherDto } from './voucher.schema';

@Controller('api/vouchers')
export class VoucherController {
  constructor(
    private readonly postingService: PostingService,
    private readonly voucherRepo: VoucherRepository,
    private readonly lineRepo: VoucherLineRepository,
  ) {}

  @Get()
  async getVouchers(): Promise<{ vouchers: Voucher[] }> {
    return { vouchers: await this.voucherRepo.getVouchers() };
  }

  @Get(':id')
  async getVoucher(@Param('id') id: string): Promise<PostedVoucher> {
    const voucher = await this.voucherRepo.getVoucherById(Number(id));
    if (!voucher) {
      throw new NotFoundException(`Voucher ${id} not found`);
    }
    const lines = await this.lineRepo.getLinesByVoucherId(voucher.id);
    return { ...voucher, lines };
  }

  @Post()
  async postVoucher(@Body() draft: DraftVoucherDto): Promise<PostedVoucher> {
    try {
      return await this.postingService.postVoucher(draft as DraftVoucher);
    } catch (err) {
      if (err instanceof ValidationError) {
        throw new BadRequestException(err.errors);
      }
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(
          `Voucher number ${(draft as DraftVoucher).voucher_number} already exists`,
        );
      }
      throw err;
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Error &&
      err.message.includes('UNIQUE constraint failed') &&
      err.message.includes('voucher_number')
    );
  }

  // Posted vouchers are immutable (ADR-0001, ADR-0006): every mutating verb is
  // rejected at the API boundary with 405. Corrections happen via reversal
  // counter-vouchers (Task 18), never by editing the original.
  @Put(':id')
  updateVoucher(@Param('id') _id: string): never {
    throw new MethodNotAllowedException('Posted vouchers are immutable');
  }

  @Patch(':id')
  patchVoucher(@Param('id') _id: string): never {
    throw new MethodNotAllowedException('Posted vouchers are immutable');
  }

  @Delete(':id')
  deleteVoucher(@Param('id') _id: string): never {
    throw new MethodNotAllowedException('Posted vouchers are immutable');
  }
}
