import { CanActivate, ExecutionContext } from '@nestjs/common';
import { MastraService } from '../src/ai/mastra.service';

export const fauxMastraService: MastraService = {
  // The agent builders reject so any path that reaches the real LLM in an e2e
  // (where there is no inference endpoint) fails fast and visibly rather than
  // hanging. Suites that exercise classification override Pass2AgentService too.
  buildTriageEnrichmentAgent: () =>
    Promise.reject(new Error('faux: no agent in e2e')),
  buildTriageClassificationAgent: () =>
    Promise.reject(new Error('faux: no agent in e2e')),
  buildBankMappingAgent: () =>
    Promise.reject(new Error('faux: no agent in e2e')),
} as unknown as MastraService;

/**
 * No-op guard that allows all requests — used to replace the global
 * ApiTokenGuard in e2e tests.
 */
export class NoOpGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}

/**
 * Faux ApiTokenGuard — always allows access.
 */
export const fauxApiTokenGuard: CanActivate = {
  canActivate: () => true,
};
