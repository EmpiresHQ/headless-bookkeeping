import createClient from 'openapi-fetch';
import type { ResolvedContext } from './config.js';

export interface RequestArgs {
  pathParams?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
}

export interface RequestResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export type RequestFn = (
  method: string,
  path: string,
  args?: RequestArgs,
) => Promise<RequestResult>;

/**
 * Generic request function bound to a resolved context. Uses openapi-fetch's
 * low-level `request(method, path, init)` so a single dispatcher serves every
 * operation: openapi-fetch substitutes `{...}` path params from `params.path`
 * and serializes `params.query`. Typing is generic here by design — the CLI
 * dispatches dynamically; openapi-typescript's `types.gen.ts` is for consumers.
 */
export function makeRequest(ctx: ResolvedContext): RequestFn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = createClient<any>({
    baseUrl: ctx.baseUrl,
    headers: { Authorization: `Bearer ${ctx.token}` },
  });

  return async (method, path, args = {}) => {
    const { response, data, error } = await client.request(
      method.toLowerCase() as 'get',
      path,
      {
        params: { path: args.pathParams, query: args.query },
        ...(args.body !== undefined ? { body: args.body } : {}),
      },
    );
    return {
      ok: response.ok,
      status: response.status,
      body: response.ok ? data : (error ?? data),
    };
  };
}
