import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import type { AuthUser } from '../../common/auth/auth';
import { AppException } from '../../common/errors/app-exception';
import { Page } from '../../common/http/page';
import { AppConfig } from '../../config/app-config';
import { InjectDb, pgCode, pgConstraint } from '../../database/database';
import type { Db, DbOrTx, Tx } from '../../database/database';
import {
  ActorRole,
  BookingStatus,
  HOLD_MINUTES,
  nextStatus,
  partnerResponseDueAt,
  PaymentStatus,
  QUOTE_MINUTES,
} from '../../domain/booking-state';
import { cancellationPolicyInfo, CancellationPolicy, computeCancellation } from '../../domain/cancellation';
import { applyBps, money } from '../../domain/money';
import { calculatePrice, PriceBreakdown } from '../../domain/pricing';
import { ageOn, validateRentalPeriod } from '../../domain/rental-dates';
import { PAYMENT_PROVIDER } from '../../payments/payment-provider';
import type { PaymentProvider } from '../../payments/payment-provider';
import { effectiveBookingMode, loadCountries, pricingVehicle, vehicleQuery } from '../catalog/catalog.service';
import { findBookingConflicts, hasConflicts } from './availability';
import { bookingQuery, BookingViews } from './booking-views';
import type { CancelDto, ConfirmPaymentDto, CreateBookingDto, CustomerBookingsQuery, QuoteDto } from './bookings.dto';
import { ExpiryService } from './expiry';

export const MIN_DRIVER_AGE = 21;
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateReference(): string {
  let s = 'RV-';
  for (let i = 0; i < 6; i++) s += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return s;
}

export const CUSTOMER_GROUPS: Record<string, BookingStatus[]> = {
  upcoming: ['confirmed'],
  pending: ['held', 'pending_partner'],
  active: ['active'],
  completed: ['completed'],
  cancelled: ['cancelled', 'rejected', 'expired'],
};

