import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from './database/types';

@Injectable()
export class AppService implements OnModuleInit {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  async onModuleInit() {
    // Ensure table exists
    await this.db.schema
      .createTable('users')
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      .addColumn('email', 'text', (col) => col.notNull().unique())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('created_at', 'integer', (col) => col.notNull())
      .execute();

    // Seed a demo user if table is empty
    const count = await this.db
      .selectFrom('users')
      .select((eb) => eb.fn.countAll().as('count'))
      .executeTakeFirst();

    if (count && Number(count.count) === 0) {
      await this.db
        .insertInto('users')
        .values({
          email: 'demo@example.com',
          name: 'Demo User',
          created_at: Math.floor(Date.now() / 1000),
        })
        .execute();
    }
  }

  async getHello(): Promise<string> {
    const users = await this.db.selectFrom('users').selectAll().execute();
    return `Hello! Found ${users.length} user(s).`;
  }

  async getUsers() {
    return this.db.selectFrom('users').selectAll().execute();
  }
}
