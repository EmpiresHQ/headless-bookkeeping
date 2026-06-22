import {
  Controller,
  Post,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ApiTokenService } from './api-token.service';
import { EnrollmentOnly } from './api-token.guard';
import { SettingsService } from '../admin/settings.service';

const exchangeSchema = z.object({ deviceName: z.string().min(1) });
export class ExchangeDto extends createZodDto(exchangeSchema) {}

@ApiTags('mobile-auth')
@Controller('api')
export class MobileAuthController {
  constructor(
    private readonly apiTokenService: ApiTokenService,
    private readonly settingsService: SettingsService,
  ) {}

  /** POST /api/device-enrollments — mint a one-time QR enrollment token. */
  @ApiOperation({ summary: 'Create a device enrollment token' })
  @Post('device-enrollments')
  @HttpCode(HttpStatus.CREATED)
  async createEnrollment() {
    // Operator-configurable in the SPA (Settings → "public_api_url"); the
    // PUBLIC_API_URL env var is a deployment-level fallback.
    const apiBaseUrl =
      (await this.settingsService.get('public_api_url')) ??
      process.env.PUBLIC_API_URL;
    if (!apiBaseUrl) {
      throw new InternalServerErrorException(
        'Public API URL is not configured — set "public_api_url" in Settings ' +
          '(or the PUBLIC_API_URL env var)',
      );
    }
    const isHttps = apiBaseUrl.startsWith('https://');
    const isLocalDev =
      /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(apiBaseUrl);
    if (!isHttps && !isLocalDev) {
      throw new InternalServerErrorException('Public API URL must use https');
    }
    const { token, expiresAt } = await this.apiTokenService.createEnrollment();
    return {
      apiBaseUrl,
      enrollmentToken: token,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    };
  }

  /** POST /api/mobile/sessions — exchange an enrollment token for a session. */
  @ApiOperation({
    summary: 'Exchange an enrollment token for a mobile session',
  })
  @EnrollmentOnly()
  @Post('mobile/sessions')
  @HttpCode(HttpStatus.CREATED)
  async exchange(
    @Req() req: { apiToken: { token_hash: string } },
    @Body() body: ExchangeDto,
  ) {
    const header = (
      req as unknown as {
        headers: Record<string, string | undefined>;
      }
    ).headers['authorization']!;
    const plaintext = header.slice('Bearer '.length);
    try {
      const { token } = await this.apiTokenService.exchangeEnrollment(
        plaintext,
        body.deviceName,
      );
      return { accessToken: token };
    } catch {
      throw new UnauthorizedException('invalid or expired enrollment token');
    }
  }

  /** POST /api/mobile/sessions/revoke — revoke the calling session token. */
  @ApiOperation({ summary: 'Revoke the current mobile session token' })
  @Post('mobile/sessions/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@Req() req: { apiToken: { id: number } }) {
    await this.apiTokenService.revoke(req.apiToken.id);
  }
}
