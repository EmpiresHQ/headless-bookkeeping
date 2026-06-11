import type { CommandModule } from 'yargs';
import { readBody, type BuilderDeps } from '../builder.js';

export type ApiDeps = BuilderDeps;

export interface ApiArgs {
  method: string;
  path: string;
  'body-file'?: string;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** Core raw-request logic. */
export async function runApi(args: ApiArgs, deps: ApiDeps): Promise<void> {
  const body = readBody(args as unknown as Record<string, unknown>, deps);
  const res = await deps.request(args.method.toLowerCase(), args.path, { body });
  if (res.ok) deps.io.out(json(res.body));
  else {
    deps.io.err(json(res.body));
    deps.exit(1);
  }
}

/** yargs command module for `hbk api <method> <path>`. */
export function apiCommand(deps: ApiDeps): CommandModule {
  return {
    command: 'api <method> <path>',
    describe: 'Raw request: hbk api <get|post|...> <path> [--body-file | stdin]',
    builder: (y) =>
      y
        .positional('method', { type: 'string', demandOption: true })
        .positional('path', { type: 'string', demandOption: true })
        .option('body-file', { type: 'string', describe: 'JSON body file (or pipe via stdin)' }),
    handler: async (argv) =>
      runApi(
        {
          method: argv.method as string,
          path: argv.path as string,
          'body-file': argv['body-file'] as string | undefined,
        },
        deps,
      ),
  };
}
