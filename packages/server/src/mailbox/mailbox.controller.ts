import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  InternalServerErrorException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  MailboxConnectorService,
  MailboxConnector,
} from './mailbox-connector.service';
import { OAuthService } from './oauth.service';

@ApiTags('mailbox')
@Controller('api/mailbox')
export class MailboxController {
  constructor(
    private readonly connectors: MailboxConnectorService,
    private readonly oauth: OAuthService,
  ) {}

  @Get('connectors')
  @ApiOperation({ summary: 'List mailbox connectors with health status' })
  list(): Promise<MailboxConnector[]> {
    return this.connectors.list();
  }

  @Post('connectors')
  @ApiOperation({ summary: 'Create an IMAP password connector' })
  async create(
    @Body()
    dto: {
      channel: 'email_sync' | 'email_push';
      provider: 'gmail' | 'outlook' | 'imap';
      host: string;
      port: number;
      username: string;
      secret: string;
      folder?: string;
    },
  ): Promise<MailboxConnector> {
    try {
      return await this.connectors.create({ ...dto, authMode: 'password' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed to create connector';
      // The credential cannot be encrypted without the server key. Nest hides
      // the message of a raw 500, so translate it into an explicit, actionable
      // error the operator actually sees.
      if (/MAILBOX_SECRET_KEY/.test(msg)) {
        throw new InternalServerErrorException(
          'MAILBOX_SECRET_KEY is not configured on the server. Set it to a 32-byte hex value (e.g. `openssl rand -hex 32`) so mailbox credentials can be encrypted at rest, then retry.',
        );
      }
      throw new BadRequestException(msg);
    }
  }

  @Delete('connectors/:id')
  @ApiOperation({ summary: 'Remove a connector' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.connectors.remove(Number(id));
  }

  @Get('oauth/start')
  @ApiOperation({ summary: 'Begin BYO-OAuth consent for a mailbox connector' })
  async start(
    @Query('provider') provider: 'gmail' | 'outlook',
    @Query('channel') channel: 'email_sync' | 'email_push',
  ): Promise<{ url: string }> {
    // The mailbox address is derived from the OAuth identity in the callback —
    // the operator does not type it. We only need provider + channel here.
    const state = Buffer.from(JSON.stringify({ provider, channel })).toString(
      'base64url',
    );
    try {
      return { url: await this.oauth.authUrl(provider, state) };
    } catch (e) {
      // Most commonly: the BYO client id/secret is not configured yet. Surface
      // a 400 with the reason instead of a raw 500.
      throw new BadRequestException(
        e instanceof Error ? e.message : 'OAuth start failed',
      );
    }
  }

  @Get('oauth/callback')
  @ApiOperation({
    summary:
      "OAuth redirect target — exchanges the code, stores the connector, and redirects the browser back to the SPA. This is hit by the user's browser after consent, so it must redirect (not return JSON).",
  })
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const s = JSON.parse(
        Buffer.from(state, 'base64url').toString('utf8'),
      ) as {
        provider: 'gmail' | 'outlook';
        channel: 'email_sync' | 'email_push';
      };
      const { refreshToken, email } = await this.oauth.exchangeCode(
        s.provider,
        code,
      );
      const host =
        s.provider === 'gmail' ? 'imap.gmail.com' : 'outlook.office365.com';
      await this.connectors.create({
        channel: s.channel,
        authMode: 'oauth',
        provider: s.provider,
        host,
        port: 993,
        username: email,
        secret: refreshToken,
      });
      res.redirect('/?mailbox=connected');
    } catch (e) {
      // A bad/expired code, malformed state, or a duplicate email_push must not
      // dump a 500 in the user's browser — bounce back to the SPA with an error.
      const msg = encodeURIComponent(
        e instanceof Error ? e.message : 'oauth failed',
      );
      res.redirect(`/?mailbox_error=${msg}`);
    }
  }
}
