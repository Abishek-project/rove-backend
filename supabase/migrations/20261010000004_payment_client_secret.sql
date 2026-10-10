-- CONTRACTS v1.3: customer Booking.payment exposes the open intent so payment can be resumed.
-- The provider's client secret is stored with the rental intent (returned only to the booking's customer).
alter table public.payments add column if not exists client_secret text;
