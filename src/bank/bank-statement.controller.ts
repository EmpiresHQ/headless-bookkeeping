import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  ParseIntPipe,
} from '@nestjs/common';
import { BankStatementService } from './bank-statement.service';
import type { CreateStatementInput } from './bank-statement.types';

@Controller('api/bank-statements')
export class BankStatementController {
  constructor(private readonly service: BankStatementService) {}

  @Post()
  async createStatement(@Body() input: CreateStatementInput) {
    const result = await this.service.createStatement(input);
    return result;
  }

  @Get()
  async listStatements() {
    return this.service.listStatements();
  }

  @Get(':id/transactions')
  async listTransactions(@Param('id', ParseIntPipe) id: number) {
    return this.service.listTransactions(id);
  }
}
