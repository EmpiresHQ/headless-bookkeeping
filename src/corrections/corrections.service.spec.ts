import { Test, TestingModule } from '@nestjs/testing';
import { CorrectionsService } from './corrections.service';
import { PostingService } from '../ledger/posting/posting.service';
import { VoucherRepository } from '../ledger/voucher/voucher.repository';
import { VoucherLineRepository } from '../ledger/voucher/voucher-line.repository';
import { AccountService } from '../ledger/account/account.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { ExpensesService } from '../expenses/expenses.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
import { CorrectionRequest } from './types';
import { DraftVoucher, PostedVoucher } from '../ledger/voucher/types';

describe('CorrectionsService (unit)', () => {
  let service: CorrectionsService;

  const mockPostingService = {
    postVouchersAtomic: jest.fn(),
  };

  const mockPeriodLock = {
    findLockedPeriod: jest.fn(),
    getCurrentOpenPeriod: jest.fn(),
  };

  const mockVoucherRepository = {
    getVoucherById: jest.fn(),
  };

  const mockVoucherLineRepository = {
    getLinesByVoucherId: jest.fn(),
  };

  const mockAccountService = {
    getAccountsByIds: jest.fn(),
  };

  const mockExpensesService = {
    getExpenseById: jest.fn(),
    updateDraft: jest.fn(),
    generateDraftVoucher: jest.fn(),
    previewPatchedDraft: jest.fn(),
    patchAmountsTx: jest.fn(),
    markReversedTx: jest.fn(),
  };

  const mockSalesInvoicesService = {
    getInvoiceById: jest.fn(),
    updateDraft: jest.fn(),
    generateDraftVoucher: jest.fn(),
    previewPatchedDraft: jest.fn(),
    patchAmountsTx: jest.fn(),
    markReversedTx: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CorrectionsService,
        { provide: PostingService, useValue: mockPostingService },
        { provide: VoucherRepository, useValue: mockVoucherRepository },
        { provide: VoucherLineRepository, useValue: mockVoucherLineRepository },
        { provide: AccountService, useValue: mockAccountService },
        { provide: PeriodLockService, useValue: mockPeriodLock },
        { provide: ExpensesService, useValue: mockExpensesService },
        { provide: SalesInvoicesService, useValue: mockSalesInvoicesService },
      ],
    }).compile();

    service = module.get(CorrectionsService);
  });

  describe('branch selection', () => {
    it('cosmetic → cosmetic_attachment_replaced', async () => {
      mockExpensesService.getExpenseById.mockResolvedValue({
        id: 1,
        status: 'posted',
        voucher_id: 10,
      });

      const request: CorrectionRequest = {
        kind: 'cosmetic',
        reason: 'Better scan uploaded',
      };

      const result = await service.correctExpense(1, request);
      expect(result.outcome).toBe('cosmetic_attachment_replaced');
    });

    it('credit_note → credit_note_not_implemented', async () => {
      mockExpensesService.getExpenseById.mockResolvedValue({
        id: 1,
        status: 'posted',
        voucher_id: 10,
      });

      const request: CorrectionRequest = {
        kind: 'credit_note',
        reason: 'Supplier sent credit note',
      };

      const result = await service.correctExpense(1, request);
      expect(result.outcome).toBe('credit_note_not_implemented');
    });

    it('financial + draft → draft_edited', async () => {
      mockExpensesService.getExpenseById.mockResolvedValue({
        id: 1,
        status: 'draft',
        voucher_id: null,
      });

      const draft: DraftVoucher = {
        voucher_number: 'DRAFT-EXP-1-123',
        tax_point_date: '2026-03-15',
        lines: [],
      };
      mockExpensesService.generateDraftVoucher.mockResolvedValue(draft);

      const request: CorrectionRequest = {
        kind: 'financial',
        reason: 'Wrong amount',
        patch: { gross_amount: 15000 },
      };

      const result = await service.correctExpense(1, request);
      expect(result.outcome).toBe('draft_edited');
      expect(mockExpensesService.updateDraft).toHaveBeenCalledWith(1, {
        gross_amount: 15000,
      });
      expect(mockExpensesService.generateDraftVoucher).toHaveBeenCalledWith(1);
    });

    it('financial + pending → draft_edited', async () => {
      mockExpensesService.getExpenseById.mockResolvedValue({
        id: 1,
        status: 'pending',
        voucher_id: null,
      });

      const draft: DraftVoucher = {
        voucher_number: 'DRAFT-EXP-1-123',
        tax_point_date: '2026-03-15',
        lines: [],
      };
      mockExpensesService.generateDraftVoucher.mockResolvedValue(draft);

      const request: CorrectionRequest = {
        kind: 'financial',
        reason: 'Wrong VAT',
        patch: { vat_amount: 3000 },
      };

      const result = await service.correctExpense(1, request);
      expect(result.outcome).toBe('draft_edited');
    });

    it('financial + posted → posted_reversal_and_correction', async () => {
      mockExpensesService.getExpenseById.mockResolvedValue({
        id: 1,
        status: 'posted',
        voucher_id: 10,
      });

      mockVoucherRepository.getVoucherById.mockResolvedValue({
        id: 10,
        voucher_number: 'V-2026-001',
        tax_point_date: '2026-03-15',
        posted_at: 1710000000,
        previous_hash: 'abc',
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      });

      mockVoucherLineRepository.getLinesByVoucherId.mockResolvedValue([
        {
          id: 100,
          voucher_id: 10,
          account_id: 1,
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          vat_code: 'IE_INPUT_23',
          is_debit: true,
        },
        {
          id: 101,
          voucher_id: 10,
          account_id: 2,
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          vat_code: null,
          is_debit: false,
        },
      ]);

      mockAccountService.getAccountsByIds.mockResolvedValue([
        {
          id: 1,
          code: 'EXPENSE_SOFTWARE',
          name: 'Software',
          type: 'expense',
          currency: null,
          parent_id: null,
          is_system: true,
        },
        {
          id: 2,
          code: 'CASH',
          name: 'Cash',
          type: 'asset',
          currency: null,
          parent_id: null,
          is_system: true,
        },
      ]);

      const reversalVoucher: PostedVoucher = {
        id: 20,
        voucher_number: 'V-2026-001-REV',
        tax_point_date: '2026-03-15',
        posted_at: 1710000001,
        previous_hash: 'def',
        reverses_id: 10,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: 'Wrong amount',
        lines: [],
      };

      const correctedVoucher: PostedVoucher = {
        id: 21,
        voucher_number: 'V-2026-001-COR',
        tax_point_date: '2026-03-15',
        posted_at: 1710000002,
        previous_hash: 'ghi',
        reverses_id: null,
        corrects_object_type: 'expense',
        corrects_object_id: 1,
        reason: 'Wrong amount',
        lines: [],
      };

      mockPostingService.postVouchersAtomic.mockResolvedValue([
        reversalVoucher,
        correctedVoucher,
      ]);

      const correctedDraft: DraftVoucher = {
        voucher_number: 'DRAFT-EXP-1-456',
        tax_point_date: '2026-03-15',
        lines: [
          {
            account_code: 'EXPENSE_SOFTWARE',
            amount: 15000,
            currency: 'EUR',
            base_amount: 15000,
            fx_rate: 1,
            is_debit: true,
          },
          {
            account_code: 'CASH',
            amount: 15000,
            currency: 'EUR',
            base_amount: 15000,
            fx_rate: 1,
            is_debit: false,
          },
        ],
      };
      mockExpensesService.previewPatchedDraft.mockResolvedValue(correctedDraft);

      const request: CorrectionRequest = {
        kind: 'financial',
        reason: 'Wrong amount',
        patch: { gross_amount: 15000 },
      };

      const result = await service.correctExpense(1, request);
      expect(result.outcome).toBe('posted_reversal_and_correction');
      expect(result.reversalVoucherId).toBe(20);
      expect(result.correctedVoucherId).toBe(21);

      // Both vouchers are posted atomically in a single call: [reversal, corrected].
      const atomicCall = (
        mockPostingService.postVouchersAtomic.mock.calls as unknown as Array<
          [
            [
              {
                voucher_number: string;
                reverses_id?: number;
                corrects_object_type?: string;
                corrects_object_id?: number;
                reason: string;
                lines: Array<{ is_debit: boolean }>;
              },
              {
                voucher_number: string;
                corrects_object_type?: string;
                corrects_object_id?: number;
                reason: string;
              },
            ],
          ]
        >
      )[0][0];
      const [reversalArg, correctedArg] = atomicCall;

      // Verify reversal draft was built correctly
      expect(reversalArg.reverses_id).toBe(10);
      expect(reversalArg.reason).toBe('Wrong amount');
      expect(reversalArg.lines).toHaveLength(2);
      expect(reversalArg.lines[0].is_debit).toBe(false); // flipped
      expect(reversalArg.lines[1].is_debit).toBe(true); // flipped

      // Verify corrected draft
      expect(correctedArg.corrects_object_type).toBe('expense');
      expect(correctedArg.corrects_object_id).toBe(1);
      expect(correctedArg.reason).toBe('Wrong amount');

      // The patch + status flip ride inside the posting transaction via hooks
      // (exercised end-to-end in the integration spec, where the real
      // postVouchersAtomic runs them).
    });

    it('reversed status → unsupported_status', async () => {
      mockExpensesService.getExpenseById.mockResolvedValue({
        id: 1,
        status: 'reversed',
        voucher_id: 10,
      });

      const request: CorrectionRequest = {
        kind: 'financial',
        reason: 'Try again',
      };

      const result = await service.correctExpense(1, request);
      expect(result.outcome).toBe('unsupported_status');
    });
  });
});
