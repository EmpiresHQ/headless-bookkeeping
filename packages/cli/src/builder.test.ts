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

const descSpec = {
  paths: {
    '/api/expenses': {
      post: {
        tags: ['expenses'],
        operationId: 'Expenses_createExpense',
        summary: 'Create an expense',
        description: 'Runs the posting pipeline AI->Rules->Policy->Voucher; 409 if the period is locked.',
        requestBody: { content: { 'application/json': {} } },
      },
    },
  },
};

const noopDeps: BuilderDeps = {
  request: async () => ({ ok: true, status: 200, body: {} }),
  io: { out: () => {}, err: () => {} },
  readFileSync: () => '',
  stdinIsTTY: true,
  readStdin: () => '',
  exit: () => {},
  readFileBuffer: () => new Uint8Array(),
};

describe('per-command help: op.description', () => {
  it('prints op.description in the per-command help', async () => {
    let help = '';
    const cli = buildCli(descSpec as never, { ...noopDeps, io: { out: (s) => (help += s), err: () => {} } });
    await cli.parseAsync(['expenses', 'create-expense', '--help']);
    expect(help).toContain('posting pipeline');
  });
});

const minimalSpec = { paths: { '/api/expenses': { get: { tags: ['expenses'], operationId: 'Expenses_getExpenses', summary: 'List expenses' } } } };

describe('agent guidance', () => {
  it('top-level help carries agent guidance', async () => {
    let help = '';
    const cli = buildCli(minimalSpec as never, { ...noopDeps, io: { out: (s) => (help += s), err: () => {} } });
    await cli.parseAsync(['--help']);
    expect(help).toContain('hbk login');
    expect(help).toContain('--body-file');
    expect(help).toContain('JSON');
  });

  it('no-command error points at --help', async () => {
    let err = '';
    const cli = buildCli(minimalSpec as never, { ...noopDeps, io: { out: () => {}, err: (s) => (err += s) } });
    try { await cli.parseAsync([]); } catch { /* expected */ }
    expect(err).toContain('hbk --help');
  });
});

const multipartSpec = {
  paths: {
    '/api/documents': {
      post: {
        tags: ['documents'],
        operationId: 'Documents_uploadDocument',
        summary: 'Upload a document',
        requestBody: {
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: { file: { type: 'string', format: 'binary' } },
              },
            },
          },
        },
      },
    },
  },
};

describe('multipart upload', () => {
  it('exposes a --file option in help', async () => {
    let help = '';
    const cli = buildCli(multipartSpec as never, { ...noopDeps, io: { out: (s) => (help += s), err: () => {} } });
    await cli.parseAsync(['documents', 'upload-document', '--help']);
    expect(help).toContain('--file');
  });

  it('reads the file and sends a FormData body with the original filename', async () => {
    let sentBody: unknown;
    const deps = {
      ...noopDeps,
      readFileBuffer: () => new Uint8Array([1, 2, 3]),
      request: async (_m: string, _p: string, args: any) => {
        sentBody = args?.body;
        return { ok: true, status: 201, body: {} };
      },
    };
    const cli = buildCli(multipartSpec as never, deps as never);
    await cli.parseAsync(['documents', 'upload-document', '--file', '/tmp/invoice.pdf']);
    expect(sentBody).toBeInstanceOf(FormData);
    const f = (sentBody as FormData).get('file');
    expect(f).toBeInstanceOf(Blob);
    expect((f as File).name).toBe('invoice.pdf');
  });

  it('sets the file content type from its extension', async () => {
    let sentBody: unknown;
    const deps = {
      ...noopDeps,
      readFileBuffer: () => new Uint8Array([1, 2, 3]),
      request: async (_m: string, _p: string, args: any) => {
        sentBody = args?.body;
        return { ok: true, status: 201, body: {} };
      },
    };
    const cli = buildCli(multipartSpec as never, deps as never);
    await cli.parseAsync(['documents', 'upload-document', '--file', '/tmp/invoice.pdf']);
    const f = (sentBody as FormData).get('file');
    expect((f as Blob).type).toBe('application/pdf');
  });
});

const bodyFlagSpec = {
  components: {
    schemas: {
      CreatePeriodDto: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Period name' },
          start_date: { type: 'string' },
          end_date: { type: 'string' },
          count: { type: 'integer' },
          active: { type: 'boolean' },
          status: { type: 'string', enum: ['open', 'locked'] },
        },
        required: ['name', 'start_date'],
      },
      // allOf must be merged into a flat field list.
      ApproveDto: {
        allOf: [
          { type: 'object', properties: { approved_by: { type: 'string' } } },
          {
            type: 'object',
            properties: { note: { type: 'string' } },
            required: ['approved_by'],
          },
        ],
      },
      // A nested array makes the body non-scalar → no flags, stdin + epilogue.
      MatchDto: {
        type: 'object',
        properties: {
          statementId: { type: 'integer' },
          matches: { type: 'array', items: { type: 'object' } },
        },
        required: ['matches'],
      },
    },
  },
  paths: {
    '/api/reporting-periods': {
      post: {
        tags: ['reporting-periods'],
        operationId: 'Rp_create',
        summary: 'Create a reporting period',
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreatePeriodDto' },
            },
          },
        },
      },
    },
    '/api/approvals/{id}/approve': {
      post: {
        tags: ['approvals'],
        operationId: 'Approvals_approve',
        summary: 'Approve',
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ApproveDto' },
            },
          },
        },
      },
    },
    '/api/bank-statements/{id}/match': {
      post: {
        tags: ['bank'],
        operationId: 'Bank_match',
        summary: 'Execute a match',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/MatchDto' },
            },
          },
        },
      },
    },
  },
};

