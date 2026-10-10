import { sql } from 'kysely';
import type { DbOrTx } from '../../database/database';
import { BLOCKING_STATUSES } from '../../domain/booking-state';

export interface ConflictReport {
  bookings: {
    id: string;
    reference: string;
    status: string;
    pickupAt: string;
    returnAt: string;
  }[];
  blocks: { id: string; startsAt: string; endsAt: string; reason: string }[];
}

/**
 * Availability for `[pickupAt, returnAt)` (CONTRACTS §7): no blocking booking whose buffered range
 * overlaps `[pickupAt, returnAt + buffer)`, and no availability block overlapping `[pickupAt, returnAt)`.
 */
export async function findBookingConflicts(
  db: DbOrTx,
  input: {
    vehicleId: string;
    pickupAt: Date;
    returnAt: Date;
    bufferHours: number;
    excludeBookingId?: string;
  },
): Promise<ConflictReport> {
  let bq = db
    .selectFrom('bookings')
    .select(['id', 'reference', 'status', 'pickup_at', 'return_at'])
    .where('vehicle_id', '=', input.vehicleId)
    .where('status', 'in', BLOCKING_STATUSES)
    .where(
      sql<boolean>`blocking_period && public.booking_blocking_range(${input.pickupAt}::timestamptz, ${input.returnAt}::timestamptz, ${input.bufferHours}::int)`,
    );
  if (input.excludeBookingId) bq = bq.where('id', '!=', input.excludeBookingId);
  const [bookings, blocks] = await Promise.all([
    bq.orderBy('pickup_at').execute(),
    db
      .selectFrom('availability_blocks')
      .select(['id', 'starts_at', 'ends_at', 'reason'])
      .where('vehicle_id', '=', input.vehicleId)
      .where(
        sql<boolean>`tstzrange(starts_at, ends_at, '[)') && tstzrange(${input.pickupAt}::timestamptz, ${input.returnAt}::timestamptz, '[)')`,
      )
      .orderBy('starts_at')
      .execute(),
  ]);
  return {
    bookings: bookings.map((b) => ({
      id: b.id,
      reference: b.reference,
      status: b.status,
      pickupAt: b.pickup_at.toISOString(),
      returnAt: b.return_at.toISOString(),
    })),
    blocks: blocks.map((b) => ({
      id: b.id,
      startsAt: b.starts_at.toISOString(),
      endsAt: b.ends_at.toISOString(),
      reason: b.reason,
    })),
  };
}

export function hasConflicts(r: ConflictReport): boolean {
  return r.bookings.length > 0 || r.blocks.length > 0;
}
