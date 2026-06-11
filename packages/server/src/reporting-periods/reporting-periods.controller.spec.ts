import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ReportingPeriodsController } from './reporting-periods.controller';
import { ReportingPeriodsService } from './reporting-periods.service';
import { ReportingPeriod } from './types';

describe('ReportingPeriodsController', () => {
  let controller: ReportingPeriodsController;

  const q1: ReportingPeriod = {
    id: 1,
    name: '2024-Q1',
    start_date: '2024-01-01',
    end_date: '2024-03-31',
    status: 'open',
    filed_at: null,
    vat_report_snapshot_id: null,
    created_at: 1700000000,
  };

  const q2: ReportingPeriod = {
    id: 2,
    name: '2024-Q2',
    start_date: '2024-04-01',
    end_date: '2024-06-30',
    status: 'open',
    filed_at: null,
    vat_report_snapshot_id: null,
    created_at: 1700000100,
  };

  const mockService = {
    list: jest.fn(),
    getById: jest.fn(),
    getCurrent: jest.fn(),
    create: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReportingPeriodsController],
      providers: [{ provide: ReportingPeriodsService, useValue: mockService }],
    }).compile();

    controller = module.get<ReportingPeriodsController>(
      ReportingPeriodsController,
    );
    jest.clearAllMocks();
  });

  it('GET /api/reporting-periods returns all periods under a reportingPeriods key', async () => {
    mockService.list.mockResolvedValue([q1, q2]);

    const result = await controller.list();

    expect(result.reportingPeriods).toEqual([q1, q2]);
    expect(result.reportingPeriods).toHaveLength(2);
    expect(mockService.list).toHaveBeenCalledTimes(1);
  });

  it('GET /api/reporting-periods returns empty array when no periods exist', async () => {
    mockService.list.mockResolvedValue([]);

    const result = await controller.list();

    expect(result.reportingPeriods).toEqual([]);
    expect(mockService.list).toHaveBeenCalledTimes(1);
  });

  it('GET /api/reporting-periods/current throws when no open period exists', async () => {
    mockService.getCurrent.mockRejectedValue(
      new NotFoundException('No open reporting period found'),
    );

    await expect(controller.getCurrent()).rejects.toThrow(NotFoundException);
    expect(mockService.getCurrent).toHaveBeenCalledTimes(1);
  });

  it('GET /api/reporting-periods/:id throws NotFoundException for unknown id', async () => {
    mockService.getById.mockRejectedValue(
      new NotFoundException('Reporting period 999 not found'),
    );

    await expect(controller.getById(999)).rejects.toThrow(NotFoundException);
    expect(mockService.getById).toHaveBeenCalledWith(999);
  });
});
