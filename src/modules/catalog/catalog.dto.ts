import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { PageQuery } from '../../common/http/page';

const toBool = ({ value }: { value: unknown }) =>
  value === 'true' || value === true ? true : value === 'false' || value === false ? false : value;
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toUpperCase() : value);

export const CATEGORIES = ['economy', 'suv', 'sedan', 'luxury', 'electric'] as const;
export const TRANSMISSIONS = ['automatic', 'manual'] as const;
export const FUEL_TYPES = ['petrol', 'diesel', 'hybrid', 'electric'] as const;

export class SearchVehiclesQuery extends PageQuery {
  @Transform(upper)
  @IsIn(['AE', 'IN'])
  countryCode: string;

  @IsOptional()
  @IsUUID()
  cityId?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  pickupAt?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  returnAt?: string;

  @IsOptional()
  @IsIn(CATEGORIES)
  category?: string;

  @IsOptional()
  @IsIn(TRANSMISSIONS)
  transmission?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  minSeats?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxDailyRateMinor?: number;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  deliveryAvailable?: boolean;

  @IsOptional()
  @IsIn(FUEL_TYPES)
  fuelType?: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  featured?: boolean;

  @IsOptional()
  @IsIn(['relevance', 'price_asc', 'price_desc', 'category'])
  sort?: 'relevance' | 'price_asc' | 'price_desc' | 'category';
}

export class VehicleDetailQuery {
  @IsOptional()
  @IsISO8601({ strict: true })
  pickupAt?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  returnAt?: string;
}

export class AddFavoriteDto {
  @IsUUID()
  vehicleId: string;
}
