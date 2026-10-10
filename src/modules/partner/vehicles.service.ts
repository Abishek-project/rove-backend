import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import sharp from 'sharp';
import type { PartnerMembership } from '../../common/auth/auth';
import { AppException } from '../../common/errors/app-exception';
import { Page } from '../../common/http/page';
import { InjectDb } from '../../database/database';
import type { Db, DbOrTx } from '../../database/database';
import { BLOCKING_STATUSES } from '../../domain/booking-state';
import { money } from '../../domain/money';
import { StorageService } from '../../storage/storage.service';
import { checkUpload, objectPath, UploadedFileLike } from '../../storage/uploads';
import type { UploadDocumentDto } from '../me/me.dto';
import { toPickupLocation } from '../reference/reference.controller';
import { addDays, requiredDocsPresent, requirementsFor, summarizeRequirements, todayUtc } from '../shared/documents';
import { maskRegistration } from '../shared/format';
import { toDocument } from './partner.service';
import type { AvailabilityQuery, CreateBlockDto, PartnerVehiclesQuery, VehicleBodyDto } from './vehicles.dto';

export const MAX_IMAGES = 12;

const FIELD_MAP: Record<keyof VehicleBodyDto, string> = {
  cityId: 'city_id',
  pickupLocationId: 'pickup_location_id',
  make: 'make',
  model: 'model',
  year: 'year',
  category: 'category',
  transmission: 'transmission',
  fuelType: 'fuel_type',
  seats: 'seats',
  doors: 'doors',
  luggage: 'luggage',
  color: 'color',
  registrationNumber: 'registration_number',
  description: 'description',
  features: 'features',
  dailyRateMinor: 'daily_rate_minor',
  weeklyDiscountBps: 'weekly_discount_bps',
  mileageLimitKmPerDay: 'mileage_limit_km_per_day',
  excessMileageFeeMinor: 'excess_mileage_fee_minor',
  fuelPolicy: 'fuel_policy',
  depositMinor: 'deposit_minor',
  cancellationPolicy: 'cancellation_policy',
  deliveryAvailable: 'delivery_available',
  deliveryFeeMinor: 'delivery_fee_minor',
  minRentalDays: 'min_rental_days',
  bufferHours: 'buffer_hours',
  insuranceInfo: 'insurance_info',
  bookingMode: 'booking_mode',
};

/** Changing these on a published vehicle sends it back to review. */
const REVIEW_FIELDS: (keyof VehicleBodyDto)[] = ['make', 'model', 'year', 'registrationNumber', 'category'];

/** Required before submit-for-review. */
const REQUIRED_FOR_SUBMIT: (keyof VehicleBodyDto)[] = [
  'cityId',
  'make',
  'model',
  'year',
  'category',
  'transmission',
  'fuelType',
  'seats',
  'doors',
  'luggage',
  'color',
  'registrationNumber',
  'dailyRateMinor',
  'fuelPolicy',
  'depositMinor',
  'cancellationPolicy',
];

type VehicleRecord = Awaited<ReturnType<PartnerVehiclesService['loadOwned']>>;

