import { computeCancellation, policyFee } from './cancellation';

const pickupAt = new Date('2026-12-10T10:00:00.000Z');
const hoursBefore = (h: number) => new Date(pickupAt.getTime() - h * 3_600_000);
const base = { rentalFeeMinor: 60000, dailyRateMinor: 20000, pickupAt };

describe('policyFee', () => {
  it('flexible: free ≥24h, else one day capped at rental fee', () => {
    expect(policyFee({ ...base, policy: 'flexible', now: hoursBefore(24) })).toBe(0);
    expect(policyFee({ ...base, policy: 'flexible', now: hoursBefore(23.9) })).toBe(20000);
    expect(policyFee({ ...base, rentalFeeMinor: 15000, policy: 'flexible', now: hoursBefore(1) })).toBe(15000);
  });
  it('moderate: free ≥72h, else 50%', () => {
    expect(policyFee({ ...base, policy: 'moderate', now: hoursBefore(72) })).toBe(0);
    expect(policyFee({ ...base, policy: 'moderate', now: hoursBefore(71) })).toBe(30000);
  });
  it('strict: free ≥7d, 50% ≥48h, else 100%', () => {
    expect(policyFee({ ...base, policy: 'strict', now: hoursBefore(168) })).toBe(0);
    expect(policyFee({ ...base, policy: 'strict', now: hoursBefore(167) })).toBe(30000);
    expect(policyFee({ ...base, policy: 'strict', now: hoursBefore(48) })).toBe(30000);
    expect(policyFee({ ...base, policy: 'strict', now: hoursBefore(47) })).toBe(60000);
  });
  it('rounds 50% half up', () => {
    expect(policyFee({ ...base, rentalFeeMinor: 33333, policy: 'moderate', now: hoursBefore(1) })).toBe(16667);
  });
});

describe('computeCancellation', () => {
  const common = { ...base, totalMinor: 70000, policy: 'strict' as const, now: hoursBefore(10) };
  it('held & pending_partner are always free', () => {
    expect(computeCancellation({ ...common, actor: 'customer', status: 'held', paymentStatus: 'unpaid' })).toEqual({
      eligible: true,
      free: true,
      feeMinor: 0,
      refundMinor: 0,
    });
    expect(
      computeCancellation({ ...common, actor: 'customer', status: 'pending_partner', paymentStatus: 'authorized' }),
    ).toEqual({
      eligible: true,
      free: true,
      feeMinor: 0,
      refundMinor: 70000,
    });
  });
  it('confirmed + paid applies the policy; refund = total − fee', () => {
    const out = computeCancellation({ ...common, actor: 'customer', status: 'confirmed', paymentStatus: 'captured' });
    expect(out).toEqual({ eligible: true, free: false, feeMinor: 60000, refundMinor: 10000 });
  });
  it('partner cancellations are free for the customer', () => {
    expect(
      computeCancellation({ ...common, actor: 'partner', status: 'confirmed', paymentStatus: 'captured' }),
    ).toEqual({
      eligible: true,
      free: true,
      feeMinor: 0,
      refundMinor: 70000,
    });
  });
  it('active / terminal bookings are not cancellable', () => {
    for (const status of ['active', 'completed', 'cancelled', 'rejected', 'expired'] as const) {
      expect(computeCancellation({ ...common, actor: 'customer', status, paymentStatus: 'captured' }).eligible).toBe(
        false,
      );
    }
    expect(computeCancellation({ ...common, actor: 'partner', status: 'held', paymentStatus: 'unpaid' }).eligible).toBe(
      false,
    );
  });
});
