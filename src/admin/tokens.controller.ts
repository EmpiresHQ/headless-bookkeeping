import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { ApiTokenService } from '../auth/api-token.service';

const createTokenSchema = z.object({ label: z.string().min(1) });

export class CreateTokenDto {
  static schema = createTokenSchema;
  label!: string;
}

@Controller('admin/tokens')
export class TokensController {
  constructor(private readonly tokens: ApiTokenService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateTokenDto,
  ): Promise<{ id: number; token: string }> {
    return this.tokens.create(dto.label);
  }

  @Get()
  async list(): Promise<{
    tokens: {
      id: number;
      label: string | null;
      created_at: number;
      revoked_at: number | null;
    }[];
  }> {
    return { tokens: await this.tokens.list() };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async revoke(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ id: number; revoked: true }> {
    await this.tokens.revoke(id);
    return { id, revoked: true };
  }
}
