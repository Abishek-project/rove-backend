import { Body, Controller, Get, HttpCode, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/auth';
import type { AuthUser } from '../../common/auth/auth';
import { PageQuery } from '../../common/http/page';
import { MAX_UPLOAD_BYTES } from '../../storage/uploads';
import { CreateSupportRequestDto, UpdateMeDto, UploadDocumentDto } from './me.dto';
import { MeService } from './me.service';

export const uploadInterceptor = () =>
  FileInterceptor('file', {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 },
  });

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.me.get(user);
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    return this.me.update(user, dto);
  }

  @Post('deletion-request')
  @HttpCode(200)
  deletion(@CurrentUser() user: AuthUser) {
    return this.me.requestDeletion(user);
  }

  @Get('verification')
  verification(@CurrentUser() user: AuthUser) {
    return this.me.verification(user);
  }

  @Post('documents')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(uploadInterceptor())
  upload(
    @CurrentUser() user: AuthUser,
    @Body() dto: UploadDocumentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.me.uploadDocument(user, dto, file);
  }
}

@ApiTags('support')
@ApiBearerAuth()
@Controller('support/requests')
export class SupportController {
  constructor(private readonly me: MeService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSupportRequestDto) {
    return this.me.createSupportRequest(user, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() page: PageQuery) {
    return this.me.listSupportRequests(user, page);
  }
}
