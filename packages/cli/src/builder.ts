import yargs, { type Argv } from 'yargs';
import { basename } from 'node:path';
import type { RequestFn } from './client.js';

export interface MultipartField {
  name: string;
  binary: boolean;
  required: boolean;
  describe?: string;
}

export interface OptionSpec {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  choices?: string[];
  describe?: string;
}

export interface BodyField {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  choices?: string[];
  describe?: string;
  /** Raw OpenAPI type for display (e.g. 'array', 'integer', 'enum'). */
  displayType: string;
  /** Top-level scalar (string/number/boolean/enum) vs nested object/array. */
  scalar: boolean;
}

export interface CommandSpec {
  group: string;
  action: string;
  method: string;
  path: string;
  positionals: string[];
  options: OptionSpec[];
  hasBody: boolean;
  multipart?: MultipartField[];
  /** Top-level fields of the JSON request body (resolved from $ref/allOf). */
  bodyFields?: BodyField[];
  /** True when every bodyField is scalar → the body is driven by flags. */
  bodyAllScalar?: boolean;
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

interface RawProperty {
  type?: string;
  format?: string;
  description?: string;
  enum?: string[];
  $ref?: string;
  allOf?: RawSchema[];
  items?: unknown;
  properties?: Record<string, RawProperty>;
  required?: string[];
}

interface RawSchema {
  type?: string;
  properties?: Record<string, RawProperty>;
  required?: string[];
  $ref?: string;
  allOf?: RawSchema[];
}

interface RawOperation {
  tags?: string[];
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: RawParam[];
  requestBody?: {
    content?: Record<string, { schema?: RawSchema }>;
  };
}

export interface OpenApiSpec {
  paths: Record<string, Record<string, RawOperation>>;
  tags?: { name: string; description?: string }[];
  components?: { schemas?: Record<string, RawSchema> };
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

const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

/**
 * Resolve a schema down to its flat top-level `{ properties, required }`.
 * nestjs-zod emits request bodies into `components.schemas` referenced by
 * `$ref` (and `match` via `allOf`), so a body schema reads empty until it is
 * dereferenced. `allOf` members are merged; depth is bounded against cycles.
 */
function derefSchema(
  schema: RawSchema | RawProperty | undefined,
  schemas: Record<string, RawSchema>,
  depth = 0,
): { properties: Record<string, RawProperty>; required: string[] } {
  if (!schema || depth > 6) return { properties: {}, required: [] };
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop() ?? '';
    return derefSchema(schemas[name], schemas, depth + 1);
  }
  if (schema.allOf) {
    const merged: {
      properties: Record<string, RawProperty>;
      required: string[];
    } = { properties: {}, required: [] };
    for (const part of schema.allOf) {
      const d = derefSchema(part, schemas, depth + 1);
      Object.assign(merged.properties, d.properties);
      merged.required.push(...d.required);
    }
    return merged;
  }
  return { properties: schema.properties ?? {}, required: schema.required ?? [] };
}

/** Extract the top-level body fields of an application/json schema, or undefined. */
function extractBodyFields(
  schema: RawSchema | undefined,
  schemas: Record<string, RawSchema>,
): BodyField[] | undefined {
  const { properties, required } = derefSchema(schema, schemas);
  const names = Object.keys(properties);
  if (names.length === 0) return undefined;
  return names.map<BodyField>((name) => {
    const p = properties[name];
    const isEnum = Array.isArray(p.enum) && p.enum.length > 0;
    const scalar =
      (SCALAR_TYPES.has(p.type ?? '') || isEnum) &&
      p.type !== 'array' &&
      !p.properties &&
      !p.$ref &&
      !p.allOf;
    return {
      name,
      type: optionType(p.type),
      required: required.includes(name),
      choices: isEnum ? p.enum : undefined,
      describe: p.description,
      displayType: p.type ?? (isEnum ? 'enum' : 'object'),
      scalar,
    };
  });
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

      const mpSchema = op.requestBody?.content?.['multipart/form-data']?.schema;
      const multipart = mpSchema?.properties
        ? Object.entries(mpSchema.properties).map(([name, p]) => ({
            name,
            binary: p.format === 'binary',
            required: (mpSchema.required ?? []).includes(name),
            describe: p.description,
          }))
        : undefined;

      const jsonSchema = op.requestBody?.content?.['application/json']?.schema;
      const bodyFields = jsonSchema
        ? extractBodyFields(jsonSchema, spec.components?.schemas ?? {})
        : undefined;
      const bodyAllScalar = bodyFields
        ? bodyFields.every((f) => f.scalar)
        : undefined;

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
        multipart,
        bodyFields,
        bodyAllScalar,
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
  readFileBuffer: (path: string) => Uint8Array;
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

/**
 * Best-effort content type from a file extension. The server stores the
 * uploaded part's MIME type and routes on it (e.g. triage OCR only accepts
 * image/* and application/pdf), so a Blob with no type (-> octet-stream) would
 * be silently rejected downstream. Falls back to octet-stream for unknowns.
 */
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  csv: 'text/csv',
  txt: 'text/plain',
  json: 'application/json',
  xml: 'application/xml',
};

export function mimeForFile(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
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
            if (cmd.multipart) {
              for (const f of cmd.multipart) {
                yy = yy.option(f.name, {
                  type: 'string',
                  demandOption: f.required,
                  describe: f.binary
                    ? (f.describe ?? 'Path to a file to upload')
                    : (f.describe ?? `Form field: ${f.name}`),
                });
              }
            } else if (cmd.bodyAllScalar && cmd.bodyFields) {
              // A flat scalar body → one flag per field (symmetric with
              // multipart). Body flags are NEVER demandOption: a required field
              // is only annotated, so the --body-file / stdin escape still
              // works; the server's schema validation stays the source of truth.
              for (const f of cmd.bodyFields) {
                yy = yy.option(f.name, {
                  type: f.type,
                  choices: f.choices,
                  describe: f.required
                    ? `${f.describe ?? `Body field: ${f.name}`} (required)`
                    : (f.describe ?? `Body field: ${f.name}`),
                });
              }
              yy = yy.option('body-file', {
                type: 'string',
                describe:
                  'Path to a JSON request body (or pipe JSON via stdin) — alternative to the flags above',
              });
            } else if (cmd.hasBody) {
              yy = yy.option('body-file', {
                type: 'string',
                describe:
                  'Path to a JSON request body (or pipe JSON via stdin)',
              });
            }
            const epilogue: string[] = [];
            if (cmd.description) epilogue.push(cmd.description);
            // For stdin-only bodies (nested/array), the field names live only in
            // OpenAPI; surface them so the body shape is discoverable from --help.
            if (cmd.hasBody && cmd.bodyFields && !cmd.bodyAllScalar) {
              epilogue.push('Request body fields (pipe JSON via stdin):');
              for (const f of cmd.bodyFields) {
                epilogue.push(
                  `  ${f.name} (${f.displayType})${f.required ? ' [required]' : ''}`,
                );
              }
            }
            if (epilogue.length) {
              yy = yy.epilogue(epilogue.join('\n'));
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
            let body: unknown;
            if (cmd.multipart) {
              const form = new FormData();
              for (const f of cmd.multipart) {
                const v = argv[f.name];
                if (v === undefined) continue;
                if (f.binary) {
                  const buf = deps.readFileBuffer(String(v));
                  const ab: ArrayBuffer = buf.buffer instanceof ArrayBuffer
                    ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
                    : new Uint8Array(buf).buffer as ArrayBuffer;
                  form.append(
                    f.name,
                    new Blob([ab], { type: mimeForFile(String(v)) }),
                    basename(String(v)),
                  );
                } else {
                  form.append(f.name, String(v));
                }
              }
              body = form;
            } else if (cmd.bodyAllScalar && cmd.bodyFields) {
              // Assemble the JSON body from the defined flags (yargs has already
              // coerced number/boolean). An undefined flag is omitted, not sent
              // as null. Flags and a stdin/--body-file body are mutually
              // exclusive — supplying both is ambiguous, so reject it.
              const fromFlags: Record<string, unknown> = {};
              let anyFlag = false;
              for (const f of cmd.bodyFields) {
                if (argv[f.name] !== undefined) {
                  fromFlags[f.name] = argv[f.name];
                  anyFlag = true;
                }
              }
              const piped = readBody(argv, deps);
              if (anyFlag && piped !== undefined) {
                deps.io.err(
                  'Provide the request body via flags OR via --body-file/stdin, not both.\n',
                );
                deps.exit(1);
                return;
              }
              body = anyFlag ? fromFlags : piped;
            } else {
              body = cmd.hasBody ? readBody(argv, deps) : undefined;
            }

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
