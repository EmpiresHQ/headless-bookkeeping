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
  parameters?: RawParam[];
  requestBody?: { content?: Record<string, unknown> };
}

export interface OpenApiSpec {
  paths: Record<string, Record<string, RawOperation>>;
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
  const name = underscore >= 0 ? operationId.slice(underscore + 1) : operationId;
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
          : kebab(`${method}-${path.replace(/[\/{}]/g, '-')}`),
        method,
        path,
        positionals,
        options,
        hasBody: op.requestBody !== undefined,
        summary: op.summary,
      });
    }
  }
  return commands;
}
