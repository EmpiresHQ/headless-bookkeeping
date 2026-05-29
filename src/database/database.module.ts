import { Module, OnModuleInit } from '@nestjs/common';
import { KyselyModule, InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import { SqliteDialect } from 'kysely';
import Database from 'better-sqlite3';
import { migrations } from './migrations';

class MigrationRunner implements OnModuleInit {
  constructor(@InjectKysely() private readonly db: Kysely<any>) {}

  async onModuleInit() {
    const migrator = new Migrator({
      db: this.db,
      provider: {
        getMigrations: () => Promise.resolve(migrations),
      },
    });

    const { error, results } = await migrator.migrateToLatest();

    results?.forEach((it) => {
      if (it.status === 'Success') {
        console.log(`migration "${it.migrationName}" executed successfully`);
      } else if (it.status === 'Error') {
        console.error(`failed to execute migration "${it.migrationName}"`);
      }
    });

    if (error) {
      console.error('failed to migrate');
      console.error(error);
      throw error instanceof Error ? error : new Error('Migration failed');
    }
  }
}

@Module({
  imports: [
    KyselyModule.forRoot({
      dialect: new SqliteDialect({
        database: new Database('./data/app.sqlite'),
      }),
    }),
  ],
  providers: [MigrationRunner],
  exports: [KyselyModule],
})
export class DatabaseModule {}
