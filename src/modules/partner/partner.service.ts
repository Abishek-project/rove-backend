import { Injectable } from '@nestjs/common';
import type { AuthUser, PartnerMembership } from '../../common/auth/auth';
import { AppException } from '../../common/errors/app-exception';
import { InjectDb, pgCode } from '../../database/database';
import type { Db, DbOrTx } from '../../database/database';
import { StorageService } from '../../storage/storage.service';
import { checkUpload, objectPath, UploadedFileLike } from '../../storage/uploads';
import type { UploadDocumentDto } from '../me/me.dto';
import { toPickupLocation } from '../reference/reference.controller';
import { requiredDocsPresent, requirementsFor, summarizeRequirements, todayUtc } from '../shared/documents';
import type { LocationDto, OnboardingDto, UpdateLocationDto, UpdatePartnerDto } from './partner.dto';

type PartnerRow = {
  id: string;
  legal_name: string;
  display_name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  country_code: string;
  city_id: string | null;
  address: string | null;
  registration_number: string | null;
  status: string;
  rejection_reason: string | null;
  booking_mode: string;
  logo_path: string | null;
  verified_at: Date | null;
};

const PROFILE_FIELDS = [
  'legal_name',
  'display_name',
  'contact_name',
  'email',
  'phone',
  'country_code',
  'city_id',
  'address',
  'registration_number',
] as const;

/** Legal identity fields, locked while under review and once approved. */
const LEGAL_FIELDS = ['legalName', 'registrationNumber', 'countryCode'] as const;

export function toDocument(d: {
  id: string;
  document_type: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  status: string;
  rejection_reason: string | null;
  expires_on: string | null;
  created_at: Date;
}) {
  return {
    id: d.id,
    documentType: d.document_type,
    fileName: d.file_name,
    contentType: d.content_type,
    sizeBytes: d.size_bytes,
    status: d.status,
    rejectionReason: d.rejection_reason,
    expiresOn: d.expires_on,
    createdAt: d.created_at.toISOString(),
  };
}

