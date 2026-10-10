export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export const RENTAL_RULES = {
  minLeadHours: 2,
  minDurationHours: 24,
  maxDurationDays: 30,
  maxAdvanceDays: 180,
} as const;

/**
 * Validates a rental period (CONTRACTS §7). Returns field errors keyed by `pickupAt`/`returnAt`;
 * an empty object means valid.
 */
export function validateRentalPeriod(pickupAt: Date, returnAt: Date, now: Date = new Date()): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  const add = (f: string, m: string) => (errors[f] = [...(errors[f] ?? []), m]);
  if (Number.isNaN(pickupAt.getTime())) add('pickupAt', 'must be a valid ISO-8601 date-time');
  if (Number.isNaN(returnAt.getTime())) add('returnAt', 'must be a valid ISO-8601 date-time');
  if (Object.keys(errors).length) return errors;

  const p = pickupAt.getTime();
  const r = returnAt.getTime();
  const n = now.getTime();
  if (p < n + RENTAL_RULES.minLeadHours * HOUR_MS) {
    add('pickupAt', `must be at least ${RENTAL_RULES.minLeadHours} hours from now`);
  }
  if (p > n + RENTAL_RULES.maxAdvanceDays * DAY_MS) {
    add('pickupAt', `must be within ${RENTAL_RULES.maxAdvanceDays} days from now`);
  }
  if (r <= p) {
    add('returnAt', 'must be after pickupAt');
  } else {
    if (r - p < RENTAL_RULES.minDurationHours * HOUR_MS) {
      add('returnAt', `rental must be at least ${RENTAL_RULES.minDurationHours} hours`);
    }
    if (r - p > RENTAL_RULES.maxDurationDays * DAY_MS) {
      add('returnAt', `rental must be at most ${RENTAL_RULES.maxDurationDays} days`);
    }
  }
  return errors;
}

/** `max(ceil((returnAt − pickupAt) / 24h), minRentalDays)` */
export function rentalDays(pickupAt: Date, returnAt: Date, minRentalDays = 1): number {
  const raw = Math.ceil((returnAt.getTime() - pickupAt.getTime()) / DAY_MS);
  return Math.max(raw, minRentalDays, 1);
}

/** Driver age in whole years on `onDate` (both `YYYY-MM-DD` / Date). */
export function ageOn(dateOfBirth: string, onDate: Date): number {
  const [y, m, d] = dateOfBirth.split('-').map(Number);
  const oy = onDate.getUTCFullYear();
  const om = onDate.getUTCMonth() + 1;
  const od = onDate.getUTCDate();
  let age = oy - y;
  if (om < m || (om === m && od < d)) age -= 1;
  return age;
}
