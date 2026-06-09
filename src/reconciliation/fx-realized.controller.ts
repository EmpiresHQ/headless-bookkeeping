import { Controller, Post, Body, Param, ParseIntPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { FXRealizedService, FXRealizedResult } from './fx-realized.service';

/** Request body for manual FX-realized computation. */
export const fxRealizedRequestSchema = z.object({
  voucherId: z.number().int(),
  matchedAmount: z.number().int(),
});

export class FXRealizedRequest extends createZodDto(fxRealizedRequestSchema) {}

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
