import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { SalesInvoicesController } from './sales-invoices.controller';
import { SalesInvoicesService } from './sales-invoices.service';
import { AccountService } from '../ledger/account/account.service';
import { RulesService } from '../rules/rules.service';
import { PolicyService } from '../policy/policy.service';
import { PostingService } from '../ledger/posting/posting.service';
import { OrganizationService } from '../organization/organization.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { SalesInvoice } from './types';
import { DraftVoucher } from '../ledger/voucher/types';

describe('SalesInvoicesController', () => {
  let controller: SalesInvoicesController;

  const mockInvoice: SalesInvoice = {
    id: 1,
    customer_id: null,
    invoice_number: 'INV-2026-001',
    gross_amount: 12300,
    vat_amount: 2300,
    currency: 'EUR',
    tax_point_date: '2026-03-15',
    due_date: '2026-04-15',
    status: 'draft',
    sent_at: null,
    voucher_id: null,
    created_at: 1740000000,
    updated_at: 1740000000,
  };

  const mockDraft: DraftVoucher = {
    voucher_number: 'INV-2026-001',
    tax_point_date: '2026-03-15',
    lines: [
      {
        account_code: 'AR',
        amount: 12300,
        currency: 'EUR',
        base_amount: 12300,
        fx_rate: 1,
        vat_code: null,
        is_debit: true,
      },
      {
        account_code: 'REVENUE',
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        vat_code: 'IE_OUTPUT_23',
        is_debit: false,
      },
      {
        account_code: 'VAT_PAYABLE',
        amount: 2300,
        currency: 'EUR',
        base_amount: 2300,
        fx_rate: 1,
        vat_code: 'IE_OUTPUT_23',
        is_debit: false,
      },
    ],
  };

  const mockService = {
    createInvoice: jest.fn(),
    getInvoices: jest.fn(),
    generateDraftVoucher: jest.fn(),
    sendInvoice: jest.fn(),
    updateInvoiceStatus: jest.fn(),
  };

  const mockAccountService = { getAccountsByCodes: jest.fn() };
  const mockRulesService = { validate: jest.fn() };
  const mockPolicyService = { decide: jest.fn() };
  const mockPostingService = { postVoucher: jest.fn() };
  const mockOrgService = { getOrganization: jest.fn() };
  const mockPluginLoader = { resolve: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SalesInvoicesController],
      providers: [
        { provide: SalesInvoicesService, useValue: mockService },
        { provide: AccountService, useValue: mockAccountService },
        { provide: RulesService, useValue: mockRulesService },
        { provide: PolicyService, useValue: mockPolicyService },
        { provide: PostingService, useValue: mockPostingService },
        { provide: OrganizationService, useValue: mockOrgService },
        { provide: PluginLoader, useValue: mockPluginLoader },
      ],
    }).compile();

    controller = module.get<SalesInvoicesController>(SalesInvoicesController);
    jest.clearAllMocks();
  });

  it('GET /api/sales-invoices wraps the list under an invoices key', async () => {
    mockService.getInvoices.mockResolvedValue([mockInvoice]);
    const result = await controller.getInvoices();
    expect(result.invoices).toEqual([mockInvoice]);
    expect(mockService.getInvoices).toHaveBeenCalledTimes(1);
  });

  it('POST /api/sales-invoices creates an invoice with draft status', async () => {
    mockService.createInvoice.mockResolvedValue(mockInvoice);
    const dto = {
      invoice_number: 'INV-2026-001',
      gross_amount: 12300,
      vat_amount: 2300,
      currency: 'EUR',
      tax_point_date: '2026-03-15',
    };
    const result = await controller.createInvoice(dto);
    expect(result.invoice_number).toBe('INV-2026-001');
    expect(result.status).toBe('draft');
    expect(mockService.createInvoice).toHaveBeenCalledWith(dto);
  });

  it('POST /api/sales-invoices throws ConflictException on duplicate invoice_number', async () => {
    const err = new Error(
      'UNIQUE constraint failed: sales_invoice.invoice_number',
    );
    mockService.createInvoice.mockRejectedValue(err);
    const dto = {
      invoice_number: 'INV-2026-001',
      gross_amount: 12300,
      vat_amount: 2300,
      currency: 'EUR',
      tax_point_date: '2026-03-15',
    };
    await expect(controller.createInvoice(dto)).rejects.toThrow(
      ConflictException,
    );
  });

  it('POST /api/sales-invoices/:id/generate-draft returns a transient draft voucher', async () => {
    mockService.generateDraftVoucher.mockResolvedValue(mockDraft);
    const result = await controller.generateDraft('1');
    expect(result.draft.voucher_number).toBe('INV-2026-001');
    expect(result.draft.lines).toHaveLength(3);
    expect(mockService.generateDraftVoucher).toHaveBeenCalledWith(1);
  });

  it('POST /api/sales-invoices/:id/send sets sent_at without changing status', async () => {
    const sentInvoice = { ...mockInvoice, sent_at: 1740000100 };
    mockService.sendInvoice.mockResolvedValue(sentInvoice);
    const result = await controller.sendInvoice('1');
    expect(result.sent_at).toBe(1740000100);
    expect(result.status).toBe('draft');
    expect(mockService.sendInvoice).toHaveBeenCalledWith(1);
  });
});
