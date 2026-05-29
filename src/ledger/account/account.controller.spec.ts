import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { Account } from './types';

describe('AccountController', () => {
  let controller: AccountController;

  const cash: Account = {
    id: 1,
    code: 'CASH',
    name: 'Cash',
    type: 'asset',
    currency: null,
    parent_id: null,
    is_system: true,
  };

  const mockService = {
    getAccounts: jest.fn(),
    getAccountByCode: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AccountController],
      providers: [{ provide: AccountService, useValue: mockService }],
    }).compile();

    controller = module.get<AccountController>(AccountController);
    jest.clearAllMocks();
  });

  it('GET /api/accounts wraps the list under an accounts key', async () => {
    mockService.getAccounts.mockResolvedValue([cash]);
    const result = await controller.getAccounts();
    expect(result.accounts).toEqual([cash]);
    expect(mockService.getAccounts).toHaveBeenCalledTimes(1);
  });

  it('GET /api/accounts/:code returns the requested account', async () => {
    mockService.getAccountByCode.mockResolvedValue(cash);
    const result = await controller.getAccount('CASH');
    expect(result.code).toBe('CASH');
    expect(mockService.getAccountByCode).toHaveBeenCalledWith('CASH');
  });

  it('GET /api/accounts/:code throws NotFoundException for unknown code', async () => {
    mockService.getAccountByCode.mockResolvedValue(null);
    await expect(controller.getAccount('NOPE')).rejects.toThrow(
      NotFoundException,
    );
  });
});
