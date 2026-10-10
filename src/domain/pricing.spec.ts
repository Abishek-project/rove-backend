import { applyBps, formatBpsPercent, formatMoneyLabel } from './money';
import { calculatePrice, PricingCountry, PricingVehicle } from './pricing';

const AE: PricingCountry = { taxLabel: 'VAT', taxRateBps: 500, platformFeeBps: 500, commissionBps: 1500 };
const IN: PricingCountry = { taxLabel: 'GST', taxRateBps: 1800, platformFeeBps: 500, commissionBps: 1500 };
const car = (o: Partial<PricingVehicle> = {}): PricingVehicle => ({
  currency: 'AED',
  dailyRateMinor: 25000,
  weeklyDiscountBps: 1000,
  deliveryFeeMinor: 5000,
  depositMinor: 100000,
  minRentalDays: 1,
  mileageLimitKmPerDay: 250,
  excessMileageFeeMinor: 100,
  ...o,
});
const t0 = new Date('2026-11-02T06:00:00.000Z');
const plus = (h: number) => new Date(t0.getTime() + h * 3_600_000);

describe('applyBps (round half up)', () => {
  it('rounds .5 up and below .5 down', () => {
    expect(applyBps(10, 5000)).toBe(5); // 5.0
    expect(applyBps(1, 5000)).toBe(1); // 0.5 → 1
    expect(applyBps(3, 5000)).toBe(2); // 1.5 → 2
    expect(applyBps(1, 4999)).toBe(0); // 0.4999 → 0
    expect(applyBps(78750, 500)).toBe(3938); // 3937.5 → 3938
  });
  it('rejects non-integers', () => {
    expect(() => applyBps(1.5, 100)).toThrow();
  });
});

describe('calculatePrice', () => {
  it('prices a 3-day AED rental exactly per CONTRACTS §7', () => {
    const p = calculatePrice({ vehicle: car(), country: AE, pickupAt: t0, returnAt: plus(72), delivery: false });
    expect(p.days).toBe(3);
    expect(p.rentalFeeMinor).toBe(75000);
    expect(p.discountMinor).toBe(0);
    expect(p.subtotalMinor).toBe(75000);
    expect(p.platformFeeMinor).toBe(3750);
    expect(p.taxMinor).toBe(3938); // (75000+3750)*5% = 3937.5 → 3938
    expect(p.totalMinor).toBe(82688);
    expect(p.depositMinor).toBe(100000);
    expect(p.commissionMinor).toBe(11250);
    expect(p.partnerPayoutMinor).toBe(63750);
    expect(p.lineItems.map((l) => l.code)).toEqual(['rental_fee', 'platform_fee', 'tax']);
    expect(p.lineItems[0].label).toBe('Rental (3 days × AED 250.00)');
    expect(p.lineItems[2].label).toBe('VAT (5%)');
    expect(p.conditionalCharges).toEqual([
      {
        code: 'excess_mileage',
        label: 'Extra km beyond 250 km/day',
        amount: { amountMinor: 100, currency: 'AED' },
        unit: 'per_km',
      },
    ]);
  });

  it('rounds partial days up and applies minRentalDays', () => {
    expect(
      calculatePrice({ vehicle: car(), country: AE, pickupAt: t0, returnAt: plus(25), delivery: false }).days,
    ).toBe(2);
    expect(
      calculatePrice({
        vehicle: car({ minRentalDays: 3 }),
        country: AE,
        pickupAt: t0,
        returnAt: plus(24),
        delivery: false,
      }).days,
    ).toBe(3);
  });

  it('applies the weekly discount from 7 days and delivery fee when requested', () => {
    const p = calculatePrice({ vehicle: car(), country: AE, pickupAt: t0, returnAt: plus(7 * 24), delivery: true });
    expect(p.rentalFeeMinor).toBe(175000);
    expect(p.discountMinor).toBe(17500);
    expect(p.deliveryFeeMinor).toBe(5000);
    expect(p.subtotalMinor).toBe(162500);
    expect(p.lineItems.find((l) => l.code === 'discount')?.amount.amountMinor).toBe(-17500);
    expect(p.totalMinor).toBe(p.subtotalMinor + p.platformFeeMinor + p.taxMinor);
    expect(p.partnerPayoutMinor + p.commissionMinor).toBe(p.subtotalMinor);
  });

  it('no discount at 6 days', () => {
    expect(
      calculatePrice({ vehicle: car(), country: AE, pickupAt: t0, returnAt: plus(6 * 24), delivery: false })
        .discountMinor,
    ).toBe(0);
  });

  it('uses GST 18% for India and omits zero line items', () => {
    const p = calculatePrice({
      vehicle: car({ currency: 'INR', dailyRateMinor: 180000, deliveryFeeMinor: 0, mileageLimitKmPerDay: null }),
      country: IN,
      pickupAt: t0,
      returnAt: plus(48),
      delivery: true,
    });
    expect(p.subtotalMinor).toBe(360000);
    expect(p.platformFeeMinor).toBe(18000);
    expect(p.taxMinor).toBe(68040);
    expect(p.totalMinor).toBe(446040);
    expect(p.lineItems.some((l) => l.code === 'delivery_fee')).toBe(false);
    expect(p.lineItems.find((l) => l.code === 'tax')?.label).toBe('GST (18%)');
    expect(p.conditionalCharges).toEqual([]);
  });

  it('keeps every amount an integer', () => {
    for (let h = 24; h <= 30 * 24; h += 17) {
      const p = calculatePrice({
        vehicle: car({ dailyRateMinor: 12345, weeklyDiscountBps: 1234 }),
        country: IN,
        pickupAt: t0,
        returnAt: plus(h),
        delivery: true,
      });
      for (const v of [p.totalMinor, p.taxMinor, p.platformFeeMinor, p.discountMinor, p.commissionMinor])
        expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe('formatting helpers', () => {
  it('formats labels', () => {
    expect(formatMoneyLabel(125000, 'AED')).toBe('AED 1,250.00');
    expect(formatMoneyLabel(-5000, 'INR')).toBe('-INR 50.00');
    expect(formatBpsPercent(500)).toBe('5%');
    expect(formatBpsPercent(1850)).toBe('18.5%');
  });
});
