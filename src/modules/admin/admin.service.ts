import { Injectable } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsOptional, IsString, Length, Matches } from 'class-validator';
import { sql } from 'kysely';
import { AppException } from '../../common/errors/app-exception';
import { Page, PageQuery } from '../../common/http/page';
import { InjectDb } from '../../database/database';
import type { Db } from '../../database/database';
import { money } from '../../domain/money';
import { addDays } from '../shared/documents';
import { maskRegistration } from '../shared/format';
import { toPayout } from '../finance/finance.service';
import { recomputeCustomerVerification } from '../me/me.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class AdminPartnersQuery extends PageQuery {
  @IsOptional()
  @IsIn(['draft', 'pending_verification', 'approved', 'rejected', 'suspended'])
  status?: string;
}

export class AdminVehiclesQuery extends PageQuery {
  @IsOptional()
  @IsIn(['draft', 'pending_review', 'published', 'rejected', 'suspended', 'unavailable'])
  status?: string;
}

export class AdminReasonDto {
  @Transform(trim) @IsString() @Length(3, 500) reason: string;
}

export class AdminOptionalReasonDto {
  @IsOptional() @Transform(trim) @IsString() @Length(0, 500) reason?: string;
}

export class GeneratePayoutsDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  periodStart: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  periodEnd: string;
}

export class MarkPaidDto {
  @Transform(trim) @IsString() @Length(2, 120) reference: string;
}

export type DocKind = 'partner' | 'vehicle' | 'customer';
const DOC_TABLE = {
  partner: 'partner_documents',
  vehicle: 'vehicle_documents',
  customer: 'customer_documents',
} as const;

@Injectable()
export class AdminService {
  constructor(@InjectDb() private readonly db: Db) {}

