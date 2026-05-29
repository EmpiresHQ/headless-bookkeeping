import { Migration } from 'kysely/migration';
import * as m001 from './001_create_organization';

export const migrations: Record<string, Migration> = {
  '001_create_organization': m001,
};
