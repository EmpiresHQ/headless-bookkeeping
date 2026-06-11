import { Module } from '@nestjs/common';
import { PluginsModule } from '../plugins/plugins.module';
import { OrganizationModule } from '../organization/organization.module';
import { CategoriesController } from './categories.controller';
import { CategoryService } from './category.service';

@Module({
  imports: [PluginsModule, OrganizationModule],
  controllers: [CategoriesController],
  providers: [CategoryService],
  exports: [CategoryService],
})
export class CategoriesModule {}
