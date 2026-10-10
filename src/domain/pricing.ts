import { applyBps, formatBpsPercent, formatMoneyLabel, Money, money } from './money';
import { rentalDays } from './rental-dates';

export interface PricingVehicle {
  currency: string;
  dailyRateMinor: number;
  weeklyDiscountBps: number;
  deliveryFeeMinor: number;
  depositMinor: number;
  minRentalDays: number;
  mileageLimitKmPerDay: number | null;
  excessMileageFeeMinor: number;
}

export interface PricingCountry {
  taxLabel: string;
  taxRateBps: number;
  platformFeeBps: number;
  commissionBps: number;
}

export interface LineItem {
  code: 'rental_fee' | 'discount' | 'delivery_fee' | 'platform_fee' | 'tax';
  label: string;
  amount: Money;
}

export interface ConditionalCharge {
  code: 'excess_mileage';
  label: string;
  amount: Money;
  unit: 'per_km';
}

export interface PriceBreakdown {
  currency: string;
  days: number;
  dailyRateMinor: number;
  rentalFeeMinor: number;
  discountMinor: number;
  deliveryFeeMinor: number;
  subtotalMinor: number;
  platformFeeMinor: number;
  taxMinor: number;
  totalMinor: number;
  depositMinor: number;
  commissionMinor: number;
  partnerPayoutMinor: number;
  lineItems: LineItem[];
  conditionalCharges: ConditionalCharge[];
}

/** CONTRACTS §7 — the only place prices are computed. Integer minor units throughout. */
export function calculatePrice(input: {
  vehicle: PricingVehicle;
  country: PricingCountry;
  pickupAt: Date;
  returnAt: Date;
  delivery: boolean;
}): PriceBreakdown {
  const { vehicle: v, country: c } = input;
  const cur = v.currency.trim();
  const days = rentalDays(input.pickupAt, input.returnAt, v.minRentalDays);
  const rentalFee = v.dailyRateMinor * days;
  const discount = days >= 7 ? applyBps(rentalFee, v.weeklyDiscountBps) : 0;
  const deliveryFee = input.delivery ? v.deliveryFeeMinor : 0;
  const subtotal = rentalFee - discount + deliveryFee;
  const platformFee = applyBps(subtotal, c.platformFeeBps);
  const tax = applyBps(subtotal + platformFee, c.taxRateBps);
  const total = subtotal + platformFee + tax;
  const commission = applyBps(subtotal, c.commissionBps);

  const lineItems: LineItem[] = [
    {
      code: 'rental_fee',
      label: `Rental (${days} ${days === 1 ? 'day' : 'days'} × ${formatMoneyLabel(v.dailyRateMinor, cur)})`,
      amount: money(rentalFee, cur),
    },
  ];
  if (discount !== 0)
    lineItems.push({
      code: 'discount',
      label: 'Weekly discount',
      amount: money(-discount, cur),
    });
  if (deliveryFee !== 0)
    lineItems.push({
      code: 'delivery_fee',
      label: 'Delivery',
      amount: money(deliveryFee, cur),
    });
  if (platformFee !== 0)
    lineItems.push({
      code: 'platform_fee',
      label: 'Service fee',
      amount: money(platformFee, cur),
    });
  if (tax !== 0) {
    lineItems.push({
      code: 'tax',
      label: `${c.taxLabel} (${formatBpsPercent(c.taxRateBps)})`,
      amount: money(tax, cur),
    });
  }

  const conditionalCharges: ConditionalCharge[] = [];
  if (v.mileageLimitKmPerDay !== null && v.excessMileageFeeMinor > 0) {
    conditionalCharges.push({
      code: 'excess_mileage',
      label: `Extra km beyond ${v.mileageLimitKmPerDay} km/day`,
      amount: money(v.excessMileageFeeMinor, cur),
      unit: 'per_km',
    });
  }

  return {
    currency: cur,
    days,
    dailyRateMinor: v.dailyRateMinor,
    rentalFeeMinor: rentalFee,
    discountMinor: discount,
    deliveryFeeMinor: deliveryFee,
    subtotalMinor: subtotal,
    platformFeeMinor: platformFee,
    taxMinor: tax,
    totalMinor: total,
    depositMinor: v.depositMinor,
    commissionMinor: commission,
    partnerPayoutMinor: subtotal - commission,
    lineItems,
    conditionalCharges,
  };
}