describe('specToCommands — JSON body fields', () => {
  const cmds = specToCommands(bodyFlagSpec as never);

  it('resolves a $ref body into typed, required-aware scalar fields', () => {
    const create = cmds.find((c) => c.action === 'create')!;
    expect(create.bodyAllScalar).toBe(true);
    const byName = Object.fromEntries(
      (create.bodyFields ?? []).map((f) => [f.name, f]),
    );
    expect(byName.name).toMatchObject({ type: 'string', required: true });
    expect(byName.start_date).toMatchObject({ required: true });
    expect(byName.end_date).toMatchObject({ required: false });
    expect(byName.count.type).toBe('number');
    expect(byName.active.type).toBe('boolean');
    expect(byName.status.choices).toEqual(['open', 'locked']);
  });

  it('merges an allOf body schema into one field list', () => {
    const approve = cmds.find((c) => c.action === 'approve')!;
    expect(approve.bodyAllScalar).toBe(true);
    const names = (approve.bodyFields ?? []).map((f) => f.name).sort();
    expect(names).toEqual(['approved_by', 'note']);
    const approvedBy = approve.bodyFields!.find((f) => f.name === 'approved_by');
    expect(approvedBy!.required).toBe(true);
  });

  it('marks a body with a nested array as not all-scalar', () => {
    const match = cmds.find((c) => c.action === 'match')!;
    expect(match.hasBody).toBe(true);
    expect(match.bodyAllScalar).toBe(false);
  });
});

describe('buildCli — JSON body flags (scalar bodies)', () => {
  it('exposes one flag per scalar body field in help, with enum choices', async () => {
    let help = '';
    const cli = buildCli(bodyFlagSpec as never, {
      ...noopDeps,
      io: { out: (s) => (help += s), err: () => {} },
    });
    await cli.parseAsync(['reporting-periods', 'create', '--help']);
    expect(help).toContain('--name');
    expect(help).toContain('--start_date');
    expect(help).toContain('--status');
    expect(help).toContain('open');
    expect(help).toContain('locked');
  });

  it('assembles a JSON body from flags with correct types, omitting absent fields', async () => {
    let sentBody: unknown;
    const cli = buildCli(bodyFlagSpec as never, {
      ...noopDeps,
      request: async (_m, _p, args) => {
        sentBody = (args as { body?: unknown })?.body;
        return { ok: true, status: 200, body: {} };
      },
    });
    await cli.parseAsync([
      'reporting-periods',
      'create',
      '--name',
      '2026-05',
      '--start_date',
      '2026-05-01',
      '--count',
      '3',
      '--active',
      'true',
    ]);
    expect(sentBody).toEqual({
      name: '2026-05',
      start_date: '2026-05-01',
      count: 3,
      active: true,
    });
  });

  it('rejects an out-of-enum value for a body flag', async () => {
    let err = '';
    let called = false;
    const cli = buildCli(bodyFlagSpec as never, {
      ...noopDeps,
      io: { out: () => {}, err: (s) => (err += s) },
      request: async () => {
        called = true;
        return { ok: true, status: 200, body: {} };
      },
    });
    try {
      await cli.parseAsync([
        'reporting-periods',
        'create',
        '--name',
        'x',
        '--start_date',
        'y',
        '--status',
        'frozen',
      ]);
    } catch {
      /* yargs fail() rethrows */
    }
    expect(called).toBe(false);
    expect(err).toMatch(/status/i);
  });

  it('errors when body flags and a stdin body are both supplied', async () => {
    let err = '';
    let called = false;
    const cli = buildCli(bodyFlagSpec as never, {
      ...noopDeps,
      stdinIsTTY: false,
      readStdin: () => '{"name":"piped"}',
      io: { out: () => {}, err: (s) => (err += s) },
      request: async () => {
        called = true;
        return { ok: true, status: 200, body: {} };
      },
      exit: () => {},
    });
    await cli.parseAsync([
      'reporting-periods',
      'create',
      '--name',
      '2026-05',
      '--start_date',
      '2026-05-01',
    ]);
    expect(called).toBe(false);
    expect(err.toLowerCase()).toContain('both');
  });
});

describe('buildCli — complex JSON body (stdin + epilogue)', () => {
  it('generates no body flags and lists the fields in help', async () => {
    let help = '';
    const cli = buildCli(bodyFlagSpec as never, {
      ...noopDeps,
      io: { out: (s) => (help += s), err: () => {} },
    });
    await cli.parseAsync(['bank', 'match', '7', '--help']);
    // No per-field flag for the array body…
    expect(help).not.toContain('--matches');
    // …but the body shape is discoverable.
    expect(help).toContain('Request body fields');
    expect(help).toContain('matches');
    expect(help).toContain('statementId');
  });

  it('reads the complex body from stdin', async () => {
    let sentBody: unknown;
    const cli = buildCli(bodyFlagSpec as never, {
      ...noopDeps,
      stdinIsTTY: false,
      readStdin: () => '{"matches":[{"voucherId":1}]}',
      request: async (_m, _p, args) => {
        sentBody = (args as { body?: unknown })?.body;
        return { ok: true, status: 200, body: {} };
      },
    });
    await cli.parseAsync(['bank', 'match', '7']);
    expect(sentBody).toEqual({ matches: [{ voucherId: 1 }] });
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
