import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth';
import { AppException } from '../../common/errors/app-exception';
import { Page, PageQuery } from '../../common/http/page';
import { InjectDb } from '../../database/database';
import type { Db, DbOrTx } from '../../database/database';
import { StorageService } from '../../storage/storage.service';
import { checkUpload, objectPath, UploadedFileLike } from '../../storage/uploads';
import {
  requiredDocsApproved,
  requiredDocsPresent,
  requirementsFor,
  summarizeRequirements,
  todayUtc,
} from '../shared/documents';
import type { CreateSupportRequestDto, UpdateMeDto, UploadDocumentDto } from './me.dto';

/** Recomputes `profiles.verification_status` from the customer's documents. */
export async function recomputeCustomerVerification(db: DbOrTx, userId: string): Promise<string> {
  const profile = await db
    .selectFrom('profiles')
    .select(['country_code', 'verification_status'])
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  const reqs = await requirementsFor(db, profile.country_code, 'customer');
  const docs = await db
    .selectFrom('customer_documents')
    .select(['id', 'document_type', 'status', 'rejection_reason', 'expires_on', 'created_at'])
    .where('user_id', '=', userId)
    .execute();
  const states = summarizeRequirements(reqs, docs);
  let status: string;
  if (reqs.length > 0 && requiredDocsApproved(states)) status = 'verified';
  else if (states.some((s) => s.isRequired && s.status === 'rejected')) status = 'rejected';
  else if (reqs.length > 0 && requiredDocsPresent(states)) status = 'submitted';
  else status = 'not_started';
  if (status !== profile.verification_status) {
    await db.updateTable('profiles').set({ verification_status: status }).where('user_id', '=', userId).execute();
  }
  return status;
}

