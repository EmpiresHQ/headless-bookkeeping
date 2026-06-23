import {
  Body,
  Controller,
  Delete,
  Get,
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
  create(
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
    return this.connectors.create({ ...dto, authMode: 'password' });
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
    @Query('host') host: string,
    @Query('username') username: string,
  ): Promise<{ url: string }> {
    const state = Buffer.from(
      JSON.stringify({ provider, channel, host, username }),
    ).toString('base64url');
    return { url: await this.oauth.authUrl(provider, state) };
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
        host: string;
        username: string;
      };
      const { refreshToken } = await this.oauth.exchangeCode(s.provider, code);
      await this.connectors.create({
        channel: s.channel,
        authMode: 'oauth',
        provider: s.provider,
        host: s.host,
        port: 993,
        username: s.username,
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
