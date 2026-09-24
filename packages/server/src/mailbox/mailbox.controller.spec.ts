import { Reflector } from '@nestjs/core';
import { BadRequestException } from '@nestjs/common';
import {
  CreateImapConnectorDto,
  MailboxController,
} from './mailbox.controller';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
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
  let worker: { connectAndSync: jest.Mock };
  let controller: MailboxController;
  let res: { redirect: jest.Mock };

  beforeEach(() => {
    connectors = { create: jest.fn().mockResolvedValue({ id: 1 }) };
    oauth = {
      exchangeCode: jest
        .fn()
        .mockResolvedValue({ refreshToken: 'rt', email: 'me@gmail.com' }),
    };
    worker = { connectAndSync: jest.fn().mockResolvedValue(undefined) };
    controller = new MailboxController(
      connectors as never,
      oauth as never,
      worker as never,
    );
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

// The global ZodValidationPipe (main.ts) is the HTTP boundary for create():
// an invalid port must be a 400 before the controller ever stores a row.
describe('MailboxController.create body validation (issue #376)', () => {
  const pipe = new ZodValidationPipe();
  const validate = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: CreateImapConnectorDto });
  const body = {
    channel: 'email_sync',
    provider: 'imap',
    host: 'imap.example.com',
    port: 993,
    username: 'me@example.com',
    secret: 's3cret',
    folder: 'INBOX',
  };

  it('accepts a valid IMAP connector body', () => {
    expect(validate(body)).toEqual(body);
    expect(validate({ ...body, port: 1 })).toMatchObject({ port: 1 });
    expect(validate({ ...body, port: 65535 })).toMatchObject({ port: 65535 });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['out of range', 65536],
    ['fractional', 993.5],
    ['empty string', ''],
    ['numeric string', '993'],
    ['null', null],
    ['missing', undefined],
  ])('rejects a %s port with a 400 naming the field', (_label, port) => {
    let err: unknown;
    try {
      validate({ ...body, port });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toHaveProperty('port');
  });

  it('rejects a blank host or username', () => {
    expect(() => validate({ ...body, host: '  ' })).toThrow(
      BadRequestException,
    );
    expect(() => validate({ ...body, username: '' })).toThrow(
      BadRequestException,
    );
  });
});
