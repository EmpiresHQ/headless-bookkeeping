import { Injectable } from '@nestjs/common';
import { AllowanceService } from '../../../allowances/allowance.service';
import { BusinessTripService } from '../../../allowances/business-trip.service';
import { DispatchContext, DispatchResult } from '../flow-dispatcher';
import { RoutedIntent } from '../types';

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

      if (missing.length > 0) {
        return {
          handled: true,
          reply: `To create a ${type} allowance I need: input_amount. Please provide the missing fields: ${missing.join(', ')}.`,
        };
      }

      const inputAmount = parseInt(fields['input_amount'], 10);
      if (isNaN(inputAmount) || inputAmount <= 0) {
        return {
          handled: true,
          reply: 'Please provide input_amount as a positive whole number.',
        };
      }

      const allowance = await this.allowanceService.createAllowance({
        claimantId,
        type: type as 'phone' | 'internet' | 'health',
        inputAmount,
        periodStart: fields['period_start'],
        periodEnd: fields['period_end'],
      });

      await this.allowanceService.submitAllowance(allowance.id);

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
