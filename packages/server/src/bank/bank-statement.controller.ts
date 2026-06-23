import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { BankStatementService } from './bank-statement.service';
import { CreateStatementInput } from './bank-statement.types';

@ApiTags('bank')
@Controller('api/bank-statements')
export class BankStatementController {
  constructor(private readonly service: BankStatementService) {}

  @ApiOperation({
    summary: 'Create a bank statement',
    description: 'Create a bank statement.',
  })
  @Post()
  async createStatement(@Body() input: CreateStatementInput) {
    const result = await this.service.createStatement(input);
    return result;
  }

  @ApiOperation({
    summary: 'List bank statements',
    description: 'Return all bank statements.',
  })
  @Get()
  async listStatements() {
    return this.service.listStatements();
  }

  @ApiOperation({
    summary: "List a statement's transactions",
    description: 'Return transactions for a statement.',
  })
  @ApiParam({ name: 'id', description: 'Bank statement id' })
  @Get(':id/transactions')
  async listTransactions(@Param('id', ParseIntPipe) id: number) {
    return this.service.listTransactions(id);
  }

  @ApiOperation({
    summary: 'Delete a bank statement',
    description: 'Delete a bank statement.',
  })
  @ApiParam({ name: 'id', description: 'Bank statement id' })
  @Delete(':id')
  async deleteStatement(@Param('id', ParseIntPipe) id: number) {
    await this.service.deleteStatement(id);
    return { deleted: id };
  }
}
