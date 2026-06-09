import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Global exception filter that maps SQLite constraint violations — which
 * Kysely/better-sqlite3 surface as a raw `SqliteError` (e.g.
 * `SQLITE_CONSTRAINT_FOREIGNKEY` when a request references a non-existent
 * supplier/document) — to clean 4xx instead of an opaque 500.
 *
 * It is a catch-all (`@Catch()`) and matches the constraint error by its `code`
 * string, NOT by `instanceof SqliteError` — under jest/CI the native module can
 * resolve to a different class instance, so identity matching is unreliable.
 * Non-constraint exceptions are handled exactly like Nest's default filter:
 * HttpExceptions keep their status + body; anything else is a 500.
 */
@Catch()
export class SqliteConstraintFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    const code = (exception as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
      const { status, message } = classify(code);
      res
        .status(status)
        .json({ statusCode: status, message, constraint: code });
      return;
    }

    // Default-equivalent handling for everything else.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res
        .status(status)
        .json(
          typeof body === 'string'
            ? { statusCode: status, message: body }
            : body,
        );
      return;
    }

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}

function classify(code: string): { status: number; message: string } {
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return {
      status: HttpStatus.BAD_REQUEST,
      message: 'A referenced record does not exist (foreign key constraint).',
    };
  }
  if (code.includes('UNIQUE') || code.includes('PRIMARYKEY')) {
    return {
      status: HttpStatus.CONFLICT,
      message: 'A record with these values already exists (unique constraint).',
    };
  }
  return {
    status: HttpStatus.BAD_REQUEST,
    message: 'The request violates a database constraint.',
  };
}
