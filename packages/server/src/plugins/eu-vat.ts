import { z } from 'zod';
import type { ServicePlaceRule } from './country-plugin.interface';

const country = z.string().regex(/^[A-Z]{2}$/);
/** Recorded transaction facts. Evidence is retained verbatim, never inferred from a merchant name. */
export const euVatFactsSchema = z
  .object({
    specialCase: z
      .enum(['margin_scheme', 'use_and_enjoyment', 'transitional_rate'])
      .optional(),
    supplyType: z.enum(['goods', 'services']).optional(),
    recipientStatus: z
      .enum(['taxable_business', 'non_taxable', 'unknown'])
      .optional(),
    receivingEstablishmentCountry: country.optional(),
    supplierEstablishmentCountry: country.optional(),
    supplierNonEstablishedInPlace: z.boolean().optional(),
    route: z
      .array(
        z.object({
          from: country,
          to: country,
          distanceKm: z.number().positive().optional(),
        }),
      )
      .min(1)
      .optional(),
    transportDistanceByCountry: z
      .array(z.object({ country, distanceKm: z.number().positive() }))
      .min(1)
      .optional(),
    hireDays: z.number().int().positive().optional(),
    vehicleKind: z.enum(['vessel', 'other']).optional(),
    attendance: z.enum(['physical', 'virtual']).optional(),
    onboard: z.boolean().optional(),
    onboardIntraCommunity: z.boolean().optional(),
    departureCountry: country.optional(),
    transportMode: z.enum(['ship', 'aircraft', 'train']).optional(),
    internationalJourney: z.boolean().optional(),
    goodsMovement: z.enum(['domestic', 'intra_community', 'import']).optional(),
    goodsDestinationCountry: country.optional(),
    importVatEvidence: z.boolean().optional(),
    documentTaxTreatment: z
      .enum(['foreign_vat', 'zero_rated', 'exempt', 'outside_scope'])
      .optional(),
    businessPurpose: z.boolean().optional(),
    buyerEvidence: z.boolean().optional(),
    evidence: z
      .array(
        z.object({
          fact: z.string().min(1),
          reference: z.string().min(1),
          source: z.enum(['document', 'human', 'registry']),
          confirmedBy: z.string().optional(),
          confirmedAt: z.string().datetime().optional(),
        }),
      )
      .optional(),
  })
  .strict();
export type EuVatFacts = z.infer<typeof euVatFactsSchema>;
export interface EuVatInput {
  date: string;
  supplyType: 'goods' | 'services' | 'unknown';
  rule?: ServicePlaceRule;
  location?: string;
  supplierCountry: string;
  supplierTaxStatus?: string;
  recipientVatRegistered?: boolean;
  recipientCountry: string;
  facts: EuVatFacts;
}
export type EuVatDecision =
  | {
      ruleId: string;
      inputs: EuVatInput;
      version: string;
      effectiveFrom: string;
      supplyDate: string;
      jurisdiction: string;
      distanceAllocation?: {
        country: string;
        distanceKm: number;
        totalDistanceKm: number;
      }[];
      liability: 'supplier' | 'article196' | 'national_review';
      nationalTreatment?: string;
      nationalRuleId?: string;
      nationalRate?: number;
      evidence: NonNullable<EuVatFacts['evidence']>;
    }
  | { hold: string; requiredFacts: string[]; ruleId: string };

