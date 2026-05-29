import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  async getHello(): Promise<string> {
    return this.appService.getHello();
  }

  @Get('users')
  async getUsers() {
    return this.appService.getUsers();
  }

  @Get('health')
  async getHealth() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
