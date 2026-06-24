import { Reflector } from '@nestjs/core';
import { MailboxController } from './mailbox.controller';
import { IS_PUBLIC_KEY } from '../auth/api-token.guard';
import type { Response } from 'express';

const makeState = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj)).toString('base64url');

describe('MailboxController.callback auth', () => {
  it('is a public route (the provider redirects the browser here with no Bearer token)', () => {
    const isPublic = new Reflector().get<boolean>(
      IS_PUBLIC_KEY,
      MailboxController.prototype.callback,
    );
    expect(isPublic).toBe(true);
  });
});

describe('MailboxController.callback (OAuth redirect)', () => {
  let connectors: { create: jest.Mock };
  let oauth: { exchangeCode: jest.Mock };
  let controller: MailboxController;
  let res: { redirect: jest.Mock };

  beforeEach(() => {
    connectors = { create: jest.fn().mockResolvedValue({ id: 1 }) };
    oauth = {
      exchangeCode: jest
        .fn()
        .mockResolvedValue({ refreshToken: 'rt', email: 'me@gmail.com' }),
    };
    controller = new MailboxController(connectors as never, oauth as never);
    res = { redirect: jest.fn() };
  });

  it('exchanges the code, derives the mailbox from the OAuth identity, and redirects to the SPA', async () => {
    const state = makeState({ provider: 'gmail', channel: 'email_sync' });

    await controller.callback('auth-code', state, res as unknown as Response);

    expect(oauth.exchangeCode).toHaveBeenCalledWith('gmail', 'auth-code');
    expect(connectors.create).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'email_sync',
        authMode: 'oauth',
        provider: 'gmail',
        host: 'imap.gmail.com',
        username: 'me@gmail.com', // from the OAuth id_token, not user input
        secret: 'rt',
      }),
    );
    expect(res.redirect).toHaveBeenCalledWith('/?mailbox=connected');
  });

  it('redirects back with an error (no 500) when the code exchange fails', async () => {
    oauth.exchangeCode.mockRejectedValue(new Error('bad code'));
    const state = makeState({
      provider: 'gmail',
      channel: 'email_sync',
      host: 'h',
      username: 'u',
    });

    await controller.callback('x', state, res as unknown as Response);

    expect(connectors.create).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/?mailbox_error=bad%20code');
  });

  it('redirects back with an error on malformed state (no 500)', async () => {
    await controller.callback(
      'x',
      'not-valid-base64-json',
      res as unknown as Response,
    );

    expect(res.redirect).toHaveBeenCalledTimes(1);
    expect(res.redirect.mock.calls[0][0]).toMatch(/^\/\?mailbox_error=/);
  });

  const passwordDto = {
    channel: 'email_sync' as const,
    provider: 'imap' as const,
    host: 'imap.x',
    port: 993,
    username: 'me@x',
    secret: 's',
  };

  it('translates a missing MAILBOX_SECRET_KEY into a clear, actionable error', async () => {
    connectors.create.mockRejectedValue(
      new Error('MAILBOX_SECRET_KEY is not set'),
    );
    await expect(controller.create(passwordDto)).rejects.toThrow(
      /MAILBOX_SECRET_KEY is not configured/i,
    );
  });

  it('surfaces other create failures as a 400 with the reason', async () => {
    connectors.create.mockRejectedValue(
      new Error('UNIQUE constraint failed: mailbox_connector.channel'),
    );
    await expect(controller.create(passwordDto)).rejects.toThrow(/UNIQUE/);
  });
});
