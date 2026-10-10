import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AppException } from '../../common/errors/app-exception';
import { Page } from '../../common/http/page';
import { InjectDb } from '../../database/database';
import type { Db, DbOrTx } from '../../database/database';
import { BLOCKING_STATUSES, BookingMode } from '../../domain/booking-state';
import { cancellationPolicyInfo, CancellationPolicy } from '../../domain/cancellation';
import { money } from '../../domain/money';
import { calculatePrice, PricingCountry } from '../../domain/pricing';
import { validateRentalPeriod } from '../../domain/rental-dates';
import { StorageService } from '../../storage/storage.service';
import { ExpiryService } from '../bookings/expiry';
import { findBookingConflicts, hasConflicts } from '../bookings/availability';
import { toPickupLocation } from '../reference/reference.controller';
import type { SearchVehiclesQuery } from './catalog.dto';

export interface CountryPricing extends PricingCountry {
  code: string;
  currency: string;
  timezone: string;
}

/** Loads all countries' pricing config (tiny, reference data). */
export async function loadCountries(db: DbOrTx): Promise<Map<string, CountryPricing>> {
  const rows = await db.selectFrom('countries').selectAll().execute();
  return new Map(
    rows.map((c) => [
      c.code,
      {
        code: c.code,
        currency: c.currency_code.trim(),
        timezone: c.default_timezone,
        taxLabel: c.tax_label,
        taxRateBps: c.tax_rate_bps,
        platformFeeBps: c.platform_fee_bps,
        commissionBps: c.commission_bps,
      },
    ]),
  );
}

export function vehicleQuery(db: DbOrTx, userId?: string) {
  return db
    .selectFrom('vehicles as v')
    .innerJoin('partners as p', 'p.id', 'v.partner_id')
    .innerJoin('cities as c', 'c.id', 'v.city_id')
    .leftJoin('vehicle_images as vi', (j) => j.onRef('vi.vehicle_id', '=', 'v.id').on('vi.is_cover', '=', true))
    .select([
      'v.id',
      'v.make',
      'v.model',
      'v.year',
      'v.category',
      'v.transmission',
      'v.fuel_type',
      'v.seats',
      'v.doors',
      'v.luggage',
      'v.color',
      'v.description',
      'v.features',
      'v.currency',
      'v.daily_rate_minor',
      'v.weekly_discount_bps',
      'v.mileage_limit_km_per_day',
      'v.excess_mileage_fee_minor',
      'v.fuel_policy',
      'v.deposit_minor',
      'v.cancellation_policy',
      'v.delivery_available',
      'v.delivery_fee_minor',
      'v.min_rental_days',
      'v.buffer_hours',
      'v.insurance_info',
      'v.booking_mode',
      'v.pickup_location_id',
      'v.is_featured',
      'v.published_at',
      'v.city_id',
      'c.name as city_name',
      'c.timezone',
      'c.country_code',
      'p.id as partner_id',
      'p.display_name as partner_name',
      'p.status as partner_status',
      'p.verified_at as partner_verified_at',
      'p.booking_mode as partner_booking_mode',
      'p.logo_path as partner_logo_path',
      'vi.storage_path as cover_path',
      userId
        ? sql<boolean>`exists (select 1 from favorites f where f.vehicle_id = v.id and f.user_id = ${userId})`.as(
            'is_favorite',
          )
        : sql<boolean>`false`.as('is_favorite'),
    ]);
}

export type VehicleRow = Awaited<ReturnType<ReturnType<typeof vehicleQuery>['executeTakeFirstOrThrow']>>;

export function effectiveBookingMode(row: { booking_mode: string | null; partner_booking_mode: string }): BookingMode {
  return (row.booking_mode ?? row.partner_booking_mode) as BookingMode;
}

export function pricingVehicle(row: VehicleRow) {
  return {
    currency: row.currency,
    dailyRateMinor: row.daily_rate_minor ?? 0,
    weeklyDiscountBps: row.weekly_discount_bps,
    deliveryFeeMinor: row.delivery_fee_minor,
    depositMinor: row.deposit_minor ?? 0,
    minRentalDays: row.min_rental_days,
    mileageLimitKmPerDay: row.mileage_limit_km_per_day,
    excessMileageFeeMinor: row.excess_mileage_fee_minor,
  };
}

