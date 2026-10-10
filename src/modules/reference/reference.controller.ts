import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { Public } from '../../common/auth/auth';
import { InjectDb } from '../../database/database';
import type { Db } from '../../database/database';

export class LocationsQuery {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsIn(['AE', 'IN'])
  countryCode: string;

  @IsOptional()
  @IsUUID()
  cityId?: string;
}

export interface CityDto {
  id: string;
  name: string;
  slug: string;
  countryCode: string;
  timezone: string;
}

@ApiTags('reference')
@Controller()
export class ReferenceController {
  constructor(@InjectDb() private readonly db: Db) {}

  @Get('countries')
  @Public()
  async countries() {
    const [countries, cities] = await Promise.all([
      this.db.selectFrom('countries').selectAll().where('is_active', '=', true).orderBy('name').execute(),
      this.db.selectFrom('cities').selectAll().where('is_active', '=', true).orderBy('name').execute(),
    ]);
    return countries.map((c) => ({
      code: c.code,
      name: c.name,
      currency: c.currency_code,
      timezone: c.default_timezone,
      taxLabel: c.tax_label,
      taxRateBps: c.tax_rate_bps,
      platformFeeBps: c.platform_fee_bps,
      paymentMethods: c.payment_methods,
      cities: cities
        .filter((city) => city.country_code === c.code)
        .map<CityDto>((city) => ({
          id: city.id,
          name: city.name,
          slug: city.slug,
          countryCode: city.country_code,
          timezone: city.timezone,
        })),
    }));
  }

  /** Pickup locations of approved partners that have at least one published vehicle. */
  @Get('locations')
  @Public()
  async locations(@Query() q: LocationsQuery) {
    let query = this.db
      .selectFrom('pickup_locations as l')
      .innerJoin('cities as c', 'c.id', 'l.city_id')
      .innerJoin('partners as p', 'p.id', 'l.partner_id')
      .select(['l.id', 'l.name', 'l.address', 'l.city_id', 'l.latitude', 'l.longitude'])
      .where('c.country_code', '=', q.countryCode)
      .where('p.status', '=', 'approved')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('vehicles as v')
            .select('v.id')
            .whereRef('v.partner_id', '=', 'l.partner_id')
            .where('v.status', '=', 'published'),
        ),
      )
      .orderBy('l.name');
    if (q.cityId) query = query.where('l.city_id', '=', q.cityId);
    const rows = await query.execute();
    return rows.map(toPickupLocation);
  }
}

export function toPickupLocation(l: {
  id: string;
  name: string;
  address: string;
  city_id: string;
  latitude: number | null;
  longitude: number | null;
}) {
  return {
    id: l.id,
    name: l.name,
    address: l.address,
    cityId: l.city_id,
    latitude: l.latitude === null ? null : Number(l.latitude),
    longitude: l.longitude === null ? null : Number(l.longitude),
  };
}
