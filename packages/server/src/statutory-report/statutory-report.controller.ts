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
      'Render the statutory report (e.g. annual accounts) for a period.',
  })
  @ApiParam({ name: 'id', description: 'Reporting period id' })
  @ApiQuery({
    name: 'format',
    required: false,
    description: 'Output format: xml | csv | all (default: xml)',
  })
  async download(
    @Param('id') id: string,
    @Query('format') format = 'xml',
    @Res() res: Response,
  ): Promise<void> {
    if (!VALID_FORMATS.has(format)) {
      throw new BadRequestException(`Unsupported format: ${format}`);
    }
    const formats: StatutoryFormat[] =
      format === 'all' ? ['xml', 'csv'] : [format as StatutoryFormat];
    const { artifacts } = await this.service.generate(Number(id), { formats });
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
