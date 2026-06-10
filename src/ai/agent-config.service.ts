// src/ai/agent-config.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../database/types';
import {
  AgentKey,
  AGENT_PROMPTS,
  DEFAULT_MODEL,
  ModelConfig,
  ResolvedAgentConfig,
} from './agent-config';

@Injectable()
export class AgentConfigService {
  constructor(
    @Inject(KYSELY_MODULE_CONNECTION_TOKEN())
    private readonly db: Kysely<Database>,
  ) {}

  private async read(key: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('setting')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst();
    return row?.value ?? null;
  }

  /** `ai_model.<key>` → `ai_model` → DEFAULT_MODEL. */
  async resolveModel(key: AgentKey): Promise<string> {
    const perAgent = await this.read(`ai_model.${key}`);
    if (perAgent) return perAgent;
    const global = await this.read('ai_model');
    if (global) return global;
    return DEFAULT_MODEL;
  }

  /**
   * The full model config for an Agent: a bare id string (gateway default) when
   * no `ai_base_url` is set, else an OpenAI-compatible object aiming inference at
   * that base URL with the optional `ai_api_key`.
   */
  async resolveModelConfig(key: AgentKey): Promise<ModelConfig> {
    const id = await this.resolveModel(key);
    const url = await this.read('ai_base_url');
    if (!url) return id;
    const apiKey = await this.read('ai_api_key');
    return {
      // Mastra's model router requires a `provider/model` id even for a custom
      // OpenAI-compatible endpoint (the provider picks the request adapter; the
      // base URL still comes from `url`). The operator must include the prefix
      // (e.g. `openai/qwen3.6-coder-fast`) — see the Settings UI hint. We do NOT
      // default a bare name to `openai/`, which would silently misroute a
      // non-OpenAI model through the OpenAI adapter.
      id: id as `${string}/${string}`,
      url,
      ...(apiKey ? { apiKey } : {}),
    };
  }

  /** `prompt.<key>` → AGENT_PROMPTS[key]. */
  async resolveInstructions(key: AgentKey): Promise<string> {
    const override = await this.read(`prompt.${key}`);
    return override ?? AGENT_PROMPTS[key];
  }

  async resolve(key: AgentKey): Promise<ResolvedAgentConfig> {
    const [model, instructions] = await Promise.all([
      this.resolveModel(key),
      this.resolveInstructions(key),
    ]);
    return { model, instructions };
  }
}
