-- Rove v1 schema (see shared/CONTRACTS.md §5).
-- All business data lives in `public`. RLS is enabled on every table with NO policies:
-- the anon/authenticated roles can read nothing through PostgREST. The backend connects
-- as `postgres` (bypasses RLS) and enforces authorization itself.

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Adding a whole number of hours to a timestamptz does not depend on the session time zone,
-- so this is safe to mark immutable (required for the generated `blocking_period` column).
create or replace function public.booking_blocking_range(p_pickup timestamptz, p_return timestamptz, p_buffer_hours int)
returns tstzrange
language sql
immutable
parallel safe
set search_path = ''
as $$
  select tstzrange(p_pickup, p_return + make_interval(hours => p_buffer_hours), '[)');
$$;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------
create table public.countries (
  code              char(2) primary key,
  name              text not null,
  currency_code     char(3) not null,
  default_timezone  text not null,
  tax_label         text not null,
  tax_rate_bps      int not null check (tax_rate_bps between 0 and 10000),
  platform_fee_bps  int not null check (platform_fee_bps between 0 and 10000),
  commission_bps    int not null check (commission_bps between 0 and 10000),
  payment_methods   text[] not null default '{}',
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table public.cities (
  id            uuid primary key default gen_random_uuid(),
  country_code  char(2) not null references public.countries(code),
  name          text not null,
  slug          text not null unique,
  timezone      text not null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index cities_country_idx on public.cities (country_code);

create table public.document_requirements (
  id             uuid primary key default gen_random_uuid(),
  country_code   char(2) not null references public.countries(code),
  scope          text not null check (scope in ('customer', 'partner', 'vehicle')),
  document_type  text not null,
  label          text not null,
  is_required    boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (country_code, scope, document_type)
);

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  email                  text,
  full_name              text,
  phone                  text,
  country_code           char(2) references public.countries(code),
  city_id                uuid references public.cities(id),
  preferred_language     text not null default 'en',
  notification_prefs     jsonb not null default '{"email":true,"push":true,"marketing":false}'::jsonb,
  is_admin               boolean not null default false,
  verification_status    text not null default 'not_started'
                           check (verification_status in ('not_started', 'submitted', 'verified', 'rejected')),
  deletion_requested_at  timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create table public.customer_documents (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(user_id) on delete cascade,
  document_type     text not null,
  storage_path      text not null unique,
  file_name         text not null,
  content_type      text not null,
  size_bytes        int not null,
  status            text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected', 'expired')),
  rejection_reason  text,
  expires_on        date,
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index customer_documents_user_idx on public.customer_documents (user_id, document_type);

-- ---------------------------------------------------------------------------
-- Partners
-- ---------------------------------------------------------------------------
create table public.partners (
  id                   uuid primary key default gen_random_uuid(),
  legal_name           text not null,
  display_name         text not null,
  contact_name         text,
  email                text,
  phone                text,
  country_code         char(2) not null references public.countries(code),
  city_id              uuid references public.cities(id),
  address              text,
  registration_number  text,
  status               text not null default 'draft'
                         check (status in ('draft', 'pending_verification', 'approved', 'rejected', 'suspended')),
  rejection_reason     text,
  booking_mode         text not null default 'request' check (booking_mode in ('instant', 'request')),
  logo_path            text,
  verified_at          timestamptz,
  submitted_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index partners_status_idx on public.partners (status);

create table public.partner_members (
  partner_id  uuid not null references public.partners(id) on delete cascade,
  user_id     uuid not null unique references public.profiles(user_id) on delete cascade,
  role        text not null check (role in ('owner', 'manager', 'staff')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (partner_id, user_id)
);

create table public.partner_documents (
  id                uuid primary key default gen_random_uuid(),
  partner_id        uuid not null references public.partners(id) on delete cascade,
  document_type     text not null,
  storage_path      text not null unique,
  file_name         text not null,
  content_type      text not null,
  size_bytes        int not null,
  status            text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected', 'expired')),
  rejection_reason  text,
  expires_on        date,
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index partner_documents_partner_idx on public.partner_documents (partner_id, document_type);

create table public.pickup_locations (
  id          uuid primary key default gen_random_uuid(),
  partner_id  uuid not null references public.partners(id) on delete cascade,
  city_id     uuid not null references public.cities(id),
  name        text not null,
  address     text not null,
  latitude    numeric(9, 6),
  longitude   numeric(9, 6),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index pickup_locations_partner_idx on public.pickup_locations (partner_id);
create index pickup_locations_city_idx on public.pickup_locations (city_id);

-- ---------------------------------------------------------------------------
-- Vehicles
-- ---------------------------------------------------------------------------
create table public.vehicles (
  id                        uuid primary key default gen_random_uuid(),
  partner_id                uuid not null references public.partners(id) on delete cascade,
  city_id                   uuid references public.cities(id),
  pickup_location_id        uuid references public.pickup_locations(id) on delete set null,
  make                      text,
  model                     text,
  year                      int check (year between 1990 and 2100),
  category                  text check (category in ('economy', 'suv', 'sedan', 'luxury', 'electric')),
  transmission              text check (transmission in ('automatic', 'manual')),
  fuel_type                 text check (fuel_type in ('petrol', 'diesel', 'hybrid', 'electric')),
  seats                     int check (seats between 1 and 20),
  doors                     int check (doors between 1 and 10),
  luggage                   int check (luggage between 0 and 20),
  color                     text,
  registration_number       text,
  description               text,
  features                  text[] not null default '{}',
  status                    text not null default 'draft'
                              check (status in ('draft', 'pending_review', 'published', 'rejected', 'suspended', 'unavailable')),
  rejection_reason          text,
  currency                  char(3) not null,
  daily_rate_minor          int check (daily_rate_minor >= 0),
  weekly_discount_bps       int not null default 0 check (weekly_discount_bps between 0 and 10000),
  mileage_limit_km_per_day  int check (mileage_limit_km_per_day > 0),
  excess_mileage_fee_minor  int not null default 0 check (excess_mileage_fee_minor >= 0),
  fuel_policy               text check (fuel_policy in ('full_to_full', 'same_to_same')),
  deposit_minor             int check (deposit_minor >= 0),
  cancellation_policy       text check (cancellation_policy in ('flexible', 'moderate', 'strict')),
  delivery_available        boolean not null default false,
  delivery_fee_minor        int not null default 0 check (delivery_fee_minor >= 0),
  min_rental_days           int not null default 1 check (min_rental_days between 1 and 30),
  buffer_hours              int not null default 2 check (buffer_hours between 0 and 72),
  insurance_info            text,
  -- Additive (CONTRACTS CHANGELOG v1.1): per-vehicle override of partners.booking_mode; null = inherit.
  booking_mode              text check (booking_mode in ('instant', 'request')),
  is_featured               boolean not null default false,
  published_at              timestamptz,
  submitted_at              timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create index vehicles_partner_idx on public.vehicles (partner_id, status);
create index vehicles_search_idx on public.vehicles (status, city_id, category);
create index vehicles_rate_idx on public.vehicles (daily_rate_minor) where status = 'published';
create index vehicles_featured_idx on public.vehicles (is_featured, published_at desc) where status = 'published';

create table public.vehicle_images (
  id            uuid primary key default gen_random_uuid(),
  vehicle_id    uuid not null references public.vehicles(id) on delete cascade,
  bucket        text not null default 'car-images',
  storage_path  text not null unique,
  sort_order    int not null default 0,
  is_cover      boolean not null default false,
  content_type  text not null,
  size_bytes    int not null,
  width         int,
  height        int,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index vehicle_images_vehicle_idx on public.vehicle_images (vehicle_id, sort_order);
create unique index vehicle_images_one_cover_idx on public.vehicle_images (vehicle_id) where is_cover;

create table public.vehicle_documents (
  id                uuid primary key default gen_random_uuid(),
  vehicle_id        uuid not null references public.vehicles(id) on delete cascade,
  document_type     text not null,
  storage_path      text not null unique,
  file_name         text not null,
  content_type      text not null,
  size_bytes        int not null,
  status            text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected', 'expired')),
  rejection_reason  text,
  expires_on        date,
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index vehicle_documents_vehicle_idx on public.vehicle_documents (vehicle_id, document_type);

create table public.availability_blocks (
  id          uuid primary key default gen_random_uuid(),
  vehicle_id  uuid not null references public.vehicles(id) on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  reason      text not null check (reason in ('maintenance', 'unavailable', 'other')),
  note        text,
  created_by  uuid references public.profiles(user_id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index availability_blocks_range_idx on public.availability_blocks
  using gist (vehicle_id, tstzrange(starts_at, ends_at, '[)'));

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------
create table public.booking_quotes (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references public.profiles(user_id) on delete cascade,
  vehicle_id        uuid not null references public.vehicles(id) on delete cascade,
  pickup_at         timestamptz not null,
  return_at         timestamptz not null,
  delivery          boolean not null default false,
  delivery_address  text,
  currency          char(3) not null,
  days              int not null,
  line_items        jsonb not null,
  pricing           jsonb not null,
  total_minor       int not null,
  deposit_minor     int not null,
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (return_at > pickup_at)
);
create index booking_quotes_customer_idx on public.booking_quotes (customer_id, created_at desc);

create table public.payouts (
  id                  uuid primary key default gen_random_uuid(),
  partner_id          uuid not null references public.partners(id) on delete cascade,
  currency            char(3) not null,
  amount_minor        int not null check (amount_minor >= 0),
  status              text not null default 'pending' check (status in ('pending', 'processing', 'paid', 'failed')),
  period_start        date not null,
  period_end          date not null,
  provider_reference  text,
  paid_at             timestamptz,
  failure_reason      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (period_end >= period_start)
);
create index payouts_partner_idx on public.payouts (partner_id, status, currency);

create table public.bookings (
  id                       uuid primary key default gen_random_uuid(),
  reference                text not null unique check (reference ~ '^RV-[A-Z0-9]{6}$'),
  customer_id              uuid not null references public.profiles(user_id),
  vehicle_id               uuid not null references public.vehicles(id),
  partner_id               uuid not null references public.partners(id),
  pickup_location_id       uuid references public.pickup_locations(id) on delete set null,
  pickup_at                timestamptz not null,
  return_at                timestamptz not null,
  buffer_hours             int not null default 2 check (buffer_hours >= 0),
  blocking_period          tstzrange generated always as (public.booking_blocking_range(pickup_at, return_at, buffer_hours)) stored,
  delivery                 boolean not null default false,
  delivery_address         text,
  status                   text not null
                             check (status in ('held', 'pending_partner', 'confirmed', 'active', 'completed', 'rejected', 'cancelled', 'expired')),
  payment_status           text not null default 'unpaid'
                             check (payment_status in ('unpaid', 'authorized', 'captured', 'partially_refunded', 'refunded', 'failed', 'voided')),
  deposit_status           text not null default 'not_held'
                             check (deposit_status in ('not_held', 'held', 'released', 'partially_released')),
  booking_mode             text not null check (booking_mode in ('instant', 'request')),
  currency                 char(3) not null,
  days                     int not null check (days >= 1),
  daily_rate_minor         int not null default 0,
  rental_fee_minor         int not null,
  delivery_fee_minor       int not null default 0,
  discount_minor           int not null default 0,
  platform_fee_minor       int not null default 0,
  tax_minor                int not null default 0,
  total_minor              int not null,
  deposit_minor            int not null default 0,
  commission_minor         int not null default 0,
  partner_payout_minor     int not null default 0,
  line_items               jsonb not null default '[]'::jsonb,
  conditional_charges      jsonb not null default '[]'::jsonb,
  cancellation_policy      text not null check (cancellation_policy in ('flexible', 'moderate', 'strict')),
  driver_full_name         text not null,
  driver_phone             text not null,
  driver_date_of_birth     date not null,
  terms_accepted_at        timestamptz not null,
  hold_expires_at          timestamptz,
  partner_response_due_at  timestamptz,
  cancelled_by             text check (cancelled_by in ('customer', 'partner', 'admin', 'system')),
  cancellation_reason      text,
  rejection_reason         text,
  cancellation_fee_minor   int not null default 0,
  refund_minor             int not null default 0,
  cancelled_at             timestamptz,
  actual_pickup_at         timestamptz,
  actual_return_at         timestamptz,
  quote_id                 uuid references public.booking_quotes(id) on delete set null,
  payout_id                uuid references public.payouts(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  check (return_at > pickup_at),
  -- Final guarantee against double booking (buffer included).
  constraint bookings_no_overlap exclude using gist (vehicle_id with =, blocking_period with &&)
    where (status in ('held', 'pending_partner', 'confirmed', 'active'))
);
create index bookings_customer_idx on public.bookings (customer_id, status, pickup_at desc);
create index bookings_partner_idx on public.bookings (partner_id, status, pickup_at);
create index bookings_vehicle_idx on public.bookings (vehicle_id, status);
create index bookings_hold_expiry_idx on public.bookings (hold_expires_at) where status = 'held';
create index bookings_response_due_idx on public.bookings (partner_response_due_at) where status = 'pending_partner';
create index bookings_payout_idx on public.bookings (partner_id, currency) where payout_id is null;

create table public.booking_events (
  id             uuid primary key default gen_random_uuid(),
  booking_id     uuid not null references public.bookings(id) on delete cascade,
  event_type     text not null,
  from_status    text,
  to_status      text,
  actor_user_id  uuid references public.profiles(user_id) on delete set null,
  actor_role     text not null check (actor_role in ('customer', 'partner', 'admin', 'system')),
  data           jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index booking_events_booking_idx on public.booking_events (booking_id, created_at);

-- Append-only audit log.
create or replace function public.booking_events_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'booking_events is append-only';
end;
$$;
create trigger booking_events_no_update before update on public.booking_events
  for each row execute function public.booking_events_immutable();

create table public.payments (
  id                  uuid primary key default gen_random_uuid(),
  booking_id          uuid not null references public.bookings(id) on delete cascade,
  provider            text not null,
  provider_reference  text not null,
  kind                text not null check (kind in ('rental', 'deposit_hold', 'refund', 'deposit_release')),
  status              text not null
                        check (status in ('requires_confirmation', 'authorized', 'captured', 'failed', 'voided', 'refunded', 'succeeded')),
  amount_minor        int not null check (amount_minor >= 0),
  currency            char(3) not null,
  failure_reason      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index payments_booking_idx on public.payments (booking_id, kind);
create unique index payments_provider_ref_idx on public.payments (provider, provider_reference, kind);

create table public.condition_reports (
  id               uuid primary key default gen_random_uuid(),
  booking_id       uuid not null references public.bookings(id) on delete cascade,
  stage            text not null check (stage in ('pickup', 'return')),
  odometer_km      int not null check (odometer_km >= 0),
  fuel_level_pct   int not null check (fuel_level_pct between 0 and 100),
  notes            text,
  damages          jsonb not null default '[]'::jsonb,
  customer_checks  jsonb,
  recorded_by      uuid references public.profiles(user_id) on delete set null,
  recorded_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (booking_id, stage)
);

create table public.evidence_photos (
  id                   uuid primary key default gen_random_uuid(),
  booking_id           uuid not null references public.bookings(id) on delete cascade,
  condition_report_id  uuid references public.condition_reports(id) on delete set null,
  stage                text not null check (stage in ('pickup', 'return')),
  storage_path         text not null unique,
  content_type         text not null,
  size_bytes           int not null,
  uploaded_by          uuid references public.profiles(user_id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index evidence_photos_booking_idx on public.evidence_photos (booking_id, stage);

create table public.favorites (
  user_id     uuid not null references public.profiles(user_id) on delete cascade,
  vehicle_id  uuid not null references public.vehicles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, vehicle_id)
);

create table public.support_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(user_id) on delete cascade,
  booking_id  uuid references public.bookings(id) on delete set null,
  subject     text not null,
  message     text not null,
  status      text not null default 'open' check (status in ('open', 'in_progress', 'resolved')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index support_requests_user_idx on public.support_requests (user_id, created_at desc);

create table public.idempotency_keys (
  key              text not null,
  user_id          uuid not null references public.profiles(user_id) on delete cascade,
  endpoint         text not null,
  request_hash     text not null,
  response_status  int,
  response_body    jsonb,
  created_at       timestamptz not null default now(),
  primary key (user_id, key)
);
create index idempotency_keys_created_idx on public.idempotency_keys (created_at);

-- ---------------------------------------------------------------------------
-- updated_at triggers + RLS (enabled, no policies) on every table
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'countries', 'cities', 'document_requirements', 'profiles', 'customer_documents', 'partners',
    'partner_members', 'partner_documents', 'pickup_locations', 'vehicles', 'vehicle_images',
    'vehicle_documents', 'availability_blocks', 'booking_quotes', 'payouts', 'bookings', 'payments',
    'condition_reports', 'evidence_photos', 'support_requests'
  ] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
      t || '_set_updated_at', t
    );
  end loop;

  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end;
$$;

-- Defence in depth: the API roles get no table privileges in `public` at all.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
