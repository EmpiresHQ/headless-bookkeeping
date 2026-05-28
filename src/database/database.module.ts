import { Module } from '@nestjs/common';
import { KyselyModule } from 'nestjs-kysely';
import { SqliteDialect } from 'kysely';
import Database from 'better-sqlite3';

@Module({
  imports: [
    KyselyModule.forRoot({
      dialect: new SqliteDialect({
        database: new Database('./data/app.sqlite'),
      }),
    }),
  ],
})
export class DatabaseModule {}
