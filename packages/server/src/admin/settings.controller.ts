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
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { SettingsService } from './settings.service';

const setSettingSchema = z.object({ value: z.string() });

// createZodDto carries the Zod schema (static `schema`, validated by the global
// pipe) AND the OpenAPI metadata Swagger reads — one source of truth.
export class SetSettingDto extends createZodDto(setSettingSchema) {}

@ApiTags('settings')
@Controller('admin/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @ApiOperation({
    summary: 'List settings',
    description: 'Return all key/value settings.',
  })
  @Get()
  async list(): Promise<{ settings: { key: string; value: string }[] }> {
    return { settings: await this.settings.list() };
  }

  @ApiOperation({
    summary: 'Get a setting',
    description: 'Fetch a setting by key.',
  })
  @ApiParam({ name: 'key', description: 'Setting key' })
  @Get(':key')
  async get(
    @Param('key') key: string,
  ): Promise<{ key: string; value: string | null }> {
    return { key, value: await this.settings.get(key) };
  }

  @ApiOperation({
    summary: 'Set a setting',
    description: 'Create or update a setting value.',
  })
  @ApiParam({ name: 'key', description: 'Setting key' })
  @Put(':key')
  @HttpCode(HttpStatus.OK)
  async put(
    @Param('key') key: string,
    @Body() dto: SetSettingDto,
  ): Promise<{ key: string; value: string }> {
    await this.settings.set(key, dto.value);
    return { key, value: dto.value };
  }

  @ApiOperation({
    summary: 'Delete a setting',
    description: 'Delete a setting by key.',
  })
  @ApiParam({ name: 'key', description: 'Setting key' })
  @Delete(':key')
  @HttpCode(HttpStatus.OK)
  async delete(
    @Param('key') key: string,
  ): Promise<{ key: string; deleted: true }> {
    await this.settings.delete(key);
    return { key, deleted: true };
  }
}
