import { describe, it, expect } from 'vitest';
import {
  specToCommands,
  actionFromOperationId,
  kebab,
  type OpenApiSpec,
} from './builder.js';
import { buildCli, readBody, type BuilderDeps } from './builder.js';

const SPEC: OpenApiSpec = {
  paths: {
    '/api/expenses': {
      post: {
        tags: ['expenses'],
        operationId: 'ExpensesController_createExpense',
        summary: 'Create an expense',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' } } },
        },
      },
      get: {
        tags: ['expenses'],
        operationId: 'ExpensesController_getExpenses',
        parameters: [
          {
            name: 'status',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['draft', 'posted'] },
          },
        ],
      },
    },
    '/api/expenses/{id}': {
      get: {
        tags: ['expenses'],
        operationId: 'ExpensesController_getExpense',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
      },
    },
  },
};

describe('kebab', () => {
  it('camelCase to kebab-case', () => {
    expect(kebab('createExpense')).toBe('create-expense');
    expect(kebab('getVATReport')).toBe('get-vat-report');
  });
});

describe('actionFromOperationId', () => {
  it('strips the Controller_ prefix and kebabs', () => {
    expect(actionFromOperationId('ExpensesController_createExpense')).toBe(
      'create-expense',
    );
  });
  it('falls back to the whole id when there is no underscore', () => {
    expect(actionFromOperationId('ping')).toBe('ping');
  });
});

describe('specToCommands', () => {
  const cmds = specToCommands(SPEC);

  it('derives one command per operation, grouped by tag', () => {
    expect(cmds).toHaveLength(3);
    expect(cmds.every((c) => c.group === 'expenses')).toBe(true);
  });

  it('maps path params to positionals', () => {
    const get = cmds.find((c) => c.action === 'get-expense')!;
    expect(get.method).toBe('get');
    expect(get.path).toBe('/api/expenses/{id}');
    expect(get.positionals).toEqual(['id']);
  });

  it('maps query params to options with enum choices', () => {
    const list = cmds.find((c) => c.action === 'get-expenses')!;
    const status = list.options.find((o) => o.name === 'status')!;
    expect(status.required).toBe(false);
    expect(status.choices).toEqual(['draft', 'posted']);
  });

  it('flags operations that carry a JSON request body', () => {
    const create = cmds.find((c) => c.action === 'create-expense')!;
    expect(create.hasBody).toBe(true);
    expect(create.positionals).toEqual([]);
  });
});

describe('readBody', () => {
  it('reads JSON from a file when --body-file is given', () => {
    const deps = {
      readFileSync: () => '{"a":1}',
      stdinIsTTY: true,
      readStdin: () => '',
    };
    expect(readBody({ 'body-file': '/tmp/x.json' }, deps)).toEqual({ a: 1 });
  });

  it('reads JSON from stdin when piped (no TTY) and no --body-file', () => {
    const deps = {
      readFileSync: () => '',
      stdinIsTTY: false,
      readStdin: () => '{"b":2}',
    };
    expect(readBody({}, deps)).toEqual({ b: 2 });
  });

  it('returns undefined when no body source is present', () => {
    const deps = {
      readFileSync: () => '',
      stdinIsTTY: true,
      readStdin: () => '',
    };
    expect(readBody({}, deps)).toBeUndefined();
  });
});

const tagSpec = {
  tags: [{ name: 'expenses', description: 'Record supplier expenses' }],
  paths: {
    '/api/expenses': {
      get: { tags: ['expenses'], operationId: 'Expenses_getExpenses', summary: 'List expenses' },
    },
  },
};

describe('group descriptions from spec.tags', () => {
  it('uses the tag description as the group command description', async () => {
    let help = '';
    const cli = buildCli(tagSpec as never, {
      request: async () => ({ ok: true, status: 200, body: {} }),
      io: { out: (s) => (help += s), err: () => {} },
      readFileSync: () => '',
      stdinIsTTY: true,
      readStdin: () => '',
      exit: () => {},
    });
    await cli.parseAsync(['--help']);
    expect(help).toContain('Record supplier expenses');
  });
});

describe('buildCli dispatch', () => {
  function makeDeps() {
    const out: string[] = [];
    const err: string[] = [];
    const requests: { method: string; path: string; args: unknown }[] = [];
    const deps: BuilderDeps = {
      request: async (method, path, args) => {
        requests.push({ method, path, args });
        return { ok: true, status: 200, body: { ok: true } };
      },
      io: { out: (s) => out.push(s), err: (s) => err.push(s) },
      readFileSync: () => '{"gross_amount":100}',
      stdinIsTTY: true,
      readStdin: () => '',
      exit: () => {},
    };
    return { deps, out, err, requests };
  }

  it('routes "expenses get-expense 7" to GET /api/expenses/{id} with the positional', async () => {
    const { deps, requests, out } = makeDeps();
    await buildCli(SPEC, deps).parseAsync(['expenses', 'get-expense', '7']);
    expect(requests[0]).toMatchObject({
      method: 'get',
      path: '/api/expenses/{id}',
      args: { pathParams: { id: '7' } },
    });
    expect(out.join('')).toContain('"ok": true');
  });

  it('sends the file body for a body-bearing command', async () => {
    const { deps, requests } = makeDeps();
    await buildCli(SPEC, deps).parseAsync([
      'expenses',
      'create-expense',
      '--body-file',
      '/tmp/e.json',
    ]);
    expect(requests[0]).toMatchObject({
      method: 'post',
      path: '/api/expenses',
      args: { body: { gross_amount: 100 } },
    });
  });
});
