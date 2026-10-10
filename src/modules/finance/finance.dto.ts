import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsOptional } from 'class-validator';
import { PageQuery } from '../../common/http/page';

const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

export class PeriodQuery {
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
}

export class EarningsQuery extends PageQuery {
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
  @IsOptional() @Transform(upper) @IsIn(['AED', 'INR']) currency?: string;
}

export class EarningsExportQuery {
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
  @IsOptional() @Transform(upper) @IsIn(['AED', 'INR']) currency?: string;
}

export class PayoutsQuery extends PageQuery {
  @IsOptional()
  @IsIn(['pending', 'processing', 'paid', 'failed'])
  status?: string;
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
  @IsOptional() @Transform(upper) @IsIn(['AED', 'INR']) currency?: string;
}
