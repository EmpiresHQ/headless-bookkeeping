import { NestFactory } from '@nestjs/core';
import { Logger, LoggerErrorInterceptor } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ZodValidationPipe } from './common/pipes/zod-validation.pipe';
import { setupSwagger } from './swagger';

async function bootstrap() {
  // bufferLogs: NestJS buffers early logs until the pino logger is wired
  // via useLogger, then flushes them through pino (instead of the default
  // console logger).
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(new ZodValidationPipe());
  // Expose error stack traces in the `err` field of pino-http response logs
  // so failed requests carry their exception details for observability.
  app.useGlobalInterceptors(new LoggerErrorInterceptor());
  setupSwagger(app);
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
