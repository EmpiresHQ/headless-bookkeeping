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
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { BankIngestionService } from './bank-ingestion.service';

@ApiTags('bank')
@Controller('api/bank-statements')
export class BankIngestionController {
  constructor(private readonly ingestion: BankIngestionService) {}

  @ApiOperation({
    summary: 'Start a bank import',
    description: 'Begin importing a bank statement (async job).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'CSV bank statement file',
        },
        account_code: {
          type: 'string',
          description: 'Ledger account code for the imported transactions',
        },
      },
    },
  })
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

  @ApiOperation({
    summary: 'Get import job status',
    description: 'Return the status of an import job.',
  })
  @ApiParam({ name: 'jobId', description: 'Import job id' })
  @Get('import/:jobId')
  async status(@Param('jobId', ParseIntPipe) jobId: number) {
    const job = await this.ingestion.getImportStatus(jobId);
    if (!job) throw new NotFoundException(`Import job ${jobId} not found`);
    return job;
  }
}
