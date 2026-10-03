import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { HealthBenefitReportService } from './health-benefit-report.service';

@ApiTags('allowances')
@Controller('api/reports/fringe-benefits')
export class HealthBenefitReportController {
  constructor(private readonly service: HealthBenefitReportService) {}

  @Get('health')
  @ApiOperation({
    summary: 'Health and sports benefit declaration figures',
    description:
      'The figures behind a year of posted health/sports claims: the monthly ' +
      'TSD annex 4 lines under benefit code 4120 (taxable benefit, income tax, ' +
      'social tax, due date) and the annual INF 14 part III exempt total with ' +
      'the number of employees. Submits nothing — these are the numbers to file.',
  })
  @ApiQuery({ name: 'year', description: 'Calendar year, e.g. 2026' })
  async health(@Query('year') year?: string) {
    if (year === undefined || year === '') {
      throw new BadRequestException('year is required');
    }
    const parsed = Number(year);
    if (!Number.isInteger(parsed)) {
      throw new BadRequestException(`Invalid year: ${year}`);
    }
    return this.service.report(parsed);
  }
}
