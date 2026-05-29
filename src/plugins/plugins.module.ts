import { Module } from '@nestjs/common';
import { NullCountryPlugin } from './null-country.plugin';
import { PluginLoader } from './plugin-loader.service';

@Module({
  providers: [NullCountryPlugin, PluginLoader],
  exports: [PluginLoader, NullCountryPlugin],
})
export class PluginsModule {}
