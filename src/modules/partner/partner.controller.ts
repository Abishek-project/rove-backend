import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentPartner, CurrentUser, PartnerRoute } from '../../common/auth/auth';
import type { AuthUser, PartnerMembership } from '../../common/auth/auth';
import { UuidParam } from '../../common/http/validation';
import { UploadDocumentDto } from '../me/me.dto';
import { uploadInterceptor } from '../me/me.controller';
import { LocationDto, OnboardingDto, UpdateLocationDto, UpdatePartnerDto } from './partner.dto';
import { PartnerService } from './partner.service';

@ApiTags('partner: profile & onboarding')
@ApiBearerAuth()
@Controller('partner')
export class PartnerController {
  constructor(private readonly partners: PartnerService) {}

  @Get('profile')
  @PartnerRoute()
  profile(@CurrentPartner() m: PartnerMembership) {
    return this.partners.profile(m);
  }

  @Post('onboarding')
  onboard(@CurrentUser() user: AuthUser, @Body() dto: OnboardingDto) {
    return this.partners.onboard(user, dto);
  }

  @Patch('profile')
  @PartnerRoute({ manage: true })
  update(@CurrentPartner() m: PartnerMembership, @Body() dto: UpdatePartnerDto) {
    return this.partners.update(m, dto);
  }

  @Get('verification')
  @PartnerRoute()
  verification(@CurrentPartner() m: PartnerMembership) {
    return this.partners.verification(m);
  }

  @Post('verification/submit')
  @PartnerRoute({ manage: true })
  @HttpCode(200)
  submit(@CurrentPartner() m: PartnerMembership) {
    return this.partners.submitVerification(m);
  }

  @Get('documents')
  @PartnerRoute()
  documents(@CurrentPartner() m: PartnerMembership) {
    return this.partners.listDocuments(m);
  }

  @Post('documents')
  @PartnerRoute({ manage: true })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(uploadInterceptor())
  uploadDocument(
    @CurrentPartner() m: PartnerMembership,
    @Body() dto: UploadDocumentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.partners.uploadDocument(m, dto, file);
  }

  @Get('documents/:documentId/url')
  @PartnerRoute()
  documentUrl(@CurrentPartner() m: PartnerMembership, @Param('documentId', UuidParam) id: string) {
    return this.partners.documentUrl(m, id);
  }

  @Post('logo')
  @PartnerRoute({ manage: true })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(uploadInterceptor())
  @HttpCode(200)
  logo(@CurrentPartner() m: PartnerMembership, @UploadedFile() file: Express.Multer.File | undefined) {
    return this.partners.uploadLogo(m, file);
  }

  @Get('locations')
  @PartnerRoute()
  locations(@CurrentPartner() m: PartnerMembership) {
    return this.partners.listLocations(m);
  }

  @Post('locations')
  @PartnerRoute({ manage: true })
  createLocation(@CurrentPartner() m: PartnerMembership, @Body() dto: LocationDto) {
    return this.partners.createLocation(m, dto);
  }

  @Patch('locations/:locationId')
  @PartnerRoute({ manage: true })
  updateLocation(
    @CurrentPartner() m: PartnerMembership,
    @Param('locationId', UuidParam) id: string,
    @Body() dto: UpdateLocationDto,
  ) {
    return this.partners.updateLocation(m, id, dto);
  }

  @Delete('locations/:locationId')
  @PartnerRoute({ manage: true })
  @HttpCode(204)
  async deleteLocation(@CurrentPartner() m: PartnerMembership, @Param('locationId', UuidParam) id: string) {
    await this.partners.deleteLocation(m, id);
  }
}
