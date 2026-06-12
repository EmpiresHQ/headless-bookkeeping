import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { EntitiesService } from './entities.service';
import {
  OnboardEntityDto,
  AddAliasDto,
  UpdateEntityDto,
  MergeEntityDto,
} from './types';
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

  /** POST /api/entities/:survivorId/merge — merge a duplicate entity into the survivor. */
  @Post(':survivorId/merge')
  async merge(
    @Param('survivorId', ParseIntPipe) survivorId: number,
    @Body() dto: MergeEntityDto,
  ): Promise<EntityWithIdentifiers> {
    return this.entitiesService.mergeInto(survivorId, dto.duplicate_id);
  }

  /** DELETE /api/entities/:id — remove an unreferenced entity (cleanup). */
  @Delete(':id')
  async delete(@Param('id', ParseIntPipe) id: number): Promise<Entity> {
    return this.entitiesService.delete(id);
  }
}
