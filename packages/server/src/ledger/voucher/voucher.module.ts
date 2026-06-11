import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PostingModule } from '../posting/posting.module';
import { VoucherController } from './voucher.controller';
import { VoucherRepository } from './voucher.repository';
import { VoucherLineRepository } from './voucher-line.repository';

@Module({
  imports: [DatabaseModule, PostingModule],
  controllers: [VoucherController],
  providers: [VoucherRepository, VoucherLineRepository],
  exports: [VoucherRepository, VoucherLineRepository],
})
export class VoucherModule {}
