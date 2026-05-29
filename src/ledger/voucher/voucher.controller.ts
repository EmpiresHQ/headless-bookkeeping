import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PostingService } from '../posting/posting.service';
import { ValidationError } from '../posting/types';
import { VoucherRepository } from './voucher.repository';
import { VoucherLineRepository } from './voucher-line.repository';
import type { DraftVoucher, PostedVoucher, Voucher } from './types';

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
  async postVoucher(@Body() draft: DraftVoucher): Promise<PostedVoucher> {
    try {
      return await this.postingService.postVoucher(draft);
    } catch (err) {
      if (err instanceof ValidationError) {
        throw new BadRequestException(err.errors);
      }
      throw err;
    }
  }
}
