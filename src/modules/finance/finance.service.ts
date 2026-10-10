import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { PartnerMembership } from '../../common/auth/auth';
import { AppException } from '../../common/errors/app-exception';
import { Page, WithMeta } from '../../common/http/page';
import type { EarningsExportQuery, EarningsQuery, PayoutsQuery, PeriodQuery } from './finance.dto';
import { InjectDb } from '../../database/database';
import type { Db, DbOrTx } from '../../database/database';
import { Money, money } from '../../domain/money';
import { bookingQuery, BookingViews } from '../bookings/booking-views';
import { ExpiryService } from '../bookings/expiry';
import { addDays, todayUtc } from '../shared/documents';
import { shiftDate, zonedStartOfDay, zonedToday } from '../../domain/zoned-dates';

/**
 * CONTRACTS v1.2: `from`/`to` are inclusive `YYYY-MM-DD` dates in the partner country's timezone
 * (default: the last 30 days, today included). ISO instants are also tolerated.
 */
export function resolvePeriod(
  from: string | undefined,
  to: string | undefined,
  timeZone: string,
  now: Date = new Date(),
): { from: Date; to: Date; fromLabel: string; toLabel: string } {
  const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  const toLabel = to ?? zonedToday(timeZone, now);
  const fromLabel = from ?? (isDate(toLabel) ? shiftDate(toLabel, -29) : shiftDate(zonedToday(timeZone, now), -29));
  const toD = isDate(toLabel) ? zonedStartOfDay(shiftDate(toLabel, 1), timeZone) : new Date(toLabel);
  const fromD = isDate(fromLabel) ? zonedStartOfDay(fromLabel, timeZone) : new Date(fromLabel);
  if (fromD >= toD) throw AppException.validation({ to: ['must be on or after from'] });
  if (toD.getTime() - fromD.getTime() > 731 * 86_400_000)
    throw AppException.validation({ from: ['range must be at most 2 years'] });
  return { from: fromD, to: toD, fromLabel, toLabel };
}

/** Bookings that produce partner earnings: completed rentals, and cancellations where a fee was retained. */
function earningRows(db: DbOrTx, partnerId: string, period?: { from: Date; to: Date }, currency?: string) {
  let q = db
    .selectFrom('bookings as b')
    .leftJoin('payouts as po', 'po.id', 'b.payout_id')
    .select([
      'b.id',
      'b.reference',
      'b.status',
      'b.currency',
      'b.commission_minor',
      'b.partner_payout_minor',
      'b.actual_return_at',
      'b.cancelled_at',
      'b.payout_id',
      'po.status as payout_status',
      sql<Date>`coalesce(b.actual_return_at, b.cancelled_at)`.as('earned_at'),
    ])
    .where('b.partner_id', '=', partnerId)
    .where((eb) =>
      eb.or([
        eb('b.status', '=', 'completed'),
        eb.and([eb('b.status', '=', 'cancelled'), eb('b.partner_payout_minor', '>', 0)]),
      ]),
    );
  if (period) {
    q = q
      .where(sql<boolean>`coalesce(b.actual_return_at, b.cancelled_at) >= ${period.from}`)
      .where(sql<boolean>`coalesce(b.actual_return_at, b.cancelled_at) < ${period.to}`);
  }
  if (currency) q = q.where('b.currency', '=', currency);
  return q;
}

type EarningRow = Awaited<ReturnType<ReturnType<typeof earningRows>['execute']>>[number];

function toTransaction(r: EarningRow) {
  const gross = r.commission_minor + r.partner_payout_minor;
  return {
    bookingId: r.id,
    reference: r.reference,
    type: r.status === 'completed' ? 'rental' : 'cancellation_fee',
    completedAt: r.earned_at.toISOString(),
    currency: r.currency,
    gross: money(gross, r.currency),
    commission: money(r.commission_minor, r.currency),
    net: money(r.partner_payout_minor, r.currency),
    status: r.payout_status ?? 'unpaid',
    payoutId: r.payout_id,
  };
}

