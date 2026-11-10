import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Query,
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
import { BankMappingProfileRepository } from './bank-mapping-profile.repository';

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
    // The ORIGINAL buffer travels alongside its parsed text so the raw source
    // is preserved durably, byte-exact — whatever encoding the unmapped
    // columns carry (issue #403: re-encoding the text would silently mutate
    // the archive).
    return this.ingestion.startImport(
      {
        text: file.buffer.toString('utf8'),
        buffer: file.buffer,
        filename: file.originalname ?? 'statement.csv',
      },
      accountCode ?? '',
    );
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

/**
 * Reset surface for the persisted bank-CSV mappings. A mapping is keyed by
 * `(account_code, header signature)` and saved only after a successful import;
 * these endpoints let an operator inspect and delete stale profiles (e.g. after
 * a bank changes its export format without changing its column names).
 */
@ApiTags('bank')
@Controller('api/bank-mapping-profiles')
export class BankMappingProfileController {
  constructor(private readonly profiles: BankMappingProfileRepository) {}

  @ApiOperation({
    summary: 'List bank mapping profiles',
    description:
      'List stored column mappings, optionally filtered by account_code.',
  })
  @Get()
  async list(@Query('account_code') accountCode?: string) {
    return this.profiles.list(accountCode || undefined);
  }

  @ApiOperation({
    summary: 'Delete a bank mapping profile',
    description: 'Forget a stored mapping so the next import infers afresh.',
  })
  @ApiParam({ name: 'id', description: 'Bank mapping profile id' })
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    const deleted = await this.profiles.deleteById(id);
    if (deleted === 0) {
      throw new NotFoundException(`Bank mapping profile ${id} not found`);
    }
    return { deleted: id };
  }
}
