import { Transform, Type } from 'class-transformer';
import { IsEmail, IsIn, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { PHONE_REGEX } from '../me/me.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

export class OnboardingDto {
  @Transform(trim) @IsString() @Length(2, 200) legalName: string;
  @Transform(trim) @IsString() @Length(2, 100) displayName: string;
  @Transform(trim) @IsString() @Length(2, 100) contactName: string;
  @Transform(trim) @IsEmail() email: string;
  @Transform(trim)
  @Matches(PHONE_REGEX, { message: 'phone must be a valid phone number' })
  phone: string;
  @Transform(upper) @IsIn(['AE', 'IN']) countryCode: string;
  @IsUUID() cityId: string;
  @Transform(trim) @IsString() @Length(5, 300) address: string;
  @Transform(trim) @IsString() @Length(3, 64) registrationNumber: string;
}

export class UpdatePartnerDto {
  @IsOptional() @Transform(trim) @IsString() @Length(2, 200) legalName?: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  displayName?: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  contactName?: string;
  @IsOptional() @Transform(trim) @IsEmail() email?: string;
  @IsOptional()
  @Transform(trim)
  @Matches(PHONE_REGEX, { message: 'phone must be a valid phone number' })
  phone?: string;
  @IsOptional() @Transform(upper) @IsIn(['AE', 'IN']) countryCode?: string;
  @IsOptional() @IsUUID() cityId?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(5, 300) address?: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(3, 64)
  registrationNumber?: string;
  @IsOptional() @IsIn(['instant', 'request']) bookingMode?: 'instant' | 'request';
}

export class LocationDto {
  @IsUUID() cityId: string;
  @Transform(trim) @IsString() @Length(2, 120) name: string;
  @Transform(trim) @IsString() @Length(5, 300) address: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-90) @Max(90) latitude?: number | null;
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number | null;
}

export class UpdateLocationDto {
  @IsOptional() @IsUUID() cityId?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(2, 120) name?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(5, 300) address?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-90) @Max(90) latitude?: number | null;
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number | null;
}
