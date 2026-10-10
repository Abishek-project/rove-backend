import { Injectable } from '@nestjs/common';
import type { PartnerMembership } from '../../common/auth/auth';
import { AppException } from '../../common/errors/app-exception';
import { InjectDb } from '../../database/database';
import type { Db, DbOrTx } from '../../database/database';
import {
  ActionContextBooking,
  BookingStatus,
  customerAllowedActions,
  PaymentStatus,
  partnerAllowedActions,
} from '../../domain/booking-state';
import { cancellationPolicyInfo, CancellationPolicy } from '../../domain/cancellation';
import { money } from '../../domain/money';
import { StorageService } from '../../storage/storage.service';
import { toPickupLocation } from '../reference/reference.controller';
import { requirementsFor } from '../shared/documents';
import { customerDisplayName, iso, maskRegistration } from '../shared/format';

export function bookingQuery(db: DbOrTx) {
  return db
    .selectFrom('bookings as b')
    .innerJoin('vehicles as v', 'v.id', 'b.vehicle_id')
    .innerJoin('partners as p', 'p.id', 'b.partner_id')
    .leftJoin('cities as c', 'c.id', 'v.city_id')
    .leftJoin('pickup_locations as l', 'l.id', 'b.pickup_location_id')
    .leftJoin('vehicle_images as vi', (j) => j.onRef('vi.vehicle_id', '=', 'v.id').on('vi.is_cover', '=', true))
    .innerJoin('profiles as cu', 'cu.user_id', 'b.customer_id')
    .selectAll('b')
    .select([
      'v.make',
      'v.model',
      'v.year',
      'v.registration_number',
      'v.fuel_policy',
      'p.display_name as partner_name',
      'p.country_code as partner_country',
      'c.id as city_id',
      'c.name as city_name',
      'c.timezone',
      'l.name as location_name',
      'l.address as location_address',
      'l.city_id as location_city_id',
      'l.latitude as location_latitude',
      'l.longitude as location_longitude',
      'vi.storage_path as cover_path',
      'cu.full_name as customer_full_name',
      'cu.phone as customer_phone',
      'cu.verification_status as customer_verification_status',
    ]);
}

export type BookingRow = Awaited<ReturnType<ReturnType<typeof bookingQuery>['executeTakeFirstOrThrow']>>;

function actionContext(b: BookingRow): ActionContextBooking {
  return {
    status: b.status as BookingStatus,
    paymentStatus: b.payment_status as PaymentStatus,
    pickupAt: b.pickup_at,
    holdExpiresAt: b.hold_expires_at,
    partnerResponseDueAt: b.partner_response_due_at,
  };
}

const PARTNER_NEXT_ACTION: Partial<Record<BookingStatus, string>> = {
  pending_partner: 'respond',
  confirmed: 'record_pickup',
  active: 'record_return',
};

function formatLocal(d: Date, timezone: string | null): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone ?? 'UTC',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
}

@Injectable()
export class BookingViews {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  async loadForCustomer(db: DbOrTx, bookingId: string, customerId: string): Promise<BookingRow> {
    const row = await bookingQuery(db)
      .where('b.id', '=', bookingId)
      .where('b.customer_id', '=', customerId)
      .executeTakeFirst();
    if (!row) throw AppException.notFound('booking');
    return row;
  }

  /** Partner view: `held` (unpaid) bookings are not visible to partners. */
  async loadForPartner(db: DbOrTx, bookingId: string, m: PartnerMembership): Promise<BookingRow> {
    const row = await bookingQuery(db)
      .where('b.id', '=', bookingId)
      .where('b.partner_id', '=', m.partnerId)
      .where('b.status', '!=', 'held')
      .executeTakeFirst();
    if (!row) throw AppException.notFound('booking');
    return row;
  }

  summary(b: BookingRow) {
    return {
      id: b.id,
      reference: b.reference,
      status: b.status,
      paymentStatus: b.payment_status,
      pickupAt: b.pickup_at.toISOString(),
      returnAt: b.return_at.toISOString(),
      total: money(b.total_minor, b.currency),
      vehicle: {
        id: b.vehicle_id,
        make: b.make,
        model: b.model,
        year: b.year,
        coverImageUrl: b.cover_path ? this.storage.publicUrl('car-images', b.cover_path) : null,
      },
      partner: { id: b.partner_id, displayName: b.partner_name },
      city: b.city_id ? { id: b.city_id, name: b.city_name as string } : null,
      timezone: b.timezone,
    };
  }