export async function recordEvent(
  db: DbOrTx,
  e: {
    bookingId: string;
    type: string;
    from: string | null;
    to: string | null;
    actorRole: ActorRole;
    actorUserId?: string | null;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .insertInto('booking_events')
    .values({
      booking_id: e.bookingId,
      event_type: e.type,
      from_status: e.from,
      to_status: e.to,
      actor_role: e.actorRole,
      actor_user_id: e.actorUserId ?? null,
      data: JSON.stringify(e.data ?? {}),
    })
    .execute();
}

/** Locks a booking row; callers must be inside a transaction. */
export async function lockBooking(trx: Tx, bookingId: string, scope: { customerId?: string; partnerId?: string }) {
  let q = trx.selectFrom('bookings').selectAll().where('id', '=', bookingId);
  if (scope.customerId) q = q.where('customer_id', '=', scope.customerId);
  if (scope.partnerId) q = q.where('partner_id', '=', scope.partnerId).where('status', '!=', 'held');
  const b = await q.forUpdate().executeTakeFirst();
  if (!b) throw AppException.notFound('booking');
  return b;
}

export type LockedBooking = Awaited<ReturnType<typeof lockBooking>>;

/**
 * Money side-effects of ending a booking before pickup: voids an authorization or refunds a
 * capture (minus `feeMinor`). Returns the new payment status and refund amount.
 */
export async function settleCancellation(
  trx: Tx,
  provider: PaymentProvider,
  b: LockedBooking,
  feeMinor: number,
): Promise<{ paymentStatus: PaymentStatus; refundMinor: number }> {
  const rental = await trx
    .selectFrom('payments')
    .selectAll()
    .where('booking_id', '=', b.id)
    .where('kind', '=', 'rental')
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  const status = b.payment_status as PaymentStatus;
  if (status === 'captured') {
    const refund = Math.max(b.total_minor - feeMinor, 0);
    if (refund > 0 && rental) {
      const res = await provider.refund({
        intentId: rental.provider_reference,
        amount: money(refund, b.currency),
      });
      if (!res.ok)
        throw new AppException('SERVICE_UNAVAILABLE', 'The refund could not be processed. Please try again.');
      await trx
        .insertInto('payments')
        .values({
          booking_id: b.id,
          provider: provider.name,
          provider_reference: res.reference,
          kind: 'refund',
          status: 'succeeded',
          amount_minor: refund,
          currency: b.currency,
        })
        .execute();
    }
    return {
      paymentStatus: refund === 0 ? 'captured' : refund === b.total_minor ? 'refunded' : 'partially_refunded',
      refundMinor: refund,
    };
  }
  if (rental && ['requires_confirmation', 'authorized', 'failed'].includes(rental.status)) {
    await provider.void({ intentId: rental.provider_reference });
    await trx.updateTable('payments').set({ status: 'voided' }).where('id', '=', rental.id).execute();
  }
  return {
    paymentStatus: 'voided',
    refundMinor: status === 'authorized' ? b.total_minor : 0,
  };
}

@Injectable()
export class BookingsService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly views: BookingViews,
    private readonly expiry: ExpiryService,
    private readonly config: AppConfig,
  ) {}

  private toQuote(
    q: {
      id: string;
      vehicle_id: string;
      pickup_at: Date;
      return_at: Date;
      days: number;
      currency: string;
      total_minor: number;
      deposit_minor: number;
      expires_at: Date;
      pricing: unknown;
      line_items: unknown;
      delivery: boolean;
      delivery_address: string | null;
    },
    policy: CancellationPolicy,
    bookingMode: string,
  ) {
    const pricing = q.pricing as PriceBreakdown;
    return {
      id: q.id,
      vehicleId: q.vehicle_id,
      pickupAt: q.pickup_at.toISOString(),
      returnAt: q.return_at.toISOString(),
      days: q.days,
      delivery: { enabled: q.delivery, address: q.delivery_address },
      lineItems: q.line_items,
      total: money(q.total_minor, q.currency),
      deposit: money(q.deposit_minor, q.currency),
      conditionalCharges: pricing.conditionalCharges,
      cancellationPolicy: cancellationPolicyInfo(policy),
      bookingMode,
      expiresAt: q.expires_at.toISOString(),
    };
  }

  private parsePeriod(pickupAt: string, returnAt: string) {
    const p = new Date(pickupAt);
    const r = new Date(returnAt);
    const errors = validateRentalPeriod(p, r);
    if (Object.keys(errors).length) throw AppException.validation(errors, 'Please check your rental dates.');
    return { pickupAt: p, returnAt: r };
  }

  async quote(auth: AuthUser, dto: QuoteDto) {
    const period = this.parsePeriod(dto.pickupAt, dto.returnAt);
    const delivery = dto.delivery?.enabled ?? false;
    if (delivery && !dto.delivery?.address) {
      throw AppException.validation({
        'delivery.address': ['is required when delivery is enabled'],
      });
    }
    await this.expiry.run({ vehicleId: dto.vehicleId });
    return this.db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('vehicles')
        .select('id')
        .where('id', '=', dto.vehicleId)
        .forUpdate()
        .executeTakeFirst();
      const v = locked
        ? await vehicleQuery(trx)
            .where('v.id', '=', dto.vehicleId)
            .where('v.status', '=', 'published')
            .where('p.status', '=', 'approved')
            .executeTakeFirst()
        : undefined;
      if (!v) throw AppException.notFound('vehicle');
      if (delivery && !v.delivery_available) {
        throw AppException.validation({
          'delivery.enabled': ['delivery is not available for this vehicle'],
        });
      }
      const conflicts = await findBookingConflicts(trx, {
        vehicleId: v.id,
        ...period,
        bufferHours: v.buffer_hours,
      });
      if (hasConflicts(conflicts)) throw new AppException('VEHICLE_UNAVAILABLE');
      const country = (await loadCountries(trx)).get(v.country_code)!;
      const price = calculatePrice({
        vehicle: pricingVehicle(v),
        country,
        ...period,
        delivery,
      });
      const q = await trx
        .insertInto('booking_quotes')
        .values({
          customer_id: auth.userId,
          vehicle_id: v.id,
          pickup_at: period.pickupAt,
          return_at: period.returnAt,
          delivery,
          delivery_address: delivery ? (dto.delivery?.address ?? null) : null,
          currency: price.currency,
          days: price.days,
          line_items: JSON.stringify(price.lineItems),
          pricing: JSON.stringify(price),
          total_minor: price.totalMinor,
          deposit_minor: price.depositMinor,
          expires_at: new Date(Date.now() + QUOTE_MINUTES * 60_000),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.toQuote(q, v.cancellation_policy as CancellationPolicy, effectiveBookingMode(v));
    });
  }

  async create(auth: AuthUser, dto: CreateBookingDto) {
    const quote = await this.db
      .selectFrom('booking_quotes')
      .selectAll()
      .where('id', '=', dto.quoteId)
      .where('customer_id', '=', auth.userId)
      .executeTakeFirst();
    if (!quote) throw AppException.notFound('quote');
    if (quote.expires_at.getTime() <= Date.now()) throw new AppException('QUOTE_EXPIRED');

    const profile = await this.db
      .selectFrom('profiles')
      .select(['full_name', 'phone', 'country_code', 'verification_status'])
      .where('user_id', '=', auth.userId)
      .executeTakeFirstOrThrow();
    if (!profile.full_name || !profile.phone || !profile.country_code) {
      throw AppException.validation({}, 'Please complete your profile (name, phone and country) before booking.', {
        reason: 'profile_incomplete',
      });
    }
    if (profile.verification_status !== 'submitted' && profile.verification_status !== 'verified') {
      throw AppException.validation({}, 'Please upload your verification documents before booking.', {
        reason: 'verification_required',
      });
    }
    if (ageOn(dto.driver.dateOfBirth, quote.pickup_at) < MIN_DRIVER_AGE) {
      throw AppException.validation(
        {
          'driver.dateOfBirth': [`driver must be at least ${MIN_DRIVER_AGE} years old at pickup`],
        },
        `The driver must be at least ${MIN_DRIVER_AGE} years old.`,
        { reason: 'driver_age' },
      );
    }

    await this.expiry.run({ vehicleId: quote.vehicle_id });
    let created: {
      bookingId: string;
      intent: { intentId: string; clientSecret: string; status: string };
    };
    try {
      created = await this.db.transaction().execute(async (trx) => {
        // Serializes concurrent bookings (and availability blocks) for this vehicle.
        const locked = await trx
          .selectFrom('vehicles')
          .select('id')
          .where('id', '=', quote.vehicle_id)
          .forUpdate()
          .executeTakeFirst();
        const v = locked
          ? await vehicleQuery(trx)
              .where('v.id', '=', quote.vehicle_id)
              .where('v.status', '=', 'published')
              .where('p.status', '=', 'approved')
              .executeTakeFirst()
          : undefined;
        if (!v) throw new AppException('VEHICLE_UNAVAILABLE');
        const conflicts = await findBookingConflicts(trx, {
          vehicleId: v.id,
          pickupAt: quote.pickup_at,
          returnAt: quote.return_at,
          bufferHours: v.buffer_hours,
        });
        if (hasConflicts(conflicts)) throw new AppException('VEHICLE_UNAVAILABLE');

        const price = quote.pricing as unknown as PriceBreakdown;
        let reference = generateReference();
        for (let i = 0; i < 5; i++) {
          const exists = await trx
            .selectFrom('bookings')
            .select('id')
            .where('reference', '=', reference)
            .executeTakeFirst();
          if (!exists) break;
          reference = generateReference();
        }
        const booking = await trx
          .insertInto('bookings')
          .values({
            reference,
            customer_id: auth.userId,
            vehicle_id: v.id,
            partner_id: v.partner_id,
            pickup_location_id: quote.delivery ? null : v.pickup_location_id,
            pickup_at: quote.pickup_at,
            return_at: quote.return_at,
            buffer_hours: v.buffer_hours,
            delivery: quote.delivery,
            delivery_address: quote.delivery_address,
            status: 'held',
            payment_status: 'unpaid',
            deposit_status: 'not_held',
            booking_mode: effectiveBookingMode(v),
            currency: quote.currency,
            days: price.days,
            daily_rate_minor: price.dailyRateMinor,
            rental_fee_minor: price.rentalFeeMinor,
            delivery_fee_minor: price.deliveryFeeMinor,
            discount_minor: price.discountMinor,
            platform_fee_minor: price.platformFeeMinor,
            tax_minor: price.taxMinor,
            total_minor: price.totalMinor,
            deposit_minor: price.depositMinor,
            commission_minor: price.commissionMinor,
            partner_payout_minor: price.partnerPayoutMinor,
            line_items: JSON.stringify(price.lineItems),
            conditional_charges: JSON.stringify(price.conditionalCharges),
            cancellation_policy: v.cancellation_policy as string,
            driver_full_name: dto.driver.fullName,
            driver_phone: dto.driver.phone,
            driver_date_of_birth: dto.driver.dateOfBirth,
            terms_accepted_at: new Date(),
            hold_expires_at: new Date(Date.now() + HOLD_MINUTES * 60_000),
            quote_id: quote.id,
          })
          .returning(['id'])
          .executeTakeFirstOrThrow();
        const intent = await this.provider.createIntent({
          bookingId: booking.id,
          amount: money(price.totalMinor, quote.currency),
        });
        await trx
          .insertInto('payments')
          .values({
            booking_id: booking.id,
            provider: this.provider.name,
            provider_reference: intent.intentId,
            kind: 'rental',
            status: 'requires_confirmation',
            amount_minor: price.totalMinor,
            currency: quote.currency,
          })
          .execute();
        await recordEvent(trx, {
          bookingId: booking.id,
          type: 'created',
          from: null,
          to: 'held',
          actorRole: 'customer',
          actorUserId: auth.userId,
          data: { reference, quoteId: quote.id },
        });
        return { bookingId: booking.id, intent };
      });
    } catch (err) {
      // The EXCLUDE constraint is the final guard against double booking.
      if (pgCode(err) === '23P01' && pgConstraint(err) === 'bookings_no_overlap')
        throw new AppException('VEHICLE_UNAVAILABLE');
      throw err;
    }
    const booking = await this.views.customerView(created.bookingId, auth.userId);
    return {
      booking,
      payment: {
        provider: this.provider.name,
        intentId: created.intent.intentId,
        clientSecret: created.intent.clientSecret,
        amount: booking.total,
        status: created.intent.status,
      },
    };
  }

  async confirmPayment(auth: AuthUser, bookingId: string, dto: ConfirmPaymentDto) {
    await this.db.transaction().execute((trx) => this.expiry.run({ bookingId }, trx));
    const failed = await this.db.transaction().execute(async (trx) => {
      const b = await lockBooking(trx, bookingId, { customerId: auth.userId });
      if (b.status === 'expired') throw new AppException('HOLD_EXPIRED');
      if (b.status !== 'held') {
        throw new AppException(
          'INVALID_STATE_TRANSITION',
          'This booking has already been paid or is no longer awaiting payment.',
          {
            status: b.status,
          },
        );
      }
      const payment = await trx
        .selectFrom('payments')
        .selectAll()
        .where('booking_id', '=', b.id)
        .where('kind', '=', 'rental')
        .where('provider_reference', '=', dto.intentId)
        .executeTakeFirst();
      if (!payment)
        throw AppException.validation({
          intentId: ['does not belong to this booking'],
        });

      const amount = money(b.total_minor, b.currency);
      const simulate = this.config.get('PAYMENT_PROVIDER') === 'mock' ? dto.simulateOutcome : undefined;
      const result = await this.provider.confirm({
        intentId: payment.provider_reference,
        amount,
        simulateOutcome: simulate,
      });

      if (result.status === 'failed') {
        await trx
          .updateTable('payments')
          .set({
            status: 'failed',
            failure_reason: result.failureReason ?? 'failed',
          })
          .where('id', '=', payment.id)
          .execute();
        await trx.updateTable('bookings').set({ payment_status: 'failed' }).where('id', '=', b.id).execute();
        await recordEvent(trx, {
          bookingId: b.id,
          type: 'payment_failed',
          from: 'held',
          to: 'held',
          actorRole: 'system',
          data: { reason: result.failureReason ?? 'failed' },
        });
        return true;
      }

      const to = nextStatus('held', 'payment_authorized', {
        actor: 'system',
        bookingMode: b.booking_mode as 'instant' | 'request',
      });
      if (to === 'confirmed') {
        const cap = await this.provider.capture({
          intentId: payment.provider_reference,
          amount,
        });
        if (!cap.ok)
          throw new AppException('SERVICE_UNAVAILABLE', 'The payment could not be captured. Please try again.');
        await trx
          .updateTable('payments')
          .set({ status: 'captured', failure_reason: null })
          .where('id', '=', payment.id)
          .execute();
        await trx
          .updateTable('bookings')
          .set({ status: 'confirmed', payment_status: 'captured' })
          .where('id', '=', b.id)
          .execute();
      } else {
        await trx
          .updateTable('payments')
          .set({ status: 'authorized', failure_reason: null })
          .where('id', '=', payment.id)
          .execute();
        await trx
          .updateTable('bookings')
          .set({
            status: 'pending_partner',
            payment_status: 'authorized',
            partner_response_due_at: partnerResponseDueAt(new Date(), b.pickup_at),
          })
          .where('id', '=', b.id)
          .execute();
      }
      await recordEvent(trx, {
        bookingId: b.id,
        type: 'payment_authorized',
        from: 'held',
        to,
        actorRole: 'system',
        data: { captured: to === 'confirmed', bookingMode: b.booking_mode },
      });
      return false;
    });
    const booking = await this.views.customerView(bookingId, auth.userId);
    if (failed) {
      throw new AppException(
        'PAYMENT_FAILED',
        'Your payment was declined. You can try again before your hold expires.',
        { booking },
      );
    }
    return booking;
  }

  async list(auth: AuthUser, q: CustomerBookingsQuery) {
    await this.expiry.run();
    let base = this.db.selectFrom('bookings as b').where('b.customer_id', '=', auth.userId);
    if (q.group) base = base.where('b.status', 'in', CUSTOMER_GROUPS[q.group]);
    const order = q.group === 'completed' || q.group === 'cancelled' ? 'desc' : 'asc';
    const [ids, count] = await Promise.all([
      base.select('b.id').orderBy('b.pickup_at', order).orderBy('b.id').limit(q.pageSize).offset(q.offset).execute(),
      base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    ]);
    const rows = ids.length ? await this.viewsQueryByIds(ids.map((i) => i.id)) : [];
    return Page.of(
      rows.map((r) => this.views.summary(r)),
      q.page,
      q.pageSize,
      Number(count.n),
    );
  }

  private async viewsQueryByIds(ids: string[]) {
    const rows = await bookingQuery(this.db).where('b.id', 'in', ids).execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)!).filter(Boolean);
  }

  async get(auth: AuthUser, bookingId: string) {
    await this.expiry.run({ bookingId });
    return this.views.customerView(bookingId, auth.userId);
  }

  async cancellationPreview(auth: AuthUser, bookingId: string) {
    await this.expiry.run({ bookingId });
    const b = await this.views.loadForCustomer(this.db, bookingId, auth.userId);
    const out = computeCancellation({
      actor: 'customer',
      status: b.status as BookingStatus,
      paymentStatus: b.payment_status as PaymentStatus,
      policy: b.cancellation_policy as CancellationPolicy,
      pickupAt: b.pickup_at,
      now: new Date(),
      rentalFeeMinor: b.rental_fee_minor,
      dailyRateMinor: b.daily_rate_minor || Math.floor(b.rental_fee_minor / b.days),
      totalMinor: b.total_minor,
    });
    return {
      eligible: out.eligible,
      free: out.free,
      fee: money(out.feeMinor, b.currency),
      refund: money(out.refundMinor, b.currency),
      ...(out.reason ? { reason: out.reason } : {}),
      policy: cancellationPolicyInfo(b.cancellation_policy as CancellationPolicy),
    };
  }

  async cancel(auth: AuthUser, bookingId: string, dto: CancelDto) {
    await this.db.transaction().execute((trx) => this.expiry.run({ bookingId }, trx));
    await this.db.transaction().execute(async (trx) => {
      const b = await lockBooking(trx, bookingId, { customerId: auth.userId });
      const out = computeCancellation({
        actor: 'customer',
        status: b.status as BookingStatus,
        paymentStatus: b.payment_status as PaymentStatus,
        policy: b.cancellation_policy as CancellationPolicy,
        pickupAt: b.pickup_at,
        now: new Date(),
        rentalFeeMinor: b.rental_fee_minor,
        dailyRateMinor: b.daily_rate_minor || Math.floor(b.rental_fee_minor / b.days),
        totalMinor: b.total_minor,
      });
      if (!out.eligible)
        throw new AppException('INVALID_STATE_TRANSITION', out.reason, {
          status: b.status,
        });
      const to = nextStatus(b.status as BookingStatus, 'customer_cancelled', {
        actor: 'customer',
      });
      const settled = await settleCancellation(trx, this.provider, b, out.feeMinor);
      const fee = b.payment_status === 'captured' ? b.total_minor - settled.refundMinor : 0;
      const countries = await loadCountries(trx);
      const partner = await trx
        .selectFrom('partners')
        .select('country_code')
        .where('id', '=', b.partner_id)
        .executeTakeFirstOrThrow();
      const commission = applyBps(fee, countries.get(partner.country_code)!.commissionBps);
      await trx
        .updateTable('bookings')
        .set({
          status: to,
          payment_status: settled.paymentStatus,
          cancelled_by: 'customer',
          cancellation_reason: dto.reason ?? null,
          cancellation_fee_minor: fee,
          refund_minor: settled.refundMinor,
          cancelled_at: new Date(),
          // A retained cancellation fee is the partner's revenue for this booking (minus commission).
          commission_minor: commission,
          partner_payout_minor: fee - commission,
        })
        .where('id', '=', b.id)
        .execute();
      await recordEvent(trx, {
        bookingId: b.id,
        type: 'customer_cancelled',
        from: b.status,
        to,
        actorRole: 'customer',
        actorUserId: auth.userId,
        data: { feeMinor: fee, refundMinor: settled.refundMinor },
      });
    });
    return this.views.customerView(bookingId, auth.userId);
  }
}
