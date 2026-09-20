import { Test, TestingModule } from '@nestjs/testing';
import { AnnualAccountsController } from './annual-accounts.controller';
import { AnnualAccountsService } from './annual-accounts.service';

describe('AnnualAccountsController', () => {
  let controller: AnnualAccountsController;
  const service = {
    generate: jest.fn(),
    finalize: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AnnualAccountsController],
      providers: [{ provide: AnnualAccountsService, useValue: service }],
    }).compile();
    controller = module.get(AnnualAccountsController);
    jest.clearAllMocks();
  });

  it('GET returns the single artifact as a file download', async () => {
    service.generate.mockResolvedValue({
      artifacts: [
        {
          filename: 'annual-accounts-2026.xbrl',
          mimeType: 'application/xml',
          content: '<xbrli:xbrl/>',
        },
      ],
      warnings: [],
    });
    const res = {
      setHeader: jest.fn(),
      send: jest.fn(),
    } as unknown as import('express').Response;
    await controller.download(7, res);
    expect(service.generate).toHaveBeenCalledWith(7);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/xml',
    );
    expect(res.send).toHaveBeenCalledWith('<xbrli:xbrl/>');
  });

  it('GET throws when no artifact is produced (Null plugin / unsupported)', async () => {
    service.generate.mockResolvedValue({ artifacts: [], warnings: [] });
    const res = {
      setHeader: jest.fn(),
      send: jest.fn(),
    } as unknown as import('express').Response;
    await expect(controller.download(7, res)).rejects.toThrow(
      /no annual-accounts/i,
    );
  });

  it('GET reports WHICH gap withheld the artifact, as a 400', async () => {
    service.generate.mockResolvedValue({
      artifacts: [],
      warnings: [
        {
          code: 'missing_declarant_reg_number',
          message: 'Annual accounts declarant has no commercial registry code',
        },
      ],
    });
    const res = {
      setHeader: jest.fn(),
      send: jest.fn(),
    } as unknown as import('express').Response;

    await expect(controller.download(7, res)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('no commercial registry code'),
    });
    // Nothing was written to the response either.
    expect(res.send).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('POST finalize delegates and returns artifacts + warnings JSON', async () => {
    service.finalize.mockResolvedValue({
      artifacts: [
        { filename: 'a.xbrl', mimeType: 'application/xml', content: '<x/>' },
      ],
      warnings: [{ code: 'soft', message: 'm' }],
    });
    const out = await controller.finalize(7, { confirm: true });
    expect(service.finalize).toHaveBeenCalledWith(7);
    expect(out.warnings).toHaveLength(1);
    expect(out.artifacts[0].filename).toBe('a.xbrl');
  });
});
