import { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';

/**
 * Builds the cleaned OpenAPI document (Zod-derived schemas inlined, Bearer
 * scheme applied to every operation). Shared by the HTTP `setupSwagger` mount
 * and the offline emitter (src/openapi-emit.ts) so the spec is identical in
 * both paths.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('headless-bookkeeping API')
    .setDescription(
      'AI-native bookkeeping kernel — remote HTTP API. ' +
        'Authenticate with a Bearer API token (mint one via POST /admin/tokens).',
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'token' },
      'bearer',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  document.security = [{ bearer: [] }];
  return cleanupOpenApiDoc(document);
}

/**
 * Mounts Swagger UI at `/api` and the OpenAPI JSON at `/api-json`.
 *
 * The Swagger routes are raw HTTP routes (not Nest controller handlers), so the
 * global ApiTokenGuard does not gate them — the docs are reachable without a
 * token, while the documented endpoints still require the Bearer token.
 */
export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup('api', app, buildOpenApiDocument(app));
}
