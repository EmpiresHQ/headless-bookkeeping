import yargs, { Argv } from 'yargs';
import { ApiTokenService } from '../auth/api-token.service';
import { OrganizationService } from '../organization/organization.service';
import { ReportingPeriodsService } from '../reporting-periods/reporting-periods.service';
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
  const { tokens, organization, periods } = deps;

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
          .demandCommand(1, 'Specify a period subcommand')
          .strict(),
      )
      .demandCommand(1, 'Specify a command (token | org | period)')
      .strict()
      .exitProcess(false)
      .fail((msg, err) => {
        io.err(`${msg || (err && err.message) || 'error'}\n`);
        throw err ?? new Error(msg);
      })
  );
}
