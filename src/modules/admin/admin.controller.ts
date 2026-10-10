import { Body, Controller, Get, HttpCode, Param, ParseEnumPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminRoute } from '../../common/auth/auth';
import { AppException } from '../../common/errors/app-exception';
import { UuidParam } from '../../common/http/validation';
import {
  AdminOptionalReasonDto,
  AdminPartnersQuery,
  AdminReasonDto,
  AdminService,
  AdminVehiclesQuery,
  DocKind,
  GeneratePayoutsDto,
  MarkPaidDto,
} from './admin.service';

enum DocKindParam {
  partner = 'partner',
  vehicle = 'vehicle',
  customer = 'customer',
}
enum DecisionParam {
  approve = 'approve',
  reject = 'reject',
}

@ApiTags('admin')
@AdminRoute()
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('partners')
  partners(@Query() q: AdminPartnersQuery) {
    return this.admin.listPartners(q);
  }

  @Post('partners/:id/approve')
  @HttpCode(200)
  approvePartner(@Param('id', UuidParam) id: string) {
    return this.admin.approvePartner(id);
  }

  @Post('partners/:id/reject')
  @HttpCode(200)
  rejectPartner(@Param('id', UuidParam) id: string, @Body() dto: AdminReasonDto) {
    return this.admin.rejectPartner(id, dto.reason);
  }

  @Post('partners/:id/suspend')
  @HttpCode(200)
  suspendPartner(@Param('id', UuidParam) id: string, @Body() dto: AdminReasonDto) {
    return this.admin.suspendPartner(id, dto.reason);
  }

  @Get('vehicles')
  vehicles(@Query() q: AdminVehiclesQuery) {
    return this.admin.listVehicles(q);
  }

  @Post('vehicles/:id/approve')
  @HttpCode(200)
  approveVehicle(@Param('id', UuidParam) id: string) {
    return this.admin.approveVehicle(id);
  }

  @Post('vehicles/:id/reject')
  @HttpCode(200)
  rejectVehicle(@Param('id', UuidParam) id: string, @Body() dto: AdminReasonDto) {
    return this.admin.rejectVehicle(id, dto.reason);
  }

  @Post('documents/:kind/:id/:decision')
  @HttpCode(200)
  reviewDocument(
    @Param(
      'kind',
      new ParseEnumPipe(DocKindParam, {
        exceptionFactory: () => AppException.notFound(),
      }),
    )
    kind: DocKind,
    @Param('id', UuidParam) id: string,
    @Param(
      'decision',
      new ParseEnumPipe(DecisionParam, {
        exceptionFactory: () => AppException.notFound(),
      }),
    )
    decision: 'approve' | 'reject',
    @Body() dto: AdminOptionalReasonDto,
  ) {
    return this.admin.reviewDocument(kind, id, decision, dto.reason);
  }

  @Post('payouts/generate')
  @HttpCode(200)
  generatePayouts(@Body() dto: GeneratePayoutsDto) {
    return this.admin.generatePayouts(dto);
  }

  @Post('payouts/:id/mark-paid')
  @HttpCode(200)
  markPaid(@Param('id', UuidParam) id: string, @Body() dto: MarkPaidDto) {
    return this.admin.markPayoutPaid(id, dto.reference);
  }
}