/** EU place and Art196 liability only: no national rates, codes or return boxes. */
export function decideEuVat(i: EuVatInput): EuVatDecision {
  const f = i.facts;
  const hold = (ruleId: string, ...requiredFacts: string[]): EuVatDecision => ({
    hold: `Cannot decide ${ruleId}; record ${requiredFacts.join(', ')} from the source document or an explicit human confirmation.`,
    requiredFacts,
    ruleId,
  });
  const result = (
    ruleId: string,
    jurisdiction: string,
    liability: 'supplier' | 'article196' | 'national_review' = 'supplier',
    effectiveFrom = '2010-01-01',
  ): EuVatDecision => ({
    ruleId,
    inputs: { ...i, facts: { ...f } },
    version: i.date >= '2025-01-01' ? 'EU-2025-01-01' : 'EU-2011-01-01',
    effectiveFrom,
    supplyDate: i.date,
    jurisdiction,
    liability,
    evidence: f.evidence ?? [],
  });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.date) || i.date < '2011-01-01')
    return hold('dated_rule_unsupported', 'supplyDate (2011 or later)');
  if (f.specialCase)
    return hold(
      `${f.specialCase}_unsupported`,
      `dated national review for ${f.specialCase}`,
    );
  if (i.supplyType === 'goods') {
    if (i.rule && i.rule !== 'general')
      return hold('goods_service_conflict', 'supplyType', 'servicePlaceRule');
    if (!f.goodsMovement || !f.goodsDestinationCountry)
      return hold(
        'goods_movement',
        'goodsMovement',
        'goodsDestinationCountry',
        'customs/movement evidence',
      );
    return result(
      `goods_${f.goodsMovement}`,
      f.goodsDestinationCountry,
      'national_review',
    );
  }
  if (i.supplyType !== 'services')
    return hold('supply_type_unknown', 'supplyType');
  const rule = i.rule ?? 'general';
  if (rule === 'passenger_transport') {
    if (!f.route?.length)
      return hold(
        'Art48',
        'route (each ticketed journey, not the round-trip envelope)',
      );
    const decision = result('Art48', 'distance_apportioned', 'national_review');
    if (f.transportDistanceByCountry && !('hold' in decision)) {
      const totalDistanceKm = f.transportDistanceByCountry.reduce(
        (sum, part) => sum + part.distanceKm,
        0,
      );
      return {
        ...decision,
        distanceAllocation: f.transportDistanceByCountry.map((part) => ({
          ...part,
          totalDistanceKm,
        })),
      };
    }
    return decision;
  }
  if (rule === 'immovable_property')
    return i.location
      ? result('Art47', i.location, 'national_review')
      : hold('Art47', 'placeOfSupplyCountry (property location)');
  if (rule === 'short_term_hire_of_means_of_transport') {
    if (!f.hireDays || !f.vehicleKind)
      return hold('Art56', 'hireDays', 'vehicleKind');
    if (f.hireDays > (f.vehicleKind === 'vessel' ? 90 : 30))
      return hold(
        'long_term_hire_unsupported',
        'national treatment for long-term hire',
      );
    return i.location
      ? result('Art56', i.location, 'national_review')
      : hold('Art56', 'placeOfSupplyCountry (handover location)');
  }
  if (rule === 'restaurant_catering') {
    if (f.onboard === undefined) return hold('Art55/57', 'onboard');
    if (f.onboard) {
      if (f.onboardIntraCommunity !== true || !f.departureCountry)
        return hold(
          'Art57',
          'onboardIntraCommunity',
          'departureCountry (passenger section)',
        );
      return result('Art57', f.departureCountry, 'national_review');
    }
    return i.location
      ? result('Art55', i.location, 'national_review')
      : hold('Art55', 'placeOfSupplyCountry (physical performance)');
  }
  if (rule === 'cultural_artistic_sporting_admission') {
    if (!f.attendance || !f.recipientStatus || f.recipientStatus === 'unknown')
      return hold('Art53/54', 'attendance', 'recipientStatus');
    if (f.attendance === 'virtual' && i.date < '2025-01-01')
      return hold(
        'virtual_admission_before_2025',
        'dated national treatment for virtual participation before 2025',
      );
    if (f.attendance === 'physical')
      return i.location
        ? result(
            f.recipientStatus === 'taxable_business' ? 'Art53' : 'Art54',
            i.location,
            'national_review',
          )
        : hold('Art53/54', 'placeOfSupplyCountry (event location)');
    if (f.recipientStatus === 'non_taxable')
      return result(
        'Art54_virtual_2025',
        f.receivingEstablishmentCountry ?? i.recipientCountry,
        'supplier',
        '2025-01-01',
      );
    // Virtual B2B admission excluded from Art53 from 2025; Art44 below.
  } else if (rule !== 'general')
    return hold(
      `${rule}_unsupported`,
      'specific special-rule treatment (accountant review)',
    );
  if (!f.recipientStatus || f.recipientStatus === 'unknown')
    return hold('Art44/45', 'recipientStatus');
  if (f.recipientStatus === 'non_taxable')
    return f.supplierEstablishmentCountry
      ? result('Art45', f.supplierEstablishmentCountry)
      : hold('Art45', 'supplierEstablishmentCountry');
  if (!f.receivingEstablishmentCountry)
    return hold('Art44', 'receivingEstablishmentCountry');
  if (f.supplierNonEstablishedInPlace === undefined)
    return hold(
      'Art196',
      'supplierNonEstablishedInPlace (including intervening fixed establishment)',
    );
  return result(
    'Art44',
    f.receivingEstablishmentCountry,
    f.supplierNonEstablishedInPlace ? 'article196' : 'supplier',
    rule === 'cultural_artistic_sporting_admission'
      ? '2025-01-01'
      : '2010-01-01',
  );
}
