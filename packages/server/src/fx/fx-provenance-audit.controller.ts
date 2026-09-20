import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  FxProvenanceAuditService,
  FxProvenanceAudit,
} from './fx-provenance-audit.service';

@ApiTags('fx')
@Controller('api')
export class FxProvenanceAuditController {
  constructor(private readonly service: FxProvenanceAuditService) {}

  /**
   * GET /api/fx/provenance-audit
   *
   * Read-only. Nothing here posts, corrects or annotates a voucher.
   */
  @Get('fx/provenance-audit')
  @ApiOperation({
    summary: 'Assess the FX provenance of posted voucher lines (read-only)',
    description:
      'Groups every posted voucher line booked at a rate other than 1 by ' +
      'currency, rate and rate source. Lines with a NULL source were posted ' +
      'before FX provenance was recorded (issue #203) and cannot be traced to ' +
      'a publication; a single such rate repeated across several tax-point ' +
      'dates is flagged as suspected date-blind. This endpoint MUTATES ' +
      'NOTHING: posted vouchers are immutable, so a rate found to be wrong is ' +
      'corrected by reversal and re-posting through the corrections flow, not ' +
      'by editing history. A rate outside the flagged population is not ' +
      'thereby verified — it is only unflagged.',
  })
  assess(): Promise<FxProvenanceAudit> {
    return this.service.assess();
  }
}
