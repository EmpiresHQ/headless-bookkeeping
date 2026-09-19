import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import JSZip from 'jszip';
import { StatutoryReportService } from './statutory-report.service';
import { StatutoryFormat } from '../plugins/statutory-report.types';

const VALID_FORMATS = new Set<string>(['xml', 'csv', 'all']);

@ApiTags('statutory-reports')
@Controller('api/reporting-periods')
export class StatutoryReportController {
  constructor(private readonly service: StatutoryReportService) {}

  @Get(':id/statutory-report')
  @ApiOperation({
    summary: 'Render a statutory report',
    description:
      'Render the statutory report for a period. An OPEN period yields a ' +
      'read-only draft and freezes nothing; a LOCKED period replays the frozen ' +
      'filing payload it was filed against.',
  })
  @ApiParam({ name: 'id', description: 'Reporting period id' })
  @ApiQuery({
    name: 'format',
    required: false,
    description: 'Output format: xml | csv | all (default: xml)',
  })
  @ApiQuery({
    name: 'filing_version',
    required: false,
    description:
      'Locked periods only: render one specific frozen filing-payload version ' +
      "(statutory_filing_snapshot id) instead of the one the period's filing " +
      'state currently pins — e.g. to reproduce exactly what an earlier ' +
      '`submitted` event identifies.',
  })
  async download(
    @Param('id') id: string,
    @Query('format') format = 'xml',
    @Query('filing_version') filingVersion: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!VALID_FORMATS.has(format)) {
      throw new BadRequestException(`Unsupported format: ${format}`);
    }
    let filingVersionId: number | undefined;
    if (filingVersion !== undefined && filingVersion !== '') {
      filingVersionId = Number(filingVersion);
      if (!Number.isInteger(filingVersionId) || filingVersionId <= 0) {
        throw new BadRequestException(
          `Invalid filing_version: ${filingVersion}`,
        );
      }
    }
    const formats: StatutoryFormat[] =
      format === 'all' ? ['xml', 'csv'] : [format as StatutoryFormat];
    const { artifacts } = await this.service.generate(Number(id), {
      formats,
      filingVersionId,
    });
    if (artifacts.length === 0) {
      throw new BadRequestException('No statutory report artifacts produced');
    }
    if (artifacts.length === 1) {
      res.setHeader('Content-Type', artifacts[0].mimeType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${artifacts[0].filename}"`,
      );
      res.send(artifacts[0].content);
      return;
    }
    const zip = new JSZip();
    artifacts.forEach((a) => zip.file(a.filename, a.content));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="kmd.zip"');
    res.send(buf);
  }
}
