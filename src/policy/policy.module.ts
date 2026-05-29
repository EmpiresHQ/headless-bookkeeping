import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PolicyService } from './policy.service';
import { OverrideController } from './override.controller';

@Module({
  imports: [DatabaseModule],
  providers: [PolicyService],
  controllers: [OverrideController],
  exports: [PolicyService],
})
export class PolicyModule {}
