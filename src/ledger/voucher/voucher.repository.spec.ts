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

  it('createVoucher inserts a row and returns it with an id', async () => {
    const v = await repo.createVoucher({
      voucher_number: 'V-2026-001',
      tax_point_date: '2026-03-15',
      posted_at: 1740000000,
    });
    expect(v.id).toBeGreaterThan(0);
    expect(v.voucher_number).toBe('V-2026-001');
    expect(v.tax_point_date).toBe('2026-03-15');
    expect(v.posted_at).toBe(1740000000);
    expect(v.previous_hash).toBeNull();
  });

  it('getVoucherById returns the persisted voucher', async () => {
    const created = await repo.createVoucher({
      voucher_number: 'V-2026-002',
      tax_point_date: '2026-03-16',
      posted_at: null,
    });
    const fetched = await repo.getVoucherById(created.id);
    expect(fetched?.voucher_number).toBe('V-2026-002');
  });

  it('getVoucherById returns null for an unknown id', async () => {
    await expect(repo.getVoucherById(9999)).resolves.toBeNull();
  });

  it('getVouchers is empty on a fresh DB and reflects inserts', async () => {
    expect(await repo.getVouchers()).toEqual([]);
    await repo.createVoucher({
      voucher_number: 'V-2026-003',
      tax_point_date: '2026-03-17',
      posted_at: null,
    });
    expect(await repo.getVouchers()).toHaveLength(1);
  });

  it('enforces voucher_number UNIQUE at the DB level (G6)', async () => {
    await repo.createVoucher({
      voucher_number: 'V-2026-DUP',
      tax_point_date: '2026-03-18',
      posted_at: null,
    });
    await expect(
      repo.createVoucher({
        voucher_number: 'V-2026-DUP',
        tax_point_date: '2026-03-19',
        posted_at: null,
      }),
    ).rejects.toThrow();
  });
});