@Injectable()
export class PartnerService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  toPartner(p: PartnerRow, role: string) {
    return {
      id: p.id,
      legalName: p.legal_name,
      displayName: p.display_name,
      contactName: p.contact_name,
      email: p.email,
      phone: p.phone,
      countryCode: p.country_code,
      cityId: p.city_id,
      address: p.address,
      registrationNumber: p.registration_number,
      status: p.status,
      rejectionReason: p.rejection_reason,
      bookingMode: p.booking_mode,
      logoUrl: p.logo_path ? this.storage.publicUrl('partner-assets', p.logo_path) : null,
      verifiedAt: p.verified_at?.toISOString() ?? null,
      role,
    };
  }

  private async load(db: DbOrTx, partnerId: string): Promise<PartnerRow> {
    return db.selectFrom('partners').selectAll().where('id', '=', partnerId).executeTakeFirstOrThrow();
  }

  async profile(m: PartnerMembership) {
    return this.toPartner(await this.load(this.db, m.partnerId), m.role);
  }

  private async assertCity(db: DbOrTx, cityId: string, countryCode: string): Promise<void> {
    const city = await db.selectFrom('cities').select('country_code').where('id', '=', cityId).executeTakeFirst();
    if (!city) throw AppException.validation({ cityId: ['unknown city'] });
    if (city.country_code !== countryCode)
      throw AppException.validation({
        cityId: ['city is not in the selected country'],
      });
  }

  async onboard(auth: AuthUser, dto: OnboardingDto) {
    if (auth.partner) throw new AppException('PARTNER_ALREADY_EXISTS');
    return this.db.transaction().execute(async (trx) => {
      await this.assertCity(trx, dto.cityId, dto.countryCode);
      const partner = await trx
        .insertInto('partners')
        .values({
          legal_name: dto.legalName,
          display_name: dto.displayName,
          contact_name: dto.contactName,
          email: dto.email,
          phone: dto.phone,
          country_code: dto.countryCode,
          city_id: dto.cityId,
          address: dto.address,
          registration_number: dto.registrationNumber,
          status: 'draft',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      try {
        await trx
          .insertInto('partner_members')
          .values({
            partner_id: partner.id,
            user_id: auth.userId,
            role: 'owner',
          })
          .execute();
      } catch (err) {
        if (pgCode(err) === '23505') throw new AppException('PARTNER_ALREADY_EXISTS');
        throw err;
      }
      return this.toPartner(partner, 'owner');
    });
  }

  async update(m: PartnerMembership, dto: UpdatePartnerDto) {
    return this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('partners')
        .selectAll()
        .where('id', '=', m.partnerId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const locked =
        current.status === 'pending_verification' || current.status === 'approved' || current.status === 'suspended';
      if (locked) {
        const changed = LEGAL_FIELDS.filter((f) => {
          const v = dto[f];
          const col = {
            legalName: current.legal_name,
            registrationNumber: current.registration_number,
            countryCode: current.country_code,
          }[f];
          return v !== undefined && v !== col;
        });
        if (changed.length > 0) {
          throw new AppException(
            'CONFLICT',
            current.status === 'pending_verification'
              ? 'Legal details cannot be changed while your verification is under review.'
              : 'Legal details of a verified company can only be changed by support.',
            { fields: Object.fromEntries(changed.map((f) => [f, ['locked']])) },
          );
        }
      }
      const countryCode = dto.countryCode ?? current.country_code;
      if (dto.countryCode && dto.countryCode !== current.country_code) {
        const hasVehicles = await trx
          .selectFrom('vehicles')
          .select('id')
          .where('partner_id', '=', m.partnerId)
          .executeTakeFirst();
        if (hasVehicles) throw new AppException('CONFLICT', 'Country cannot be changed once vehicles exist.');
      }
      const cityId = dto.cityId ?? current.city_id;
      if (cityId && (dto.cityId || dto.countryCode)) await this.assertCity(trx, cityId, countryCode);
      const updated = await trx
        .updateTable('partners')
        .set({
          ...(dto.legalName !== undefined && { legal_name: dto.legalName }),
          ...(dto.displayName !== undefined && {
            display_name: dto.displayName,
          }),
          ...(dto.contactName !== undefined && {
            contact_name: dto.contactName,
          }),
          ...(dto.email !== undefined && { email: dto.email }),
          ...(dto.phone !== undefined && { phone: dto.phone }),
          ...(dto.countryCode !== undefined && {
            country_code: dto.countryCode,
          }),
          ...(dto.cityId !== undefined && { city_id: dto.cityId }),
          ...(dto.address !== undefined && { address: dto.address }),
          ...(dto.registrationNumber !== undefined && {
            registration_number: dto.registrationNumber,
          }),
          ...(dto.bookingMode !== undefined && {
            booking_mode: dto.bookingMode,
          }),
        })
        .where('id', '=', m.partnerId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.toPartner(updated, m.role);
    });
  }

  private async documentStates(db: DbOrTx, partner: PartnerRow) {
    const reqs = await requirementsFor(db, partner.country_code, 'partner');
    const docs = await db
      .selectFrom('partner_documents')
      .select(['id', 'document_type', 'status', 'rejection_reason', 'expires_on', 'created_at'])
      .where('partner_id', '=', partner.id)
      .execute();
    return summarizeRequirements(reqs, docs);
  }

  async verification(m: PartnerMembership) {
    const partner = await this.load(this.db, m.partnerId);
    const states = await this.documentStates(this.db, partner);
    const profileComplete = PROFILE_FIELDS.every((f) => partner[f] !== null && partner[f] !== '');
    const docsComplete = requiredDocsPresent(states);
    return {
      status: partner.status,
      rejectionReason: partner.rejection_reason,
      steps: [
        {
          key: 'profile',
          label: 'Business profile',
          complete: profileComplete,
        },
        {
          key: 'documents',
          label: 'Verification documents',
          complete: docsComplete,
        },
        {
          key: 'review',
          label: 'Rove review',
          complete: partner.status === 'approved',
        },
      ],
      requiredDocuments: states.map((s) => ({
        documentType: s.documentType,
        label: s.label,
        isRequired: s.isRequired,
        status: s.status,
        rejectionReason: s.rejectionReason,
        expiresOn: s.expiresOn,
      })),
      canSubmit: (partner.status === 'draft' || partner.status === 'rejected') && profileComplete && docsComplete,
    };
  }

  async submitVerification(m: PartnerMembership) {
    return this.db.transaction().execute(async (trx) => {
      const partner = await trx
        .selectFrom('partners')
        .selectAll()
        .where('id', '=', m.partnerId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (partner.status !== 'draft' && partner.status !== 'rejected') {
        throw new AppException(
          'INVALID_STATE_TRANSITION',
          `Verification cannot be submitted while the company is ${partner.status.replace('_', ' ')}.`,
        );
      }
      const missingFields = PROFILE_FIELDS.filter((f) => partner[f] === null || partner[f] === '');
      const states = await this.documentStates(trx, partner);
      const missingDocs = states.filter((s) => s.isRequired && s.status !== 'submitted' && s.status !== 'approved');
      if (missingFields.length || missingDocs.length) {
        throw AppException.validation(
          {
            ...Object.fromEntries(missingFields.map((f) => [camel(f), ['is required']])),
            ...(missingDocs.length
              ? {
                  documents: missingDocs.map((d) => `${d.label} is ${d.status}`),
                }
              : {}),
          },
          'Please complete your profile and upload all required documents first.',
          { missingDocuments: missingDocs.map((d) => d.documentType) },
        );
      }
      const updated = await trx
        .updateTable('partners')
        .set({
          status: 'pending_verification',
          rejection_reason: null,
          submitted_at: new Date(),
        })
        .where('id', '=', m.partnerId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.toPartner(updated, m.role);
    });
  }

  async listDocuments(m: PartnerMembership) {
    const rows = await this.db
      .selectFrom('partner_documents')
      .selectAll()
      .where('partner_id', '=', m.partnerId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toDocument);
  }

  async uploadDocument(m: PartnerMembership, dto: UploadDocumentDto, file: UploadedFileLike | undefined) {
    const partner = await this.load(this.db, m.partnerId);
    if (partner.status === 'pending_verification') {
      throw new AppException('CONFLICT', 'Documents cannot be changed while your verification is under review.');
    }
    const reqs = await requirementsFor(this.db, partner.country_code, 'partner');
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
    const path = objectPath(`partners/${m.partnerId}`, checked.ext);
    await this.storage.upload('verification-documents', path, checked.buffer, checked.contentType);
    try {
      const doc = await this.db
        .insertInto('partner_documents')
        .values({
          partner_id: m.partnerId,
          document_type: dto.documentType,
          storage_path: path,
          file_name: checked.fileName,
          content_type: checked.contentType,
          size_bytes: checked.size,
          expires_on: dto.expiresOn ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toDocument(doc);
    } catch (err) {
      await this.storage.remove('verification-documents', [path]);
      throw err;
    }
  }

  async documentUrl(m: PartnerMembership, documentId: string) {
    const doc = await this.db
      .selectFrom('partner_documents')
      .select('storage_path')
      .where('id', '=', documentId)
      .where('partner_id', '=', m.partnerId)
      .executeTakeFirst();
    if (!doc) throw AppException.notFound('document');
    return this.storage.signedUrl('verification-documents', doc.storage_path);
  }

  async uploadLogo(m: PartnerMembership, file: UploadedFileLike | undefined) {
    const checked = await checkUpload(file, 'image');
    const path = objectPath(`partners/${m.partnerId}`, checked.ext);
    await this.storage.upload('partner-assets', path, checked.buffer, checked.contentType);
    try {
      const before = await this.load(this.db, m.partnerId);
      const updated = await this.db
        .updateTable('partners')
        .set({ logo_path: path })
        .where('id', '=', m.partnerId)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (before.logo_path) await this.storage.remove('partner-assets', [before.logo_path]);
      return this.toPartner(updated, m.role);
    } catch (err) {
      await this.storage.remove('partner-assets', [path]);
      throw err;
    }
  }

  // ── pickup locations ──
  async listLocations(m: PartnerMembership) {
    const rows = await this.db
      .selectFrom('pickup_locations')
      .selectAll()
      .where('partner_id', '=', m.partnerId)
      .orderBy('name')
      .execute();
    return rows.map(toPickupLocation);
  }

  async createLocation(m: PartnerMembership, dto: LocationDto) {
    await this.assertCity(this.db, dto.cityId, m.countryCode);
    const row = await this.db
      .insertInto('pickup_locations')
      .values({
        partner_id: m.partnerId,
        city_id: dto.cityId,
        name: dto.name,
        address: dto.address,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toPickupLocation(row);
  }

  async updateLocation(m: PartnerMembership, id: string, dto: UpdateLocationDto) {
    if (dto.cityId) await this.assertCity(this.db, dto.cityId, m.countryCode);
    const row = await this.db
      .updateTable('pickup_locations')
      .set({
        ...(dto.cityId !== undefined && { city_id: dto.cityId }),
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.address !== undefined && { address: dto.address }),
        ...(dto.latitude !== undefined && { latitude: dto.latitude }),
        ...(dto.longitude !== undefined && { longitude: dto.longitude }),
      })
      .where('id', '=', id)
      .where('partner_id', '=', m.partnerId)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw AppException.notFound('location');
    return toPickupLocation(row);
  }

  async deleteLocation(m: PartnerMembership, id: string): Promise<void> {
    const res = await this.db
      .deleteFrom('pickup_locations')
      .where('id', '=', id)
      .where('partner_id', '=', m.partnerId)
      .executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) throw AppException.notFound('location');
  }
}

function camel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