function major(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function csvCell(v: string): string {
  // Neutralise spreadsheet formula injection and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

@Injectable()
export class FinanceService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly views: BookingViews,
    private readonly expiry: ExpiryService,
  ) {}

  private async partnerCurrency(m: PartnerMembership): Promise<string> {
    const c = await this.db
      .selectFrom('countries')
      .select('currency_code')
      .where('code', '=', m.countryCode)
      .executeTakeFirstOrThrow();
    return c.currency_code.trim();
  }

  private async partnerTimezone(m: PartnerMembership): Promise<string> {
    const c = await this.db
      .selectFrom('countries')
      .select('default_timezone')
      .where('code', '=', m.countryCode)
      .executeTakeFirstOrThrow();
    return c.default_timezone;
  }

  async overview(m: PartnerMembership, q: PeriodQuery) {
    await this.expiry.run();
    const period = resolvePeriod(q.from, q.to, await this.partnerTimezone(m));
    const now = new Date();
    const today = todayUtc(now);
    const soon = addDays(today, 30);
    const pid = m.partnerId;

    const [
      vehicleCounts,
      bookingCounts,
      docsExpiring,
      rows,
      unpaid,
      recent,
      pending,
      overdue,
      rejectedVehicles,
      rejectedDocs,
    ] = await Promise.all([
      this.db
        .selectFrom('vehicles')
        .select([
          (eb) => eb.fn.countAll<number>().as('total'),
          sql<number>`count(*) filter (where status = 'published')`.as('published'),
          sql<number>`count(*) filter (where status = 'pending_review')`.as('pending_review'),
        ])
        .where('partner_id', '=', pid)
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('bookings')
        .select([
          sql<number>`count(*) filter (where status = 'confirmed' and pickup_at >= ${now})`.as('upcoming'),
          sql<number>`count(*) filter (where status = 'pending_partner')`.as('pending'),
          sql<number>`count(*) filter (where status = 'active')`.as('active'),
          sql<number>`count(*) filter (where status = 'completed')`.as('completed'),
        ])
        .where('partner_id', '=', pid)
        .executeTakeFirstOrThrow(),
      sql<{ n: number }>`
          select count(*)::int as n from (
            select expires_on from partner_documents where partner_id = ${pid} and status in ('submitted','approved')
            union all
            select d.expires_on from vehicle_documents d join vehicles v on v.id = d.vehicle_id
              where v.partner_id = ${pid} and d.status in ('submitted','approved')
          ) x where expires_on is not null and expires_on >= ${today}::date and expires_on <= ${soon}::date`.execute(
        this.db,
      ),
      earningRows(this.db, pid, period).execute(),
      earningRows(this.db, pid)
        .where((eb) => eb.or([eb('b.payout_id', 'is', null), eb('po.status', 'in', ['pending', 'processing'])]))
        .execute(),
      bookingQuery(this.db)
        .where('b.partner_id', '=', pid)
        .where('b.status', '!=', 'held')
        .orderBy('b.created_at', 'desc')
        .limit(5)
        .execute(),
      this.db
        .selectFrom('bookings')
        .select(['id', 'reference', 'partner_response_due_at'])
        .where('partner_id', '=', pid)
        .where('status', '=', 'pending_partner')
        .orderBy('partner_response_due_at')
        .limit(10)
        .execute(),
      this.db
        .selectFrom('bookings')
        .select(['id', 'reference'])
        .where('partner_id', '=', pid)
        .where('status', '=', 'active')
        .where('return_at', '<', now)
        .limit(10)
        .execute(),
      this.db
        .selectFrom('vehicles')
        .select(['id', 'make', 'model', 'rejection_reason'])
        .where('partner_id', '=', pid)
        .where('status', '=', 'rejected')
        .limit(10)
        .execute(),
      this.db
        .selectFrom('partner_documents')
        .select(['id', 'document_type'])
        .where('partner_id', '=', pid)
        .where('status', '=', 'rejected')
        .limit(10)
        .execute(),
    ]);

    const byCurrency = new Map<string, { gross: number; commission: number; net: number; pending: number }>();
    const bucket = (c: string) => {
      if (!byCurrency.has(c)) byCurrency.set(c, { gross: 0, commission: 0, net: 0, pending: 0 });
      return byCurrency.get(c)!;
    };
    bucket(await this.partnerCurrency(m));
    for (const r of rows) {
      const b = bucket(r.currency);
      b.gross += r.commission_minor + r.partner_payout_minor;
      b.commission += r.commission_minor;
      b.net += r.partner_payout_minor;
    }
    for (const r of unpaid) bucket(r.currency).pending += r.partner_payout_minor;

    const attention: {
      type: string;
      message: string;
      bookingId?: string;
      vehicleId?: string;
    }[] = [];
    for (const p of pending) {
      attention.push({
        type: 'booking_request',
        message: `Booking ${p.reference} is waiting for your response${p.partner_response_due_at ? ` (due ${p.partner_response_due_at.toISOString()})` : ''}.`,
        bookingId: p.id,
      });
    }
    for (const o of overdue)
      attention.push({
        type: 'return_overdue',
        message: `Booking ${o.reference} is past its return time.`,
        bookingId: o.id,
      });
    for (const v of rejectedVehicles) {
      attention.push({
        type: 'vehicle_rejected',
        message:
          `${v.make ?? 'Vehicle'} ${v.model ?? ''} was rejected${v.rejection_reason ? `: ${v.rejection_reason}` : ''}.`.replace(
            /\s+/g,
            ' ',
          ),
        vehicleId: v.id,
      });
    }
    for (const d of rejectedDocs) {
      attention.push({
        type: 'document_rejected',
        message: `Your ${d.document_type.replace(/_/g, ' ')} document was rejected. Please upload a new one.`,
      });
    }
    const expiring = Number(docsExpiring.rows[0]?.n ?? 0);
    if (expiring > 0)
      attention.push({
        type: 'documents_expiring',
        message: `${expiring} document(s) expire within 30 days.`,
      });
    if (m.status !== 'approved') {
      attention.unshift({
        type: 'partner_status',
        message: `Your company is ${m.status.replace('_', ' ')}.`,
      });
    }

    return {
      counts: {
        totalVehicles: Number(vehicleCounts.total),
        activeListings: Number(vehicleCounts.published),
        awaitingApproval: Number(vehicleCounts.pending_review),
        upcomingBookings: Number(bookingCounts.upcoming),
        pendingRequests: Number(bookingCounts.pending),
        currentlyRented: Number(bookingCounts.active),
        documentsExpiringSoon: expiring,
        completedRentals: Number(bookingCounts.completed),
      },
      financials: [...byCurrency.entries()].map(([currency, v]) => ({
        currency,
        grossRentalValue: money(v.gross, currency),
        platformCommission: money(v.commission, currency),
        netEarnings: money(v.net, currency),
        pendingPayouts: money(v.pending, currency),
      })),
      period: { from: period.fromLabel, to: period.toLabel },
      recentBookings: recent.map((r) => this.views.partnerSummary(r)),
      attention,
    };
  }

  async earnings(m: PartnerMembership, q: EarningsQuery) {
    const period = resolvePeriod(q.from, q.to, await this.partnerTimezone(m));
    const all = await earningRows(this.db, m.partnerId, period, q.currency)
      .orderBy('earned_at', 'desc')
      .orderBy('b.id')
      .execute();
    const sums = new Map<
      string,
      {
        gross: number;
        commission: number;
        adjustments: number;
        refunds: number;
        net: number;
      }
    >();
    if (!q.currency)
      sums.set(await this.partnerCurrency(m), {
        gross: 0,
        commission: 0,
        adjustments: 0,
        refunds: 0,
        net: 0,
      });
    else
      sums.set(q.currency, {
        gross: 0,
        commission: 0,
        adjustments: 0,
        refunds: 0,
        net: 0,
      });
    for (const r of all) {
      if (!sums.has(r.currency))
        sums.set(r.currency, {
          gross: 0,
          commission: 0,
          adjustments: 0,
          refunds: 0,
          net: 0,
        });
      const s = sums.get(r.currency)!;
      if (r.status === 'completed') {
        s.gross += r.commission_minor + r.partner_payout_minor;
        s.commission += r.commission_minor;
      } else {
        s.adjustments += r.partner_payout_minor;
      }
      s.net += r.partner_payout_minor;
    }
    const m$ = (v: number, c: string): Money => money(v, c);
    const pageRows = all.slice(q.offset, q.offset + q.pageSize);
    return new WithMeta(
      {
        period: { from: period.fromLabel, to: period.toLabel },
        summaries: [...sums.entries()].map(([c, s]) => ({
          currency: c,
          gross: m$(s.gross, c),
          commission: m$(s.commission, c),
          adjustments: m$(s.adjustments, c),
          refunds: m$(s.refunds, c),
          net: m$(s.net, c),
        })),
        transactions: pageRows.map(toTransaction),
      },
      Page.of([], q.page, q.pageSize, all.length).meta,
    );
  }

  async earningsCsv(m: PartnerMembership, q: EarningsExportQuery): Promise<string> {
    const period = resolvePeriod(q.from, q.to, await this.partnerTimezone(m));
    const rows = await earningRows(this.db, m.partnerId, period, q.currency)
      .orderBy('earned_at', 'desc')
      .limit(10_000)
      .execute();
    const header = ['reference', 'type', 'completed_at', 'currency', 'gross', 'commission', 'net', 'payout_status'];
    const lines = rows.map((r) => {
      const t = toTransaction(r);
      return [
        t.reference,
        t.type,
        t.completedAt,
        t.currency,
        major(t.gross.amountMinor),
        major(t.commission.amountMinor),
        major(t.net.amountMinor),
        t.status,
      ]
        .map(csvCell)
        .join(',');
    });
    return [header.join(','), ...lines].join('\n') + '\n';
  }

  async payouts(m: PartnerMembership, q: PayoutsQuery) {
    let base = this.db.selectFrom('payouts').where('partner_id', '=', m.partnerId);
    if (q.status) base = base.where('status', '=', q.status);
    if (q.currency) base = base.where('currency', '=', q.currency);
    // Date filters: payouts whose period overlaps [from, to] (inclusive dates).
    if (q.from) base = base.where('period_end', '>=', q.from.slice(0, 10));
    if (q.to) base = base.where('period_start', '<=', q.to.slice(0, 10));
    const [rows, count] = await Promise.all([
      base
        .selectAll()
        .orderBy('period_end', 'desc')
        .orderBy('created_at', 'desc')
        .limit(q.pageSize)
        .offset(q.offset)
        .execute(),
      base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return Page.of(rows.map(toPayout), q.page, q.pageSize, Number(count.n));
  }
}

export function toPayout(p: {
  id: string;
  currency: string;
  amount_minor: number;
  status: string;
  period_start: string;
  period_end: string;
  provider_reference: string | null;
  paid_at: Date | null;
  failure_reason: string | null;
  created_at: Date;
}) {
  return {
    id: p.id,
    currency: p.currency.trim(),
    amount: money(p.amount_minor, p.currency),
    status: p.status,
    periodStart: p.period_start,
    periodEnd: p.period_end,
    reference: p.provider_reference,
    paidAt: p.paid_at?.toISOString() ?? null,
    failureReason: p.failure_reason,
    createdAt: p.created_at.toISOString(),
  };
}
