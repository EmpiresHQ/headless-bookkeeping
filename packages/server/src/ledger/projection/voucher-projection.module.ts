import { Module } from '@nestjs/common';
import { OrganizationModule } from '../../organization/organization.module';
import { PluginsModule } from '../../plugins/plugins.module';
import { CurrencyModule } from '../../currency/currency.module';
import { VoucherProjectionService } from './voucher-projection.service';

/**
 * The deep projection module (ADR-0006): given a business object's economic
 * facts + direction, produce the balanced draft Voucher. Expense, SalesInvoice
 * and the corrections-preview path are all thin adapters over it.
 */
@Module({
  imports: [OrganizationModule, PluginsModule, CurrencyModule],
  providers: [VoucherProjectionService],
  exports: [VoucherProjectionService],
})
export class VoucherProjectionModule {}
