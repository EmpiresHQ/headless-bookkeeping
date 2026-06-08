import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/api-token.guard';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  getHealth(): { status: string; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
