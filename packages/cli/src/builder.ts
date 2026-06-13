import yargs, { type Argv } from 'yargs';
import type { RequestFn } from './client.js';

export interface OptionSpec {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  choices?: string[];
  describe?: string;
}

export interface CommandSpec {
  group: string;
  action: string;
  method: string;
  path: string;
  positionals: string[];
  options: OptionSpec[];
  hasBody: boolean;
  summary?: string;
  description?: string;
}

interface RawParam {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  schema?: { type?: string; enum?: string[] };
  description?: string;
}

interface RawOperation {
  tags?: string[];
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: RawParam[];
  requestBody?: { content?: Record<string, unknown> };
}

export interface OpenApiSpec {
  paths: Record<string, Record<string, RawOperation>>;
  tags?: { name: string; description?: string }[];
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** camelCase / PascalCase / ALLCAPS runs → kebab-case. */
export function kebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/** `ExpensesController_createExpense` → `create-expense`. */
export function actionFromOperationId(operationId: string): string {
  const underscore = operationId.indexOf('_');
  const name =
    underscore >= 0 ? operationId.slice(underscore + 1) : operationId;
  return kebab(name);
}

function optionType(schemaType?: string): OptionSpec['type'] {
  if (schemaType === 'integer' || schemaType === 'number') return 'number';
  if (schemaType === 'boolean') return 'boolean';
  return 'string';
}

/** Turn the OpenAPI spec into a flat list of command descriptors. */
export function specToCommands(spec: OpenApiSpec): CommandSpec[] {
  const commands: CommandSpec[] = [];

  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;

      const tag = op.tags?.[0] ?? 'misc';
      const params = op.parameters ?? [];
      const positionals = params
        .filter((p) => p.in === 'path')
        .map((p) => p.name);
      const options = params
        .filter((p) => p.in === 'query')
        .map<OptionSpec>((p) => ({
          name: p.name,
          type: optionType(p.schema?.type),
          required: p.required ?? false,
          choices: p.schema?.enum,
          describe: p.description,
        }));

      commands.push({
        group: kebab(tag),
        action: op.operationId
          ? actionFromOperationId(op.operationId)
          : kebab(`${method}-${path.replace(/[/{}]/g, '-')}`),
        method,
        path,
        positionals,
        options,
        hasBody: op.requestBody !== undefined,
        summary: op.summary,
        description: op.description,
      });
    }
  }
  return commands;
}

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface BuilderDeps {
  request: RequestFn;
  io: CliIo;
  readFileSync: (path: string) => string;
  stdinIsTTY: boolean;
  readStdin: () => string;
  exit: (code: number) => void;
}

interface BodyDeps {
  readFileSync: (path: string) => string;
  stdinIsTTY: boolean;
  readStdin: () => string;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/**
 * Resolve a JSON request body from --body-file, else from piped stdin (when
 * stdin is not a TTY), else undefined.
 */
export function readBody(
  argv: Record<string, unknown>,
  deps: BodyDeps,
): unknown {
  const file = argv['body-file'] as string | undefined;
  if (file) return JSON.parse(deps.readFileSync(file));
  if (!deps.stdinIsTTY) {
    const piped = deps.readStdin();
    if (piped.trim().length > 0) return JSON.parse(piped);
  }
  return undefined;
}

function yargsType(t: OptionSpec['type']): 'string' | 'number' | 'boolean' {
  return t;
}

/** Build the full yargs CLI from the OpenAPI spec and injected dependencies. */
export function buildCli(spec: OpenApiSpec, deps: BuilderDeps): Argv {
  const commands = specToCommands(spec);
  const byGroup = new Map<string, CommandSpec[]>();
  for (const cmd of commands) {
    const list = byGroup.get(cmd.group) ?? [];
    list.push(cmd);
    byGroup.set(cmd.group, list);
  }

  const tagDescriptions = new Map<string, string>();
  for (const t of spec.tags ?? []) {
    if (t.description) tagDescriptions.set(kebab(t.name), t.description);
  }

  let cli = yargs().scriptName('hbk');
  // Route yargs's built-in logger (used for --help / --version output) through
  // the injected io.out so help text is fully testable without touching
  // process.stdout. getInternalMethods() is a stable but UNTYPED yargs escape
  // hatch (@types/yargs does not declare it), so we cast; if it breaks on a
  // yargs major upgrade, pipe stdout in the test harness instead.
  (
    cli as unknown as {
      getInternalMethods(): {
        getLoggerInstance(): { log: (s: string) => void };
      };
    }
  )
    .getInternalMethods()
    .getLoggerInstance().log = deps.io.out;

  for (const [group, cmds] of byGroup) {
    const groupDescribe = tagDescriptions.get(group) ?? `${group} operations`;
    cli = cli.command(group, groupDescribe, (g) => {
      let sub = g;
      for (const cmd of cmds) {
        const positional = cmd.positionals.map((p) => `<${p}>`).join(' ');
        const commandString = positional
          ? `${cmd.action} ${positional}`
          : cmd.action;

        sub = sub.command(
          commandString,
          cmd.summary ?? `${cmd.method.toUpperCase()} ${cmd.path}`,
          (y) => {
            let yy = y;
            for (const name of cmd.positionals) {
              yy = yy.positional(name, { type: 'string', demandOption: true });
            }
            for (const opt of cmd.options) {
              yy = yy.option(opt.name, {
                type: yargsType(opt.type),
                demandOption: opt.required,
                choices: opt.choices,
                describe: opt.describe,
              });
            }
            if (cmd.hasBody) {
              yy = yy.option('body-file', {
                type: 'string',
                describe:
                  'Path to a JSON request body (or pipe JSON via stdin)',
              });
            }
            if (cmd.description) {
              yy = yy.epilogue(cmd.description);
            }
            return yy;
          },
          async (argv) => {
            const pathParams: Record<string, string> = {};
            for (const name of cmd.positionals) {
              pathParams[name] = String(argv[name]);
            }
            const query: Record<string, unknown> = {};
            for (const opt of cmd.options) {
              if (argv[opt.name] !== undefined)
                query[opt.name] = argv[opt.name];
            }
            const body = cmd.hasBody ? readBody(argv, deps) : undefined;

            const res = await deps.request(cmd.method, cmd.path, {
              pathParams,
              query,
              body,
            });
            if (res.ok) {
              deps.io.out(json(res.body));
            } else {
              deps.io.err(json(res.body));
              deps.exit(1);
            }
          },
        );
      }
      return sub
        .demandCommand(1, `No ${group} subcommand given. Run "hbk ${group} --help" to list operations.`)
        .strict();
    });
  }

  const AGENT_EPILOGUE = [
    'Remote REST client for the headless-bookkeeping API. Each command maps 1:1 to an API operation.',
    '',
    'Auth:      hbk login --url <url> --token <token>   (or HBK_URL / HBK_TOKEN env vars)',
    'Discover:  hbk <group> --help            list a group\'s operations',
    '           hbk <group> <command> --help  show parameters and details',
    'Body:      --body-file <path.json>       (or pipe JSON via stdin)',
    'Output:    JSON response -> stdout; notes/errors -> stderr; HTTP >= 400 -> non-zero exit',
    'Escape:    hbk api <method> <path>       call any endpoint directly',
  ].join('\n');

  return cli
    .demandCommand(1, 'No command group given. Run "hbk --help" to list groups.')
    .epilogue(AGENT_EPILOGUE)
    .strict()
    .exitProcess(false)
    .fail((msg, err) => {
      deps.io.err(`${msg || (err && err.message) || 'error'}\n`);
      throw err ?? new Error(msg);
    });
}
