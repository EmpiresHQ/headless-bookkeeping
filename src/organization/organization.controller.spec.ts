import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';
import { Organization } from './types';

describe('OrganizationController', () => {
  let controller: OrganizationController;

  const defaultOrg: Organization = {
    id: 1,
    country: 'DK',
    base_currency: 'DKK',
    vat_registered: false,
    created_at: 1700000000,
  };

  const mockService = {
    getOrganization: jest.fn(),
    updateOrganization: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationController],
      providers: [
        {
          provide: OrganizationService,
          useValue: mockService,
        },
      ],
    }).compile();

    controller = module.get<OrganizationController>(OrganizationController);

    jest.clearAllMocks();
  });

  describe('GET /api/organization', () => {
    it('should return organization with default values', async () => {
      mockService.getOrganization.mockResolvedValue(defaultOrg);

      const result = await controller.getOrganization();

      expect(result).toEqual(defaultOrg);
      expect(result.country).toBe('DK');
      expect(result.base_currency).toBe('DKK');
      expect(result.vat_registered).toBe(false);
      expect(mockService.getOrganization).toHaveBeenCalledTimes(1);
    });

    it('should throw NotFoundException when organization does not exist', async () => {
      mockService.getOrganization.mockRejectedValue(
        new NotFoundException('Organization not found'),
      );

      await expect(controller.getOrganization()).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('PUT /api/organization', () => {
    it('should update and return updated values', async () => {
      const updatedOrg: Organization = {
        ...defaultOrg,
        country: 'SE',
        base_currency: 'SEK',
        vat_registered: true,
      };

      mockService.updateOrganization.mockResolvedValue(updatedOrg);

      const result = await controller.updateOrganization({
        country: 'SE',
        base_currency: 'SEK',
        vat_registered: true,
      });

      expect(result).toEqual(updatedOrg);
      expect(result.country).toBe('SE');
      expect(result.base_currency).toBe('SEK');
      expect(result.vat_registered).toBe(true);
      expect(mockService.updateOrganization).toHaveBeenCalledWith({
        country: 'SE',
        base_currency: 'SEK',
        vat_registered: true,
      });
    });

    it('should partially update only provided fields', async () => {
      const partiallyUpdated: Organization = {
        ...defaultOrg,
        country: 'NO',
      };

      mockService.updateOrganization.mockResolvedValue(partiallyUpdated);

      const result = await controller.updateOrganization({
        country: 'NO',
      });

      expect(result.country).toBe('NO');
      expect(result.base_currency).toBe('DKK');
      expect(result.vat_registered).toBe(false);
    });
  });

  describe('singleton constraint', () => {
    it('should reject update when singleton constraint is violated', async () => {
      mockService.updateOrganization.mockRejectedValue(
        new ConflictException('Expected exactly 1 organization record, found 0'),
      );

      await expect(
        controller.updateOrganization({ country: 'SE' }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