@Injectable()
export class MeService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  async get(auth: AuthUser) {
    const p = await this.db
      .selectFrom('profiles')
      .selectAll()
      .where('user_id', '=', auth.userId)
      .executeTakeFirstOrThrow();
    return {
      user: { id: auth.userId, email: p.email ?? auth.email },
      profile: {
        fullName: p.full_name,
        phone: p.phone,
        countryCode: p.country_code,
        cityId: p.city_id,
        preferredLanguage: p.preferred_language,
        notificationPrefs: p.notification_prefs,
        verificationStatus: p.verification_status,
        deletionRequestedAt: p.deletion_requested_at?.toISOString() ?? null,
      },
      profileComplete: Boolean(p.full_name && p.phone && p.country_code),
      isAdmin: p.is_admin,
      partner: auth.partner
        ? {
            id: auth.partner.partnerId,
            displayName: auth.partner.displayName,
            status: auth.partner.status,
            role: auth.partner.role,
          }
        : null,
    };
  }

  async update(auth: AuthUser, dto: UpdateMeDto) {
    const current = await this.db
      .selectFrom('profiles')
      .select(['country_code', 'city_id', 'notification_prefs'])
      .where('user_id', '=', auth.userId)
      .executeTakeFirstOrThrow();
    const countryCode = dto.countryCode ?? current.country_code;
    const countryChanged = dto.countryCode !== undefined && dto.countryCode !== current.country_code;
    let cityId = dto.cityId !== undefined ? dto.cityId : countryChanged ? null : current.city_id;
    if (cityId) {
      const city = await this.db
        .selectFrom('cities')
        .select('country_code')
        .where('id', '=', cityId)
        .executeTakeFirst();
      if (!city) throw AppException.validation({ cityId: ['unknown city'] });
      if (countryCode && city.country_code !== countryCode) {
        if (dto.cityId !== undefined)
          throw AppException.validation({
            cityId: ['city is not in the selected country'],
          });
        cityId = null;
      }
    }
    const prefs =
      dto.notificationPrefs !== undefined
        ? {
            ...(current.notification_prefs as Record<string, boolean>),
            ...stripUndefined(dto.notificationPrefs),
          }
        : undefined;
    await this.db
      .updateTable('profiles')
      .set({
        ...(dto.fullName !== undefined && { full_name: dto.fullName }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.countryCode !== undefined && { country_code: dto.countryCode }),
        city_id: cityId ?? null,
        ...(dto.preferredLanguage !== undefined && {
          preferred_language: dto.preferredLanguage,
        }),
        ...(prefs && { notification_prefs: JSON.stringify(prefs) }),
      })
      .where('user_id', '=', auth.userId)
      .execute();
    if (countryChanged) await recomputeCustomerVerification(this.db, auth.userId);
    return this.get(auth);
  }

  async requestDeletion(auth: AuthUser) {
    const row = await this.db
      .updateTable('profiles')
      .set({ deletion_requested_at: new Date() })
      .where('user_id', '=', auth.userId)
      .where('deletion_requested_at', 'is', null)
      .returning('deletion_requested_at')
      .executeTakeFirst();
    const at =
      row?.deletion_requested_at ??
      (
        await this.db
          .selectFrom('profiles')
          .select('deletion_requested_at')
          .where('user_id', '=', auth.userId)
          .executeTakeFirstOrThrow()
      ).deletion_requested_at;
    return { deletionRequestedAt: at?.toISOString() ?? null };
  }

  async verification(auth: AuthUser) {
    const status = await recomputeCustomerVerification(this.db, auth.userId);
    const profile = await this.db
      .selectFrom('profiles')
      .select('country_code')
      .where('user_id', '=', auth.userId)
      .executeTakeFirstOrThrow();
    const reqs = await requirementsFor(this.db, profile.country_code, 'customer');
    const docs = await this.db
      .selectFrom('customer_documents')
      .select(['id', 'document_type', 'status', 'rejection_reason', 'expires_on', 'created_at'])
      .where('user_id', '=', auth.userId)
      .execute();
    return {
      status,
      requiredDocuments: summarizeRequirements(reqs, docs).map((s) => ({
        documentType: s.documentType,
        label: s.label,
        isRequired: s.isRequired,
        status: s.status,
        rejectionReason: s.rejectionReason,
      })),
    };
  }

  async uploadDocument(auth: AuthUser, dto: UploadDocumentDto, file: UploadedFileLike | undefined) {
    const profile = await this.db
      .selectFrom('profiles')
      .select('country_code')
      .where('user_id', '=', auth.userId)
      .executeTakeFirstOrThrow();
    if (!profile.country_code) {
      throw AppException.validation({ countryCode: ['set your country first'] }, 'Please choose your country first.');
    }
    const reqs = await requirementsFor(this.db, profile.country_code, 'customer');
    if (!reqs.some((r) => r.documentType === dto.documentType)) {
      throw AppException.validation({
        documentType: [`must be one of: ${reqs.map((r) => r.documentType).join(', ')}`],
      });
    }
    if (dto.expiresOn && dto.expiresOn < todayUtc()) {
      throw AppException.validation({
        expiresOn: ['document has already expired'],
      });
    }
    const checked = await checkUpload(file, 'document');
    const path = objectPath(`customers/${auth.userId}`, checked.ext);
    await this.storage.upload('verification-documents', path, checked.buffer, checked.contentType);
    try {
      const doc = await this.db
        .insertInto('customer_documents')
        .values({
          user_id: auth.userId,
          document_type: dto.documentType,
          storage_path: path,
          file_name: checked.fileName,
          content_type: checked.contentType,
          size_bytes: checked.size,
          expires_on: dto.expiresOn ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await recomputeCustomerVerification(this.db, auth.userId);
      return {
        id: doc.id,
        documentType: doc.document_type,
        fileName: doc.file_name,
        status: doc.status,
        expiresOn: doc.expires_on,
        createdAt: doc.created_at.toISOString(),
      };
    } catch (err) {
      await this.storage.remove('verification-documents', [path]);
      throw err;
    }
  }

  // ── support ──
  async createSupportRequest(auth: AuthUser, dto: CreateSupportRequestDto) {
    if (dto.bookingId) {
      const booking = await this.db
        .selectFrom('bookings')
        .select('id')
        .where('id', '=', dto.bookingId)
        .where((eb) =>
          eb.or([
            eb('customer_id', '=', auth.userId),
            ...(auth.partner ? [eb('partner_id', '=', auth.partner.partnerId)] : []),
          ]),
        )
        .executeTakeFirst();
      if (!booking) throw AppException.validation({ bookingId: ['booking not found'] });
    }
    const row = await this.db
      .insertInto('support_requests')
      .values({
        user_id: auth.userId,
        booking_id: dto.bookingId ?? null,
        subject: dto.subject,
        message: dto.message,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSupport(row);
  }

  async listSupportRequests(auth: AuthUser, page: PageQuery) {
    const [rows, count] = await Promise.all([
      this.db
        .selectFrom('support_requests')
        .selectAll()
        .where('user_id', '=', auth.userId)
        .orderBy('created_at', 'desc')
        .limit(page.pageSize)
        .offset(page.offset)
        .execute(),
      this.db
        .selectFrom('support_requests')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('user_id', '=', auth.userId)
        .executeTakeFirstOrThrow(),
    ]);
    return Page.of(rows.map(toSupport), page.page, page.pageSize, Number(count.n));
  }
}

function toSupport(r: {
  id: string;
  booking_id: string | null;
  subject: string;
  message: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: r.id,
    bookingId: r.booking_id,
    subject: r.subject,
    message: r.message,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
