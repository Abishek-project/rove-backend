import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentPartner, CurrentUser, PartnerRoute } from '../../common/auth/auth';
import type { AuthUser, PartnerMembership } from '../../common/auth/auth';
import { UuidParam } from '../../common/http/validation';
import { uploadInterceptor } from '../me/me.controller';
import { UploadDocumentDto } from '../me/me.dto';
import { AvailabilityQuery, CreateBlockDto, ImageOrderDto, PartnerVehiclesQuery, VehicleBodyDto } from './vehicles.dto';
import { PartnerVehiclesService } from './vehicles.service';

/**
 * Drafts (list/read/create/edit, photos, documents) are allowed before the company is approved;
 * submit, (un)publish and availability require approval (CONTRACTS §9.5).
 */
@ApiTags('partner: vehicles')
@ApiBearerAuth()
@Controller('partner/vehicles')
export class PartnerVehiclesController {
  constructor(private readonly vehicles: PartnerVehiclesService) {}

  @Get()
  @PartnerRoute()
  list(@CurrentPartner() m: PartnerMembership, @Query() q: PartnerVehiclesQuery) {
    return this.vehicles.list(m, q);
  }

  @Post()
  @PartnerRoute({ manage: true })
  create(@CurrentPartner() m: PartnerMembership, @Body() dto: VehicleBodyDto) {
    return this.vehicles.create(m, dto);
  }

  @Get(':vehicleId')
  @PartnerRoute()
  get(@CurrentPartner() m: PartnerMembership, @Param('vehicleId', UuidParam) id: string) {
    return this.vehicles.get(m, id);
  }

  @Patch(':vehicleId')
  @PartnerRoute({ manage: true })
  update(
    @CurrentPartner() m: PartnerMembership,
    @Param('vehicleId', UuidParam) id: string,
    @Body() dto: VehicleBodyDto,
  ) {
    return this.vehicles.update(m, id, dto);
  }

  @Delete(':vehicleId')
  @PartnerRoute({ manage: true })
  @HttpCode(204)
  async remove(@CurrentPartner() m: PartnerMembership, @Param('vehicleId', UuidParam) id: string) {
    await this.vehicles.remove(m, id);
  }

  @Post(':vehicleId/submit')
  @PartnerRoute({ manage: true, approved: true })
  @HttpCode(200)
  submit(@CurrentPartner() m: PartnerMembership, @Param('vehicleId', UuidParam) id: string) {
    return this.vehicles.submit(m, id);
  }

  @Post(':vehicleId/unpublish')
  @PartnerRoute({ manage: true, approved: true })
  @HttpCode(200)
  unpublish(@CurrentPartner() m: PartnerMembership, @Param('vehicleId', UuidParam) id: string) {
    return this.vehicles.setListed(m, id, false);
  }

  @Post(':vehicleId/republish')
  @PartnerRoute({ manage: true, approved: true })
  @HttpCode(200)
  republish(@CurrentPartner() m: PartnerMembership, @Param('vehicleId', UuidParam) id: string) {
    return this.vehicles.setListed(m, id, true);
  }

  // ── images ──
  @Post(':vehicleId/images')
  @PartnerRoute({ manage: true })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(uploadInterceptor())
  addImage(
    @CurrentPartner() m: PartnerMembership,
    @Param('vehicleId', UuidParam) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.vehicles.addImage(m, id, file);
  }

  @Put(':vehicleId/images/order')
  @PartnerRoute({ manage: true })
  reorder(
    @CurrentPartner() m: PartnerMembership,
    @Param('vehicleId', UuidParam) id: string,
    @Body() dto: ImageOrderDto,
  ) {
    return this.vehicles.reorderImages(m, id, dto.imageIds);
  }

  @Post(':vehicleId/images/:imageId/cover')
  @PartnerRoute({ manage: true })
  @HttpCode(200)
  cover(
    @CurrentPartner() m: PartnerMembership,
    @Param('vehicleId', UuidParam) id: string,
    @Param('imageId', UuidParam) imageId: string,
  ) {
    return this.vehicles.setCover(m, id, imageId);
  }

  @Delete(':vehicleId/images/:imageId')
  @PartnerRoute({ manage: true })
  @HttpCode(204)
  async deleteImage(
    @CurrentPartner() m: PartnerMembership,
    @Param('vehicleId', UuidParam) id: string,
    @Param('imageId', UuidParam) imageId: string,
  ) {
    await this.vehicles.deleteImage(m, id, imageId);
  }

  // ── documents ──
  @Get(':vehicleId/documents')
  @PartnerRoute()
  documents(@CurrentPartner() m: PartnerMembership, @Param('vehicleId', UuidParam) id: string) {
    return this.vehicles.listDocuments(m, id);
  }

  @Post(':vehicleId/documents')
  @PartnerRoute({ manage: true })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(uploadInterceptor())
  uploadDocument(
    @CurrentPartner() m: PartnerMembership,
    @Param('vehicleId', UuidParam) id: string,
    @Body() dto: UploadDocumentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.vehicles.uploadDocument(m, id, dto, file);
  }

  @Get(':vehicleId/documents/:docId/url')
  @PartnerRoute()
  documentUrl(
    @CurrentPartner() m: PartnerMembership,
    @Param('vehicleId', UuidParam) id: string,
    @Param('docId', UuidParam) docId: string,
  ) {
    return this.vehicles.documentUrl(m, id, docId);
  }

  // ── availability ──
  @Get(':vehicleId/availability')
  @PartnerRoute({ approved: true })
  availability(
    @CurrentPartner() m: PartnerMembership,
    @Param('vehicleId', UuidParam) id: string,
    @Query() q: AvailabilityQuery,
  ) {
    return this.vehicles.availability(m, id, q);
  }

  @Post(':vehicleId/availability')
  @PartnerRoute({ manage: true, approved: true })
  createBlock(
    @CurrentPartner() m: PartnerMembership,
    @CurrentUser() user: AuthUser,
    @Param('vehicleId', UuidParam) id: string,
    @Body() dto: CreateBlockDto,
  ) {
    return this.vehicles.createBlock(m, id, dto, user.userId);
  }

  @Delete(':vehicleId/availability/:blockId')
  @PartnerRoute({ manage: true, approved: true })
  @HttpCode(204)
  async deleteBlock(
    @CurrentPartner() m: PartnerMembership,
    @Param('vehicleId', UuidParam) id: string,
    @Param('blockId', UuidParam) blockId: string,
  ) {
    await this.vehicles.deleteBlock(m, id, blockId);
  }
}
