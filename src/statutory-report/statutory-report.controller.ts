import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import JSZip = require('jszip');
import { StatutoryReportService } from './statutory-report.service';
import { StatutoryFormat } from '../plugins/statutory-report.types';

@Controller('api/reporting-periods')
export class StatutoryReportController {
  constructor(private readonly service: StatutoryReportService) {}

  @Get(':id/statutory-report')
  async download(
    @Param('id') id: string,
    @Query('format') format = 'xml',
    @Res() res: Response,
  ): Promise<void> {
    const formats: StatutoryFormat[] =
      format === 'all' ? ['xml', 'csv'] : [format as StatutoryFormat];
    const { artifacts } = await this.service.generate(Number(id), { formats });
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
