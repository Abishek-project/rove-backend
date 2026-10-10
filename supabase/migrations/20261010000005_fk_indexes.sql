-- Covering indexes for foreign keys flagged by the Supabase performance advisor (unindexed_foreign_keys).
-- Keeps joins and ON DELETE cascades/SET NULLs from scanning whole tables as data grows.
create index if not exists availability_blocks_created_by_idx on public.availability_blocks (created_by);
create index if not exists booking_events_actor_user_idx on public.booking_events (actor_user_id);
create index if not exists booking_quotes_vehicle_idx on public.booking_quotes (vehicle_id);
create index if not exists bookings_payout_id_idx on public.bookings (payout_id);
create index if not exists bookings_pickup_location_idx on public.bookings (pickup_location_id);
create index if not exists bookings_quote_idx on public.bookings (quote_id);
create index if not exists condition_reports_recorded_by_idx on public.condition_reports (recorded_by);
create index if not exists evidence_photos_condition_report_idx on public.evidence_photos (condition_report_id);
create index if not exists evidence_photos_uploaded_by_idx on public.evidence_photos (uploaded_by);
create index if not exists favorites_vehicle_idx on public.favorites (vehicle_id);
create index if not exists partners_city_idx on public.partners (city_id);
create index if not exists partners_country_idx on public.partners (country_code);
create index if not exists profiles_city_idx on public.profiles (city_id);
create index if not exists profiles_country_idx on public.profiles (country_code);
create index if not exists support_requests_booking_idx on public.support_requests (booking_id);
create index if not exists vehicles_city_idx on public.vehicles (city_id);
create index if not exists vehicles_pickup_location_idx on public.vehicles (pickup_location_id);
