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
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
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
  @ApiOperation({ summary: 'Onboard an entity', description: 'Create a counterparty (supplier/customer) with identifiers.' })
  async onboard(@Body() dto: OnboardEntityDto): Promise<EntityWithIdentifiers> {
    return this.entitiesService.onboard(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List entities', description: 'Return all entities.' })
  async list(): Promise<{ entities: Entity[] }> {
    return { entities: await this.entitiesService.list() };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an entity by id', description: 'Fetch a single entity.' })
  @ApiParam({ name: 'id', description: 'Entity id' })
  async findById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<EntityWithIdentifiers> {
    return this.entitiesService.findById(id);
  }

  /** PATCH /api/entities/:id — update mutable intrinsic facts (C4). */
  @Patch(':id')
  @ApiOperation({ summary: 'Update an entity', description: "Update an entity's fields." })
  @ApiParam({ name: 'id', description: 'Entity id' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEntityDto,
  ): Promise<EntityWithIdentifiers> {
    return this.entitiesService.update(id, dto);
  }

  /** POST /api/entities/:id/aliases — add an identifier/alias (C4). */
  @Post(':id/aliases')
  @ApiOperation({ summary: 'Add an entity alias', description: 'Add an alias/identifier to an entity.' })
  @ApiParam({ name: 'id', description: 'Entity id' })
  async addAlias(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddAliasDto,
  ): Promise<EntityIdentifier> {
    return this.entitiesService.addAlias(id, dto);
  }

  /** POST /api/entities/:survivorId/merge — merge a duplicate entity into the survivor. */
  @Post(':survivorId/merge')
  @ApiOperation({ summary: 'Merge a duplicate entity', description: 'Merge a duplicate entity into the survivor entity.' })
  @ApiParam({ name: 'survivorId', description: 'Survivor entity id' })
  async merge(
    @Param('survivorId', ParseIntPipe) survivorId: number,
    @Body() dto: MergeEntityDto,
  ): Promise<EntityWithIdentifiers> {
    return this.entitiesService.mergeInto(survivorId, dto.duplicate_id);
  }

  /** DELETE /api/entities/:id — remove an unreferenced entity (cleanup). */
  @Delete(':id')
  @ApiOperation({ summary: 'Delete an entity', description: 'Delete an entity.' })
  @ApiParam({ name: 'id', description: 'Entity id' })
  async delete(@Param('id', ParseIntPipe) id: number): Promise<Entity> {
    return this.entitiesService.delete(id);
  }
}
