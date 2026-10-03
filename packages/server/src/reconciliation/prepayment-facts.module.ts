import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PrepaymentAllocationRepository } from './prepayment-allocation.repository';

/**
 * The advance/allocation/refund RECORDS on their own, without the
 * reconciliation services that write them.
 *
 * The reporting side needs to read what an advance IS (issue #213) — a filing
 * cannot be frozen while a customer receipt in the period is unclassified, and
 * the advance documents belong in the KMD INF assembly. Importing the whole
 * {@link ReconciliationModule} to read two tables would drag the bank and
 * posting graph into the report path (and back again, since reconciliation
 * already forward-references bank). This module exposes only the repository,
 * which depends on the database and nothing else.
 */
@Module({
  imports: [DatabaseModule],
  providers: [PrepaymentAllocationRepository],
  exports: [PrepaymentAllocationRepository],
})
export class PrepaymentFactsModule {}
