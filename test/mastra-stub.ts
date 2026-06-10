/**
 * Jest stub for the @mastra/* ESM packages.
 *
 * The production code statically imports `@mastra/core`, `@mastra/core/agent`,
 * and `@mastra/libsql`. Those are ESM-only packages that Jest's CJS runtime
 * cannot load, so `moduleNameMapper` (in `package.json` and
 * `test/jest-e2e.json`) redirects all three specifiers here.
 *
 * The stubs reproduce just enough of the real surface for the unit tests:
 *  - `new Mastra(config)` / `new LibSQLStore(config)` capture their config.
 *  - `new Agent(config)` captures its config and exposes a `generate()` method
 *    that is `jest.spyOn`-able and returns a `FullOutput`-shaped object
 *    (`{ object, text }`). Tests spy on `getAgent().generate` to control the
 *    structured output.
 */

interface MastraConfig {
  agents?: unknown;
  storage?: unknown;
}

interface AgentConfig {
  id?: unknown;
  name?: unknown;
  instructions?: unknown;
  tools?: unknown;
  model?: unknown;
}

interface LibSQLStoreConfig {
  id?: unknown;
  url?: unknown;
}

export class Mastra {
  agents: unknown;
  storage: unknown;

  constructor(config: MastraConfig) {
    this.agents = config.agents;
    this.storage = config.storage;
  }
}

export class Agent {
  id: unknown;
  name: unknown;
  instructions: unknown;
  tools: unknown;
  model: unknown;

  constructor(config: AgentConfig) {
    this.id = config.id;
    this.name = config.name;
    this.instructions = config.instructions;
    this.tools = config.tools;
    this.model = config.model;
  }

  /**
   * Mirrors the shape of the real `agent.generate(messages, opts)` return: a
   * FullOutput whose parsed structured object is on `.object`. The default
   * stub returns an empty object; tests override it via `jest.spyOn`.
   */
  generate(
    _messages: unknown,
    _options?: unknown,
  ): Promise<{ object: unknown; text: string }> {
    return Promise.resolve({ object: undefined, text: '' });
  }

  /**
   * Mirrors the real `agent.listTools()` — the public way to inspect the
   * configured tools. Returns the tools captured at construction so the unit
   * tests can assert the read-only tool set by name.
   */
  listTools(): Record<string, unknown> {
    return (this.tools ?? {}) as Record<string, unknown>;
  }
}

export class LibSQLStore {
  id: unknown;
  url: unknown;

  constructor(config: LibSQLStoreConfig) {
    this.id = config.id;
    this.url = config.url;
  }
}

export class Run {
  readonly runId = 'stub-run';
  async start(_args: { inputData?: unknown }): Promise<{ status: string; result: unknown }> {
    return { status: 'success', result: undefined };
  }
}
export class Workflow {
  constructor(public config: { id?: unknown } = {}) {}
  then(): this { return this; }
  commit(): this { return this; }
  async createRun(): Promise<Run> { return new Run(); }
}
export function createWorkflow(config: { id?: unknown } = {}): Workflow {
  return new Workflow(config);
}
export function createStep(params: unknown): unknown {
  return params;
}
