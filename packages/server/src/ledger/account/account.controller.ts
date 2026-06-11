import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AccountService } from './account.service';
import { Account } from './types';

@ApiTags('accounts')
@Controller('api/accounts')
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @Get()
  async getAccounts(): Promise<{ accounts: Account[] }> {
    return { accounts: await this.accountService.getAccounts() };
  }

  @Get(':code')
  async getAccount(@Param('code') code: string): Promise<Account> {
    const account = await this.accountService.getAccountByCode(code);
    if (!account) {
      throw new NotFoundException(`Account '${code}' not found`);
    }
    return account;
  }
}
