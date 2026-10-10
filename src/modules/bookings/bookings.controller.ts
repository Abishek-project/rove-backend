import { Body, Controller, Get, HttpCode, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentPartner, CurrentUser, PartnerRoute } from '../../common/auth/auth';
import type { AuthUser, PartnerMembership } from '../../common/auth/auth';
import { Idempotent } from '../../common/http/idempotency';
import { UuidParam } from '../../common/http/validation';
import { uploadInterceptor } from '../me/me.controller';
import {
  CancelDto,
  ConfirmPaymentDto,
  CreateBookingDto,
  CustomerBookingsQuery,
  EvidenceDto,
  PartnerBookingsQuery,
  PartnerCancelDto,
  PickupReportDto,
  QuoteDto,
  RejectDto,
  ReturnReportDto,
} from './bookings.dto';
import { BookingsService } from './bookings.service';
import { PartnerBookingsService } from './partner-bookings.service';

@ApiTags('bookings')
@ApiBearerAuth()
@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Post('quote')
  @HttpCode(200)
  quote(@CurrentUser() user: AuthUser, @Body() dto: QuoteDto) {
    return this.bookings.quote(user, dto);
  }

  @Post()
  @Idempotent()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateBookingDto) {
    return this.bookings.create(user, dto);
  }

  @Post(':bookingId/payment/confirm')
  @Idempotent()
  @HttpCode(200)
  confirm(@CurrentUser() user: AuthUser, @Param('bookingId', UuidParam) id: string, @Body() dto: ConfirmPaymentDto) {
    return this.bookings.confirmPayment(user, id, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: CustomerBookingsQuery) {
    return this.bookings.list(user, q);
  }

  @Get(':bookingId')
  get(@CurrentUser() user: AuthUser, @Param('bookingId', UuidParam) id: string) {
    return this.bookings.get(user, id);
  }

  @Get(':bookingId/cancellation-preview')
  preview(@CurrentUser() user: AuthUser, @Param('bookingId', UuidParam) id: string) {
    return this.bookings.cancellationPreview(user, id);
  }

  @Post(':bookingId/cancel')
  @Idempotent()
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('bookingId', UuidParam) id: string, @Body() dto: CancelDto) {
    return this.bookings.cancel(user, id, dto);
  }
}

@ApiTags('partner: bookings')
@ApiBearerAuth()
@Controller('partner/bookings')
export class PartnerBookingsController {
  constructor(private readonly ops: PartnerBookingsService) {}

  @Get()
  @PartnerRoute({ approved: true })
  list(@CurrentPartner() m: PartnerMembership, @Query() q: PartnerBookingsQuery) {
    return this.ops.list(m, q);
  }

  @Get(':bookingId')
  @PartnerRoute({ approved: true })
  get(@CurrentPartner() m: PartnerMembership, @Param('bookingId', UuidParam) id: string) {
    return this.ops.get(m, id);
  }

  @Post(':bookingId/accept')
  @PartnerRoute({ approved: true })
  @Idempotent()
  @HttpCode(200)
  accept(
    @CurrentPartner() m: PartnerMembership,
    @CurrentUser() u: AuthUser,
    @Param('bookingId', UuidParam) id: string,
  ) {
    return this.ops.accept(m, u.userId, id);
  }

  @Post(':bookingId/reject')
  @PartnerRoute({ approved: true })
  @Idempotent()
  @HttpCode(200)
  reject(
    @CurrentPartner() m: PartnerMembership,
    @CurrentUser() u: AuthUser,
    @Param('bookingId', UuidParam) id: string,
    @Body() dto: RejectDto,
  ) {
    return this.ops.reject(m, u.userId, id, dto.reason);
  }

  @Post(':bookingId/cancel')
  @PartnerRoute({ approved: true })
  @Idempotent()
  @HttpCode(200)
  cancel(
    @CurrentPartner() m: PartnerMembership,
    @CurrentUser() u: AuthUser,
    @Param('bookingId', UuidParam) id: string,
    @Body() dto: PartnerCancelDto,
  ) {
    return this.ops.cancel(m, u.userId, id, dto.reason);
  }

  @Post(':bookingId/pickup')
  @PartnerRoute({ approved: true })
  @Idempotent()
  @HttpCode(200)
  pickup(
    @CurrentPartner() m: PartnerMembership,
    @CurrentUser() u: AuthUser,
    @Param('bookingId', UuidParam) id: string,
    @Body() dto: PickupReportDto,
  ) {
    return this.ops.pickup(m, u.userId, id, dto);
  }

  @Post(':bookingId/return')
  @PartnerRoute({ approved: true })
  @Idempotent()
  @HttpCode(200)
  return(
    @CurrentPartner() m: PartnerMembership,
    @CurrentUser() u: AuthUser,
    @Param('bookingId', UuidParam) id: string,
    @Body() dto: ReturnReportDto,
  ) {
    return this.ops.return(m, u.userId, id, dto);
  }

  @Post(':bookingId/evidence')
  @PartnerRoute({ approved: true })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(uploadInterceptor())
  evidence(
    @CurrentPartner() m: PartnerMembership,
    @CurrentUser() u: AuthUser,
    @Param('bookingId', UuidParam) id: string,
    @Body() dto: EvidenceDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.ops.uploadEvidence(m, u.userId, id, dto.stage, file);
  }

  @Get(':bookingId/evidence')
  @PartnerRoute({ approved: true })
  listEvidence(@CurrentPartner() m: PartnerMembership, @Param('bookingId', UuidParam) id: string) {
    return this.ops.listEvidence(m, id);
  }
}
