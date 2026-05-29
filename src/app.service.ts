import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from './database/types';

@Injectable()
export class AppService {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  async getHello(): Promise<string> {
    const orgs = await this.db.selectFrom('organization').selectAll().execute();
    return `Hello! Found ${orgs.length} organization(s).`;
  }

  async getUsers() {
    return this.db.selectFrom('organization').selectAll().execute();
  }
}
