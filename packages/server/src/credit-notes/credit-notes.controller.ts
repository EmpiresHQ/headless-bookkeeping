import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { CreditNotesService } from './credit-notes.service';
import { CreateCreditNoteDto } from './types';

@ApiTags('credit-notes')
@Controller('api/credit-notes')
export class CreditNotesController {
  constructor(private readonly service: CreditNotesService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a credit note',
    description: 'Create a credit note against a sales invoice.',
  })
  create(@Body() dto: CreateCreditNoteDto) {
    return this.service.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List credit notes',
    description: 'Return all credit notes.',
  })
  async list() {
    return { credit_notes: await this.service.list() };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a credit note by id',
    description: 'Fetch a single credit note.',
  })
  @ApiParam({ name: 'id', description: 'Credit note id' })
  get(@Param('id') id: string) {
    return this.service.getById(Number(id));
  }
}
