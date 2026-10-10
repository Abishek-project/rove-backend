import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { sql } from 'kysely';
import { AppConfig } from '../../config/app-config';
import { InjectDb } from '../../database/database';
import type { Db, DbOrTx } from '../../database/database';
import { PAYMENT_PROVIDER } from '../../payments/payment-provider';
import type { PaymentProvider } from '../../payments/payment-provider';

/**
 * Expires held bookings past `hold_expires_at` and partner requests past `partner_response_due_at`
 * (CONTRACTS §6). Runs every minute and lazily before availability checks. Idempotent: rows are
 * re-checked under the row lock taken by UPDATE, so a concurrent payment/accept wins or loses cleanly.
 */
export async function expireOverdueBookings(
  db: DbOrTx,
  provider: PaymentProvider,
  scope: { vehicleId?: string; bookingId?: string } = {},
): Promise<number> {
  const expired: {
    id: string;
    from: string;
    total: number;
    paymentStatus: string;
  }[] = [];

  for (const kind of ['held', 'pending_partner'] as const) {
    let q = db
      .updateTable('bookings')
      .set({
        status: 'expired',
        payment_status: sql<string>`case when payment_status in ('unpaid', 'failed', 'authorized') then 'voided' else payment_status end`,
        refund_minor: sql<number>`case when payment_status = 'authorized' then total_minor else 0 end`,
      })
      .where('status', '=', kind)
      .where(kind === 'held' ? 'hold_expires_at' : 'partner_response_due_at', '<=', new Date());
    if (scope.vehicleId) q = q.where('vehicle_id', '=', scope.vehicleId);
    if (scope.bookingId) q = q.where('id', '=', scope.bookingId);
    const rows = await q.returning(['id', 'total_minor', 'payment_status']).execute();
    expired.push(
      ...rows.map((r) => ({
        id: r.id,
        from: kind,
        total: r.total_minor,
        paymentStatus: r.payment_status,
      })),
    );
  }
  if (expired.length === 0) return 0;

  const ids = expired.map((e) => e.id);
  const intents = await db
    .updateTable('payments')
    .set({ status: 'voided' })
    .where('booking_id', 'in', ids)
    .where('kind', '=', 'rental')
    .where('status', 'in', ['requires_confirmation', 'authorized', 'failed'])
    .returning(['provider_reference'])
    .execute();
  for (const i of intents) await provider.void({ intentId: i.provider_reference });

  await db
    .insertInto('booking_events')
    .values(
      expired.map((e) => ({
        booking_id: e.id,
        event_type: e.from === 'held' ? 'hold_expired' : 'response_expired',
        from_status: e.from,
        to_status: 'expired',
        actor_role: 'system',
        data: JSON.stringify({}),
      })),
    )
    .execute();
  return expired.length;
}

@Injectable()
export class ExpiryService {
  private readonly logger = new Logger(ExpiryService.name);
  private running = false;

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly config: AppConfig,
  ) {}

  /** Lazy expiry before availability checks / reads. */
  run(scope: { vehicleId?: string; bookingId?: string } = {}, db: DbOrTx = this.db): Promise<number> {
    return expireOverdueBookings(db, this.provider, scope);
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'booking-expiry' })
  async tick(): Promise<void> {
    if (!this.config.get('ENABLE_CRON') || this.running) return;
    this.running = true;
    try {
      const n = await this.db.transaction().execute((trx) => expireOverdueBookings(trx, this.provider));
      if (n > 0) this.logger.log(`Expired ${n} booking(s)`);
      await this.db
        .deleteFrom('idempotency_keys')
        .where('created_at', '<', new Date(Date.now() - 24 * 3_600_000))
        .execute();
    } catch (err) {
      this.logger.error(`Expiry job failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
