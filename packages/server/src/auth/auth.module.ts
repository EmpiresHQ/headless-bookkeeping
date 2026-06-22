import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ApiTokenService } from './api-token.service';
import { ApiTokenGuard } from './api-token.guard';
import { MobileAuthController } from './mobile-auth.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [MobileAuthController],
  providers: [ApiTokenService, ApiTokenGuard],
  exports: [ApiTokenService, ApiTokenGuard],
})
export class AuthModule {}
