import { MailboxController } from './mailbox.controller';
import type { Response } from 'express';

const makeState = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj)).toString('base64url');

describe('MailboxController.callback (OAuth redirect)', () => {
  let connectors: { create: jest.Mock };
  let oauth: { exchangeCode: jest.Mock };
  let controller: MailboxController;
  let res: { redirect: jest.Mock };

  beforeEach(() => {
    connectors = { create: jest.fn().mockResolvedValue({ id: 1 }) };
    oauth = {
      exchangeCode: jest.fn().mockResolvedValue({ refreshToken: 'rt' }),
    };
    controller = new MailboxController(
      connectors as never,
      oauth as never,
    );
    res = { redirect: jest.fn() };
  });

  it('exchanges the code, creates an oauth connector, and redirects to the SPA', async () => {
    const state = makeState({
      provider: 'gmail',
      channel: 'email_sync',
      host: 'imap.gmail.com',
      username: 'me@gmail.com',
    });

    await controller.callback('auth-code', state, res as unknown as Response);

    expect(oauth.exchangeCode).toHaveBeenCalledWith('gmail', 'auth-code');
    expect(connectors.create).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'email_sync',
        authMode: 'oauth',
        provider: 'gmail',
        username: 'me@gmail.com',
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
});
