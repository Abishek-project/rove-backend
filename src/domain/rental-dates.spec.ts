import { ageOn, rentalDays, validateRentalPeriod } from './rental-dates';
import { shiftDate, zonedStartOfDay, zonedToday } from './zoned-dates';
import { resolvePeriod } from '../modules/finance/finance.service';

const now = new Date('2026-11-01T12:00:00.000Z');
const at = (h: number) => new Date(now.getTime() + h * 3_600_000);

describe('validateRentalPeriod', () => {
  it('accepts a valid period', () => {
    expect(validateRentalPeriod(at(2), at(26), now)).toEqual({});
    expect(validateRentalPeriod(at(24 * 180), at(24 * 181), now)).toEqual({});
  });
  it('requires pickup ≥ now + 2h', () => {
    expect(validateRentalPeriod(at(1.9), at(30), now).pickupAt).toBeDefined();
  });
  it('requires return after pickup, ≥ 24h and ≤ 30 days', () => {
    expect(validateRentalPeriod(at(5), at(5), now).returnAt).toEqual(['must be after pickupAt']);
    expect(validateRentalPeriod(at(5), at(28.9), now).returnAt?.[0]).toMatch(/at least 24 hours/);
    expect(validateRentalPeriod(at(5), at(5 + 30 * 24), now)).toEqual({});
    expect(validateRentalPeriod(at(5), at(5 + 30 * 24 + 1), now).returnAt?.[0]).toMatch(/at most 30 days/);
  });
  it('requires pickup within 180 days', () => {
    expect(validateRentalPeriod(at(24 * 181), at(24 * 182), now).pickupAt?.[0]).toMatch(/180 days/);
  });
  it('flags invalid dates', () => {
    expect(validateRentalPeriod(new Date('nope'), at(30), now).pickupAt).toBeDefined();
  });
});

describe('rentalDays / ageOn', () => {
  it('ceil of 24h blocks with a minimum', () => {
    expect(rentalDays(at(0), at(24))).toBe(1);
    expect(rentalDays(at(0), at(24.01))).toBe(2);
    expect(rentalDays(at(0), at(48), 3)).toBe(3);
  });
  it('computes driver age on the pickup date', () => {
    expect(ageOn('2005-11-01', new Date('2026-11-01T00:00:00Z'))).toBe(21);
    expect(ageOn('2005-11-02', new Date('2026-11-01T00:00:00Z'))).toBe(20);
  });
});

describe('zoned date ranges (CONTRACTS v1.2)', () => {
  it('converts local midnight to UTC', () => {
    expect(zonedStartOfDay('2026-11-02', 'Asia/Dubai').toISOString()).toBe('2026-11-01T20:00:00.000Z');
    expect(zonedStartOfDay('2026-11-02', 'Asia/Kolkata').toISOString()).toBe('2026-11-01T18:30:00.000Z');
    expect(zonedStartOfDay('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
  });
  it('knows the local date', () => {
    expect(zonedToday('Asia/Dubai', new Date('2026-11-01T21:00:00Z'))).toBe('2026-11-02');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('resolvePeriod: inclusive local dates, default last 30 days', () => {
    const p = resolvePeriod('2026-10-01', '2026-10-31', 'Asia/Dubai');
    expect(p.from.toISOString()).toBe('2026-09-30T20:00:00.000Z');
    expect(p.to.toISOString()).toBe('2026-10-31T20:00:00.000Z');
    const d = resolvePeriod(undefined, undefined, 'Asia/Kolkata', new Date('2026-11-01T12:00:00Z'));
    expect(d.fromLabel).toBe('2026-10-03');
    expect(d.toLabel).toBe('2026-11-01');
    expect(() => resolvePeriod('2026-10-05', '2026-10-01', 'Asia/Dubai')).toThrow();
  });
});
