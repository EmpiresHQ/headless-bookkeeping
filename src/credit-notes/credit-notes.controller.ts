import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CreditNotesService } from './credit-notes.service';
import { CreateCreditNoteDto } from './types';

@ApiTags('credit-notes')
@Controller('api/credit-notes')
export class CreditNotesController {
  constructor(private readonly service: CreditNotesService) {}

  @Post()
  create(@Body() dto: CreateCreditNoteDto) {
    return this.service.create(dto);
  }

  @Get()
  async list() {
    return { credit_notes: await this.service.list() };
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.getById(Number(id));
  }
}
