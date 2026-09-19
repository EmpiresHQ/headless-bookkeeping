import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AllowanceController } from '../src/allowances/allowance.controller';
import { AllowanceService } from '../src/allowances/allowance.service';
import { BusinessTripController } from '../src/allowances/business-trip.controller';
import { BusinessTripService } from '../src/allowances/business-trip.service';
import { SqliteConstraintFilter } from '../src/common/filters/sqlite-constraint.filter';
import { ZodValidationPipe } from '../src/common/pipes/zod-validation.pipe';

describe('Allowance request validation (HTTP)', () => {
  let app: INestApplication<App>;
  const createBusinessTrip = jest.fn().mockResolvedValue({ id: 1 });
  const createAllowance = jest.fn().mockResolvedValue({ id: 2 });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BusinessTripController, AllowanceController],
      providers: [
        { provide: BusinessTripService, useValue: { createBusinessTrip } },
        { provide: AllowanceService, useValue: { createAllowance } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ZodValidationPipe());
    app.useGlobalFilters(new SqliteConstraintFilter());
    await app.init();
  });

  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => app.close());

  it('returns field errors for the incomplete business trip seen in production', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/business-trips')
      .send({ claimant_id: 45 })
      .expect(400);
    expect(response.body).toEqual({
      departure_date: expect.any(Array),
      return_date: expect.any(Array),
      destination_country: expect.any(Array),
    });
    expect(createBusinessTrip).not.toHaveBeenCalled();
  });

  it('rejects invalid allowance types and amounts before calling the service', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/allowances')
      .send({ claimant_id: 45, type: 'invalid', input_amount: -1 })
      .expect(400);
    expect(response.body).toEqual({
      type: expect.any(Array),
      input_amount: expect.any(Array),
    });
    expect(createAllowance).not.toHaveBeenCalled();
  });

  it('creates a valid business trip with the expected service arguments', async () => {
    await request(app.getHttpServer())
      .post('/api/business-trips')
      .send({
        claimant_id: 45,
        departure_date: '2026-09-19',
        return_date: '2026-09-20',
        destination_country: 'EE',
        purpose: 'Meeting',
      })
      .expect(201);
    expect(createBusinessTrip).toHaveBeenCalledWith({
      claimantId: 45,
      departureDate: '2026-09-19',
      returnDate: '2026-09-20',
      destinationCountry: 'EE',
      purpose: 'Meeting',
    });
  });

  it('creates a valid allowance with the expected service arguments', async () => {
    await request(app.getHttpServer())
      .post('/api/allowances')
      .send({
        claimant_id: 45,
        type: 'mileage',
        km: 10,
        route_description: 'Office to client',
        period_start: '2026-09-19',
        period_end: '2026-09-20',
      })
      .expect(201);
    expect(createAllowance).toHaveBeenCalledWith({
      claimantId: 45,
      type: 'mileage',
      km: 10,
      routeDescription: 'Office to client',
      periodStart: '2026-09-19',
      periodEnd: '2026-09-20',
    });
  });
});
