import yargs, { Argv } from 'yargs';
import { ApiTokenService } from '../auth/api-token.service';

export interface CliIo {
  /** Machine-readable output (the token on `create`) → stdout. */
  out: (s: string) => void;
  /** Human-readable notes / usage / errors → stderr. */
  err: (s: string) => void;
}

/**
 * Build the yargs CLI for `token` commands, wired to the given service and IO
 * sinks. IO is injected (not console/process) so it is unit-testable; the
 * plaintext token is written to `out` alone so `TOKEN=$(cli token create)`
 * captures just the token. On parse/validation failure the configured `fail`
 * handler writes to `err` and rethrows so `parseAsync` rejects.
 */
export function buildTokenCli(tokens: ApiTokenService, io: CliIo): Argv {
  return yargs()
    .scriptName('cli')
    .command('token', 'Manage API tokens', (t) =>
      t
        .command(
          'create',
          'Mint a new API token; prints the plaintext ONCE to stdout',
          (y) =>
            y.option('label', {
              type: 'string',
              default: 'cli',
              describe: 'Human label for the token',
            }),
          async (argv) => {
            const { id, token } = await tokens.create(argv.label);
            io.out(`${token}\n`);
            io.err(`created token id=${id} label=${argv.label}\n`);
          },
        )
        .command(
          'list',
          'List tokens (id, label, created_at, revoked_at) — never secrets',
          (y) => y,
          async () => {
            io.out(`${JSON.stringify(await tokens.list(), null, 2)}\n`);
          },
        )
        .command(
          'revoke <id>',
          'Revoke a token by id',
          (y) =>
            y
              .positional('id', {
                type: 'number',
                describe: 'Token id to revoke',
              })
              .check((argv) => {
                if (!Number.isInteger(argv.id)) {
                  throw new Error('token revoke requires a numeric <id>');
                }
                return true;
              }),
          async (argv) => {
            await tokens.revoke(argv.id as number);
            io.err(`revoked token id=${argv.id}\n`);
          },
        )
        .demandCommand(1, 'Specify a token subcommand')
        .strict(),
    )
    .demandCommand(1, 'Specify a command')
    .strict()
    .exitProcess(false)
    .fail((msg, err) => {
      io.err(`${msg || (err && err.message) || 'error'}\n`);
      throw err ?? new Error(msg);
    });
}
