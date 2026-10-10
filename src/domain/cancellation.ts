import { applyBps } from './money';
import { HOUR_MS } from './rental-dates';
import type { BookingStatus, PaymentStatus } from './booking-state';

export type CancellationPolicy = 'flexible' | 'moderate' | 'strict';

export const CANCELLATION_SUMMARIES: Record<CancellationPolicy, string> = {
  flexible: "Free cancellation up to 24 hours before pickup. After that, a fee of 1 day's rental applies.",
  moderate: 'Free cancellation up to 72 hours before pickup. After that, 50% of the rental fee is charged.',
  strict:
    'Free cancellation up to 7 days before pickup. 50% of the rental fee is charged from 7 days to 48 hours before pickup, and 100% within 48 hours.',
};

export const cancellationPolicyInfo = (code: CancellationPolicy) => ({
  code,
  summary: CANCELLATION_SUMMARIES[code],
});

/** Fee charged to a customer cancelling a *paid, confirmed* booking (CONTRACTS §6). */
export function policyFee(input: {
  policy: CancellationPolicy;
  pickupAt: Date;
  now: Date;
  rentalFeeMinor: number;
  dailyRateMinor: number;
}): number {
  const hoursBefore = (input.pickupAt.getTime() - input.now.getTime()) / HOUR_MS;
  const rental = input.rentalFeeMinor;
  switch (input.policy) {
    case 'flexible':
      return hoursBefore >= 24 ? 0 : Math.min(input.dailyRateMinor, rental);
    case 'moderate':
      return hoursBefore >= 72 ? 0 : applyBps(rental, 5000);
    case 'strict':
      if (hoursBefore >= 7 * 24) return 0;
      return hoursBefore >= 48 ? applyBps(rental, 5000) : rental;
  }
}

export interface CancellationOutcome {
  eligible: boolean;
  free: boolean;
  feeMinor: number;
  /** Amount returned to the customer (refund of a capture, or release of an authorization). */
  refundMinor: number;
  reason?: string;
}

/**
 * What happens if `actor` cancels now. Held / pending_partner cancellations are free (void);
 * partner cancellations are always free for the customer; the fee never exceeds what was paid.
 */
export function computeCancellation(input: {
  actor: 'customer' | 'partner' | 'admin';
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  policy: CancellationPolicy;
  pickupAt: Date;
  now: Date;
  rentalFeeMinor: number;
  dailyRateMinor: number;
  totalMinor: number;
}): CancellationOutcome {
  const allowed: BookingStatus[] =
    input.actor === 'customer' ? ['held', 'pending_partner', 'confirmed'] : ['pending_partner', 'confirmed'];
  if (!allowed.includes(input.status)) {
    return {
      eligible: false,
      free: false,
      feeMinor: 0,
      refundMinor: 0,
      reason:
        input.status === 'active'
          ? 'The rental has already started. Please contact support.'
          : 'This booking can no longer be cancelled.',
    };
  }
  const paid = paidAmount(input.paymentStatus, input.totalMinor);
  if (input.actor !== 'customer' || input.status === 'held' || input.status === 'pending_partner') {
    return { eligible: true, free: true, feeMinor: 0, refundMinor: paid };
  }
  const fee = Math.min(
    policyFee({
      policy: input.policy,
      pickupAt: input.pickupAt,
      now: input.now,
      rentalFeeMinor: input.rentalFeeMinor,
      dailyRateMinor: input.dailyRateMinor,
    }),
    paid,
  );
  return {
    eligible: true,
    free: fee === 0,
    feeMinor: fee,
    refundMinor: paid - fee,
  };
}

function paidAmount(paymentStatus: PaymentStatus, totalMinor: number): number {
  return paymentStatus === 'authorized' || paymentStatus === 'captured' ? totalMinor : 0;
}
