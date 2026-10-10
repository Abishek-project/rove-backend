import { Inject, Injectable } from '@nestjs/common';
import type { PartnerMembership } from '../../common/auth/auth';
import { AppException } from '../../common/errors/app-exception';
import { Page } from '../../common/http/page';
import { InjectDb } from '../../database/database';
import type { Db } from '../../database/database';
import { BookingStatus, nextStatus, PICKUP_WINDOW_HOURS } from '../../domain/booking-state';
import { money } from '../../domain/money';
import { HOUR_MS } from '../../domain/rental-dates';
import { PAYMENT_PROVIDER } from '../../payments/payment-provider';
import type { PaymentProvider } from '../../payments/payment-provider';
import { StorageService } from '../../storage/storage.service';
import { checkUpload, objectPath, UploadedFileLike } from '../../storage/uploads';
import { bookingQuery, BookingViews } from './booking-views';
import type { PartnerBookingsQuery, PickupReportDto, ReturnReportDto } from './bookings.dto';
import { lockBooking, recordEvent, settleCancellation } from './bookings.service';
import { ExpiryService } from './expiry';

export const MAX_EVIDENCE_PER_STAGE = 30;

@Injectable()
export class PartnerBookingsService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly views: BookingViews,
    private readonly expiry: ExpiryService,
    private readonly storage: StorageService,
  ) {}

  async list(m: PartnerMembership, q: PartnerBookingsQuery) {
    await this.expiry.run();
    const now = new Date();
    let base = bookingQuery(this.db).where('b.partner_id', '=', m.partnerId).where('b.status', '!=', 'held');
    let order: 'asc' | 'desc' = 'asc';
    let orderCol: 'b.pickup_at' | 'b.return_at' = 'b.pickup_at';
    switch (q.filter) {
      case 'pending':
        base = base.where('b.status', '=', 'pending_partner');
        break;
      case 'confirmed':
        base = base.where('b.status', '=', 'confirmed');
        break;
      case 'upcoming_pickups':
        base = base
          .where('b.status', '=', 'confirmed')
          .where('b.pickup_at', '<=', new Date(now.getTime() + 7 * 24 * HOUR_MS));
        break;
      case 'active':
        base = base.where('b.status', '=', 'active');
        orderCol = 'b.return_at';
        break;
      case 'returns_due':
        base = base.where('b.status', '=', 'active').where('b.return_at', '<=', new Date(now.getTime() + 48 * HOUR_MS));
        orderCol = 'b.return_at';
        break;
      case 'completed':
        base = base.where('b.status', '=', 'completed');
        order = 'desc';
        break;
      case 'cancelled':
        base = base.where('b.status', 'in', ['cancelled', 'rejected', 'expired']);
        order = 'desc';
        break;
      default:
        order = 'desc';
    }
    if (q.q) {
      const like = `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      base = base.where((eb) =>
        eb.or([
          eb('b.reference', 'ilike', like),
          eb('v.make', 'ilike', like),
          eb('v.model', 'ilike', like),
          eb('cu.full_name', 'ilike', like),
        ]),
      );
    }
    const [rows, count] = await Promise.all([
      base.orderBy(orderCol, order).orderBy('b.id').limit(q.pageSize).offset(q.offset).execute(),
      base
        .clearSelect()
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .executeTakeFirstOrThrow(),
    ]);
    return Page.of(
      rows.map((r) => this.views.partnerSummary(r)),
      q.page,
      q.pageSize,
      Number(count.n),
    );
  }

  async get(m: PartnerMembership, bookingId: string) {
    await this.expiry.run({ bookingId });
    return this.views.partnerView(bookingId, m);
  }

  async accept(m: PartnerMembership, userId: string, bookingId: string) {
    await this.db.transaction().execute((trx) => this.expiry.run({ bookingId }, trx));
    const outcome = await this.db.transaction().execute(async (trx): Promise<'ok' | 'expired'> => {
      const b = await lockBooking(trx, bookingId, { partnerId: m.partnerId });
      if (b.status === 'expired') {
        throw new AppException('INVALID_STATE_TRANSITION', 'This request expired before it was accepted.', {
          status: b.status,
        });
      }
      // The deadline may have passed between the lazy expiry above and taking the row lock.
      if (
        b.status === 'pending_partner' &&
        b.partner_response_due_at &&
        b.partner_response_due_at.getTime() <= Date.now()
      ) {
        await this.expiry.run({ bookingId: b.id }, trx);
        return 'expired';
      }
      const to = nextStatus(b.status as BookingStatus, 'partner_accepted', {
        actor: 'partner',
      });
      const rental = await trx
        .selectFrom('payments')
        .selectAll()
        .where('booking_id', '=', b.id)
        .where('kind', '=', 'rental')
        .where('status', '=', 'authorized')
        .executeTakeFirst();
      if (!rental) throw new AppException('CONFLICT', 'The payment authorization for this booking is missing.');
      const cap = await this.provider.capture({
        intentId: rental.provider_reference,
        amount: money(b.total_minor, b.currency),
      });
      if (!cap.ok)
        throw new AppException('SERVICE_UNAVAILABLE', 'The payment could not be captured. Please try again.');
      await trx.updateTable('payments').set({ status: 'captured' }).where('id', '=', rental.id).execute();
      await trx
        .updateTable('bookings')
        .set({ status: to, payment_status: 'captured' })
        .where('id', '=', b.id)
        .execute();
      await recordEvent(trx, {
        bookingId: b.id,
        type: 'partner_accepted',
        from: b.status,
        to,
        actorRole: 'partner',
        actorUserId: userId,
      });
      return 'ok';
    });
    if (outcome === 'expired') {
      throw new AppException('INVALID_STATE_TRANSITION', 'This request expired before it was accepted.', {
        status: 'expired',
      });
    }
    return this.views.partnerView(bookingId, m);
  }

  async reject(m: PartnerMembership, userId: string, bookingId: string, reason: string) {
    await this.db.transaction().execute((trx) => this.expiry.run({ bookingId }, trx));
    await this.db.transaction().execute(async (trx) => {
      const b = await lockBooking(trx, bookingId, { partnerId: m.partnerId });
      const to = nextStatus(b.status as BookingStatus, 'partner_rejected', {
        actor: 'partner',
      });
      const settled = await settleCancellation(trx, this.provider, b, 0);
      await trx
        .updateTable('bookings')
        .set({
          status: to,
          payment_status: settled.paymentStatus,
          refund_minor: settled.refundMinor,
          rejection_reason: reason,
          commission_minor: 0,
          partner_payout_minor: 0,
        })
        .where('id', '=', b.id)
        .execute();
      await recordEvent(trx, {
        bookingId: b.id,
        type: 'partner_rejected',
        from: b.status,
        to,
        actorRole: 'partner',
        actorUserId: userId,
        data: { reason },
      });
    });
    return this.views.partnerView(bookingId, m);
  }

  async cancel(m: PartnerMembership, userId: string, bookingId: string, reason: string) {
    await this.db.transaction().execute((trx) => this.expiry.run({ bookingId }, trx));
    await this.db.transaction().execute(async (trx) => {
      const b = await lockBooking(trx, bookingId, { partnerId: m.partnerId });
      const to = nextStatus(b.status as BookingStatus, 'partner_cancelled', {
        actor: 'partner',
      });
      // Partner cancellations are always free for the customer: void or refund in full.
      const settled = await settleCancellation(trx, this.provider, b, 0);
      await trx
        .updateTable('bookings')
        .set({
          status: to,
          payment_status: settled.paymentStatus,
          refund_minor: settled.refundMinor,
          cancellation_fee_minor: 0,
          cancelled_by: 'partner',
          cancellation_reason: reason,
          cancelled_at: new Date(),
          commission_minor: 0,
          partner_payout_minor: 0,
        })
        .where('id', '=', b.id)
        .execute();
      await recordEvent(trx, {
        bookingId: b.id,
        type: 'partner_cancelled',
        from: b.status,
        to,
        actorRole: 'partner',
        actorUserId: userId,
        data: { reason, refundMinor: settled.refundMinor },
      });
    });
    return this.views.partnerView(bookingId, m);
  }

  async pickup(m: PartnerMembership, userId: string, bookingId: string, dto: PickupReportDto) {
    await this.db.transaction().execute(async (trx) => {
      const b = await lockBooking(trx, bookingId, { partnerId: m.partnerId });
      const to = nextStatus(b.status as BookingStatus, 'pickup_recorded', {
        actor: 'partner',
      });
      const opensAt = b.pickup_at.getTime() - PICKUP_WINDOW_HOURS * HOUR_MS;
      if (Date.now() < opensAt) {
        throw new AppException(
          'INVALID_STATE_TRANSITION',
          `Pickup can be recorded from ${PICKUP_WINDOW_HOURS} hours before the scheduled pickup time.`,
          { opensAt: new Date(opensAt).toISOString() },
        );
      }
      const report = await trx
        .insertInto('condition_reports')
        .values({
          booking_id: b.id,
          stage: 'pickup',
          odometer_km: dto.odometerKm,
          fuel_level_pct: dto.fuelLevelPct,
          notes: dto.notes ?? null,
          damages: JSON.stringify(dto.damages.map((d) => ({ ...d, isNew: d.isNew ?? false }))),
          customer_checks: JSON.stringify(dto.customerChecks),
          recorded_by: userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('evidence_photos')
        .set({ condition_report_id: report.id })
        .where('booking_id', '=', b.id)
        .where('stage', '=', 'pickup')
        .where('condition_report_id', 'is', null)
        .execute();
      let depositStatus = b.deposit_status;
      if (b.deposit_minor > 0) {
        const hold = await this.provider.holdDeposit({
          bookingId: b.id,
          amount: money(b.deposit_minor, b.currency),
        });
        if (!hold.ok) throw new AppException('PAYMENT_FAILED', 'The security deposit could not be held.');
        await trx
          .insertInto('payments')
          .values({
            booking_id: b.id,
            provider: this.provider.name,
            provider_reference: hold.reference,
            kind: 'deposit_hold',
            status: 'authorized',
            amount_minor: b.deposit_minor,
            currency: b.currency,
          })
          .execute();
        depositStatus = 'held';
      }
      await trx
        .updateTable('bookings')
        .set({
          status: to,
          deposit_status: depositStatus,
          actual_pickup_at: new Date(),
        })
        .where('id', '=', b.id)
        .execute();
      await recordEvent(trx, {
        bookingId: b.id,
        type: 'pickup_recorded',
        from: b.status,
        to,
        actorRole: 'partner',
        actorUserId: userId,
        data: {
          odometerKm: dto.odometerKm,
          fuelLevelPct: dto.fuelLevelPct,
          damages: dto.damages.length,
        },
      });
    });
    return this.views.partnerView(bookingId, m);
  }

  async return(m: PartnerMembership, userId: string, bookingId: string, dto: ReturnReportDto) {
    await this.db.transaction().execute(async (trx) => {
      const b = await lockBooking(trx, bookingId, { partnerId: m.partnerId });
      const to = nextStatus(b.status as BookingStatus, 'return_recorded', {
        actor: 'partner',
      });
      const pickup = await trx
        .selectFrom('condition_reports')
        .select('odometer_km')
        .where('booking_id', '=', b.id)
        .where('stage', '=', 'pickup')
        .executeTakeFirst();
      if (pickup && dto.odometerKm < pickup.odometer_km) {
        throw AppException.validation(
          {
            odometerKm: [`must be at least the pickup reading (${pickup.odometer_km} km)`],
          },
          'The return odometer reading cannot be lower than at pickup.',
        );
      }
      const report = await trx
        .insertInto('condition_reports')
        .values({
          booking_id: b.id,
          stage: 'return',
          odometer_km: dto.odometerKm,
          fuel_level_pct: dto.fuelLevelPct,
          notes: dto.notes ?? null,
          damages: JSON.stringify(dto.damages.map((d) => ({ ...d, isNew: d.isNew ?? false }))),
          recorded_by: userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('evidence_photos')
        .set({ condition_report_id: report.id })
        .where('booking_id', '=', b.id)
        .where('stage', '=', 'return')
        .where('condition_report_id', 'is', null)
        .execute();
      let depositStatus = b.deposit_status;
      if (b.deposit_status === 'held') {
        const hold = await trx
          .selectFrom('payments')
          .select('provider_reference')
          .where('booking_id', '=', b.id)
          .where('kind', '=', 'deposit_hold')
          .executeTakeFirst();
        // v1: always a full release; damage claims are handled by support (CONTRACTS §6).
        const rel = await this.provider.releaseDeposit({
          holdReference: hold?.provider_reference ?? b.id,
          amount: money(b.deposit_minor, b.currency),
        });
        await trx
          .updateTable('payments')
          .set({ status: 'voided' })
          .where('booking_id', '=', b.id)
          .where('kind', '=', 'deposit_hold')
          .execute();
        await trx
          .insertInto('payments')
          .values({
            booking_id: b.id,
            provider: this.provider.name,
            provider_reference: rel.reference,
            kind: 'deposit_release',
            status: 'succeeded',
            amount_minor: b.deposit_minor,
            currency: b.currency,
          })
          .execute();
        depositStatus = 'released';
      }
      await trx
        .updateTable('bookings')
        .set({
          status: to,
          deposit_status: depositStatus,
          actual_return_at: new Date(),
        })
        .where('id', '=', b.id)
        .execute();
      await recordEvent(trx, {
        bookingId: b.id,
        type: 'return_recorded',
        from: b.status,
        to,
        actorRole: 'partner',
        actorUserId: userId,
        data: {
          odometerKm: dto.odometerKm,
          fuelLevelPct: dto.fuelLevelPct,
          damages: dto.damages.length,
        },
      });
    });
    return this.views.partnerView(bookingId, m);
  }

  // ── evidence ──
  async uploadEvidence(
    m: PartnerMembership,
    userId: string,
    bookingId: string,
    stage: 'pickup' | 'return',
    file: UploadedFileLike | undefined,
  ) {
    const b = await this.views.loadForPartner(this.db, bookingId, m);
    const allowed: Record<'pickup' | 'return', string[]> = {
      pickup: ['confirmed', 'active'],
      return: ['active', 'completed'],
    };
    if (!allowed[stage].includes(b.status)) {
      throw new AppException(
        'INVALID_STATE_TRANSITION',
        `${stage === 'pickup' ? 'Pickup' : 'Return'} photos cannot be added to a ${b.status} booking.`,
      );
    }
    const count = await this.db
      .selectFrom('evidence_photos')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('booking_id', '=', b.id)
      .where('stage', '=', stage)
      .executeTakeFirstOrThrow();
    if (Number(count.n) >= MAX_EVIDENCE_PER_STAGE) {
      throw AppException.validation({
        file: [`at most ${MAX_EVIDENCE_PER_STAGE} photos per stage`],
      });
    }
    const checked = await checkUpload(file, 'image');
    const path = objectPath(`bookings/${b.id}/${stage}`, checked.ext);
    await this.storage.upload('booking-evidence', path, checked.buffer, checked.contentType);
    try {
      const report = await this.db
        .selectFrom('condition_reports')
        .select('id')
        .where('booking_id', '=', b.id)
        .where('stage', '=', stage)
        .executeTakeFirst();
      const row = await this.db
        .insertInto('evidence_photos')
        .values({
          booking_id: b.id,
          condition_report_id: report?.id ?? null,
          stage,
          storage_path: path,
          content_type: checked.contentType,
          size_bytes: checked.size,
          uploaded_by: userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const signed = await this.storage.signedUrl('booking-evidence', path);
      return {
        id: row.id,
        stage: row.stage,
        url: signed.url,
        expiresAt: signed.expiresAt,
        createdAt: row.created_at.toISOString(),
      };
    } catch (err) {
      await this.storage.remove('booking-evidence', [path]);
      throw err;
    }
  }

  async listEvidence(m: PartnerMembership, bookingId: string) {
    const b = await this.views.loadForPartner(this.db, bookingId, m);
    const rows = await this.db
      .selectFrom('evidence_photos')
      .selectAll()
      .where('booking_id', '=', b.id)
      .orderBy('created_at')
      .execute();
    const urls = await this.storage.signedUrls(
      'booking-evidence',
      rows.map((r) => r.storage_path),
    );
    return rows.map((r) => ({
      id: r.id,
      stage: r.stage,
      url: urls.get(r.storage_path)?.url ?? null,
      expiresAt: urls.get(r.storage_path)?.expiresAt ?? null,
      createdAt: r.created_at.toISOString(),
    }));
  }
}
