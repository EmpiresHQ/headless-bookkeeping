import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { BankStatementService } from './bank-statement.service';
import { CreateStatementInput } from './bank-statement.types';

@ApiTags('bank')
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
