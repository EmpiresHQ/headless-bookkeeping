import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';
import { AccountService } from '../../ledger/account/account.service';
import {
  rollUpLines,
  unmappedNonzeroCodes,
} from '../../plugins/estonia-annual-accounts/rtj-mapping';

describe('migration 081 — tax accounts', () => {
  let db: Kysely<Database>;
  let migrator: Migrator;

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
    });
    migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateTo(
      '080_add_document_classification_snapshot',
    );
    if (error) throw error;
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('upgrades the chart without changing existing accounts and exposes tax assets through the account service', async () => {
    const service = new AccountService(db);
    const before = await service.getAccounts();
    const { error } = await migrator.migrateTo('081_add_tax_accounts');
    if (error) throw error;
    const codes = [
      'INCOME_TAX_RECEIVABLE',
      'TAX_PREPAYMENTS',
      'INCOME_TAX_PAYABLE',
    ];
    const after = await service.getAccounts();
    expect(after.filter((account) => !codes.includes(account.code))).toEqual(
      before,
    );
    for (const code of codes) {
      expect(await service.getAccountByCode(code)).toMatchObject({
        code,
        type: code === 'INCOME_TAX_PAYABLE' ? 'liability' : 'asset',
        is_system: true,
        currency: null,
        parent_id: null,
      });
    }
    const rerun = await migrator.migrateTo('081_add_tax_accounts');
    expect(rerun.error).toBeUndefined();
    expect(await service.getAccounts()).toHaveLength(before.length + 3);
    const rollback = await migrator.migrateTo(
      '080_add_document_classification_snapshot',
    );
    if (rollback.error) throw rollback.error;
    expect(await service.getAccounts()).toEqual(before);
  });

  it('reports tax assets and liabilities separately in annual accounts', () => {
    const balances = [
      {
        code: 'INCOME_TAX_PAYABLE',
        type: 'liability' as const,
        current: 80,
        prior: 20,
      },
      {
        code: 'INCOME_TAX_RECEIVABLE',
        type: 'asset' as const,
        current: 120,
        prior: 50,
      },
      {
        code: 'TAX_PREPAYMENTS',
        type: 'asset' as const,
        current: 300,
        prior: 100,
      },
    ];
    expect(unmappedNonzeroCodes(balances)).toEqual([]);
    expect(
      rollUpLines(balances).find(
        (line) => line.id === 'receivablesAndPrepayments',
      ),
    ).toMatchObject({ current: 420, prior: 150 });
    expect(
      rollUpLines(balances).find(
        (line) => line.id === 'payablesAndPrepayments',
      ),
    ).toMatchObject({ current: 80, prior: 20 });
  });
});
