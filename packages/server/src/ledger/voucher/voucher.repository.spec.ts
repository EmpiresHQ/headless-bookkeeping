import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../../database/types';
import { migrations } from '../../database/migrations';
import { VoucherRepository } from './voucher.repository';

describe('VoucherRepository (integration)', () => {
  let db: Kysely<Database>;
  let repo: VoucherRepository;

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('Migration failed');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        VoucherRepository,
      ],
    }).compile();

    repo = module.get(VoucherRepository);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('getVoucherById returns the persisted voucher', async () => {
    await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-2026-002',
        tax_point_date: '2026-03-16',
        posted_at: null,
      })
      .execute();
    const all = await repo.getVouchers();
    const fetched = await repo.getVoucherById(all[0].id);
    expect(fetched?.voucher_number).toBe('V-2026-002');
  });

  it('getVoucherById returns null for an unknown id', async () => {
    await expect(repo.getVoucherById(9999)).resolves.toBeNull();
  });

  it('getVouchers is empty on a fresh DB and reflects inserts', async () => {
    expect(await repo.getVouchers()).toEqual([]);
    await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-2026-003',
        tax_point_date: '2026-03-17',
        posted_at: null,
      })
      .execute();
    expect(await repo.getVouchers()).toHaveLength(1);
  });

  it('enforces voucher_number UNIQUE at the DB level (G6)', async () => {
    await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-2026-DUP',
        tax_point_date: '2026-03-18',
        posted_at: null,
      })
      .execute();
    let threw = false;
    try {
      await db
        .insertInto('voucher')
        .values({
          voucher_number: 'V-2026-DUP',
          tax_point_date: '2026-03-19',
          posted_at: null,
        })
        .execute();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
