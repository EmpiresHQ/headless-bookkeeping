import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Mounts Swagger UI at `/api` and the OpenAPI JSON at `/api-json`.
 *
 * Extracted from bootstrap so e2e tests can apply the exact same setup. The
 * Swagger routes are raw HTTP routes (not Nest controller handlers), so the
 * global ApiTokenGuard does not gate them — the docs are reachable without a
 * token, while the documented endpoints still require the Bearer token.
 */
export function setupSwagger(app: INestApplication): void {
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
  // Apply the Bearer scheme to every operation so the UI's "Authorize" sends the
  // token on "Try it out" requests (the global guard requires it anyway).
  document.security = [{ bearer: [] }];

  SwaggerModule.setup('api', app, document);
}
