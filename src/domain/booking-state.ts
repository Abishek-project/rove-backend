import { AppException } from '../common/errors/app-exception';
import { HOUR_MS } from './rental-dates';

export type BookingStatus =
  'held' | 'pending_partner' | 'confirmed' | 'active' | 'completed' | 'rejected' | 'cancelled' | 'expired';
export type PaymentStatus =
  'unpaid' | 'authorized' | 'captured' | 'partially_refunded' | 'refunded' | 'failed' | 'voided';
export type DepositStatus = 'not_held' | 'held' | 'released' | 'partially_released';
export type BookingMode = 'instant' | 'request';
export type ActorRole = 'customer' | 'partner' | 'admin' | 'system';

export const BLOCKING_STATUSES: BookingStatus[] = ['held', 'pending_partner', 'confirmed', 'active'];
export const TERMINAL_STATUSES: BookingStatus[] = ['completed', 'rejected', 'cancelled', 'expired'];

export type BookingTransition =
  | 'payment_authorized'
  | 'payment_failed'
  | 'hold_expired'
  | 'partner_accepted'
  | 'partner_rejected'
  | 'response_expired'
  | 'customer_cancelled'
  | 'partner_cancelled'
  | 'admin_cancelled'
  | 'pickup_recorded'
  | 'return_recorded';

/** Pickup may be recorded from this many hours before `pickupAt`. */
export const PICKUP_WINDOW_HOURS = 6;
export const HOLD_MINUTES = 15;
export const QUOTE_MINUTES = 15;
export const PARTNER_RESPONSE_HOURS = 24;

const TABLE: Record<BookingTransition, { from: BookingStatus[]; actors: ActorRole[] }> = {
  payment_authorized: { from: ['held'], actors: ['system', 'customer'] },
  payment_failed: { from: ['held'], actors: ['system', 'customer'] },
  hold_expired: { from: ['held'], actors: ['system'] },
  partner_accepted: { from: ['pending_partner'], actors: ['partner', 'admin'] },
  partner_rejected: { from: ['pending_partner'], actors: ['partner', 'admin'] },
  response_expired: { from: ['pending_partner'], actors: ['system'] },
  customer_cancelled: {
    from: ['held', 'pending_partner', 'confirmed'],
    actors: ['customer'],
  },
  partner_cancelled: {
    from: ['pending_partner', 'confirmed'],
    actors: ['partner'],
  },
  admin_cancelled: {
    from: ['held', 'pending_partner', 'confirmed'],
    actors: ['admin'],
  },
  pickup_recorded: { from: ['confirmed'], actors: ['partner'] },
  return_recorded: { from: ['active'], actors: ['partner'] },
};

/**
 * The booking state machine (CONTRACTS §6). Returns the next status or throws
 * `409 INVALID_STATE_TRANSITION`.
 */
export function nextStatus(
  from: BookingStatus,
  event: BookingTransition,
  ctx: { actor: ActorRole; bookingMode?: BookingMode },
): BookingStatus {
  const rule = TABLE[event];
  if (!rule.from.includes(from) || !rule.actors.includes(ctx.actor)) {
    throw new AppException(
      'INVALID_STATE_TRANSITION',
      `This booking is ${from.replace('_', ' ')}; that action is not allowed.`,
      {
        status: from,
        event,
      },
    );
  }
  switch (event) {
    case 'payment_authorized':
      return ctx.bookingMode === 'instant' ? 'confirmed' : 'pending_partner';
    case 'payment_failed':
      return 'held';
    case 'hold_expired':
    case 'response_expired':
      return 'expired';
    case 'partner_accepted':
      return 'confirmed';
    case 'partner_rejected':
      return 'rejected';
    case 'customer_cancelled':
    case 'partner_cancelled':
    case 'admin_cancelled':
      return 'cancelled';
    case 'pickup_recorded':
      return 'active';
    case 'return_recorded':
      return 'completed';
  }
}

export function canTransition(from: BookingStatus, event: BookingTransition, actor: ActorRole): boolean {
  const rule = TABLE[event];
  return rule.from.includes(from) && rule.actors.includes(actor);
}

/** Partner response deadline: 24 h after payment, or 2 h before pickup if sooner (never in the past). */
export function partnerResponseDueAt(now: Date, pickupAt: Date): Date {
  const in24h = now.getTime() + PARTNER_RESPONSE_HOURS * HOUR_MS;
  const beforePickup = pickupAt.getTime() - 2 * HOUR_MS;
  const due = Math.min(in24h, beforePickup);
  return new Date(due > now.getTime() ? due : pickupAt.getTime());
}

export interface ActionContextBooking {
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  pickupAt: Date;
  holdExpiresAt: Date | null;
  partnerResponseDueAt: Date | null;
}

export type CustomerAction = 'pay' | 'cancel' | 'contact_support';
export type PartnerAction = 'accept' | 'reject' | 'record_pickup' | 'record_return' | 'cancel';

export function customerAllowedActions(b: ActionContextBooking, now: Date = new Date()): CustomerAction[] {
  const actions: CustomerAction[] = [];
  const holdLive = b.holdExpiresAt !== null && b.holdExpiresAt.getTime() > now.getTime();
  if (b.status === 'held' && holdLive && (b.paymentStatus === 'unpaid' || b.paymentStatus === 'failed')) {
    actions.push('pay');
  }
  if (canTransition(b.status, 'customer_cancelled', 'customer') && (b.status !== 'held' || holdLive)) {
    actions.push('cancel');
  }
  actions.push('contact_support');
  return actions;
}

export function partnerAllowedActions(b: ActionContextBooking, now: Date = new Date()): PartnerAction[] {
  const actions: PartnerAction[] = [];
  if (b.status === 'pending_partner') {
    const live = b.partnerResponseDueAt === null || b.partnerResponseDueAt.getTime() > now.getTime();
    if (live) actions.push('accept', 'reject');
  }
  if (b.status === 'confirmed' && now.getTime() >= b.pickupAt.getTime() - PICKUP_WINDOW_HOURS * HOUR_MS) {
    actions.push('record_pickup');
  }
  if (b.status === 'active') actions.push('record_return');
  if (canTransition(b.status, 'partner_cancelled', 'partner')) actions.push('cancel');
  return actions;
}
