#!/usr/bin/env node
import { readFileSync as fsReadFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hideBin } from 'yargs/helpers';
import { buildCli, type BuilderDeps, type CliIo } from './builder.js';
import { makeRequest } from './client.js';
import { resolveContext, readConfig } from './config.js';
import { loginCommand } from './commands/login.js';
import { apiCommand } from './commands/api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// openapi.json sits at the package root (one level up from dist/).
const SPEC_PATH = join(__dirname, '..', 'openapi.json');

function readStdinSync(): string {
  try {
    return fsReadFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const spec = JSON.parse(fsReadFileSync(SPEC_PATH, 'utf8'));
  const io: CliIo = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  };

  const argv = hideBin(process.argv);
  const isLogin = argv[0] === 'login';

  const request: BuilderDeps['request'] = async (method, path, args) => {
    const ctx = resolveContext(
      {
        profile: process.env.HBK_PROFILE,
      },
      { HBK_URL: process.env.HBK_URL, HBK_TOKEN: process.env.HBK_TOKEN },
      readConfig(),
    );
    return makeRequest(ctx)(method, path, args);
  };

  const deps: BuilderDeps = {
    request,
    io,
    readFileSync: (p) => fsReadFileSync(p, 'utf8'),
    stdinIsTTY: process.stdin.isTTY ?? false,
    readStdin: readStdinSync,
    exit: (code) => {
      process.exitCode = code;
    },
  };

  const cli = buildCli(spec, deps)
    .command(loginCommand(io))
    .command(apiCommand(deps));

  try {
    await cli.parseAsync(argv);
  } catch {
    if (!isLogin) process.exitCode = process.exitCode || 1;
  }
}

void main();
