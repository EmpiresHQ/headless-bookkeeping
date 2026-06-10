import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UploadedFile,
  UseInterceptors,
  ParseIntPipe,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { BankIngestionService } from './bank-ingestion.service';

@ApiTags('bank')
@Controller('api/bank-statements')
export class BankIngestionController {
  constructor(private readonly ingestion: BankIngestionService) {}

  @Post('import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async startImport(
    @UploadedFile() file: Express.Multer.File,
    @Body('account_code') accountCode: string,
  ): Promise<{ jobId: number }> {
    if (!file) throw new BadRequestException('A CSV file is required');
    const csvText = file.buffer.toString('utf8');
    return this.ingestion.startImport(csvText, accountCode ?? '');
  }

  @Get('import/:jobId')
  async status(@Param('jobId', ParseIntPipe) jobId: number) {
    const job = await this.ingestion.getImportStatus(jobId);
    if (!job) throw new NotFoundException(`Import job ${jobId} not found`);
    return job;
  }
}
