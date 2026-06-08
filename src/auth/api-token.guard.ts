import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiTokenService } from './api-token.service';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Decorator to mark a route as public (skips API token check).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Global guard that checks `Authorization: Bearer <token>` against the
 * api_token table. Routes decorated with @Public() are exempt.
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiTokenService: ApiTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();

    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid authorization header');
    }

    const token = authHeader.slice('Bearer '.length);
    const valid = await this.apiTokenService.verify(token);

    if (!valid) {
      throw new UnauthorizedException('Invalid or revoked API token');
    }

    // Attach token info to the request for downstream use.
    (request as Record<string, unknown>)['apiToken'] = valid;

    return true;
  }
}
