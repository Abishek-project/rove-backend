import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class LocationsQuery {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsIn(['AE', 'IN'])
  countryCode: string;

  @IsOptional()
  @IsUUID()
  cityId?: string;
}
