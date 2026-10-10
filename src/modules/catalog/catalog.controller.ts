import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public } from '../../common/auth/auth';
import type { AuthUser } from '../../common/auth/auth';
import { UuidParam } from '../../common/http/validation';
import { AddFavoriteDto, SearchVehiclesQuery, VehicleDetailQuery } from './catalog.dto';
import { CatalogService } from './catalog.service';

@ApiTags('vehicles')
@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @Public()
  search(@Query() q: SearchVehiclesQuery, @CurrentUser() user?: AuthUser) {
    return this.catalog.search(q, user?.userId);
  }

  @Get(':vehicleId')
  @Public()
  detail(@Param('vehicleId', UuidParam) id: string, @Query() q: VehicleDetailQuery, @CurrentUser() user?: AuthUser) {
    return this.catalog.detail(id, user?.userId, q.pickupAt, q.returnAt);
  }
}

@ApiTags('favorites')
@ApiBearerAuth()
@Controller('favorites')
export class FavoritesController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.catalog.favorites(user.userId);
  }

  @Post()
  @HttpCode(201)
  async add(@CurrentUser() user: AuthUser, @Body() body: AddFavoriteDto) {
    await this.catalog.addFavorite(user.userId, body.vehicleId);
    return { vehicleId: body.vehicleId, isFavorite: true };
  }

  @Delete(':vehicleId')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('vehicleId', UuidParam) vehicleId: string) {
    await this.catalog.removeFavorite(user.userId, vehicleId);
  }
}
