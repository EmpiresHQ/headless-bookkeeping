import { Writable } from 'node:stream';
import pino from 'pino';
import { LOG_REDACTION } from './log-redaction';

function capture(): { stream: Writable; lines: () => unknown[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as unknown),
  };
}

describe('LOG_REDACTION', () => {
  it('censors credential headers but keeps the rest of the request', () => {
    const out = capture();
    const logger = pino({ redact: LOG_REDACTION }, out.stream);

    logger.info(
      {
        req: {
          method: 'GET',
          url: '/api/expenses',
          headers: {
            authorization: 'Bearer s3cr3t-api-token',
            cookie: 'session=abc',
            'x-telegram-bot-api-secret-token': 'tg-secret',
            'user-agent': 'hbk/0.0.4',
          },
        },
        res: { statusCode: 200, headers: { 'set-cookie': 'session=def' } },
      },
      'request completed',
    );

    const [line] = out.lines() as Array<{
      req: { url: string; headers: Record<string, string> };
      res: { headers: Record<string, string> };
    }>;
    expect(line.req.headers.authorization).toBe('[Redacted]');
    expect(line.req.headers.cookie).toBe('[Redacted]');
    expect(line.req.headers['x-telegram-bot-api-secret-token']).toBe(
      '[Redacted]',
    );
    expect(line.res.headers['set-cookie']).toBe('[Redacted]');
    expect(line.req.headers['user-agent']).toBe('hbk/0.0.4');
    expect(line.req.url).toBe('/api/expenses');
    const raw = JSON.stringify(line);
    for (const secret of [
      's3cr3t-api-token',
      'session=abc',
      'tg-secret',
      'session=def',
    ]) {
      expect(raw).not.toContain(secret);
    }
  });
});
