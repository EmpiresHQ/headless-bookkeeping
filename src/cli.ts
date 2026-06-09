#!/usr/bin/env node
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { hideBin } from 'yargs/helpers';
import { AuthModule } from './auth/auth.module';
import { ApiTokenService } from './auth/api-token.service';
import { buildTokenCli } from './cli/token-cli';

/**
 * Minimal module for the CLI — just AuthModule (which pulls DatabaseModule, so
 * migrations run and the same ./data/app.sqlite is used). Avoids booting the
 * HTTP server, AI runtime and schedulers.
 */
@Module({ imports: [AuthModule] })
class CliModule {}

async function main(): Promise<void> {
  // DatabaseModule logs each migration via console.log (stdout). Route console
  // output to stderr so stdout carries ONLY the command's result — e.g.
  // `TOKEN=$(cli token create)` captures just the token.
  console.log = (...args: unknown[]) => console.error(...args);

  const app = await NestFactory.createApplicationContext(CliModule, {
    logger: ['error'],
  });
  try {
    const tokens = app.get(ApiTokenService);
    await buildTokenCli(tokens, {
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    }).parseAsync(hideBin(process.argv));
  } catch {
    // yargs surfaced a usage/validation error (already written to stderr).
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
