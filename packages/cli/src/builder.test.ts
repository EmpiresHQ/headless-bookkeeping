import { describe, it, expect } from 'vitest';
import { specToCommands, actionFromOperationId, kebab, type OpenApiSpec } from './builder.js';

const SPEC: OpenApiSpec = {
  paths: {
    '/api/expenses': {
      post: {
        tags: ['expenses'],
        operationId: 'ExpensesController_createExpense',
        summary: 'Create an expense',
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      },
      get: {
        tags: ['expenses'],
        operationId: 'ExpensesController_getExpenses',
        parameters: [
          { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['draft', 'posted'] } },
        ],
      },
    },
    '/api/expenses/{id}': {
      get: {
        tags: ['expenses'],
        operationId: 'ExpensesController_getExpense',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
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
    expect(actionFromOperationId('ExpensesController_createExpense')).toBe('create-expense');
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
