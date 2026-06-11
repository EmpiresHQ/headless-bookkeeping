import { Test, TestingModule } from '@nestjs/testing';
import { MethodNotAllowedException } from '@nestjs/common';
import { VoucherController } from './voucher.controller';
import { PostingService } from '../posting/posting.service';
import { VoucherRepository } from './voucher.repository';
import { VoucherLineRepository } from './voucher-line.repository';
import { Voucher } from './types';
import { GENESIS_HASH } from '../posting/voucher-hash';

describe('VoucherController (immutability)', () => {
  let controller: VoucherController;

  const posted: Voucher = {
    id: 1,
    voucher_number: 'V-2026-001',
    tax_point_date: '2026-01-15',
    posted_at: 1740000000,
    previous_hash: GENESIS_HASH,
    reverses_id: null,
    corrects_object_type: null,
    corrects_object_id: null,
    reason: null,
  };

  const mockPosting = { postVoucher: jest.fn() };
  const mockVoucherRepo = {
    getVouchers: jest.fn(),
    getVoucherById: jest.fn(),
  };
  const mockLineRepo = { getLinesByVoucherId: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [VoucherController],
      providers: [
        { provide: PostingService, useValue: mockPosting },
        { provide: VoucherRepository, useValue: mockVoucherRepo },
        { provide: VoucherLineRepository, useValue: mockLineRepo },
      ],
    }).compile();

    controller = module.get<VoucherController>(VoucherController);
    jest.clearAllMocks();
  });

  it('PUT /api/vouchers/:id throws MethodNotAllowedException (405)', () => {
    expect(() => controller.updateVoucher('1')).toThrow(
      MethodNotAllowedException,
    );
    expect(() => controller.updateVoucher('1')).toThrow(
      'Posted vouchers are immutable',
    );
  });

  it('PATCH /api/vouchers/:id throws MethodNotAllowedException (405)', () => {
    expect(() => controller.patchVoucher('1')).toThrow(
      MethodNotAllowedException,
    );
  });

  it('DELETE /api/vouchers/:id throws MethodNotAllowedException (405)', () => {
    expect(() => controller.deleteVoucher('1')).toThrow(
      MethodNotAllowedException,
    );
  });

  it('GET /api/vouchers/:id still returns the voucher with lines', async () => {
    mockVoucherRepo.getVoucherById.mockResolvedValue(posted);
    mockLineRepo.getLinesByVoucherId.mockResolvedValue([]);
    const result = await controller.getVoucher('1');
    expect(result.voucher_number).toBe('V-2026-001');
    expect(mockVoucherRepo.getVoucherById).toHaveBeenCalledWith(1);
  });
});
