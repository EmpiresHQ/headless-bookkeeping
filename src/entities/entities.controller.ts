import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { EntitiesService } from './entities.service';
import { OnboardEntityDto, AddAliasDto, UpdateEntityDto } from './types';
import type { EntityWithIdentifiers, Entity, EntityIdentifier } from './types';

@ApiTags('entities')
@Controller('api/entities')
export class EntitiesController {
  constructor(private readonly entitiesService: EntitiesService) {}

  @Post()
  async onboard(@Body() dto: OnboardEntityDto): Promise<EntityWithIdentifiers> {
    return this.entitiesService.onboard(dto);
  }

  @Get()
  async list(): Promise<{ entities: Entity[] }> {
    return { entities: await this.entitiesService.list() };
  }

  @Get(':id')
  async findById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<EntityWithIdentifiers> {
    return this.entitiesService.findById(id);
  }

  /** PATCH /api/entities/:id — update mutable intrinsic facts (C4). */
  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEntityDto,
  ): Promise<EntityWithIdentifiers> {
    return this.entitiesService.update(id, dto);
  }

  /** POST /api/entities/:id/aliases — add an identifier/alias (C4). */
  @Post(':id/aliases')
  async addAlias(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddAliasDto,
  ): Promise<EntityIdentifier> {
    return this.entitiesService.addAlias(id, dto);
  }
}
