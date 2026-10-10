import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { PageQuery } from '../../common/http/page';
import { CATEGORIES, FUEL_TYPES, TRANSMISSIONS } from '../catalog/catalog.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Optional but, when present, not null (for NOT NULL columns). */
const Opt = () => ValidateIf((_o, v) => v !== undefined);

export class VehicleBodyDto {
  @IsOptional() @IsUUID() cityId?: string | null;
  @IsOptional() @IsUUID() pickupLocationId?: string | null;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 60) make?: string | null;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 60) model?: string | null;
  @IsOptional() @IsInt() @Min(1990) @Max(2100) year?: number | null;
  @IsOptional() @IsIn(CATEGORIES) category?: string | null;
  @IsOptional() @IsIn(TRANSMISSIONS) transmission?: string | null;
  @IsOptional() @IsIn(FUEL_TYPES) fuelType?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(20) seats?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(10) doors?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(20) luggage?: number | null;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 40) color?: string | null;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 20)
  registrationNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) description?: string | null;
  @Opt()
  @IsArray()
  @ArrayMaxSize(40)
  @ArrayUnique()
  @IsString({ each: true })
  @Length(1, 60, { each: true })
  features?: string[];
  @IsOptional() @IsInt() @Min(100) @Max(100_000_000) dailyRateMinor?: number | null;
  @Opt() @IsInt() @Min(0) @Max(9000) weeklyDiscountBps?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10_000) mileageLimitKmPerDay?: number | null;
  @Opt() @IsInt() @Min(0) @Max(1_000_000) excessMileageFeeMinor?: number;
  @IsOptional() @IsIn(['full_to_full', 'same_to_same']) fuelPolicy?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) depositMinor?: number | null;
  @IsOptional() @IsIn(['flexible', 'moderate', 'strict']) cancellationPolicy?: string | null;
  @Opt() @IsBoolean() deliveryAvailable?: boolean;
  @Opt() @IsInt() @Min(0) @Max(10_000_000) deliveryFeeMinor?: number;
  @Opt() @IsInt() @Min(1) @Max(30) minRentalDays?: number;
  @Opt() @IsInt() @Min(0) @Max(72) bufferHours?: number;
  @IsOptional() @IsString() @MaxLength(2000) insuranceInfo?: string | null;
  /** Additive (v1.2): per-vehicle booking mode override; null = use the company default. */
  @IsOptional() @IsIn(['instant', 'request']) bookingMode?: 'instant' | 'request' | null;
}

export class PartnerVehiclesQuery extends PageQuery {
  @IsOptional()
  @IsIn(['draft', 'pending_review', 'published', 'rejected', 'suspended', 'unavailable'])
  status?: string;
  @IsOptional() @IsIn(CATEGORIES) category?: string;
  @IsOptional() @IsUUID() cityId?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
}

export class ImageOrderDto {
  @IsArray()
  @ArrayMaxSize(12)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  imageIds: string[];
}

export class AvailabilityQuery {
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
}

export class CreateBlockDto {
  @IsISO8601({ strict: true }) startsAt: string;
  @IsISO8601({ strict: true }) endsAt: string;
  @IsIn(['maintenance', 'unavailable', 'other']) reason: 'maintenance' | 'unavailable' | 'other';
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
}

export class ReasonDto {
  @Transform(trim) @IsString() @Length(5, 500) reason: string;
}

export class OptionalReasonDto {
  @IsOptional() @Transform(trim) @IsString() @Length(0, 500) reason?: string;
}
