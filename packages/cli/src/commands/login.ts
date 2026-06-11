import type { CommandModule } from 'yargs';
import type { CliIo } from '../builder.js';
import { readConfig, upsertProfile, writeConfig } from '../config.js';

export interface LoginArgs {
  url: string;
  token: string;
  profile?: string;
}

export interface LoginDeps {
  /** Returns the HTTP status of GET {url}/admin/tokens with the Bearer token. */
  validate: (url: string, token: string) => Promise<number>;
  saveProfile: (name: string, baseUrl: string, token: string) => void;
  io: CliIo;
}

/** Core login logic; returns the process exit code. */
export async function runLogin(
  args: LoginArgs,
  deps: LoginDeps,
): Promise<number> {
  const name = args.profile ?? 'default';
  const status = await deps.validate(args.url, args.token);
  if (status !== 200) {
    deps.io.err(`Token rejected by ${args.url} (HTTP ${status}).\n`);
    return 1;
  }
  deps.saveProfile(name, args.url, args.token);
  deps.io.err(`Logged in to ${args.url} as profile "${name}".\n`);
  return 0;
}

/** Default validator: a real network call to the guarded admin endpoint. */
async function defaultValidate(url: string, token: string): Promise<number> {
  const res = await fetch(`${url.replace(/\/$/, '')}/admin/tokens`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.status;
}

/** yargs command module wiring runLogin to real IO + disk. */
export function loginCommand(io: CliIo): CommandModule {
  return {
    command: 'login',
    describe: 'Store and validate a base URL + API token as a profile',
    builder: (y) =>
      y
        .option('url', {
          type: 'string',
          demandOption: true,
          describe: 'Server base URL',
        })
        .option('token', {
          type: 'string',
          demandOption: true,
          describe: 'API token',
        })
        .option('profile', {
          type: 'string',
          default: 'default',
          describe: 'Profile name',
        }),
    handler: async (argv) => {
      const code = await runLogin(
        {
          url: argv.url as string,
          token: argv.token as string,
          profile: argv.profile as string,
        },
        {
          validate: defaultValidate,
          saveProfile: (name, baseUrl, token) =>
            writeConfig(upsertProfile(readConfig(), name, { baseUrl, token })),
          io,
        },
      );
      if (code !== 0) process.exitCode = code;
    },
  };
}
