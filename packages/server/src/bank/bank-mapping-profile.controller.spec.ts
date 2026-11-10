import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { BankMappingProfileRepository } from './bank-mapping-profile.repository';
import { BankMappingProfileController } from './bank-ingestion.controller';
import type { MappingRuleset } from './bank-mapping.types';

const ruleset: MappingRuleset = {
  account_code: 'BANK_EUR',
  date_column: 'Date',
  date_format: 'YYYY-MM-DD',
  amount: { mode: 'signed', column: 'Amount' },
  currency_column: 'Currency',
  default_currency: 'EUR',
  description_column: null,
  counterparty_iban_column: null,
  counterparty_descriptor_column: null,
  reference_column: null,
};

describe('BankMappingProfileController (integration)', () => {
  let db: Kysely<Database>;
  let repo: BankMappingProfileRepository;
  let controller: BankMappingProfileController;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('Migration failed');

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BankMappingProfileController],
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        BankMappingProfileRepository,
      ],
    }).compile();

    repo = module.get(BankMappingProfileRepository);
    controller = module.get(BankMappingProfileController);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('GET /api/bank-mapping-profiles lists profiles, optionally by account', async () => {
    await repo.save({
      accountCode: 'BANK_EUR',
      headerHash: 'hash-a',
      headerColumns: ['Date', 'Amount', 'Currency'],
      ruleset,
      sourceJobId: 22,
    });
    await repo.save({
      accountCode: 'BANK_USD',
      headerHash: 'hash-b',
      headerColumns: ['Date', 'Amount', 'Currency'],
      ruleset,
    });

    const all = await controller.list();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({
      account_code: 'BANK_EUR',
      header_json: '["Date","Amount","Currency"]',
      source_job_id: 22,
    });

    const eur = await controller.list('BANK_EUR');
    expect(eur).toHaveLength(1);
    expect(eur[0].account_code).toBe('BANK_EUR');
  });

  it('DELETE /api/bank-mapping-profiles/:id deletes one profile', async () => {
    const saved = await repo.save({
      accountCode: 'BANK_EUR',
      headerHash: 'hash-a',
      headerColumns: ['Date', 'Amount', 'Currency'],
      ruleset,
    });

    await expect(controller.remove(saved.id)).resolves.toEqual({
      deleted: saved.id,
    });
    await expect(repo.list()).resolves.toHaveLength(0);
  });

  it('DELETE /api/bank-mapping-profiles/:id returns 404 for an unknown id', async () => {
    let error: unknown;
    try {
      await controller.remove(9999);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(NotFoundException);
  });
});
