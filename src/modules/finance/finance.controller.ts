import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentPartner, PartnerRoute } from '../../common/auth/auth';
import type { PartnerMembership } from '../../common/auth/auth';
import { RawResponse } from '../../common/http/envelope.interceptor';
import { EarningsExportQuery, EarningsQuery, FinanceService, PayoutsQuery, PeriodQuery } from './finance.service';

@ApiTags('partner: overview & financials')
@ApiBearerAuth()
@Controller('partner')
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get('overview')
  @PartnerRoute({ approved: true })
  overview(@CurrentPartner() m: PartnerMembership, @Query() q: PeriodQuery) {
    return this.finance.overview(m, q);
  }

  @Get('earnings')
  @PartnerRoute({ approved: true })
  earnings(@CurrentPartner() m: PartnerMembership, @Query() q: EarningsQuery) {
    return this.finance.earnings(m, q);
  }

  @Get('earnings/export.csv')
  @PartnerRoute({ approved: true })
  @RawResponse()
  @ApiProduces('text/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportCsv(
    @CurrentPartner() m: PartnerMembership,
    @Query() q: EarningsExportQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const csv = await this.finance.earningsCsv(m, q);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="rove-earnings-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    return csv;
  }

  @Get('payouts')
  @PartnerRoute({ approved: true })
  payouts(@CurrentPartner() m: PartnerMembership, @Query() q: PayoutsQuery) {
    return this.finance.payouts(m, q);
  }
}
