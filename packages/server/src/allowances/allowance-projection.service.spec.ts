import { Test, TestingModule } from '@nestjs/testing';
import {
  AllowanceProjectionService,
  AllowanceRow,
} from './allowance-projection.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { NULL_VAT_CODE } from '../ledger/posting/vat-constants';

function stubAllowance(overrides: Partial<AllowanceRow>): AllowanceRow {
  return {
    id: 1,
    claimant_id: 1,
    trip_id: null,
    type: 'daily_allowance',
    days: null,
    km: null,
    input_amount: null,
    route_description: null,
    gross_amount: 0,
    tax_free_amount: 0,
    taxable_amount: 0,
    currency: 'EUR',
    breakdown: null,
    period_start: '2026-06-01',
    period_end: null,
    status: 'draft',
    voucher_id: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe('AllowanceProjectionService', () => {
  let service: AllowanceProjectionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AllowanceProjectionService, NullCountryPlugin],
    }).compile();

    service = module.get(AllowanceProjectionService);
  });

  it('projects zero-taxable daily_allowance — 2 lines', async () => {
    const allowance = stubAllowance({
      type: 'daily_allowance',
      gross_amount: 45000,
      tax_free_amount: 45000,
      taxable_amount: 0,
      period_start: '2026-06-10',
      claimant_id: 1,
    });
    const draft = await service.project(allowance);

    expect(draft.lines).toHaveLength(2);
    const debit = draft.lines.find(
      (l) => l.account_code === 'EXPENSE_TRAVEL' && l.is_debit,
    );
    const credit = draft.lines.find(
      (l) => l.account_code === 'CLAIMANT_PAYABLE' && !l.is_debit,
    );
    expect(debit?.amount).toBe(45000);
    expect(credit?.amount).toBe(45000); // positive, is_debit: false
    expect(debit?.vat_code).toBe(NULL_VAT_CODE);
  });

  it('sets tax_point_date from period_start', async () => {
    const allowance = stubAllowance({
      type: 'daily_allowance',
      gross_amount: 10000,
      tax_free_amount: 10000,
      taxable_amount: 0,
      period_start: '2026-06-10',
    });
    const draft = await service.project(allowance);
    expect(draft.tax_point_date).toBe('2026-06-10');
  });

  it('projects mileage with taxable split — 3 lines', async () => {
    const allowance = stubAllowance({
      type: 'mileage',
      gross_amount: 12000,
      tax_free_amount: 5000,
      taxable_amount: 7000,
      period_start: '2026-06-20',
      claimant_id: 1,
    });
    const draft = await service.project(allowance);

    expect(draft.lines).toHaveLength(3);
    const travelDebit = draft.lines.find(
      (l) => l.account_code === 'EXPENSE_TRAVEL' && l.is_debit,
    );
    const salaryDebit = draft.lines.find(
      (l) => l.account_code === 'EXPENSE_SALARY' && l.is_debit,
    );
    const credit = draft.lines.find(
      (l) => l.account_code === 'CLAIMANT_PAYABLE' && !l.is_debit,
    );

    expect(travelDebit?.amount).toBe(5000);
    expect(salaryDebit?.amount).toBe(7000);
    expect(salaryDebit?.metadata?.payroll_flag).toBe(true);
    expect(credit?.amount).toBe(12000);
  });

  it('credit line uses is_debit: false with positive amount', async () => {
    const allowance = stubAllowance({
      type: 'daily_allowance',
      gross_amount: 30000,
      tax_free_amount: 30000,
      taxable_amount: 0,
      period_start: '2026-06-15',
    });
    const draft = await service.project(allowance);
    const credit = draft.lines.find(
      (l) => l.account_code === 'CLAIMANT_PAYABLE',
    );
    expect(credit?.is_debit).toBe(false);
    expect(credit?.amount).toBeGreaterThan(0);
  });

  it('all lines carry NULL_VAT_CODE', async () => {
    const allowance = stubAllowance({
      type: 'mileage',
      gross_amount: 12000,
      tax_free_amount: 5000,
      taxable_amount: 7000,
      period_start: '2026-06-20',
    });
    const draft = await service.project(allowance);
    for (const line of draft.lines) {
      expect(line.vat_code).toBe(NULL_VAT_CODE);
    }
  });

  it('all lines use fx_rate 1 and base_amount = amount', async () => {
    const allowance = stubAllowance({
      type: 'daily_allowance',
      gross_amount: 45000,
      tax_free_amount: 45000,
      taxable_amount: 0,
      period_start: '2026-06-10',
    });
    const draft = await service.project(allowance);
    for (const line of draft.lines) {
      expect(line.fx_rate).toBe(1);
      expect(line.base_amount).toBe(line.amount);
    }
  });

  it('balances in base currency: sum debits === sum credits', async () => {
    const allowance = stubAllowance({
      type: 'mileage',
      gross_amount: 12000,
      tax_free_amount: 5000,
      taxable_amount: 7000,
      period_start: '2026-06-20',
    });
    const draft = await service.project(allowance);
    const totalDebits = draft.lines
      .filter((l) => l.is_debit)
      .reduce((s, l) => s + l.base_amount, 0);
    const totalCredits = draft.lines
      .filter((l) => !l.is_debit)
      .reduce((s, l) => s + l.base_amount, 0);
    expect(totalDebits).toBe(totalCredits);
  });

  it('uses EXPENSE_TRAVEL for mileage type', async () => {
    const allowance = stubAllowance({
      type: 'mileage',
      gross_amount: 5000,
      tax_free_amount: 5000,
      taxable_amount: 0,
      period_start: '2026-06-01',
    });
    const draft = await service.project(allowance);
    const debit = draft.lines.find((l) => l.is_debit);
    expect(debit?.account_code).toBe('EXPENSE_TRAVEL');
  });
});
