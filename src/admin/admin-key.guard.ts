import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Decorator to mark a route as public (skips admin key check).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Guard that checks the X-Admin-Key header against the hardcoded dev key.
 * Routes decorated with @Public() are exempt from auth.
 */
@Injectable()
export class AdminKeyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
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
    const adminKey = request.headers['x-admin-key'];

    if (adminKey !== 'dev') {
      throw new UnauthorizedException('Invalid or missing admin key');
    }

    return true;
  }
}