  partnerSummary(b: BookingRow) {
    return {
      id: b.id,
      reference: b.reference,
      status: b.status,
      paymentStatus: b.payment_status,
      vehicle: {
        id: b.vehicle_id,
        make: b.make,
        model: b.model,
        registrationMasked: maskRegistration(b.registration_number),
      },
      customer: { displayName: customerDisplayName(b.customer_full_name) },
      pickupAt: b.pickup_at.toISOString(),
      returnAt: b.return_at.toISOString(),
      total: money(b.total_minor, b.currency),
      partnerPayout: money(b.partner_payout_minor, b.currency),
      nextAction: this.partnerNextAction(b),
      timezone: b.timezone,
    };
  }

  private partnerNextAction(b: BookingRow): string | null {
    const allowed = partnerAllowedActions(actionContext(b));
    const next = PARTNER_NEXT_ACTION[b.status as BookingStatus];
    if (!next) return null;
    if (next === 'respond') return allowed.includes('accept') ? 'respond' : null;
    return next;
  }

  private async extras(db: DbOrTx, b: BookingRow) {
    const [events, reports, photos, reqs] = await Promise.all([
      db
        .selectFrom('booking_events')
        .selectAll()
        .where('booking_id', '=', b.id)
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
      db.selectFrom('condition_reports').selectAll().where('booking_id', '=', b.id).execute(),
      db
        .selectFrom('evidence_photos')
        .select(['stage', (eb) => eb.fn.countAll<number>().as('n')])
        .where('booking_id', '=', b.id)
        .groupBy('stage')
        .execute(),
      requirementsFor(db, b.partner_country, 'customer'),
    ]);
    const photoCount = (stage: string) => Number(photos.find((p) => p.stage === stage)?.n ?? 0);
    const report = (stage: 'pickup' | 'return', detailed: boolean) => {
      const r = reports.find((x) => x.stage === stage);
      if (!r) return null;
      return {
        recordedAt: r.recorded_at.toISOString(),
        odometerKm: r.odometer_km,
        fuelLevelPct: r.fuel_level_pct,
        damages: r.damages,
        photoCount: photoCount(stage),
        ...(detailed && { notes: r.notes, customerChecks: r.customer_checks }),
      };
    };
    return {
      events,
      report,
      requiredDocuments: reqs.filter((r) => r.isRequired).map((r) => r.label),
    };
  }

  private instructions(b: BookingRow) {
    const where = b.delivery
      ? `Your car will be delivered to ${b.delivery_address ?? 'your address'}`
      : b.location_name
        ? `Collect your car from ${b.location_name}, ${b.location_address}`
        : `Collect your car from ${b.partner_name}`;
    const pickupInstructions =
      `${where} on ${formatLocal(b.pickup_at, b.timezone)}. ` +
      'Bring the driving licence and ID you uploaded; the rental company will check them and inspect the car with you before handing over the keys.';
    const fuel =
      b.fuel_policy === 'full_to_full'
        ? 'Return it with a full tank.'
        : 'Return it with the same fuel level as at pickup.';
    const back = b.delivery
      ? 'The rental company will collect the car from the delivery address'
      : b.location_name
        ? `Return the car to ${b.location_name}, ${b.location_address}`
        : `Return the car to ${b.partner_name}`;
    const returnInstructions = `${back} by ${formatLocal(b.return_at, b.timezone)}. ${fuel} The car will be inspected together with you.`;
    return { pickupInstructions, returnInstructions };
  }