  async listPartners(q: AdminPartnersQuery) {
    let base = this.db.selectFrom('partners as p');
    if (q.status) base = base.where('p.status', '=', q.status);
    const [rows, count] = await Promise.all([
      base
        .leftJoin('partner_members as pm', (j) => j.onRef('pm.partner_id', '=', 'p.id').on('pm.role', '=', 'owner'))
        .leftJoin('profiles as pr', 'pr.user_id', 'pm.user_id')
        .selectAll('p')
        .select([
          'pr.email as owner_email',
          sql<number>`(select count(*) from partner_documents d where d.partner_id = p.id)`.as('document_count'),
          sql<number>`(select count(*) from vehicles v where v.partner_id = p.id)`.as('vehicle_count'),
        ])
        .orderBy('p.created_at', 'desc')
        .limit(q.pageSize)
        .offset(q.offset)
        .execute(),
      base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return Page.of(
      rows.map((p) => ({
        id: p.id,
        legalName: p.legal_name,
        displayName: p.display_name,
        countryCode: p.country_code,
        status: p.status,
        rejectionReason: p.rejection_reason,
        ownerEmail: p.owner_email,
        documentCount: Number(p.document_count),
        vehicleCount: Number(p.vehicle_count),
        submittedAt: p.submitted_at?.toISOString() ?? null,
        verifiedAt: p.verified_at?.toISOString() ?? null,
        createdAt: p.created_at.toISOString(),
      })),
      q.page,
      q.pageSize,
      Number(count.n),
    );
  }

  private async setPartnerStatus(id: string, from: string[], to: string, patch: Record<string, unknown>) {
    return this.db.transaction().execute(async (trx) => {
      const p = await trx
        .selectFrom('partners')
        .select(['id', 'status'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!p) throw AppException.notFound('partner');
      if (!from.includes(p.status)) {
        throw new AppException('INVALID_STATE_TRANSITION', `Partner is ${p.status}; cannot move to ${to}.`, {
          status: p.status,
        });
      }
      const row = await trx
        .updateTable('partners')
        .set({ status: to, ...patch })
        .where('id', '=', id)
        .returning(['id', 'status', 'rejection_reason', 'verified_at'])
        .executeTakeFirstOrThrow();
      if (to === 'approved') {
        await trx
          .updateTable('partner_documents')
          .set({
            status: 'approved',
            reviewed_at: new Date(),
            rejection_reason: null,
          })
          .where('partner_id', '=', id)
          .where('status', '=', 'submitted')
          .execute();
      }
      return {
        id: row.id,
        status: row.status,
        rejectionReason: row.rejection_reason,
        verifiedAt: row.verified_at?.toISOString() ?? null,
      };
    });
  }

  approvePartner(id: string) {
    return this.setPartnerStatus(id, ['pending_verification', 'rejected', 'suspended'], 'approved', {
      verified_at: new Date(),
      rejection_reason: null,
    });
  }

  rejectPartner(id: string, reason: string) {
    return this.setPartnerStatus(id, ['pending_verification'], 'rejected', {
      rejection_reason: reason,
    });
  }

  suspendPartner(id: string, reason: string) {
    return this.setPartnerStatus(id, ['approved'], 'suspended', {
      rejection_reason: reason,
    });
  }

  async listVehicles(q: AdminVehiclesQuery) {
    let base = this.db.selectFrom('vehicles as v').innerJoin('partners as p', 'p.id', 'v.partner_id');
    if (q.status) base = base.where('v.status', '=', q.status);
    const [rows, count] = await Promise.all([
      base
        .select([
          'v.id',
          'v.make',
          'v.model',
          'v.year',
          'v.category',
          'v.status',
          'v.registration_number',
          'v.currency',
          'v.daily_rate_minor',
          'v.rejection_reason',
          'v.submitted_at',
          'v.updated_at',
          'p.id as partner_id',
          'p.display_name as partner_name',
          sql<number>`(select count(*) from vehicle_images i where i.vehicle_id = v.id)`.as('image_count'),
          sql<number>`(select count(*) from vehicle_documents d where d.vehicle_id = v.id)`.as('document_count'),
        ])
        .orderBy('v.submitted_at', 'asc')
        .orderBy('v.updated_at', 'desc')
        .limit(q.pageSize)
        .offset(q.offset)
        .execute(),
      base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return Page.of(
      rows.map((v) => ({
        id: v.id,
        make: v.make,
        model: v.model,
        year: v.year,
        category: v.category,
        status: v.status,
        registrationMasked: maskRegistration(v.registration_number),
        dailyRate: v.daily_rate_minor === null ? null : money(v.daily_rate_minor, v.currency),
        rejectionReason: v.rejection_reason,
        partner: { id: v.partner_id, displayName: v.partner_name },
        imageCount: Number(v.image_count),
        documentCount: Number(v.document_count),
        submittedAt: v.submitted_at?.toISOString() ?? null,
        updatedAt: v.updated_at.toISOString(),
      })),
      q.page,
      q.pageSize,
      Number(count.n),
    );
  }

  private async setVehicleStatus(id: string, to: 'published' | 'rejected', reason?: string) {
    return this.db.transaction().execute(async (trx) => {
      const v = await trx
        .selectFrom('vehicles')
        .select(['id', 'status'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!v) throw AppException.notFound('vehicle');
      if (v.status !== 'pending_review') {
        throw new AppException(
          'INVALID_STATE_TRANSITION',
          `Vehicle is ${v.status}; only vehicles pending review can be ${to}.`,
          {
            status: v.status,
          },
        );
      }
      const row = await trx
        .updateTable('vehicles')
        .set(
          to === 'published'
            ? { status: to, published_at: new Date(), rejection_reason: null }
            : { status: to, rejection_reason: reason ?? null },
        )
        .where('id', '=', id)
        .returning(['id', 'status', 'rejection_reason', 'published_at'])
        .executeTakeFirstOrThrow();
      if (to === 'published') {
        await trx
          .updateTable('vehicle_documents')
          .set({ status: 'approved', reviewed_at: new Date() })
          .where('vehicle_id', '=', id)
          .where('status', '=', 'submitted')
          .execute();
      }
      return {
        id: row.id,
        status: row.status,
        rejectionReason: row.rejection_reason,
        publishedAt: row.published_at?.toISOString() ?? null,
      };
    });
  }

  approveVehicle(id: string) {
    return this.setVehicleStatus(id, 'published');
  }

  rejectVehicle(id: string, reason: string) {
    return this.setVehicleStatus(id, 'rejected', reason);
  }

  async reviewDocument(kind: DocKind, id: string, decision: 'approve' | 'reject', reason?: string) {
    if (decision === 'reject' && (!reason || reason.trim().length < 3)) {
      throw AppException.validation({
        reason: ['a reason is required when rejecting'],
      });
    }
    const table = DOC_TABLE[kind];
    const row = await this.db
      .updateTable(table)
      .set({
        status: decision === 'approve' ? 'approved' : 'rejected',
        rejection_reason: decision === 'approve' ? null : (reason ?? null),
        reviewed_at: new Date(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw AppException.notFound('document');
    if (kind === 'customer') await recomputeCustomerVerification(this.db, (row as { user_id: string }).user_id);
    return {
      id: row.id,
      kind,
      documentType: row.document_type,
      status: row.status,
      rejectionReason: row.rejection_reason,
    };
  }

  /** Creates one pending payout per partner per currency from unpaid earnings in the period. */
  async generatePayouts(dto: GeneratePayoutsDto) {
    if (dto.periodEnd < dto.periodStart)
      throw AppException.validation({
        periodEnd: ['must be on or after periodStart'],
      });
    const from = new Date(`${dto.periodStart}T00:00:00.000Z`);
    const to = new Date(`${addDays(dto.periodEnd, 1)}T00:00:00.000Z`);
    return this.db.transaction().execute(async (trx) => {
      const groups = await trx
        .selectFrom('bookings')
        .select([
          'partner_id',
          'currency',
          (eb) => eb.fn.sum<number>('partner_payout_minor').as('amount'),
          (eb) => eb.fn.countAll<number>().as('n'),
        ])
        .where('payout_id', 'is', null)
        .where((eb) =>
          eb.or([
            eb('status', '=', 'completed'),
            eb.and([eb('status', '=', 'cancelled'), eb('partner_payout_minor', '>', 0)]),
          ]),
        )
        .where(sql<boolean>`coalesce(actual_return_at, cancelled_at) >= ${from}`)
        .where(sql<boolean>`coalesce(actual_return_at, cancelled_at) < ${to}`)
        .groupBy(['partner_id', 'currency'])
        .execute();
      const created = [];
      for (const g of groups) {
        const payout = await trx
          .insertInto('payouts')
          .values({
            partner_id: g.partner_id,
            currency: g.currency,
            amount_minor: Number(g.amount),
            status: 'pending',
            period_start: dto.periodStart,
            period_end: dto.periodEnd,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('bookings')
          .set({ payout_id: payout.id })
          .where('partner_id', '=', g.partner_id)
          .where('currency', '=', g.currency)
          .where('payout_id', 'is', null)
          .where((eb) =>
            eb.or([
              eb('status', '=', 'completed'),
              eb.and([eb('status', '=', 'cancelled'), eb('partner_payout_minor', '>', 0)]),
            ]),
          )
          .where(sql<boolean>`coalesce(actual_return_at, cancelled_at) >= ${from}`)
          .where(sql<boolean>`coalesce(actual_return_at, cancelled_at) < ${to}`)
          .execute();
        created.push({
          ...toPayout(payout),
          partnerId: g.partner_id,
          bookingCount: Number(g.n),
        });
      }
      return created;
    });
  }

  async markPayoutPaid(id: string, reference: string) {
    const row = await this.db
      .updateTable('payouts')
      .set({
        status: 'paid',
        provider_reference: reference,
        paid_at: new Date(),
        failure_reason: null,
      })
      .where('id', '=', id)
      .where('status', 'in', ['pending', 'processing'])
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      const exists = await this.db.selectFrom('payouts').select('status').where('id', '=', id).executeTakeFirst();
      if (!exists) throw AppException.notFound('payout');
      throw new AppException('INVALID_STATE_TRANSITION', `Payout is already ${exists.status}.`);
    }
    return toPayout(row);
  }
}
