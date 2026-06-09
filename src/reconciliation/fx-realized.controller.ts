import { Controller, Post, Body, Param, ParseIntPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { FXRealizedService, FXRealizedResult } from './fx-realized.service';

/** Request body for manual FX-realized computation. */
export interface FXRealizedRequest {
  voucherId: number;
  matchedAmount: number;
}

@ApiTags('reconciliation')
@Controller('api/reconciliation')
export class FXRealizedController {
  constructor(private readonly fxRealizedService: FXRealizedService) {}

  /**
   * Manually trigger realized-FX computation and posting for a match.
   *
   * POST /api/reconciliation/:bankTransactionId/fx-realized
   *
   * Body: { voucherId, matchedAmount }
   *
   * Returns an FXRealizedResult indicating whether an FX voucher was posted,
   * no FX was needed, or data was missing.
   */
  @Post(':bankTransactionId/fx-realized')
  async computeAndPost(
    @Param('bankTransactionId', ParseIntPipe) bankTransactionId: number,
    @Body() body: FXRealizedRequest,
  ): Promise<FXRealizedResult> {
    return this.fxRealizedService.computeAndPost(
      body.voucherId,
      bankTransactionId,
      body.matchedAmount,
    );
  }
}
