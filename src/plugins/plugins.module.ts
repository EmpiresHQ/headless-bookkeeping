import { Module } from '@nestjs/common';
import { NullCountryPlugin } from './null-country.plugin';
import { EstoniaCountryPlugin } from './estonia-country.plugin';
import { PluginLoader } from './plugin-loader.service';

@Module({
  providers: [NullCountryPlugin, EstoniaCountryPlugin, PluginLoader],
  exports: [PluginLoader, NullCountryPlugin, EstoniaCountryPlugin],
})
export class PluginsModule {}
