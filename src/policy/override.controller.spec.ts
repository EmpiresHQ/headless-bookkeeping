import { Test, TestingModule } from '@nestjs/testing';
import { OverrideController } from './override.controller';
import { PolicyService } from './policy.service';
import { OverrideRecord } from './types';

describe('OverrideController', () => {
  let controller: OverrideController;

  const mockOverrides: OverrideRecord[] = [
    {
      id: 1,
      business_object_type: 'expense',
      business_object_id: 42,
      rule_type: 'semantic',
      rule_name: 'vat_code_validity',
      reason: 'Supplier confirmed special VAT treatment',
      created_by: 'alice@example.com',
      created_at: 1700000000,
    },
    {
      id: 2,
      business_object_type: 'sales_invoice',
      business_object_id: 7,
      rule_type: 'semantic',
      rule_name: 'category_mapping',
      reason: 'New category — mapping not yet in plugin',
      created_by: 'bob@example.com',
      created_at: 1700000100,
    },
  ];

  const mockPolicyService = {
    getOverrides: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OverrideController],
      providers: [
        {
          provide: PolicyService,
          useValue: mockPolicyService,
        },
      ],
    }).compile();

    controller = module.get<OverrideController>(OverrideController);
    jest.clearAllMocks();
  });

  it('GET /api/overrides returns all overrides wrapped in an overrides key', async () => {
    mockPolicyService.getOverrides.mockResolvedValue(mockOverrides);

    const result = await controller.getOverrides();

    expect(result.overrides).toEqual(mockOverrides);
    expect(result.overrides).toHaveLength(2);
    expect(mockPolicyService.getOverrides).toHaveBeenCalledTimes(1);
  });

  it('GET /api/overrides returns empty array when no overrides exist', async () => {
    mockPolicyService.getOverrides.mockResolvedValue([]);

    const result = await controller.getOverrides();

    expect(result.overrides).toEqual([]);
    expect(mockPolicyService.getOverrides).toHaveBeenCalledTimes(1);
  });

  it('GET /api/overrides returns overrides in the order provided by the service', async () => {
    const ordered = [...mockOverrides].reverse();
    mockPolicyService.getOverrides.mockResolvedValue(ordered);

    const result = await controller.getOverrides();

    expect(result.overrides[0].id).toBe(2);
    expect(result.overrides[1].id).toBe(1);
  });
});