@Injectable()
export class PartnerVehiclesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  /** Every lookup is scoped by the caller's partner id — never a client-supplied one. */
  async loadOwned(db: DbOrTx, m: PartnerMembership, vehicleId: string, lock = false) {
    let q = db.selectFrom('vehicles').selectAll().where('id', '=', vehicleId).where('partner_id', '=', m.partnerId);
    if (lock) q = q.forUpdate();
    const v = await q.executeTakeFirst();
    if (!v) throw AppException.notFound('vehicle');
    return v;
  }

  private allowedActions(v: { status: string }, m: PartnerMembership): string[] {
    if (m.role === 'staff') return [];
    const a: string[] = [];
    if (v.status !== 'suspended') a.push('edit');
    if ((v.status === 'draft' || v.status === 'rejected') && m.status === 'approved') a.push('submit');
    if (v.status === 'published') a.push('unpublish');
    if (v.status === 'unavailable') a.push('republish');
    if (v.status === 'draft' || v.status === 'rejected') a.push('delete');
    return a;
  }

  private async toPartnerVehicle(db: DbOrTx, m: PartnerMembership, v: VehicleRecord) {
    const [images, docs, reqs, city, location, partner] = await Promise.all([
      db
        .selectFrom('vehicle_images')
        .selectAll()
        .where('vehicle_id', '=', v.id)
        .orderBy('sort_order')
        .orderBy('created_at')
        .execute(),
      db
        .selectFrom('vehicle_documents')
        .selectAll()
        .where('vehicle_id', '=', v.id)
        .orderBy('created_at', 'desc')
        .execute(),
      requirementsFor(db, m.countryCode, 'vehicle'),
      v.city_id
        ? db.selectFrom('cities').select(['id', 'name', 'timezone']).where('id', '=', v.city_id).executeTakeFirst()
        : undefined,
      v.pickup_location_id
        ? db.selectFrom('pickup_locations').selectAll().where('id', '=', v.pickup_location_id).executeTakeFirst()
        : undefined,
      db.selectFrom('partners').select('booking_mode').where('id', '=', m.partnerId).executeTakeFirstOrThrow(),
    ]);
    const cur = v.currency.trim();
    return {
      id: v.id,
      status: v.status,
      rejectionReason: v.rejection_reason,
      cityId: v.city_id,
      city: city ? { id: city.id, name: city.name } : null,
      timezone: city?.timezone ?? null,
      pickupLocationId: v.pickup_location_id,
      pickupLocation: location ? toPickupLocation(location) : null,
      make: v.make,
      model: v.model,
      year: v.year,
      category: v.category,
      transmission: v.transmission,
      fuelType: v.fuel_type,
      seats: v.seats,
      doors: v.doors,
      luggage: v.luggage,
      color: v.color,
      registrationNumber: v.registration_number,
      registrationMasked: maskRegistration(v.registration_number),
      description: v.description,
      features: v.features,
      currency: cur,
      dailyRateMinor: v.daily_rate_minor,
      dailyRate: v.daily_rate_minor === null ? null : money(v.daily_rate_minor, cur),
      weeklyDiscountBps: v.weekly_discount_bps,
      mileageLimitKmPerDay: v.mileage_limit_km_per_day,
      excessMileageFeeMinor: v.excess_mileage_fee_minor,
      fuelPolicy: v.fuel_policy,
      depositMinor: v.deposit_minor,
      cancellationPolicy: v.cancellation_policy,
      deliveryAvailable: v.delivery_available,
      deliveryFeeMinor: v.delivery_fee_minor,
      minRentalDays: v.min_rental_days,
      bufferHours: v.buffer_hours,
      insuranceInfo: v.insurance_info,
      bookingMode: v.booking_mode,
      effectiveBookingMode: v.booking_mode ?? partner.booking_mode,
      isFeatured: v.is_featured,
      images: images.map((i) => ({
        id: i.id,
        url: this.storage.publicUrl('car-images', i.storage_path),
        isCover: i.is_cover,
        sortOrder: i.sort_order,
        width: i.width,
        height: i.height,
      })),
      documents: docs.map(toDocument),
      requiredDocuments: summarizeRequirements(reqs, docs).map((s) => ({
        documentType: s.documentType,
        label: s.label,
        isRequired: s.isRequired,
        status: s.status,
        rejectionReason: s.rejectionReason,
        expiresOn: s.expiresOn,
      })),
      allowedActions: this.allowedActions(v, m),
      publishedAt: v.published_at?.toISOString() ?? null,
      createdAt: v.created_at.toISOString(),
      updatedAt: v.updated_at.toISOString(),
    };
  }

  async list(m: PartnerMembership, q: PartnerVehiclesQuery) {
    const now = new Date();
    let base = this.db
      .selectFrom('vehicles as v')
      .leftJoin('cities as c', 'c.id', 'v.city_id')
      .where('v.partner_id', '=', m.partnerId);
    if (q.status) base = base.where('v.status', '=', q.status);
    if (q.category) base = base.where('v.category', '=', q.category);
    if (q.cityId) base = base.where('v.city_id', '=', q.cityId);
    if (q.q) {
      const like = `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      base = base.where((eb) =>
        eb.or([eb('v.make', 'ilike', like), eb('v.model', 'ilike', like), eb('v.registration_number', 'ilike', like)]),
      );
    }
    const [rows, count, reqs] = await Promise.all([
      base
        .leftJoin('vehicle_images as vi', (j) => j.onRef('vi.vehicle_id', '=', 'v.id').on('vi.is_cover', '=', true))
        .select([
          'v.id',
          'v.make',
          'v.model',
          'v.year',
          'v.category',
          'v.registration_number',
          'v.currency',
          'v.daily_rate_minor',
          'v.status',
          'v.updated_at',
          'c.id as city_id',
          'c.name as city_name',
          'vi.storage_path as cover_path',
          sql<boolean>`exists (select 1 from bookings b where b.vehicle_id = v.id and b.status = 'active')`.as(
            'rented',
          ),
          sql<boolean>`exists (select 1 from availability_blocks ab where ab.vehicle_id = v.id and ab.starts_at <= ${now} and ab.ends_at > ${now})`.as(
            'blocked',
          ),
        ])
        .orderBy('v.updated_at', 'desc')
        .orderBy('v.id')
        .limit(q.pageSize)
        .offset(q.offset)
        .execute(),
      base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
      requirementsFor(this.db, m.countryCode, 'vehicle'),
    ]);
    const ids = rows.map((r) => r.id);
    const docs = ids.length
      ? await this.db
          .selectFrom('vehicle_documents')
          .select(['id', 'vehicle_id', 'document_type', 'status', 'rejection_reason', 'expires_on', 'created_at'])
          .where('vehicle_id', 'in', ids)
          .execute()
      : [];
    const soon = addDays(todayUtc(now), 30);
    const items = rows.map((r) => {
      const states = summarizeRequirements(
        reqs,
        docs.filter((d) => d.vehicle_id === r.id),
        now,
      ).filter((s) => s.isRequired);
      let documentStatus: 'complete' | 'missing' | 'expiring' | 'rejected' = 'complete';
      if (states.some((s) => s.status === 'rejected')) documentStatus = 'rejected';
      else if (states.some((s) => s.status === 'missing' || s.status === 'expired')) documentStatus = 'missing';
      else if (states.some((s) => s.expiresOn !== null && s.expiresOn <= soon)) documentStatus = 'expiring';
      return {
        id: r.id,
        make: r.make,
        model: r.model,
        year: r.year,
        category: r.category,
        coverImageUrl: r.cover_path ? this.storage.publicUrl('car-images', r.cover_path) : null,
        registrationMasked: maskRegistration(r.registration_number),
        city: r.city_id ? { id: r.city_id, name: r.city_name as string } : null,
        dailyRate: r.daily_rate_minor === null ? null : money(r.daily_rate_minor, r.currency),
        status: r.status,
        availabilityStatus: r.rented ? 'rented' : r.blocked ? 'blocked' : 'available',
        documentStatus,
        updatedAt: r.updated_at.toISOString(),
      };
    });
    return Page.of(items, q.page, q.pageSize, Number(count.n));
  }

  async get(m: PartnerMembership, vehicleId: string) {
    return this.toPartnerVehicle(this.db, m, await this.loadOwned(this.db, m, vehicleId));
  }

  private async validateRefs(db: DbOrTx, m: PartnerMembership, dto: VehicleBodyDto): Promise<void> {
    if (dto.cityId) {
      const city = await db.selectFrom('cities').select('country_code').where('id', '=', dto.cityId).executeTakeFirst();
      if (!city || city.country_code !== m.countryCode) {
        throw AppException.validation({
          cityId: ["must be a city in your company's country"],
        });
      }
    }
    if (dto.pickupLocationId) {
      const loc = await db
        .selectFrom('pickup_locations')
        .select('id')
        .where('id', '=', dto.pickupLocationId)
        .where('partner_id', '=', m.partnerId)
        .executeTakeFirst();
      if (!loc)
        throw AppException.validation({
          pickupLocationId: ['unknown pickup location'],
        });
    }
  }

  private toColumns(dto: VehicleBodyDto): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, col] of Object.entries(FIELD_MAP)) {
      const v = dto[key as keyof VehicleBodyDto];
      if (v !== undefined) out[col] = v;
    }
    return out;
  }

  async create(m: PartnerMembership, dto: VehicleBodyDto) {
    if (m.status === 'suspended') throw new AppException('FORBIDDEN', 'Your company is suspended.');
    return this.db.transaction().execute(async (trx) => {
      await this.validateRefs(trx, m, dto);
      const country = await trx
        .selectFrom('countries')
        .select('currency_code')
        .where('code', '=', m.countryCode)
        .executeTakeFirstOrThrow();
      const row = await trx
        .insertInto('vehicles')
        .values({
          ...this.toColumns(dto),
          partner_id: m.partnerId,
          currency: country.currency_code,
          status: 'draft',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.toPartnerVehicle(trx, m, row);
    });
  }

  async update(m: PartnerMembership, vehicleId: string, dto: VehicleBodyDto) {
    if (m.status === 'suspended') throw new AppException('FORBIDDEN', 'Your company is suspended.');
    return this.db.transaction().execute(async (trx) => {
      const v = await this.loadOwned(trx, m, vehicleId, true);
      if (v.status === 'suspended')
        throw new AppException('CONFLICT', 'A suspended vehicle cannot be edited. Please contact support.');
      await this.validateRefs(trx, m, dto);
      const cols = this.toColumns(dto);
      const current = v as unknown as Record<string, unknown>;
      const reviewChange = REVIEW_FIELDS.some((f) => {
        const col = FIELD_MAP[f];
        return col in cols && cols[col] !== current[col];
      });
      if (v.status === 'published' && reviewChange) {
        cols.status = 'pending_review';
        cols.submitted_at = new Date();
      }
      if (Object.keys(cols).length === 0) return this.toPartnerVehicle(trx, m, v);
      const row = await trx
        .updateTable('vehicles')
        .set(cols as never)
        .where('id', '=', v.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.toPartnerVehicle(trx, m, row);
    });
  }

  async remove(m: PartnerMembership, vehicleId: string): Promise<void> {
    const paths = await this.db.transaction().execute(async (trx) => {
      const v = await this.loadOwned(trx, m, vehicleId, true);
      if (v.status !== 'draft' && v.status !== 'rejected') {
        throw new AppException('INVALID_STATE_TRANSITION', 'Only draft or rejected vehicles can be deleted.');
      }
      const hasBookings = await trx
        .selectFrom('bookings')
        .select('id')
        .where('vehicle_id', '=', v.id)
        .executeTakeFirst();
      if (hasBookings) throw new AppException('CONFLICT', 'This vehicle has bookings and cannot be deleted.');
      const images = await trx
        .selectFrom('vehicle_images')
        .select('storage_path')
        .where('vehicle_id', '=', v.id)
        .execute();
      const docs = await trx
        .selectFrom('vehicle_documents')
        .select('storage_path')
        .where('vehicle_id', '=', v.id)
        .execute();
      await trx.deleteFrom('vehicles').where('id', '=', v.id).execute();
      return {
        images: images.map((i) => i.storage_path),
        docs: docs.map((d) => d.storage_path),
      };
    });
    await this.storage.remove('car-images', paths.images);
    await this.storage.remove('verification-documents', paths.docs);
  }

  async submit(m: PartnerMembership, vehicleId: string) {
    if (m.status !== 'approved') throw new AppException('PARTNER_NOT_APPROVED');
    return this.db.transaction().execute(async (trx) => {
      const v = await this.loadOwned(trx, m, vehicleId, true);
      if (v.status !== 'draft' && v.status !== 'rejected') {
        throw new AppException(
          'INVALID_STATE_TRANSITION',
          `A ${v.status.replace('_', ' ')} vehicle cannot be submitted for review.`,
        );
      }
      const current = v as unknown as Record<string, unknown>;
      const fields: Record<string, string[]> = {};
      for (const f of REQUIRED_FOR_SUBMIT) {
        const val = current[FIELD_MAP[f]];
        if (val === null || val === undefined || val === '') fields[f] = ['is required'];
      }
      const images = await trx
        .selectFrom('vehicle_images')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('vehicle_id', '=', v.id)
        .executeTakeFirstOrThrow();
      if (Number(images.n) < 1) fields.images = ['at least one photo is required'];
      const reqs = await requirementsFor(trx, m.countryCode, 'vehicle');
      const docs = await trx
        .selectFrom('vehicle_documents')
        .select(['id', 'document_type', 'status', 'rejection_reason', 'expires_on', 'created_at'])
        .where('vehicle_id', '=', v.id)
        .execute();
      const states = summarizeRequirements(reqs, docs);
      if (!requiredDocsPresent(states)) {
        fields.documents = states
          .filter((s) => s.isRequired && s.status !== 'submitted' && s.status !== 'approved')
          .map((s) => `${s.label} is ${s.status}`);
      }
      if (Object.keys(fields).length) {
        throw AppException.validation(fields, 'Please complete the listing before submitting it for review.');
      }
      const row = await trx
        .updateTable('vehicles')
        .set({
          status: 'pending_review',
          rejection_reason: null,
          submitted_at: new Date(),
        })
        .where('id', '=', v.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.toPartnerVehicle(trx, m, row);
    });
  }

  async setListed(m: PartnerMembership, vehicleId: string, listed: boolean) {
    return this.db.transaction().execute(async (trx) => {
      const v = await this.loadOwned(trx, m, vehicleId, true);
      const from = listed ? 'unavailable' : 'published';
      if (v.status !== from) {
        throw new AppException(
          'INVALID_STATE_TRANSITION',
          listed ? 'Only unpublished vehicles can be republished.' : 'Only published vehicles can be unpublished.',
        );
      }
      const row = await trx
        .updateTable('vehicles')
        .set({ status: listed ? 'published' : 'unavailable' })
        .where('id', '=', v.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.toPartnerVehicle(trx, m, row);
    });
  }

  // ── images ──
  async addImage(m: PartnerMembership, vehicleId: string, file: UploadedFileLike | undefined) {
    const checked = await checkUpload(file, 'image');
    let width: number | null = null;
    let height: number | null = null;
    try {
      const meta = await sharp(checked.buffer).metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;
    } catch {
      throw new AppException('UNSUPPORTED_FILE_TYPE', 'The image could not be read.');
    }
    await this.loadOwned(this.db, m, vehicleId);
    const path = objectPath(`vehicles/${vehicleId}`, checked.ext);
    await this.storage.upload('car-images', path, checked.buffer, checked.contentType);
    try {
      return await this.db.transaction().execute(async (trx) => {
        await this.loadOwned(trx, m, vehicleId, true);
        const existing = await trx
          .selectFrom('vehicle_images')
          .select(['id', 'sort_order'])
          .where('vehicle_id', '=', vehicleId)
          .execute();
        if (existing.length >= MAX_IMAGES) {
          throw AppException.validation(
            { file: [`a vehicle can have at most ${MAX_IMAGES} photos`] },
            `A vehicle can have at most ${MAX_IMAGES} photos.`,
          );
        }
        const img = await trx
          .insertInto('vehicle_images')
          .values({
            vehicle_id: vehicleId,
            bucket: 'car-images',
            storage_path: path,
            sort_order: existing.reduce((mx, i) => Math.max(mx, i.sort_order + 1), 0),
            is_cover: existing.length === 0,
            content_type: checked.contentType,
            size_bytes: checked.size,
            width,
            height,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return {
          id: img.id,
          url: this.storage.publicUrl('car-images', img.storage_path),
          isCover: img.is_cover,
          sortOrder: img.sort_order,
        };
      });
    } catch (err) {
      await this.storage.remove('car-images', [path]);
      throw err;
    }
  }

  private async imageList(db: DbOrTx, vehicleId: string) {
    const rows = await db
      .selectFrom('vehicle_images')
      .selectAll()
      .where('vehicle_id', '=', vehicleId)
      .orderBy('sort_order')
      .orderBy('created_at')
      .execute();
    return rows.map((i) => ({
      id: i.id,
      url: this.storage.publicUrl('car-images', i.storage_path),
      isCover: i.is_cover,
      sortOrder: i.sort_order,
    }));
  }

  async reorderImages(m: PartnerMembership, vehicleId: string, imageIds: string[]) {
    return this.db.transaction().execute(async (trx) => {
      await this.loadOwned(trx, m, vehicleId, true);
      const existing = await trx
        .selectFrom('vehicle_images')
        .select('id')
        .where('vehicle_id', '=', vehicleId)
        .execute();
      const set = new Set(existing.map((e) => e.id));
      if (imageIds.length !== set.size || !imageIds.every((id) => set.has(id))) {
        throw AppException.validation({
          imageIds: ["must list each of this vehicle's image ids exactly once"],
        });
      }
      for (const [idx, id] of imageIds.entries()) {
        await trx.updateTable('vehicle_images').set({ sort_order: idx }).where('id', '=', id).execute();
      }
      return this.imageList(trx, vehicleId);
    });
  }

  async setCover(m: PartnerMembership, vehicleId: string, imageId: string) {
    return this.db.transaction().execute(async (trx) => {
      await this.loadOwned(trx, m, vehicleId, true);
      const img = await trx
        .selectFrom('vehicle_images')
        .select('id')
        .where('id', '=', imageId)
        .where('vehicle_id', '=', vehicleId)
        .executeTakeFirst();
      if (!img) throw AppException.notFound('image');
      await trx
        .updateTable('vehicle_images')
        .set({ is_cover: false })
        .where('vehicle_id', '=', vehicleId)
        .where('is_cover', '=', true)
        .execute();
      await trx.updateTable('vehicle_images').set({ is_cover: true }).where('id', '=', imageId).execute();
      return this.imageList(trx, vehicleId);
    });
  }

  async deleteImage(m: PartnerMembership, vehicleId: string, imageId: string): Promise<void> {
    const path = await this.db.transaction().execute(async (trx) => {
      const v = await this.loadOwned(trx, m, vehicleId, true);
      const img = await trx
        .selectFrom('vehicle_images')
        .selectAll()
        .where('id', '=', imageId)
        .where('vehicle_id', '=', vehicleId)
        .executeTakeFirst();
      if (!img) throw AppException.notFound('image');
      const count = await trx
        .selectFrom('vehicle_images')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('vehicle_id', '=', vehicleId)
        .executeTakeFirstOrThrow();
      if (Number(count.n) <= 1 && (v.status === 'published' || v.status === 'pending_review')) {
        throw new AppException('CONFLICT', 'A listed vehicle must keep at least one photo.');
      }
      await trx.deleteFrom('vehicle_images').where('id', '=', imageId).execute();
      if (img.is_cover) {
        const next = await trx
          .selectFrom('vehicle_images')
          .select('id')
          .where('vehicle_id', '=', vehicleId)
          .orderBy('sort_order')
          .orderBy('created_at')
          .executeTakeFirst();
        if (next) await trx.updateTable('vehicle_images').set({ is_cover: true }).where('id', '=', next.id).execute();
      }
      return img.storage_path;
    });
    await this.storage.remove('car-images', [path]);
  }

  // ── documents ──
  async listDocuments(m: PartnerMembership, vehicleId: string) {
    await this.loadOwned(this.db, m, vehicleId);
    const rows = await this.db
      .selectFrom('vehicle_documents')
      .selectAll()
      .where('vehicle_id', '=', vehicleId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toDocument);
  }

  async uploadDocument(
    m: PartnerMembership,
    vehicleId: string,
    dto: UploadDocumentDto,
    file: UploadedFileLike | undefined,
  ) {
    await this.loadOwned(this.db, m, vehicleId);
    const reqs = await requirementsFor(this.db, m.countryCode, 'vehicle');
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
    const path = objectPath(`vehicles/${vehicleId}`, checked.ext);
    await this.storage.upload('verification-documents', path, checked.buffer, checked.contentType);
    try {
      const doc = await this.db
        .insertInto('vehicle_documents')
        .values({
          vehicle_id: vehicleId,
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

  async documentUrl(m: PartnerMembership, vehicleId: string, docId: string) {
    await this.loadOwned(this.db, m, vehicleId);
    const doc = await this.db
      .selectFrom('vehicle_documents')
      .select('storage_path')
      .where('id', '=', docId)
      .where('vehicle_id', '=', vehicleId)
      .executeTakeFirst();
    if (!doc) throw AppException.notFound('document');
    return this.storage.signedUrl('verification-documents', doc.storage_path);
  }

  // ── availability ──
  async availability(m: PartnerMembership, vehicleId: string, q: AvailabilityQuery) {
    const v = await this.loadOwned(this.db, m, vehicleId);
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 7 * 86_400_000);
    const to = q.to ? new Date(q.to) : new Date(from.getTime() + 90 * 86_400_000);
    if (to <= from) throw AppException.validation({ to: ['must be after from'] });
    if (to.getTime() - from.getTime() > 400 * 86_400_000)
      throw AppException.validation({ to: ['range must be at most 400 days'] });
    const [city, blocks, bookings] = await Promise.all([
      v.city_id
        ? this.db.selectFrom('cities').select('timezone').where('id', '=', v.city_id).executeTakeFirst()
        : undefined,
      this.db
        .selectFrom('availability_blocks')
        .selectAll()
        .where('vehicle_id', '=', v.id)
        .where('starts_at', '<', to)
        .where('ends_at', '>', from)
        .orderBy('starts_at')
        .execute(),
      this.db
        .selectFrom('bookings')
        .select(['id', 'reference', 'status', 'pickup_at', 'return_at'])
        .where('vehicle_id', '=', v.id)
        .where('status', 'in', [...BLOCKING_STATUSES, 'completed'])
        .where('pickup_at', '<', to)
        .where('return_at', '>', from)
        .orderBy('pickup_at')
        .execute(),
    ]);
    return {
      timezone: city?.timezone ?? null,
      bufferHours: v.buffer_hours,
      blocks: blocks.map((b) => ({
        id: b.id,
        startsAt: b.starts_at.toISOString(),
        endsAt: b.ends_at.toISOString(),
        reason: b.reason,
        note: b.note,
      })),
      bookings: bookings.map((b) => ({
        id: b.id,
        reference: b.reference,
        status: b.status,
        pickupAt: b.pickup_at.toISOString(),
        returnAt: b.return_at.toISOString(),
      })),
    };
  }

  async createBlock(m: PartnerMembership, vehicleId: string, dto: CreateBlockDto, userId: string) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt <= startsAt) throw AppException.validation({ endsAt: ['must be after startsAt'] });
    if (endsAt.getTime() < Date.now()) throw AppException.validation({ endsAt: ['must be in the future'] });
    return this.db.transaction().execute(async (trx) => {
      // Same lock booking creation takes: blocks and bookings for one vehicle are serialized.
      await this.loadOwned(trx, m, vehicleId, true);
      const [bookings, blocks] = await Promise.all([
        trx
          .selectFrom('bookings')
          .select(['id', 'reference', 'status', 'pickup_at', 'return_at'])
          .where('vehicle_id', '=', vehicleId)
          .where('status', 'in', BLOCKING_STATUSES)
          .where(sql<boolean>`blocking_period && tstzrange(${startsAt}::timestamptz, ${endsAt}::timestamptz, '[)')`)
          .execute(),
        trx
          .selectFrom('availability_blocks')
          .select(['id', 'starts_at', 'ends_at', 'reason'])
          .where('vehicle_id', '=', vehicleId)
          .where('starts_at', '<', endsAt)
          .where('ends_at', '>', startsAt)
          .execute(),
      ]);
      if (bookings.length || blocks.length) {
        throw new AppException('AVAILABILITY_CONFLICT', undefined, {
          conflicts: {
            bookings: bookings.map((b) => ({
              id: b.id,
              reference: b.reference,
              status: b.status,
              pickupAt: b.pickup_at.toISOString(),
              returnAt: b.return_at.toISOString(),
            })),
            blocks: blocks.map((b) => ({
              id: b.id,
              startsAt: b.starts_at.toISOString(),
              endsAt: b.ends_at.toISOString(),
              reason: b.reason,
            })),
          },
        });
      }
      const b = await trx
        .insertInto('availability_blocks')
        .values({
          vehicle_id: vehicleId,
          starts_at: startsAt,
          ends_at: endsAt,
          reason: dto.reason,
          note: dto.note ?? null,
          created_by: userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return {
        id: b.id,
        startsAt: b.starts_at.toISOString(),
        endsAt: b.ends_at.toISOString(),
        reason: b.reason,
        note: b.note,
      };
    });
  }

  async deleteBlock(m: PartnerMembership, vehicleId: string, blockId: string): Promise<void> {
    await this.loadOwned(this.db, m, vehicleId);
    const res = await this.db
      .deleteFrom('availability_blocks')
      .where('id', '=', blockId)
      .where('vehicle_id', '=', vehicleId)
      .executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) throw AppException.notFound('availability block');
  }
}
