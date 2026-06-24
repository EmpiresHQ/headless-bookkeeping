import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { KyselyModule, InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import { SqliteDialect } from 'kysely';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { Database as DBType } from './types';
import { migrations } from './migrations';
import { dataDir } from '../common/paths';

class MigrationRunner implements OnModuleInit {
  private readonly logger = new Logger(MigrationRunner.name);
  constructor(@InjectKysely() private readonly db: Kysely<DBType>) {}

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
        this.logger.log(`migration "${it.migrationName}" executed successfully`);
      } else if (it.status === 'Error') {
        this.logger.error(
          `failed to execute migration "${it.migrationName}"`,
        );
      }
    });

    if (error) {
      this.logger.error('failed to migrate');
      this.logger.error(error);
      throw error instanceof Error ? error : new Error('Migration failed');
    }
  }
}

@Module({
  imports: [
    KyselyModule.forRoot({
      dialect: new SqliteDialect({
        database: (() => {
          const db = new Database(join(dataDir(), 'app.sqlite'));
          db.pragma('foreign_keys = ON');
          return db;
        })(),
      }),
    }),
  ],
  providers: [MigrationRunner],
  exports: [KyselyModule],
})
export class DatabaseModule {}
