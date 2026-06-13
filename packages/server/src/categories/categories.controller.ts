import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CategoryService } from './category.service';
import type { CategoryDef } from '../plugins/country-plugin.interface';

@ApiTags('categories')
@Controller('api/categories')
export class CategoriesController {
  constructor(private readonly categoryService: CategoryService) {}

  @Get()
  @ApiOperation({ summary: 'List expense categories', description: 'Return all expense category definitions.' })
  async getCategories(): Promise<{ categories: CategoryDef[] }> {
    return { categories: await this.categoryService.list() };
  }
}
