import { Module } from '@nestjs/common';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';
import { BookingViews } from './bookings/booking-views';
import { BookingsController, PartnerBookingsController } from './bookings/bookings.controller';
import { BookingsService } from './bookings/bookings.service';
import { ExpiryService } from './bookings/expiry';
import { PartnerBookingsService } from './bookings/partner-bookings.service';
import { FavoritesController, VehiclesController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { FinanceController } from './finance/finance.controller';
import { FinanceService } from './finance/finance.service';
import { HealthController } from './health/health.controller';
import { MeController, SupportController } from './me/me.controller';
import { MeService } from './me/me.service';
import { PartnerController } from './partner/partner.controller';
import { PartnerService } from './partner/partner.service';
import { PartnerVehiclesController } from './partner/vehicles.controller';
import { PartnerVehiclesService } from './partner/vehicles.service';
import { ReferenceController } from './reference/reference.controller';

@Module({ controllers: [HealthController, ReferenceController] })
export class CoreModule {}

/** Booking engine shared by customer, partner, finance and admin features. */
@Module({
  providers: [ExpiryService, BookingViews],
  exports: [ExpiryService, BookingViews],
})
export class BookingCoreModule {}

@Module({
  imports: [BookingCoreModule],
  controllers: [VehiclesController, FavoritesController, MeController, SupportController, BookingsController],
  providers: [CatalogService, MeService, BookingsService],
})
export class CustomerModule {}

@Module({
  imports: [BookingCoreModule],
  controllers: [PartnerController, PartnerVehiclesController, PartnerBookingsController, FinanceController],
  providers: [PartnerService, PartnerVehiclesService, PartnerBookingsService, FinanceService],
})
export class PartnerModule {}

@Module({
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}

export const FeatureModules = [CoreModule, BookingCoreModule, CustomerModule, PartnerModule, AdminModule];
