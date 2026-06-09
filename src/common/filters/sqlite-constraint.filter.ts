import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import Database from 'better-sqlite3';

/**
 * Catches ONLY raw better-sqlite3 `SqliteError`s (which Kysely surfaces, e.g.
 * `SQLITE_CONSTRAINT_FOREIGNKEY` when a request references a non-existent
 * supplier/document) and maps constraint violations to clean 4xx instead of an
 * opaque 500. Every other exception — including HttpExceptions like
 * ConflictException — is untouched and uses Nest's default handling.
 */
@Catch(Database.SqliteError)
export class SqliteConstraintFilter implements ExceptionFilter {
  catch(exception: Error & { code?: string }, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const code = exception.code ?? '';

    if (code.startsWith('SQLITE_CONSTRAINT')) {
      const { status, message } = classify(code);
      res
        .status(status)
        .json({ statusCode: status, message, constraint: code });
      return;
    }

    // A non-constraint SQLite error is a genuine server fault.
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
