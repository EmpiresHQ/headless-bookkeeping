import {
  PipeTransform,
  Injectable,
  BadRequestException,
  ArgumentMetadata,
} from '@nestjs/common';
import { ZodSchema, ZodError } from 'zod';

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata) {
    const schema = (metadata.metatype as unknown as { schema?: ZodSchema })
      ?.schema;
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
