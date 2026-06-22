import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ApiTokenService } from './api-token.service';
import { ApiTokenGuard } from './api-token.guard';
import { MobileAuthController } from './mobile-auth.controller';
import { SettingsService } from '../admin/settings.service';

@Module({
  imports: [DatabaseModule],
  controllers: [MobileAuthController],
  // SettingsService is provided here (not imported from AdminModule) because
  // AdminModule imports AuthModule — importing it back would be a cycle. The
  // service is stateless (DB + static registry), so a second instance is safe.
  providers: [ApiTokenService, ApiTokenGuard, SettingsService],
  exports: [ApiTokenService, ApiTokenGuard],
})
export class AuthModule {}