  private async base(db: DbOrTx, b: BookingRow, detailedReports: boolean) {
    const x = await this.extras(db, b);
    const cur = b.currency;
    return {
      x,
      body: {
        ...this.summary(b),
        days: b.days,
        bookingMode: b.booking_mode,
        depositStatus: b.deposit_status,
        delivery: { enabled: b.delivery, address: b.delivery_address },
        pickupLocation: b.pickup_location_id
          ? toPickupLocation({
              id: b.pickup_location_id,
              name: b.location_name as string,
              address: b.location_address as string,
              city_id: b.location_city_id as string,
              latitude: b.location_latitude,
              longitude: b.location_longitude,
            })
          : null,
        lineItems: b.line_items,
        deposit: money(b.deposit_minor, cur),
        conditionalCharges: b.conditional_charges,
        cancellationPolicy: cancellationPolicyInfo(b.cancellation_policy as CancellationPolicy),
        cancellationFee: money(b.cancellation_fee_minor, cur),
        refund: money(b.refund_minor, cur),
        holdExpiresAt: iso(b.hold_expires_at),
        partnerResponseDueAt: iso(b.partner_response_due_at),
        cancelledBy: b.cancelled_by,
        cancellationReason: b.cancellation_reason,
        rejectionReason: b.rejection_reason,
        ...this.instructions(b),
        requiredDocuments: x.requiredDocuments,
        pickupReport: x.report('pickup', detailedReports),
        returnReport: x.report('return', detailedReports),
        actualPickupAt: iso(b.actual_pickup_at),
        actualReturnAt: iso(b.actual_return_at),
        createdAt: b.created_at.toISOString(),
      },
    };
  }

  async customerBooking(db: DbOrTx, b: BookingRow, now = new Date()) {
    const { x, body } = await this.base(db, b, false);
    const allowedActions = customerAllowedActions(actionContext(b), now);
    return {
      ...body,
      driver: { fullName: b.driver_full_name, phone: b.driver_phone },
      events: x.events.map((e) => ({
        type: e.event_type,
        toStatus: e.to_status,
        at: e.created_at.toISOString(),
        actorRole: e.actor_role,
      })),
      // CONTRACTS v1.3: the open intent while the customer can still pay (customer view only).
      payment: allowedActions.includes('pay') ? await this.openIntent(db, b.id) : null,
      allowedActions,
    };
  }

  private async openIntent(db: DbOrTx, bookingId: string) {
    const p = await db
      .selectFrom('payments')
      .select(['provider', 'provider_reference', 'client_secret', 'amount_minor', 'currency', 'status'])
      .where('booking_id', '=', bookingId)
      .where('kind', '=', 'rental')
      .where('status', 'in', ['requires_confirmation', 'failed'])
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    if (!p) return null;
    return {
      provider: p.provider,
      intentId: p.provider_reference,
      clientSecret: p.client_secret,
      amount: money(p.amount_minor, p.currency),
      status: p.status,
    };
  }

  async partnerBooking(db: DbOrTx, b: BookingRow, now = new Date()) {
    const { x, body } = await this.base(db, b, true);
    const contactable = b.status === 'confirmed' || b.status === 'active';
    return {
      ...body,
      vehicle: {
        ...body.vehicle,
        registrationMasked: maskRegistration(b.registration_number),
      },
      driver: {
        fullName: b.driver_full_name,
        phone: contactable ? b.driver_phone : null,
      },
      customer: {
        displayName: customerDisplayName(b.customer_full_name),
        phone: contactable ? b.customer_phone : null,
        verificationStatus: b.customer_verification_status,
      },
      commission: money(b.commission_minor, b.currency),
      partnerPayout: money(b.partner_payout_minor, b.currency),
      events: x.events.map((e) => ({
        type: e.event_type,
        fromStatus: e.from_status,
        toStatus: e.to_status,
        at: e.created_at.toISOString(),
        actorRole: e.actor_role,
        data: e.data,
      })),
      nextAction: this.partnerNextAction(b),
      allowedActions: partnerAllowedActions(actionContext(b), now),
    };
  }

  /** Convenience for after-transaction reads. */
  async customerView(bookingId: string, customerId: string) {
    return this.customerBooking(this.db, await this.loadForCustomer(this.db, bookingId, customerId));
  }

  async partnerView(bookingId: string, m: PartnerMembership) {
    return this.partnerBooking(this.db, await this.loadForPartner(this.db, bookingId, m));
  }
}
