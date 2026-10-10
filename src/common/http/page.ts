import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Returned by controllers for paginated lists; the envelope interceptor renders `{ data, meta }`. */
export class Page<T> {
  constructor(
    readonly items: T[],
    readonly meta: PageMeta,
  ) {}

  static of<T>(items: T[], page: number, pageSize: number, total: number): Page<T> {
    return new Page(items, {
      page,
      pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    });
  }
}

/** Response wrapper for endpoints whose payload is an object but which also return `meta`. */
export class WithMeta<T> {
  constructor(
    readonly data: T,
    readonly meta: PageMeta,
  ) {}
}

export class PageQuery {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;

  get offset(): number {
    return (this.page - 1) * this.pageSize;
  }
}