@Injectable()
export class CatalogService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly storage: StorageService,
    private readonly expiry: ExpiryService,
  ) {}

  coverUrl(path: string | null): string | null {
    return path ? this.storage.publicUrl('car-images', path) : null;
  }

  toSummary(row: VehicleRow, estimate?: { pickupAt: Date; returnAt: Date; country: CountryPricing }) {
    let estimatedTotal = null;
    let days: number | null = null;
    if (estimate) {
      const price = calculatePrice({
        vehicle: pricingVehicle(row),
        country: estimate.country,
        pickupAt: estimate.pickupAt,
        returnAt: estimate.returnAt,
        delivery: false,
      });
      estimatedTotal = money(price.totalMinor, price.currency);
      days = price.days;
    }
    return {
      id: row.id,
      make: row.make,
      model: row.model,
      year: row.year,
      category: row.category,
      transmission: row.transmission,
      fuelType: row.fuel_type,
      seats: row.seats,
      luggage: row.luggage,
      coverImageUrl: this.coverUrl(row.cover_path),
      dailyRate: money(row.daily_rate_minor ?? 0, row.currency),
      estimatedTotal,
      days,
      city: { id: row.city_id as string, name: row.city_name },
      deliveryAvailable: row.delivery_available,
      partner: {
        id: row.partner_id,
        displayName: row.partner_name,
        verified: row.partner_status === 'approved' && row.partner_verified_at !== null,
      },
      isFavorite: Boolean(row.is_favorite),
    };
  }

  private parsePeriod(pickupAt?: string, returnAt?: string): { pickupAt: Date; returnAt: Date } | null {
    if (!pickupAt && !returnAt) return null;
    if (!pickupAt || !returnAt) {
      throw AppException.validation(
        {
          [pickupAt ? 'returnAt' : 'pickupAt']: ['pickupAt and returnAt must be provided together'],
        },
        'Please choose both pickup and return times.',
      );
    }
    const p = new Date(pickupAt);
    const r = new Date(returnAt);
    const errors = validateRentalPeriod(p, r);
    if (Object.keys(errors).length) throw AppException.validation(errors, 'Please check your rental dates.');
    return { pickupAt: p, returnAt: r };
  }

  async search(q: SearchVehiclesQuery, userId?: string) {
    const period = this.parsePeriod(q.pickupAt, q.returnAt);
    const countries = await loadCountries(this.db);
    const country = countries.get(q.countryCode);
    if (!country) throw AppException.validation({ countryCode: ['unsupported country'] });
    if (period) await this.expiry.run();

    const filtered = <T extends ReturnType<typeof vehicleQuery>>(base: T): T => {
      let b = base
        .where('v.status', '=', 'published')
        .where('p.status', '=', 'approved')
        .where('c.country_code', '=', q.countryCode) as T;
      if (q.cityId) b = b.where('v.city_id', '=', q.cityId) as T;
      if (q.category) b = b.where('v.category', '=', q.category) as T;
      if (q.transmission) b = b.where('v.transmission', '=', q.transmission) as T;
      if (q.fuelType) b = b.where('v.fuel_type', '=', q.fuelType) as T;
      if (q.minSeats) b = b.where('v.seats', '>=', q.minSeats) as T;
      if (q.maxDailyRateMinor !== undefined) b = b.where('v.daily_rate_minor', '<=', q.maxDailyRateMinor) as T;
      if (q.deliveryAvailable !== undefined) b = b.where('v.delivery_available', '=', q.deliveryAvailable) as T;
      if (q.featured !== undefined) b = b.where('v.is_featured', '=', q.featured) as T;
      if (period) {
        b = b
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('bookings as b')
                  .select('b.id')
                  .whereRef('b.vehicle_id', '=', 'v.id')
                  .where('b.status', 'in', BLOCKING_STATUSES)
                  .where(
                    sql<boolean>`b.blocking_period && public.booking_blocking_range(${period.pickupAt}::timestamptz, ${period.returnAt}::timestamptz, v.buffer_hours)`,
                  ),
              ),
            ),
          )
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('availability_blocks as ab')
                  .select('ab.id')
                  .whereRef('ab.vehicle_id', '=', 'v.id')
                  .where(
                    sql<boolean>`tstzrange(ab.starts_at, ab.ends_at, '[)') && tstzrange(${period.pickupAt}::timestamptz, ${period.returnAt}::timestamptz, '[)')`,
                  ),
              ),
            ),
          ) as T;
      }
      return b;
    };

    let listQ = filtered(vehicleQuery(this.db, userId));
    switch (q.sort ?? 'relevance') {
      case 'price_asc':
        listQ = listQ.orderBy('v.daily_rate_minor', 'asc');
        break;
      case 'price_desc':
        listQ = listQ.orderBy('v.daily_rate_minor', 'desc');
        break;
      case 'category':
        listQ = listQ.orderBy('v.category', 'asc').orderBy('v.daily_rate_minor', 'asc');
        break;
      default:
        listQ = listQ.orderBy('v.is_featured', 'desc').orderBy(sql`v.published_at desc nulls last`);
    }
    const [rows, countRow] = await Promise.all([
      listQ.orderBy('v.id').limit(q.pageSize).offset(q.offset).execute(),
      filtered(vehicleQuery(this.db))
        .clearSelect()
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .executeTakeFirst(),
    ]);
    const items = rows.map((r) => this.toSummary(r, period ? { ...period, country } : undefined));
    return Page.of(items, q.page, q.pageSize, Number(countRow?.n ?? 0));
  }

  async detail(vehicleId: string, userId?: string, pickupAt?: string, returnAt?: string) {
    const period = this.parsePeriod(pickupAt, returnAt);
    const row = await vehicleQuery(this.db, userId)
      .where('v.id', '=', vehicleId)
      .where('v.status', '=', 'published')
      .where('p.status', '=', 'approved')
      .executeTakeFirst();
    if (!row) throw AppException.notFound('vehicle');
    const countries = await loadCountries(this.db);
    const country = countries.get(row.country_code)!;

    const [images, location] = await Promise.all([
      this.db
        .selectFrom('vehicle_images')
        .select(['id', 'storage_path', 'is_cover', 'sort_order'])
        .where('vehicle_id', '=', vehicleId)
        .orderBy('sort_order')
        .orderBy('created_at')
        .execute(),
      row.pickup_location_id
        ? this.db.selectFrom('pickup_locations').selectAll().where('id', '=', row.pickup_location_id).executeTakeFirst()
        : Promise.resolve(undefined),
    ]);

    let availability: { checked: boolean; available: boolean | null } = {
      checked: false,
      available: null,
    };
    if (period) {
      await this.expiry.run({ vehicleId });
      const conflicts = await findBookingConflicts(this.db, {
        vehicleId,
        pickupAt: period.pickupAt,
        returnAt: period.returnAt,
        bufferHours: row.buffer_hours,
      });
      availability = { checked: true, available: !hasConflicts(conflicts) };
    }

    const summary = this.toSummary(row, period ? { ...period, country } : undefined);
    return {
      ...summary,
      images: images.map((i) => ({
        id: i.id,
        url: this.storage.publicUrl('car-images', i.storage_path),
        isCover: i.is_cover,
        sortOrder: i.sort_order,
      })),
      doors: row.doors,
      color: row.color,
      description: row.description,
      features: row.features,
      timezone: row.timezone,
      pickupLocation: location ? toPickupLocation(location) : null,
      deliveryFee: money(row.delivery_fee_minor, row.currency),
      mileagePolicy: {
        limitKmPerDay: row.mileage_limit_km_per_day,
        excessFeePerKm: money(row.excess_mileage_fee_minor, row.currency),
      },
      fuelPolicy: row.fuel_policy,
      deposit: money(row.deposit_minor ?? 0, row.currency),
      cancellationPolicy: cancellationPolicyInfo(row.cancellation_policy as CancellationPolicy),
      insuranceInfo: row.insurance_info,
      minRentalDays: row.min_rental_days,
      bookingMode: effectiveBookingMode(row),
      partner: {
        ...summary.partner,
        cityName: row.city_name,
        logoUrl: row.partner_logo_path ? this.storage.publicUrl('partner-assets', row.partner_logo_path) : null,
      },
      availability,
    };
  }

  // ── favorites ──
  async favorites(userId: string) {
    const rows = await vehicleQuery(this.db, userId)
      .innerJoin('favorites as fav', (j) => j.onRef('fav.vehicle_id', '=', 'v.id').on('fav.user_id', '=', userId))
      .where('v.status', '=', 'published')
      .where('p.status', '=', 'approved')
      .orderBy('fav.created_at', 'desc')
      .execute();
    return rows.map((r) => this.toSummary(r));
  }

  async addFavorite(userId: string, vehicleId: string): Promise<void> {
    const vehicle = await this.db
      .selectFrom('vehicles as v')
      .innerJoin('partners as p', 'p.id', 'v.partner_id')
      .select('v.id')
      .where('v.id', '=', vehicleId)
      .where('v.status', '=', 'published')
      .where('p.status', '=', 'approved')
      .executeTakeFirst();
    if (!vehicle) throw AppException.notFound('vehicle');
    await this.db
      .insertInto('favorites')
      .values({ user_id: userId, vehicle_id: vehicleId })
      .onConflict((oc) => oc.columns(['user_id', 'vehicle_id']).doNothing())
      .execute();
  }

  async removeFavorite(userId: string, vehicleId: string): Promise<void> {
    await this.db.deleteFrom('favorites').where('user_id', '=', userId).where('vehicle_id', '=', vehicleId).execute();
  }
}
