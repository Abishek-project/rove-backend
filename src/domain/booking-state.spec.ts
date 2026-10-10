import { AppException } from '../common/errors/app-exception';
import {
  BookingStatus,
  BookingTransition,
  customerAllowedActions,
  nextStatus,
  partnerAllowedActions,
  partnerResponseDueAt,
} from './booking-state';

const H = 3_600_000;

describe('booking state machine (CONTRACTS §6)', () => {
  const ok: [
    BookingStatus,
    BookingTransition,
    'customer' | 'partner' | 'system',
    BookingStatus,
    ('instant' | 'request')?,
  ][] = [
    ['held', 'payment_authorized', 'system', 'confirmed', 'instant'],
    ['held', 'payment_authorized', 'system', 'pending_partner', 'request'],
    ['held', 'payment_failed', 'system', 'held'],
    ['held', 'hold_expired', 'system', 'expired'],
    ['pending_partner', 'partner_accepted', 'partner', 'confirmed'],
    ['pending_partner', 'partner_rejected', 'partner', 'rejected'],
    ['pending_partner', 'response_expired', 'system', 'expired'],
    ['held', 'customer_cancelled', 'customer', 'cancelled'],
    ['pending_partner', 'customer_cancelled', 'customer', 'cancelled'],
    ['confirmed', 'customer_cancelled', 'customer', 'cancelled'],
    ['pending_partner', 'partner_cancelled', 'partner', 'cancelled'],
    ['confirmed', 'partner_cancelled', 'partner', 'cancelled'],
    ['confirmed', 'pickup_recorded', 'partner', 'active'],
    ['active', 'return_recorded', 'partner', 'completed'],
  ];
  it.each(ok)('%s --%s(%s)--> %s', (...row) => {
    const [from, ev, actor, to, mode] = row;
    expect(nextStatus(from, ev, { actor, bookingMode: mode })).toBe(to);
  });

  const illegal: [BookingStatus, BookingTransition, 'customer' | 'partner' | 'system'][] = [
    ['confirmed', 'payment_authorized', 'system'],
    ['held', 'partner_accepted', 'partner'],
    ['active', 'customer_cancelled', 'customer'],
    ['held', 'partner_cancelled', 'partner'],
    ['pending_partner', 'pickup_recorded', 'partner'],
    ['confirmed', 'return_recorded', 'partner'],
    ['completed', 'customer_cancelled', 'customer'],
    ['expired', 'payment_authorized', 'system'],
    ['pending_partner', 'partner_accepted', 'customer'],
    ['held', 'hold_expired', 'customer'],
  ];
  it.each(illegal)('rejects %s --%s(%s)', (from, ev, actor) => {
    try {
      nextStatus(from, ev, { actor });
      fail('expected an error');
    } catch (e) {
      expect(e).toBeInstanceOf(AppException);
      expect((e as AppException).code).toBe('INVALID_STATE_TRANSITION');
      expect((e as AppException).status).toBe(409);
    }
  });
});

describe('partnerResponseDueAt', () => {
  const now = new Date('2026-11-01T00:00:00.000Z');
  it('is 24h after payment when pickup is far away', () => {
    expect(partnerResponseDueAt(now, new Date(now.getTime() + 72 * H)).toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });
  it('is 2h before pickup when that is sooner', () => {
    expect(partnerResponseDueAt(now, new Date(now.getTime() + 10 * H)).toISOString()).toBe('2026-11-01T08:00:00.000Z');
  });
  it('never lies in the past', () => {
    expect(partnerResponseDueAt(now, new Date(now.getTime() + H)).getTime()).toBeGreaterThan(now.getTime());
  });
});

describe('allowedActions', () => {
  const now = new Date('2026-11-01T00:00:00.000Z');
  const b = (o: Partial<Parameters<typeof customerAllowedActions>[0]>) => ({
    status: 'held' as BookingStatus,
    paymentStatus: 'unpaid' as const,
    pickupAt: new Date(now.getTime() + 48 * H),
    holdExpiresAt: new Date(now.getTime() + 10 * 60_000),
    partnerResponseDueAt: null,
    ...o,
  });
  it('customer: pay + cancel while the hold is live', () => {
    expect(customerAllowedActions(b({}), now)).toEqual(['pay', 'cancel', 'contact_support']);
    expect(customerAllowedActions(b({ paymentStatus: 'failed' }), now)).toContain('pay');
    expect(customerAllowedActions(b({ holdExpiresAt: new Date(now.getTime() - 1) }), now)).toEqual(['contact_support']);
  });
  it('customer: only support once active/completed', () => {
    expect(customerAllowedActions(b({ status: 'active', paymentStatus: 'captured' }), now)).toEqual([
      'contact_support',
    ]);
    expect(customerAllowedActions(b({ status: 'confirmed', paymentStatus: 'captured' }), now)).toEqual([
      'cancel',
      'contact_support',
    ]);
  });
  it('partner: accept/reject until the deadline', () => {
    const pending = b({
      status: 'pending_partner',
      paymentStatus: 'authorized',
      partnerResponseDueAt: new Date(now.getTime() + H),
    });
    expect(partnerAllowedActions(pending, now)).toEqual(['accept', 'reject', 'cancel']);
    expect(partnerAllowedActions({ ...pending, partnerResponseDueAt: new Date(now.getTime() - 1) }, now)).toEqual([
      'cancel',
    ]);
  });
  it('partner: pickup opens 6h before pickupAt; return when active', () => {
    const confirmed = b({ status: 'confirmed', paymentStatus: 'captured', pickupAt: new Date(now.getTime() + 7 * H) });
    expect(partnerAllowedActions(confirmed, now)).toEqual(['cancel']);
    expect(partnerAllowedActions({ ...confirmed, pickupAt: new Date(now.getTime() + 6 * H) }, now)).toEqual([
      'record_pickup',
      'cancel',
    ]);
    expect(partnerAllowedActions(b({ status: 'active', paymentStatus: 'captured' }), now)).toEqual(['record_return']);
    expect(partnerAllowedActions(b({ status: 'completed', paymentStatus: 'captured' }), now)).toEqual([]);
  });
});
