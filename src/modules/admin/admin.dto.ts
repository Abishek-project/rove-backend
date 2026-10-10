import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsOptional, IsString, Length, Matches } from 'class-validator';
import { PageQuery } from '../../common/http/page';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class AdminPartnersQuery extends PageQuery {
  @IsOptional()
  @IsIn(['draft', 'pending_verification', 'approved', 'rejected', 'suspended'])
  status?: string;
}

export class AdminVehiclesQuery extends PageQuery {
  @IsOptional()
  @IsIn(['draft', 'pending_review', 'published', 'rejected', 'suspended', 'unavailable'])
  status?: string;
}

export class AdminReasonDto {
  @Transform(trim) @IsString() @Length(3, 500) reason: string;
}

export class AdminOptionalReasonDto {
  @IsOptional() @Transform(trim) @IsString() @Length(0, 500) reason?: string;
}

export class GeneratePayoutsDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  periodStart: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  periodEnd: string;
}

export class MarkPaidDto {
  @Transform(trim) @IsString() @Length(2, 120) reference: string;
}
