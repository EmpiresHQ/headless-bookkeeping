import {
  PipeTransform,
  Injectable,
  BadRequestException,
  ArgumentMetadata,
  Type,
} from '@nestjs/common';
import { ZodSchema, ZodError } from 'zod';

/**
 * Type guard: returns true when `obj` has a `schema` property that is a
 * ZodSchema, allowing safe access without `as`-style type assertions.
 */
function hasSchema(obj: Type<unknown>): obj is Type<unknown> & { schema: ZodSchema } {
  return 'schema' in obj;
}

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata) {
    const schema =
      metadata.metatype && hasSchema(metadata.metatype)
        ? metadata.metatype.schema
        : undefined;
    if (!schema) {
      return value;
    }

    const result = schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(this.formatErrors(result.error));
    }

    return result.data;
  }

  private formatErrors(error: ZodError): Record<string, string[]> {
    return error.flatten().fieldErrors;
  }
}
