// src/ai/agent-config.module.ts
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AgentConfigService } from './agent-config.service';

@Module({
  imports: [DatabaseModule],
  providers: [AgentConfigService],
  exports: [AgentConfigService],
})
export class AgentConfigModule {}
