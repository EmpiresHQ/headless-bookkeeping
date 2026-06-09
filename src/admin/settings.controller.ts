import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
} from '@nestjs/common';
import { z } from 'zod';
import { SettingsService } from './settings.service';

const setSettingSchema = z.object({ value: z.string() });

export class SetSettingDto {
  static schema = setSettingSchema;
  value!: string;
}

@Controller('admin/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  async list(): Promise<{ settings: { key: string; value: string }[] }> {
    return { settings: await this.settings.list() };
  }

  @Get(':key')
  async get(
    @Param('key') key: string,
  ): Promise<{ key: string; value: string | null }> {
    return { key, value: await this.settings.get(key) };
  }

  @Put(':key')
  @HttpCode(HttpStatus.OK)
  async put(
    @Param('key') key: string,
    @Body() dto: SetSettingDto,
  ): Promise<{ key: string; value: string }> {
    await this.settings.set(key, dto.value);
    return { key, value: dto.value };
  }

  @Delete(':key')
  @HttpCode(HttpStatus.OK)
  async delete(
    @Param('key') key: string,
  ): Promise<{ key: string; deleted: true }> {
    await this.settings.delete(key);
    return { key, deleted: true };
  }
}
