import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { StatusTransitionService } from './status-transition.service';

/**
 * The deep module that owns business-object status transitions (the guarded
 * transition graph + atomic idempotency claim). See {@link StatusTransitionService}.
 */
@Module({
  imports: [DatabaseModule],
  providers: [StatusTransitionService],
  exports: [StatusTransitionService],
})
export class StatusTransitionModule {}
