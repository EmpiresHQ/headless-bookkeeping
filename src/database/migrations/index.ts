import { Migration } from 'kysely/migration';
import * as m001 from './001_create_organization';
import * as m002 from './002_create_account';

export const migrations: Record<string, Migration> = {
  '001_create_organization': m001,
  '002_create_account': m002,
};
