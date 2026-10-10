import { Transform, Type } from 'class-transformer';
import {
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { PageQuery } from '../../common/http/page';
import { PHONE_REGEX } from '../me/me.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class DeliveryDto {
  @IsBoolean() enabled: boolean;
  @IsOptional() @Transform(trim) @IsString() @Length(5, 300) address?: string;
}

export class QuoteDto {
  @IsUUID() vehicleId: string;
  @IsISO8601({ strict: true }) pickupAt: string;
  @IsISO8601({ strict: true }) returnAt: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => DeliveryDto)
  delivery?: DeliveryDto;
}

export class DriverDto {
  @Transform(trim) @IsString() @Length(2, 100) fullName: string;
  @Transform(trim)
  @Matches(PHONE_REGEX, { message: 'phone must be a valid phone number' })
  phone: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateOfBirth must be YYYY-MM-DD' })
  @IsISO8601({ strict: true })
  dateOfBirth: string;
}

export class CreateBookingDto {
  @IsUUID() quoteId: string;
  @ValidateNested() @Type(() => DriverDto) driver: DriverDto;
  @Equals(true, { message: 'termsAccepted must be true' })
  termsAccepted: boolean;
}

export class ConfirmPaymentDto {
  @IsString() @Length(1, 200) intentId: string;
  @IsOptional() @IsIn(['success', 'fail']) simulateOutcome?: 'success' | 'fail';
}

export class CustomerBookingsQuery extends PageQuery {
  @IsOptional()
  @IsIn(['upcoming', 'pending', 'active', 'completed', 'cancelled'])
  group?: string;
}

export class CancelDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) reason?: string;
}

// ── partner ops ──
export class PartnerBookingsQuery extends PageQuery {
  @IsOptional()
  @IsIn(['pending', 'confirmed', 'upcoming_pickups', 'active', 'returns_due', 'completed', 'cancelled'])
  filter?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
}

export class RejectDto {
  @Transform(trim) @IsString() @Length(5, 500) reason: string;
}

export class PartnerCancelDto {
  @Transform(trim) @IsString() @Length(5, 500) reason: string;
}

export class DamageDto {
  @Transform(trim) @IsString() @Length(1, 60) area: string;
  @IsIn(['minor', 'moderate', 'major']) severity: 'minor' | 'moderate' | 'major';
  @Transform(trim) @IsString() @Length(1, 500) description: string;
  @IsOptional() @IsBoolean() isNew?: boolean;
}

export class CustomerChecksDto {
  @Equals(true, { message: 'licenceVerified must be true' })
  licenceVerified: boolean;
  @Equals(true, { message: 'identityVerified must be true' })
  identityVerified: boolean;
}

export class ReturnReportDto {
  @IsInt() @Min(0) @Max(2_000_000) odometerKm: number;
  @IsInt() @Min(0) @Max(100) fuelLevelPct: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) notes?: string;
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => DamageDto)
  damages: DamageDto[];
}

export class PickupReportDto extends ReturnReportDto {
  @ValidateNested()
  @Type(() => CustomerChecksDto)
  customerChecks: CustomerChecksDto;
}

export class EvidenceDto {
  @IsIn(['pickup', 'return']) stage: 'pickup' | 'return';
}
