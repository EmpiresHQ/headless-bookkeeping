import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ZodValidationPipe } from './common/pipes/zod-validation.pipe';
import { setupSwagger } from './swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ZodValidationPipe());
  setupSwagger(app);
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
