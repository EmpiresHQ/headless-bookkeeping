import yargs, { Argv } from 'yargs';
import { Kysely, sql } from 'kysely';
import { Database } from '../database/types';
import { ApiTokenService } from '../auth/api-token.service';
import { OrganizationService } from '../organization/organization.service';
import { ReportingPeriodsService } from '../reporting-periods/reporting-periods.service';
import { ExpensesService } from '../expenses/expenses.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
import { EntitiesService } from '../entities/entities.service';
import { UpdateOrganizationDto } from '../organization/types';

export interface CliIo {
  /** Machine-readable output (token / JSON) → stdout. */
  out: (s: string) => void;
  /** Human-readable notes / usage / errors → stderr. */
  err: (s: string) => void;
}

export interface CliDeps {
  tokens: ApiTokenService;
  organization: OrganizationService;
  periods: ReportingPeriodsService;
  expenses: ExpensesService;
  salesInvoices: SalesInvoicesService;
  entities: EntitiesService;
  db: Kysely<Database>;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/**
 * Build the yargs CLI wired to services + injected IO (unit-testable; no
 * console/process). `create` writes the plaintext token to `out` alone so
 * `TOKEN=$(cli token create)` captures just the token. Parse/validation
 * failures go through `fail`, which writes to `err` and rethrows so
 * `parseAsync` surfaces the error.
 */
export function buildCli(deps: CliDeps, io: CliIo): Argv {
  const {
    tokens,
    organization,
    periods,
    expenses,
    salesInvoices,
    entities,
    db,
  } = deps;

  // Numeric-positional guard reused by the delete subcommands.
  const numericId = (label: string) => (y: Argv) =>
    y.positional('id', { type: 'number', describe: 'id' }).check((argv) => {
      if (!Number.isInteger(argv.id)) {
        throw new Error(`${label} requires a numeric <id>`);
      }
      return true;
    });

  return (
    yargs()
      .scriptName('cli')
      // ── token ────────────────────────────────────────────────────
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
            async () => io.out(json(await tokens.list())),
          )
          .command(
            'revoke <id>',
            'Revoke a token by id',
            (y) =>
              y
                .positional('id', { type: 'number', describe: 'Token id' })
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
      // ── org ──────────────────────────────────────────────────────
      .command('org', 'Configure the organization', (o) =>
        o
          .command(
            'show',
            'Print the current organization',
            (y) => y,
            async () => io.out(json(await organization.getOrganization())),
          )
          .command(
            'set',
            'Update organization fields (only the flags you pass change)',
            (y) =>
              y
                .option('country', {
                  type: 'string',
                  describe: 'ISO-2 country',
                })
                .option('org-type', {
                  choices: ['company', 'sole_proprietor'] as const,
                  describe: 'Legal form',
                })
                .option('vat-registered', {
                  type: 'boolean',
                  describe: 'VAT registration status',
                })
                .option('base-currency', {
                  type: 'string',
                  describe: 'Base currency override (empty string clears it)',
                }),
            async (argv) => {
              const dto: UpdateOrganizationDto = {};
              if (argv.country !== undefined) dto.country = argv.country;
              if (argv.orgType !== undefined) dto.org_type = argv.orgType;
              if (argv.vatRegistered !== undefined)
                dto.vat_registered = argv.vatRegistered;
              if (argv.baseCurrency !== undefined)
                dto.base_currency =
                  argv.baseCurrency === '' ? null : argv.baseCurrency;
              io.out(json(await organization.updateOrganization(dto)));
            },
          )
          .demandCommand(1, 'Specify an org subcommand')
          .strict(),
      )
      // ── period ───────────────────────────────────────────────────
      .command('period', 'Manage reporting periods', (p) =>
        p
          .command(
            'open',
            'Open a reporting period',
            (y) =>
              y
                .option('name', {
                  type: 'string',
                  demandOption: true,
                  describe: 'Period name, e.g. FY2026',
                })
                .option('start', {
                  type: 'string',
                  demandOption: true,
                  describe: 'Start date YYYY-MM-DD',
                })
                .option('end', {
                  type: 'string',
                  demandOption: true,
                  describe: 'End date YYYY-MM-DD',
                }),
            async (argv) =>
              io.out(
                json(
                  await periods.create({
                    name: argv.name,
                    start_date: argv.start,
                    end_date: argv.end,
                  }),
                ),
              ),
          )
          .command(
            'list',
            'List reporting periods',
            (y) => y,
            async () => io.out(json(await periods.list())),
          )
          .command(
            'delete <id>',
            'Delete an EMPTY period (open, no vouchers) — undo a mistake',
            (y) =>
              y
                .positional('id', { type: 'number', describe: 'Period id' })
                .check((argv) => {
                  if (!Number.isInteger(argv.id)) {
                    throw new Error('period delete requires a numeric <id>');
                  }
                  return true;
                }),
            async (argv) => {
              const deleted = await periods.deleteEmptyPeriod(
                argv.id as number,
              );
              io.err(`deleted period id=${deleted.id} (${deleted.name})\n`);
            },
          )
          .demandCommand(1, 'Specify a period subcommand')
          .strict(),
      )
      // ── cleanup: delete draft business objects / unreferenced entities ────
      .command('expense', 'Manage expenses', (e) =>
        e
          .command(
            'delete <id>',
            'Delete a DRAFT expense (junk cleanup)',
            numericId('expense delete'),
            async (argv) => {
              const d = await expenses.deleteDraft(argv.id as number);
              io.err(`deleted expense id=${d.id}\n`);
            },
          )
          .demandCommand(1, 'Specify an expense subcommand')
          .strict(),
      )
      .command('invoice', 'Manage sales invoices', (i) =>
        i
          .command(
            'delete <id>',
            'Delete a DRAFT sales invoice (junk cleanup)',
            numericId('invoice delete'),
            async (argv) => {
              const d = await salesInvoices.deleteDraft(argv.id as number);
              io.err(`deleted invoice id=${d.id} (${d.invoice_number})\n`);
            },
          )
          .demandCommand(1, 'Specify an invoice subcommand')
          .strict(),
      )
      .command('entity', 'Manage counterparties', (en) =>
        en
          .command(
            'delete <id>',
            'Delete an UNREFERENCED entity (junk cleanup)',
            numericId('entity delete'),
            async (argv) => {
              const d = await entities.delete(argv.id as number);
              io.err(`deleted entity id=${d.id} (${d.name})\n`);
            },
          )
          .demandCommand(1, 'Specify an entity subcommand')
          .strict(),
      )
      // ── reset: wipe all data (development only) ──────────────────
      .command(
        'reset',
        'Wipe ALL data from the database — development only, irreversible',
        (y) =>
          y.option('force', {
            type: 'boolean',
            default: false,
            describe: 'Skip confirmation prompt',
          }),
        async (argv) => {
          if (!argv.force) {
            io.err(
              'This will DELETE ALL DATA. Re-run with --force to confirm.\n',
            );
            return;
          }

          await sql`PRAGMA foreign_keys = OFF`.execute(db);

          // Immutability triggers (ADR-0009 vat_report; ADR-0019 posted
          // voucher / voucher_line) RAISE(ABORT) on the DELETEs below. Capture
          // their DDL, drop them for the wipe, then recreate from the captured
          // `sql` in finally so the guards always survive a reset — even if the
          // wipe throws midway.
          const triggers = (
            await sql<{ name: string; sql: string | null }>`
              SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
            `.execute(db)
          ).rows;

          try {
            for (const t of triggers) {
              await sql.raw(`DROP TRIGGER IF EXISTS "${t.name}"`).execute(db);
            }

            // Every table in the schema, alphabetically.
            // Tables to wipe (all business data + operational records).
            // Excludes: account (chart of accounts), setting (config),
            // policy_config (posting policy), organization (tenant identity).
            const ALL_TABLES = [
              'ai_proposal',
              'api_token',
              'approval',
              'artifact',
              'audit_finding',
              'audit_log',
              'bank_import_job',
              'bank_statement',
              'bank_transaction',
              'conversation',
              'conversation_business_object',
              'conversation_document',
              'credit_note',
              'document',
              'document_source',
              'entity',
              'entity_identifier',
              'expense',
              'message',
              'override',
              'reconciliation_match',
              'reporting_period',
              'sales_invoice',
              'vat_report',
              'voucher',
              'voucher_line',
              'voucher_sequence',
            ] as const;

            for (const table of ALL_TABLES) {
              await db.deleteFrom(table).execute();
            }

            io.err('Database reset complete.\n');
          } finally {
            for (const t of triggers) {
              if (t.sql) await sql.raw(t.sql).execute(db);
            }
            await sql`PRAGMA foreign_keys = ON`.execute(db);
          }
        },
      )
      .demandCommand(
        1,
        'Specify a command (token | org | period | expense | invoice | entity | reset)',
      )
      .strict()
      .exitProcess(false)
      .fail((msg, err) => {
        io.err(`${msg || (err && err.message) || 'error'}\n`);
        throw err ?? new Error(msg);
      })
  );
}
