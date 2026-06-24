#!/usr/bin/env node
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { hideBin } from 'yargs/helpers';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { AuthModule } from './auth/auth.module';
import { OrganizationModule } from './organization/organization.module';
import { ReportingPeriodsModule } from './reporting-periods/reporting-periods.module';
import { ExpensesModule } from './expenses/expenses.module';
import { SalesInvoicesModule } from './sales-invoices/sales-invoices.module';
import { EntitiesModule } from './entities/entities.module';
import { DocumentsModule } from './documents/documents.module';
import { DatabaseModule } from './database/database.module';
import { ApiTokenService } from './auth/api-token.service';
import { OrganizationService } from './organization/organization.service';
import { ReportingPeriodsService } from './reporting-periods/reporting-periods.service';
import { ExpensesService } from './expenses/expenses.service';
import { SalesInvoicesService } from './sales-invoices/sales-invoices.service';
import { EntitiesService } from './entities/entities.service';
import { DocumentsService } from './documents/documents.service';
import { buildCli } from './cli/cli';

/**
 * Minimal module for the CLI — the DB-backed modules the commands need (each
 * pulls DatabaseModule, so migrations run and the same ./data/app.sqlite is
 * used). Avoids booting the HTTP server, AI runtime and schedulers.
 */
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    OrganizationModule,
    ReportingPeriodsModule,
    ExpensesModule,
    SalesInvoicesModule,
    EntitiesModule,
    DocumentsModule,
  ],
})
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
    await buildCli(
      {
        tokens: app.get(ApiTokenService),
        organization: app.get(OrganizationService),
        periods: app.get(ReportingPeriodsService),
        expenses: app.get(ExpensesService),
        salesInvoices: app.get(SalesInvoicesService),
        entities: app.get(EntitiesService),
        documents: app.get(DocumentsService),
        db: app.get(KYSELY_MODULE_CONNECTION_TOKEN()),
      },
      {
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
      },
    ).parseAsync(hideBin(process.argv));
  } catch (err) {
    // yargs writes usage/validation errors to stderr itself; surface anything
    // else (DI wiring, runtime failures) so a command never dies silently.
    if (err)
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
