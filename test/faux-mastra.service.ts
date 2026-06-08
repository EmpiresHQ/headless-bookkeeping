import { CanActivate, ExecutionContext } from '@nestjs/common';
import { MastraService } from '../src/ai/mastra.service';

export const fauxMastraService: MastraService = {
  onModuleInit: async () => {},
  initialize: async () => {},
  getMastra: () => null,
  getAgent: () => null,
  isInitialized: () => false,
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
