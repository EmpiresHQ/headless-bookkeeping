import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  ParseIntPipe,
} from '@nestjs/common';
import { EntitiesService } from './entities.service';
import type { OnboardEntityDto, EntityWithIdentifiers, Entity } from './types';

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
}
