import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { EcbFxRateSource } from './ecb-fx-rate.source';
import { FxRateService } from './fx-rate.service';
import { FxProvenanceAuditController } from './fx-provenance-audit.controller';
import { FxProvenanceAuditService } from './fx-provenance-audit.service';
import { FX_RATE_SOURCE } from './fx-rate.types';

/**
 * The FX rate seam (issue #203).
 *
 * {@link FX_RATE_SOURCE} is the ONE boundary at which authoritative rates
 * enter the system. Production binds it to the live ECB endpoint; a test binds
 * it to a deterministic fixture via `.overrideProvider(FX_RATE_SOURCE)`. There
 * is deliberately no "use fixed rates" flag inside the production code — a
 * test constant reachable from a production build is exactly the defect #203
 * exists to remove.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [FxProvenanceAuditController],
  providers: [
    FxProvenanceAuditService,
    EcbFxRateSource,
    { provide: FX_RATE_SOURCE, useExisting: EcbFxRateSource },
    FxRateService,
  ],
  exports: [FX_RATE_SOURCE, FxRateService, FxProvenanceAuditService],
})
export class FxModule {}
