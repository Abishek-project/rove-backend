import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

export const PHONE_REGEX = /^\+?[0-9][0-9 ()-]{6,19}$/;

export class NotificationPrefsDto {
  @IsOptional() @IsBoolean() email?: boolean;
  @IsOptional() @IsBoolean() push?: boolean;
  @IsOptional() @IsBoolean() marketing?: boolean;
}

export class UpdateMeDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  fullName?: string;

  @IsOptional()
  @Transform(trim)
  @Matches(PHONE_REGEX, {
    message: 'phone must be a valid phone number, e.g. +971501234567',
  })
  phone?: string;

  @IsOptional()
  @Transform(upper)
  @IsIn(['AE', 'IN'])
  countryCode?: string;

  @IsOptional()
  @IsUUID()
  cityId?: string | null;

  @IsOptional()
  @IsIn(['en', 'ar', 'hi'])
  preferredLanguage?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationPrefsDto)
  notificationPrefs?: NotificationPrefsDto;
}

export class UploadDocumentDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  documentType: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'expiresOn must be YYYY-MM-DD' })
  expiresOn?: string;
}

export class CreateSupportRequestDto {
  @Transform(trim)
  @IsString()
  @Length(3, 150)
  subject: string;

  @Transform(trim)
  @IsString()
  @Length(10, 5000)
  message: string;

  @IsOptional()
  @IsUUID()
  bookingId?: string;
}
