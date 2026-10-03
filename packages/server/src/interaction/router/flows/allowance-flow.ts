import { Injectable } from '@nestjs/common';
import { AllowanceService } from '../../../allowances/allowance.service';
import { BusinessTripService } from '../../../allowances/business-trip.service';
import { DispatchContext, DispatchResult } from '../flow-dispatcher';
import { RoutedIntent } from '../types';

/** The answers read as "yes" for a yes/no eligibility condition. */
const AFFIRMATIVE = new Set(['yes', 'y', 'true', 'jah', '1']);

@Injectable()
export class AllowanceFlow {
  constructor(
    private readonly allowanceService: AllowanceService,
    private readonly businessTripService: BusinessTripService,
  ) {}

  async dispatch(
    intent: RoutedIntent,
    ctx: DispatchContext,
  ): Promise<DispatchResult> {
    if (
      intent.kind !== 'action' ||
      intent.actionIntent !== 'create_allowance'
    ) {
      return { handled: false };
    }

    const claimantId = parseInt(
      ctx.principal.senderId.replace('entity:', ''),
      10,
    );
    if (isNaN(claimantId)) {
      return {
        handled: true,
        reply: 'Could not resolve your identity. Please try again.',
      };
    }

    const fields = intent.fields ?? {};
    const type = fields['type'];

    if (!type) {
      return {
        handled: true,
        reply:
          'To create an allowance I need to know the type. Please specify: daily_allowance, mileage, phone, internet, or health.',
      };
    }

    if (type === 'daily_allowance') {
      const missing: string[] = [];
      if (!fields['departure_date']) missing.push('departure_date');
      if (!fields['return_date']) missing.push('return_date');
      if (!fields['destination_country']) missing.push('destination_country');

      if (missing.length > 0) {
        return {
          handled: true,
          reply: `To create a daily allowance I need: departure_date, return_date, destination_country. Please provide the missing fields: ${missing.join(', ')}.`,
        };
      }

      const trip = await this.businessTripService.createBusinessTrip({
        claimantId,
        departureDate: fields['departure_date'],
        returnDate: fields['return_date'],
        destinationCountry: fields['destination_country'],
      });

      const allowance = await this.allowanceService.createAllowance({
        claimantId,
        type: 'daily_allowance',
        tripId: trip.id,
      });

      await this.allowanceService.submitAllowance(allowance.id);

      return {
        handled: true,
        reply: `päevaraha created and submitted for approval.`,
      };
    }

    if (type === 'mileage') {
      const missing: string[] = [];
      if (!fields['km']) missing.push('km');
      if (!fields['period_start']) missing.push('period_start');

      if (missing.length > 0) {
        return {
          handled: true,
          reply: `To create a mileage allowance I need: km, period_start. Please provide the missing fields: ${missing.join(', ')}.`,
        };
      }

      const km = parseInt(fields['km'], 10);
      if (isNaN(km) || km <= 0) {
        return {
          handled: true,
          reply: 'Please provide km as a positive whole number.',
        };
      }

      const allowance = await this.allowanceService.createAllowance({
        claimantId,
        type: 'mileage',
        km,
        periodStart: fields['period_start'],
        routeDescription: fields['route_description'],
      });

      await this.allowanceService.submitAllowance(allowance.id);

      return {
        handled: true,
        reply: `Mileage allowance created and submitted for approval.`,
      };
    }

    if (type === 'phone' || type === 'internet' || type === 'health') {
      const missing: string[] = [];
      if (!fields['input_amount']) missing.push('input_amount');
      // A health claim is exempt only up to a statutory limit and only under
      // conditions, so the chat flow has to collect the same facts the API
      // requires (issue #212). Asking for them here — naming each one — keeps
      // the conversation able to finish in one more turn, rather than handing
      // back a 422 from deeper in the stack.
      if (type === 'health') {
        if (!fields['period_start']) missing.push('period_start');
        if (!fields['health_category']) missing.push('health_category');
        if (!fields['claimant_relation'])
          missing.push('claimant_relation (employee | board_member | other)');
        if (
          !fields['supporting_document_ref'] &&
          !fields['supporting_document_id']
        )
          missing.push('supporting_document_ref');
        if (!fields['offered_to_all_employees'])
          missing.push('offered_to_all_employees (yes | no)');
      }

      if (missing.length > 0) {
        return {
          handled: true,
          reply: `To create a ${type} allowance I need: ${missing.join(', ')}. Please provide the missing fields: ${missing.join(', ')}.`,
        };
      }

      const inputAmount = parseInt(fields['input_amount'], 10);
      if (isNaN(inputAmount) || inputAmount <= 0) {
        return {
          handled: true,
          reply: 'Please provide input_amount as a positive whole number.',
        };
      }

      const supportingDocumentId = fields['supporting_document_id']
        ? parseInt(fields['supporting_document_id'], 10)
        : undefined;

      const allowance = await this.allowanceService.createAllowance({
        claimantId,
        type: type as 'phone' | 'internet' | 'health',
        inputAmount,
        periodStart: fields['period_start'],
        periodEnd: fields['period_end'],
        health:
          type === 'health'
            ? {
                category: fields['health_category'],
                claimantRelation: fields['claimant_relation'],
                supportingDocumentId:
                  supportingDocumentId !== undefined &&
                  !isNaN(supportingDocumentId)
                    ? supportingDocumentId
                    : undefined,
                supportingDocumentRef: fields['supporting_document_ref'],
                providerRegistration: fields['provider_registration'],
                // Anything other than an explicit yes is NOT a yes: the
                // condition is that the benefit is open to every eligible
                // employee, and an unclear answer cannot assert that.
                offeredToAllEmployees: AFFIRMATIVE.has(
                  fields['offered_to_all_employees'].trim().toLowerCase(),
                ),
              }
            : undefined,
      });

      await this.allowanceService.submitAllowance(allowance.id);

      if (type === 'health') {
        // Say what was decided, not just that something was created: a claim
        // over the limit or outside the conditions is partly or wholly a
        // taxable fringe benefit, and the claimant should hear that now rather
        // than discover it on a payslip.
        const exempt = allowance.tax_free_amount;
        const taxable = allowance.taxable_amount;
        return {
          handled: true,
          reply:
            `Health allowance created and submitted for approval. ` +
            (taxable === 0
              ? `On the figures so far the full amount is tax-exempt — a ` +
                `preview, confirmed when the claim is approved.`
              : `${formatAmount(exempt)} is tax-exempt and ` +
                `${formatAmount(taxable)} is a taxable fringe benefit ` +
                `(${allowance.exemption_basis ?? 'no exemption'}). The final ` +
                `split is confirmed when the claim is approved.`),
        };
      }

      return {
        handled: true,
        reply: `${type.charAt(0).toUpperCase() + type.slice(1)} allowance created and submitted for approval.`,
      };
    }

    return {
      handled: true,
      reply: `Unknown allowance type '${type}'. Supported types: daily_allowance, mileage, phone, internet, health.`,
    };
  }
}

/** Minor units as a plain decimal amount, for a chat reply. */
function formatAmount(minorUnits: number): string {
  return (minorUnits / 100).toFixed(2);
}
