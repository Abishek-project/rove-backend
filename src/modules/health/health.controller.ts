import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { sql } from 'kysely';
import { Public } from '../../common/auth/auth';
import { InjectDb } from '../../database/database';
import type { Db } from '../../database/database';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(@InjectDb() private readonly db: Db) {}

  /** `/api/v1/health` (enveloped like every API route); `/health` (raw, for probes) is wired in app.setup.ts. */
  @Get('health')
  @Public()
  @HttpCode(200)
  @ApiOkResponse({ schema: { example: { data: { status: 'ok', db: 'ok' } } } })
  async health(@Res({ passthrough: true }) res: Response): Promise<{ status: string; db: string }> {
    const body = await this.check();
    if (body.db !== 'ok') res.status(503);
    return body;
  }

  async check(): Promise<{ status: string; db: string }> {
    try {
      await sql`select 1`.execute(this.db);
      return { status: 'ok', db: 'ok' };
    } catch {
      return { status: 'degraded', db: 'unavailable' };
    }
  }
}
