# Rove — Shared Architecture & API Contracts (v1)

**This file is the single source of truth for all three repositories.**
Owner: the coordinator session. The backend agent may extend it (new optional fields, new endpoints) but must append an entry to `CHANGELOG` at the bottom. Frontend agents never edit it — they request changes in `shared/status/contract-requests.md`.

Requirements sources (also binding): `shared/requirements/rove-customer-app-master-prompt.md`, `shared/requirements/rove-partner-dashboard-master-prompt.md`. Where this file is more specific, this file wins.

---

## 1. System overview

```
 Flutter customer app ─┐                     ┌─ Supabase Auth (Google OAuth; email+password in local dev only)
                       ├─ HTTPS /api/v1 ──▶ NestJS backend ──┬─ PostgreSQL (Supabase)  — all app data + file metadata
 React partner portal ─┘   Bearer <supabase access token>     ├─ Supabase Storage       — images & documents
                                                              └─ PaymentProvider (mock now; Stripe later)
 Clients use Supabase ONLY for auth (sign-in / session / token refresh), using the public anon key.
 All business data, uploads and file URLs go through the backend.
```

* Backend is the only component holding `SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL`.
* **Every table in `public` has RLS enabled with no policies** → the anon/authenticated keys can read nothing through PostgREST. The backend connects as `postgres` (bypasses RLS).
* Business logic — availability, pricing, booking state, cancellation fees, payment verification, authorization — lives only in the backend.

### Local development ports
| Service | URL |
|---|---|
| Supabase API (auth, storage) | `http://127.0.0.1:54321` |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| Supabase Studio | `http://127.0.0.1:54323` |
| Mailpit (local emails) | `http://127.0.0.1:54324` |
| Backend | `http://localhost:4000` (Swagger at `/api/docs`, OpenAPI JSON at `/api/docs-json`) |
| Partner dashboard | `http://localhost:5173` |
| Android emulator → host | use `10.0.2.2` instead of `127.0.0.1` |

The local Supabase project lives in `rove-backend/supabase/` and is started **only** by the backend (`npx supabase start`). Frontends never run their own Supabase.

---

## 2. Authentication

* Production: Google OAuth via Supabase Auth on both clients.
* Local dev/test: Supabase email+password sign-in, shown in the UI **only** when the client env flag `ENABLE_DEV_EMAIL_LOGIN=true` (Flutter: `--dart-define=ENABLE_DEV_EMAIL_LOGIN=true`; Vite: `VITE_ENABLE_DEV_EMAIL_LOGIN=true`). Never enabled in release builds.
* Redirect URLs: dashboard `http://localhost:5173/auth/callback`; mobile deep link `com.rove.customer://login-callback`.
* Clients send `Authorization: Bearer <access_token>` on every `/api/v1` call (except public endpoints). On 401 the client refreshes the session once via Supabase and retries; if that fails → sign out → login screen.
* Backend verifies the JWT (Supabase JWKS at `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` for asymmetric keys, falling back to HS256 with `SUPABASE_JWT_SECRET`), checks `aud = authenticated` and expiry, and uses `sub` as the user id. **It never trusts user ids, partner ids or roles sent by the client.**
* On first authenticated request, the backend upserts a `profiles` row for the user.

### Roles (resolved server-side on every request)
| Role | How determined |
|---|---|
| customer | any authenticated user |
| partner member | row in `partner_members` (role `owner` / `manager` / `staff`) |
| admin | `profiles.is_admin = true` (set only by seed/SQL) |

Partner endpoints resolve the caller's partner from `partner_members` — **there is no partnerId in partner URLs**. A user belongs to at most one partner in v1.

### Seeded local test accounts
Created by `rove-backend` `npm run seed` (uses the Supabase admin API). The shared password lives in `rove-backend/.env.example` as `SEED_USER_PASSWORD` — do not hardcode it elsewhere.

| Email | Purpose |
|---|---|
| `customer@rove.test` | customer with completed profile (country AE) |
| `customer.in@rove.test` | customer with completed profile (country IN) |
| `partner.ae@rove.test` | owner of approved partner "Desert Drive Rentals" (Dubai) |
| `partner.in@rove.test` | owner of approved partner "Mumbai Motors" (Mumbai) |
| `partner.pending@rove.test` | owner of partner in `pending_verification` |
| `newpartner@rove.test` | signed-in user with no partner profile (onboarding flow) |
| `admin@rove.test` | admin |

---

## 3. API conventions

* Base path `/api/v1`. JSON only (except multipart uploads and CSV export). **JSON keys are camelCase**; DB columns are snake_case.
* IDs: UUID v4 strings. Booking reference: `RV-` + 6 uppercase alphanumerics (e.g. `RV-7K2Q9M`).
* Timestamps: ISO-8601 UTC strings (`2026-11-02T06:00:00.000Z`). Dates without time: `YYYY-MM-DD`. Every vehicle/city exposes an IANA `timezone` for display.
* **Money** is always an object: `{ "amountMinor": 125000, "currency": "AED" }` (integer minor units; AED and INR both have 2 decimals). Never floats. Never sum different currencies.
* Success envelope: `{ "data": <payload>, "meta"?: { "page": 1, "pageSize": 20, "total": 57, "totalPages": 3 } }`
* Error envelope (all non-2xx):
  ```json
  { "error": { "code": "VEHICLE_UNAVAILABLE", "message": "This vehicle is no longer available for the selected dates.", "details": { }, "requestId": "req_…" } }
  ```
  `details` for validation: `{ "fields": { "pickupAt": ["must be in the future"] } }`. Messages are user-safe; no stack traces.
  (v1.3) Malformed request bodies/params → `400 VALIDATION_FAILED`; well-formed requests that break a business rule (profile incomplete, missing documents, date rules, odometer) → `422 VALIDATION_FAILED`. Nested field keys use dots (`driver.dateOfBirth`). Malformed UUIDs in paths → `404 NOT_FOUND`.
* Pagination: `?page=1&pageSize=20` (max 100). When a paginated payload is an object (e.g. `/partner/earnings`), `meta` paginates its list field (`transactions`); summaries always cover the whole filtered range.
* Date-range query params: `from`/`to` on `/partner/vehicles/:id/availability` are ISO-8601 instants (a bare `YYYY-MM-DD` is accepted and treated as 00:00 UTC); on `/partner/overview`, `/partner/earnings`, `/partner/earnings/export.csv` and `/partner/payouts` they are `YYYY-MM-DD` dates, inclusive, interpreted in the partner country's timezone. Defaults: overview/earnings = last 30 days.
* Every response carries `x-request-id`; clients may send one.
* **Idempotency**: `POST /bookings`, `POST /bookings/:id/payment/confirm`, partner `accept`/`reject`/`pickup`/`return`, and `cancel` accept an `Idempotency-Key` header (UUID). Same key + same user → same result replayed; same key with different body → `409 IDEMPOTENCY_CONFLICT`. Clients generate one key per user action and reuse it on retry.
* Rate limit: 120 req/min per user (stricter on writes) → `429 RATE_LIMITED` with `Retry-After`.
* Clients may retry only GETs automatically (max 2, backoff). Never auto-retry POSTs without the same idempotency key.

### Error codes
| HTTP | code |
|---|---|
| 400/422 | `VALIDATION_FAILED` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN`, `PARTNER_NOT_APPROVED`, `PARTNER_REQUIRED` |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT`, `VEHICLE_UNAVAILABLE`, `QUOTE_EXPIRED`, `HOLD_EXPIRED`, `INVALID_STATE_TRANSITION`, `AVAILABILITY_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `PARTNER_ALREADY_EXISTS` |
| 402 | `PAYMENT_FAILED` |
| 413 / 415 | `FILE_TOO_LARGE` / `UNSUPPORTED_FILE_TYPE` |
| 429 | `RATE_LIMITED` |
| 500 / 503 | `INTERNAL_ERROR` / `SERVICE_UNAVAILABLE` |

---

## 4. Country configuration (seeded, never hardcoded in clients)

| | India `IN` | UAE `AE` |
|---|---|---|
| currency | INR | AED |
| default timezone | Asia/Kolkata | Asia/Dubai |
| tax | GST, `taxRateBps` 1800 (configurable) | VAT, `taxRateBps` 500 |
| platform (service) fee charged to customer | 500 bps | 500 bps |
| commission taken from partner | 1500 bps | 1500 bps |
| seeded cities | Mumbai, Bengaluru, New Delhi, Goa | Dubai, Abu Dhabi, Sharjah, Ras Al Khaimah |
| customer documents | `driving_licence` | `driving_licence`, `passport_or_emirates_id` |
| partner documents | `business_registration`, `gst_certificate`, `owner_id` | `trade_licence`, `vat_certificate`, `owner_id` |
| vehicle documents | `registration_certificate`, `insurance` | `mulkiya`, `insurance` |
| payment methods (display) | card, upi (mock) | card, apple_pay (mock) |

`bps` = basis points (500 = 5%). All rates come from `GET /countries`; clients only display them.

---

## 5. Database schema (PostgreSQL, owned by rove-backend `supabase/migrations`)

All tables: `id uuid pk default gen_random_uuid()` (unless noted), `created_at timestamptz default now()`, `updated_at timestamptz default now()` (trigger). RLS enabled on every table, no policies.

* **countries**(`code` pk char(2), name, currency_code char(3), default_timezone, tax_label, tax_rate_bps int, platform_fee_bps int, commission_bps int, is_active bool)
* **cities**(id, country_code fk, name, slug unique, timezone, is_active)
* **profiles**(`user_id` pk fk auth.users on delete cascade, email, full_name, phone, country_code fk null, city_id fk null, preferred_language default 'en', notification_prefs jsonb default `{"email":true,"push":true,"marketing":false}`, is_admin bool default false, verification_status text default 'not_started' [not_started|submitted|verified|rejected], deletion_requested_at timestamptz null)
* **document_requirements**(id, country_code, scope [customer|partner|vehicle], document_type, label, is_required bool) unique(country_code, scope, document_type)
* **customer_documents**(id, user_id, document_type, storage_path, file_name, content_type, size_bytes, status [submitted|approved|rejected|expired], rejection_reason, expires_on date null)
* **partners**(id, legal_name, display_name, contact_name, email, phone, country_code, city_id, address, registration_number, status [draft|pending_verification|approved|rejected|suspended], rejection_reason, booking_mode [instant|request] default 'request', logo_path null, verified_at)
* **partner_members**(partner_id, user_id unique, role [owner|manager|staff]) pk(partner_id,user_id)
* **partner_documents**(id, partner_id, document_type, storage_path, file_name, content_type, size_bytes, status [submitted|approved|rejected|expired], rejection_reason, expires_on, reviewed_at)
* **pickup_locations**(id, partner_id, city_id, name, address, latitude numeric null, longitude numeric null)
* **vehicles**(id, partner_id, city_id, pickup_location_id null, make, model, year int, category [economy|suv|sedan|luxury|electric], transmission [automatic|manual], fuel_type [petrol|diesel|hybrid|electric], seats int, doors int, luggage int, color, registration_number, description, features text[], status [draft|pending_review|published|rejected|suspended|unavailable], rejection_reason, currency char(3), daily_rate_minor int, weekly_discount_bps int default 0, mileage_limit_km_per_day int null (null = unlimited), excess_mileage_fee_minor int default 0, fuel_policy [full_to_full|same_to_same], deposit_minor int, cancellation_policy [flexible|moderate|strict], delivery_available bool, delivery_fee_minor int default 0, min_rental_days int default 1, buffer_hours int default 2, insurance_info text, booking_mode [instant|request] null (v1.3: per-vehicle override; null = partner default), is_featured bool default false, published_at)
* **vehicle_images**(id, vehicle_id fk cascade, bucket, storage_path unique, sort_order int, is_cover bool, content_type, size_bytes, width int null, height int null) — partial unique index: one cover per vehicle
* **vehicle_documents**(id, vehicle_id, document_type, storage_path, file_name, content_type, size_bytes, status, rejection_reason, expires_on)
* **availability_blocks**(id, vehicle_id, starts_at, ends_at, reason [maintenance|unavailable|other], note, created_by uuid) check(ends_at > starts_at)
* **booking_quotes**(id, customer_id, vehicle_id, pickup_at, return_at, delivery bool, delivery_address, currency, days int, line_items jsonb, total_minor, deposit_minor, expires_at) — 15 min validity
* **bookings**(id, reference unique, customer_id, vehicle_id, partner_id, pickup_location_id, pickup_at, return_at, delivery bool, delivery_address, status, payment_status, deposit_status, booking_mode, currency, days, rental_fee_minor, delivery_fee_minor, discount_minor, platform_fee_minor, tax_minor, total_minor, deposit_minor, commission_minor, partner_payout_minor, driver_full_name, driver_phone, driver_date_of_birth date, terms_accepted_at, hold_expires_at, partner_response_due_at, cancelled_by [customer|partner|admin|system], cancellation_reason, rejection_reason, cancellation_fee_minor default 0, refund_minor default 0, actual_pickup_at, actual_return_at, quote_id)
  * generated column `blocking_period tstzrange` = `tstzrange(pickup_at, return_at + (buffer_hours * interval '1 hour'), '[)')` (buffer copied onto the booking as `buffer_hours int`)
  * **`EXCLUDE USING gist (vehicle_id WITH =, blocking_period WITH &&) WHERE (status IN ('held','pending_partner','confirmed','active'))`** — requires `btree_gist`. This is the final guarantee against double booking.
* **booking_events**(id, booking_id, event_type, from_status, to_status, actor_user_id null, actor_role [customer|partner|admin|system], data jsonb, created_at) — append-only audit log
* **payments**(id, booking_id, provider, provider_reference, kind [rental|deposit_hold|refund|deposit_release], status [requires_confirmation|authorized|captured|failed|voided|refunded|succeeded], amount_minor, currency, failure_reason)
* **condition_reports**(id, booking_id, stage [pickup|return], odometer_km int, fuel_level_pct int, notes, damages jsonb `[{area, severity:[minor|moderate|major], description, isNew}]`, customer_checks jsonb `{licenceVerified, identityVerified}`, recorded_by, recorded_at)
* **evidence_photos**(id, booking_id, condition_report_id null, stage, storage_path, content_type, size_bytes, uploaded_by)
* **payouts**(id, partner_id, currency, amount_minor, status [pending|processing|paid|failed], period_start date, period_end date, provider_reference, paid_at, failure_reason)
* **favorites**(user_id, vehicle_id, created_at) pk(user_id, vehicle_id)
* **support_requests**(id, user_id, booking_id null, subject, message, status [open|in_progress|resolved])
* **idempotency_keys**(key, user_id, endpoint, request_hash, response_status, response_body jsonb, created_at) pk(user_id, key)

### Storage buckets
| Bucket | Public? | Contents | Path pattern |
|---|---|---|---|
| `car-images` | public read | vehicle photos | `vehicles/{vehicleId}/{uuid}.{ext}` |
| `partner-assets` | public read | partner logos | `partners/{partnerId}/{uuid}.{ext}` |
| `verification-documents` | private | partner, vehicle & customer documents | `partners/{partnerId}/…`, `vehicles/{vehicleId}/…`, `customers/{userId}/…` |
| `booking-evidence` | private | pickup/return photos | `bookings/{bookingId}/{stage}/{uuid}.{ext}` |

* All uploads are `multipart/form-data` **to the backend** (field `file`). The backend checks size, sniffs magic bytes (not just the extension/MIME), writes to Storage with the service role, then inserts metadata. If the DB insert fails it deletes the object; if object deletion fails it logs for cleanup.
* Images: jpeg/png/webp, ≤ 10 MB. Documents: pdf/jpeg/png, ≤ 15 MB.
* Public images are returned as public URLs. Private files are returned **only** as signed URLs with a 10-minute TTL, generated after an authorization check.

---

## 6. Booking lifecycle

### Statuses
`status`: `held` → `pending_partner` → `confirmed` → `active` → `completed`; terminal also `rejected`, `cancelled`, `expired`.
`paymentStatus`: `unpaid` → `authorized` → `captured` → `partially_refunded` | `refunded`; also `failed`, `voided`.
`depositStatus`: `not_held` → `held` → `released` | `partially_released`.

| From | Event | To | Actor | Side effects |
|---|---|---|---|---|
| — | create booking from valid quote | `held` (hold 15 min, paymentStatus `unpaid`) | customer | payment intent created |
| held | payment authorized, bookingMode=instant | `confirmed` | system | capture payment → `captured` |
| held | payment authorized, bookingMode=request | `pending_partner` (response due in 24 h, or 2 h before pickup if sooner) | system | paymentStatus `authorized` |
| held | payment failed | stays `held` (customer may retry until hold expires) | system | paymentStatus `failed` |
| held | hold expires | `expired` | system | void intent |
| pending_partner | partner accepts | `confirmed` | partner | capture payment |
| pending_partner | partner rejects (reason required) | `rejected` | partner | void authorization |
| pending_partner | response deadline passes | `expired` | system | void authorization |
| held / pending_partner / confirmed | customer cancels | `cancelled` | customer | fee per policy; refund remainder |
| pending_partner / confirmed | partner cancels | `cancelled` | partner | full refund |
| confirmed | partner records pickup (condition report) | `active` | partner | deposit hold → `held` |
| active | partner records return (condition report) | `completed` | partner | deposit `released` (v1: always full release; damage claims are out of scope and go to support) |

Every transition writes a `booking_events` row. Transitions are done in a DB transaction with `SELECT … FOR UPDATE` on the booking. Illegal transitions → `409 INVALID_STATE_TRANSITION`. Expiry runs every minute via `@nestjs/schedule` **and** lazily before any availability check.

### Cancellation policy (backend computes; clients display)
| Policy | Free cancellation if cancelled ≥ | Otherwise fee |
|---|---|---|
| flexible | 24 h before pickup | 1 day's rental (`dailyRateMinor`), capped at rental fee |
| moderate | 72 h before pickup | 50% of rental fee |
| strict | 7 days before pickup | 50% of rental fee if ≥ 48 h, else 100% of rental fee |

Cancelling in `held` or `pending_partner` → always free (void). Partner cancellation/rejection → always free for the customer. `refundMinor = totalMinor − cancellationFeeMinor`. The deposit is never charged before pickup.

### `allowedActions`
Every booking response includes `allowedActions: string[]`, computed by the backend for **the caller**:
customer: `pay`, `cancel`, `contact_support`; partner: `accept`, `reject`, `record_pickup`, `record_return`, `cancel`. Clients show only these actions.

---

## 7. Pricing (backend only; integer math)

```
days            = max(ceil((returnAt − pickupAt) / 24h), vehicle.minRentalDays)
rentalFee       = dailyRate × days
discount        = days ≥ 7 ? round(rentalFee × weeklyDiscountBps / 10000) : 0
deliveryFee     = delivery ? vehicle.deliveryFeeMinor : 0
subtotal        = rentalFee − discount + deliveryFee
platformFee     = round(subtotal × country.platformFeeBps / 10000)
tax             = round((subtotal + platformFee) × country.taxRateBps / 10000)
total           = subtotal + platformFee + tax              ← charged to customer
deposit         = vehicle.depositMinor                      ← refundable, NOT in total
commission      = round(subtotal × country.commissionBps / 10000)
partnerPayout   = subtotal − commission
```
`round` = round-half-up on integers. Rental dates are validated: `pickupAt ≥ now + 2h`, `returnAt > pickupAt`, rental ≥ 24 h, ≤ 30 days, pickup ≤ 180 days ahead.

**Availability** for `[pickupAt, returnAt)`: the vehicle is `published`, its partner is `approved`, there is no blocking booking overlapping `[pickupAt, returnAt + buffer)` (and no booking whose buffered range overlaps the requested start), and no `availability_blocks` overlap. Search applies this in SQL; quote and booking creation re-check inside a transaction that locks the vehicle row (`FOR UPDATE`); the EXCLUDE constraint is the backstop (constraint violation → `409 VEHICLE_UNAVAILABLE`).

### Line-item shape (quote & booking)
```json
"lineItems": [
  { "code": "rental_fee",   "label": "Rental (3 days × AED 250.00)", "amount": {"amountMinor": 75000, "currency": "AED"} },
  { "code": "discount",     "label": "Weekly discount",               "amount": {"amountMinor": -5000, "currency": "AED"} },
  { "code": "delivery_fee", "label": "Delivery",                      "amount": {...} },
  { "code": "platform_fee", "label": "Service fee",                   "amount": {...} },
  { "code": "tax",          "label": "VAT (5%)",                      "amount": {...} }
],
"total":   {"amountMinor": 82688, "currency": "AED"},
"deposit": {"amountMinor": 100000, "currency": "AED"},
"conditionalCharges": [ { "code": "excess_mileage", "label": "Extra km beyond 250 km/day", "amount": {"amountMinor": 100, "currency": "AED"}, "unit": "per_km" } ]
```
Line items with zero amount are omitted (except `rental_fee`).

---

## 8. Payments

`PaymentProvider` interface in the backend: `createIntent`, `confirm`, `capture`, `void`, `refund`, `holdDeposit`, `releaseDeposit`, `verifyWebhook`. v1 implementation: `MockPaymentProvider` (`PAYMENT_PROVIDER=mock`).

Flow: `POST /bookings` returns `payment: { provider: "mock", intentId, clientSecret, amount, status: "requires_confirmation" }`. The client shows a mock checkout sheet and calls `POST /bookings/:id/payment/confirm { intentId, simulateOutcome?: "success" | "fail" }`. `simulateOutcome` is honoured **only** when `PAYMENT_PROVIDER=mock`; the default is success. The backend verifies the intent with the provider before moving the booking. The client shows the result only from the returned booking — never from the fact that it called confirm. A real provider will add `POST /api/v1/payments/webhooks/:provider` (signature-verified); the endpoint shape above stays the same.

---

## 9. Endpoints

`[pub]` = no auth required (token optional), `[auth]` = any signed-in user, `[partner]` = partner member, `[owner]` = partner owner/manager, `[admin]` = admin.

### 9.1 Public / reference
* `GET /health` [pub] → `{status:"ok", db:"ok"}` (outside `/api/v1` as well at `/api/v1/health`). (v1.3) `/health` is raw (for probes); `/api/v1/health` uses the standard envelope `{ data: {status, db} }`.
* `GET /countries` [pub] → `Country[]`
  `Country = { code, name, currency, timezone, taxLabel, taxRateBps, platformFeeBps, paymentMethods: string[], cities: City[] }`
  `City = { id, name, slug, countryCode, timezone }`
* `GET /locations?countryCode=AE&cityId=` [pub] → `PickupLocation[]` = `{ id, name, address, cityId, latitude, longitude }`

### 9.2 Vehicles (customer)
* `GET /vehicles` [pub] — query: `countryCode` (required), `cityId`, `pickupAt`, `returnAt` (both or neither), `category`, `transmission`, `minSeats`, `maxDailyRateMinor`, `deliveryAvailable`, `fuelType`, `featured`, `sort` = `relevance|price_asc|price_desc|category`, `page`, `pageSize`.
  If dates are given, only vehicles available for the full period are returned and each item has `estimatedTotal` and `days`. Without dates, `estimatedTotal` is null.
  → `VehicleSummary[]`:
  ```
  { id, make, model, year, category, transmission, fuelType, seats, luggage,
    coverImageUrl | null, dailyRate: Money, estimatedTotal: Money | null, days: int | null,
    city: {id, name}, deliveryAvailable, partner: { id, displayName, verified: bool },
    isFavorite: bool  // false when unauthenticated
  }
  ```
* `GET /vehicles/:vehicleId?pickupAt&returnAt` [pub] → `VehicleDetail` = VehicleSummary + `{ images: [{id, url, isCover, sortOrder}], doors, color, description, features[], timezone,
  pickupLocation: PickupLocation | null, deliveryFee: Money, mileagePolicy: { limitKmPerDay: int|null, excessFeePerKm: Money }, fuelPolicy, deposit: Money,
  cancellationPolicy: { code, summary }, insuranceInfo, minRentalDays, bookingMode, partner: { id, displayName, verified, cityName, logoUrl|null },
  availability: { checked: bool, available: bool|null } }`
  Only `published` vehicles of `approved` partners → otherwise 404.

### 9.3 Profile, verification, favorites, support
* `GET /me` [auth] →
  ```
  { user: {id, email}, profile: { fullName, phone, countryCode, cityId, preferredLanguage, notificationPrefs, verificationStatus, deletionRequestedAt },
    profileComplete: bool,  // fullName && phone && countryCode
    isAdmin: bool, partner: { id, displayName, status, role } | null }
  ```
* `PATCH /me` [auth] body: any of `{ fullName, phone, countryCode, cityId, preferredLanguage, notificationPrefs }` → same as GET /me
* `POST /me/deletion-request` [auth] → `{ deletionRequestedAt }`
* `GET /me/verification` [auth] → `{ status, requiredDocuments: [{ documentType, label, isRequired, status: "missing"|"submitted"|"approved"|"rejected"|"expired", rejectionReason }] }` (requirements by profile country)
* `POST /me/documents` [auth] multipart `file`, `documentType`, `expiresOn?` → `CustomerDocument { id, documentType, fileName, status, expiresOn, createdAt }`; profile `verificationStatus` becomes `submitted` once all required are present.
* `GET /favorites` [auth] → `VehicleSummary[]`; `POST /favorites { vehicleId }` → 201; `DELETE /favorites/:vehicleId` → 204
* `POST /support/requests` [auth] `{ subject, message, bookingId? }` → `SupportRequest`; `GET /support/requests` [auth]

### 9.4 Bookings (customer)
* `POST /bookings/quote` [auth] `{ vehicleId, pickupAt, returnAt, delivery: { enabled: bool, address?: string } }` →
  `Quote { id, vehicleId, pickupAt, returnAt, days, lineItems, total, deposit, conditionalCharges, cancellationPolicy:{code, summary}, bookingMode, expiresAt }`; `409 VEHICLE_UNAVAILABLE` if not available.
* `POST /bookings` [auth] (Idempotency-Key) `{ quoteId, driver: { fullName, phone, dateOfBirth }, termsAccepted: true }` →
  `{ booking: Booking, payment: PaymentIntent }`. Requires an unexpired quote owned by the caller, a complete profile, customer `verificationStatus` in (`submitted`,`verified`), and the driver aged ≥ 21. Errors: `QUOTE_EXPIRED`, `VEHICLE_UNAVAILABLE`, `VALIDATION_FAILED` (with `details.reason = "verification_required" | "profile_incomplete" | "driver_age"`).
* `POST /bookings/:id/payment/confirm` [auth] (Idempotency-Key) `{ intentId, simulateOutcome? }` → `Booking` (or `402 PAYMENT_FAILED` with the booking in `details.booking`)
* `GET /bookings?group=upcoming|pending|active|completed|cancelled&page=` [auth] → `BookingSummary[]`
  groups: upcoming = confirmed; pending = held + pending_partner; active = active; completed = completed; cancelled = cancelled + rejected + expired.
* `GET /bookings/:id` [auth, owner only] → `Booking`
* `GET /bookings/:id/cancellation-preview` [auth] → `{ eligible: bool, free: bool, fee: Money, refund: Money, reason?: string }`
* `POST /bookings/:id/cancel` [auth] (Idempotency-Key) `{ reason? }` → `Booking`

```
BookingSummary = { id, reference, status, paymentStatus, pickupAt, returnAt, total: Money,
                   vehicle: { id, make, model, year, coverImageUrl }, partner: { id, displayName }, city: { id, name }, timezone }
Booking = BookingSummary + { days, bookingMode, depositStatus, delivery: { enabled, address }, pickupLocation,
          lineItems, deposit: Money, conditionalCharges, cancellationPolicy, cancellationFee: Money, refund: Money,
          holdExpiresAt, partnerResponseDueAt, driver: { fullName, phone },
          pickupInstructions: string, returnInstructions: string, requiredDocuments: string[],
          pickupReport: ConditionReportSummary | null, returnReport: ConditionReportSummary | null,
          events: [{ type, toStatus, at, actorRole }], allowedActions: string[], createdAt,
          payment: PaymentIntent | null   // customer view only: the open intent while allowedActions contains "pay" (status held); null otherwise }
ConditionReportSummary = { recordedAt, odometerKm, fuelLevelPct, damages: [...], photoCount }
PaymentIntent = { provider, intentId, clientSecret, amount: Money, status }
```

### 9.5 Partner — profile & onboarding
* `GET /partner/profile` [partner] → `Partner { id, legalName, displayName, contactName, email, phone, countryCode, cityId, address, registrationNumber, status, rejectionReason, bookingMode, logoUrl, verifiedAt, role }` — 403 `PARTNER_REQUIRED` if none.
* `POST /partner/onboarding` [auth] `{ legalName, displayName, contactName, email, phone, countryCode, cityId, address, registrationNumber }` → `Partner` (status `draft`, caller = owner). `409 PARTNER_ALREADY_EXISTS` if the caller already belongs to one.
* `PATCH /partner/profile` [owner] same fields (+ `bookingMode`) → `Partner`. While `pending_verification`, legal fields are locked (`409`).
* `GET /partner/verification` [partner] → `{ status, rejectionReason, steps: [{ key: "profile"|"documents"|"review", label, complete }], requiredDocuments: [{ documentType, label, isRequired, status, rejectionReason, expiresOn }], canSubmit: bool }`
* `GET /partner/documents` [partner]; `POST /partner/documents` [owner] multipart `file`, `documentType`, `expiresOn?` → `PartnerDocument`; `GET /partner/documents/:id/url` [partner] → `{ url, expiresAt }`
* `POST /partner/verification/submit` [owner] → status `pending_verification` (all required docs present, else 422)
* `POST /partner/logo` [owner] multipart → `Partner`
* `GET /partner/locations`, `POST /partner/locations`, `PATCH /partner/locations/:id`, `DELETE …` [owner] — pickup locations

Partner endpoints other than profile/onboarding/verification/documents return `403 PARTNER_NOT_APPROVED` while the partner is not `approved` — **except** vehicle draft create/edit, which drafts are allowed for; submit-for-review requires approval.

### 9.6 Partner — overview, vehicles, availability
* `GET /partner/overview?from&to` [partner] →
  ```
  { counts: { totalVehicles, activeListings, awaitingApproval, upcomingBookings, pendingRequests, currentlyRented, documentsExpiringSoon, completedRentals },
    financials: [{ currency, grossRentalValue: Money, platformCommission: Money, netEarnings: Money, pendingPayouts: Money }],   // one entry per currency, never mixed
    period: { from, to }, recentBookings: PartnerBookingSummary[] (5), attention: [{ type, message, bookingId?, vehicleId? }] }
  ```
* `GET /partner/vehicles?status&category&cityId&q&page` [partner] → `PartnerVehicleSummary[]` = `{ id, make, model, year, category, coverImageUrl, registrationMasked ("•••• 4821"), city, dailyRate, status, availabilityStatus: "available"|"rented"|"blocked", documentStatus: "complete"|"missing"|"expiring"|"rejected", updatedAt }`
* `POST /partner/vehicles` [owner] full or partial vehicle body → `PartnerVehicle` (status `draft`)
  Body fields (camelCase of the vehicles columns): `cityId, pickupLocationId, make, model, year, category, transmission, fuelType, seats, doors, luggage, color, registrationNumber, description, features, dailyRateMinor, weeklyDiscountBps, mileageLimitKmPerDay, excessMileageFeeMinor, fuelPolicy, depositMinor, cancellationPolicy, deliveryAvailable, deliveryFeeMinor, minRentalDays, bufferHours, insuranceInfo`, plus (v1.3, optional) `bookingMode`: `instant`|`request`|`null` (= company default). `currency` is derived from the partner country — not accepted from the client.
* `GET /partner/vehicles/:id` [partner] → `PartnerVehicle` (all fields, `registrationNumber` unmasked, `images`, `documents`, `requiredDocuments: [{ documentType, label, isRequired, status: "missing"|"submitted"|"approved"|"rejected"|"expired", rejectionReason, expiresOn }]` (from `document_requirements` scope `vehicle` for the partner country + the vehicle's latest document per type; same shape as `/partner/verification`), `rejectionReason`, `status`, `allowedActions: ["edit","submit","unpublish","republish","delete"]`). POST/PATCH responses return the same shape.
* `PATCH /partner/vehicles/:id` [owner] partial → `PartnerVehicle`. For a `published` vehicle, changes to make/model/year/registrationNumber/category send it back to `pending_review`; pricing/policy changes apply immediately.
* `DELETE /partner/vehicles/:id` [owner] — only `draft`/`rejected`
* `POST /partner/vehicles/:id/submit` [owner] → `pending_review` (requires partner approved, ≥ 1 image, all required fields, required vehicle documents)
* `POST /partner/vehicles/:id/unpublish` → `unavailable`; `POST /partner/vehicles/:id/republish` → `published` (only from `unavailable`)
* Images: `POST /partner/vehicles/:id/images` multipart `file` → `VehicleImage {id, url, isCover, sortOrder}` (max 12 per vehicle; first image becomes cover); `PUT /partner/vehicles/:id/images/order { imageIds: [] }`; `POST /partner/vehicles/:id/images/:imageId/cover`; `DELETE /partner/vehicles/:id/images/:imageId`
* Documents: `GET/POST /partner/vehicles/:id/documents`, `GET /partner/vehicles/:id/documents/:docId/url`
* `GET /partner/vehicles/:id/availability?from&to` [partner] → `{ timezone, bufferHours, blocks: [{ id, startsAt, endsAt, reason, note }], bookings: [{ id, reference, status, pickupAt, returnAt }] }`
* `POST /partner/vehicles/:id/availability` [owner] `{ startsAt, endsAt, reason, note? }` → block; `409 AVAILABILITY_CONFLICT` with `details.conflicts` if it overlaps a blocking booking (incl. buffer) or another block
* `DELETE /partner/vehicles/:id/availability/:blockId` [owner]

### 9.7 Partner — bookings & operations
* `GET /partner/bookings?filter=pending|confirmed|upcoming_pickups|active|returns_due|completed|cancelled&q=&page=` →
  `PartnerBookingSummary = { id, reference, status, paymentStatus, vehicle: {id, make, model, registrationMasked}, customer: { displayName }, pickupAt, returnAt, total: Money, partnerPayout: Money, nextAction: string|null, timezone }`
  (`upcoming_pickups` = confirmed with pickup within 7 days; `returns_due` = active with return within 48 h or overdue)
* `GET /partner/bookings/:id` → `PartnerBooking` = Booking fields + `customer: { displayName, phone (only when confirmed/active), verificationStatus }`, `commission`, `partnerPayout`, `events` (full history), `pickupReport`, `returnReport`, `allowedActions`. Customer email, date of birth and documents are never exposed to partners.
* `POST /partner/bookings/:id/accept` (Idempotency-Key) → `PartnerBooking`
* `POST /partner/bookings/:id/reject` (Idempotency-Key) `{ reason }` (required, 5–500 chars) → `PartnerBooking`
* `POST /partner/bookings/:id/cancel` (Idempotency-Key) `{ reason }` → `PartnerBooking`
* `POST /partner/bookings/:id/pickup` (Idempotency-Key) `{ odometerKm, fuelLevelPct, notes?, damages: [], customerChecks: { licenceVerified: true, identityVerified: true } }` → `PartnerBooking` (both checks must be true; allowed from 6 h before pickupAt)
* `POST /partner/bookings/:id/return` (Idempotency-Key) `{ odometerKm, fuelLevelPct, notes?, damages: [] }` → `PartnerBooking` (odometer ≥ pickup odometer)
* `POST /partner/bookings/:id/evidence` multipart `file`, `stage` → `{ id, stage, url (signed), createdAt }`; `GET /partner/bookings/:id/evidence` → list with signed URLs

### 9.8 Partner — financials
* `GET /partner/earnings?from&to&currency&page` → `{ summaries: [{ currency, gross, commission, adjustments, refunds, net }], transactions: [{ bookingId, reference, completedAt, currency, gross, commission, net, status }] }` (all Money, per currency)
  (v1.3) transaction `status` = payout state: `unpaid` (not yet in a payout) | `pending` | `processing` | `paid` | `failed`; additive `type`: `rental` | `cancellation_fee` (a retained customer cancellation fee, net of commission, counted in `adjustments`), and `payoutId`. `period: {from, to}` echoes the resolved range.
* `GET /partner/earnings/export.csv?from&to&currency` → `text/csv`
* `GET /partner/payouts?status&currency&page` → `[{ id, currency, amount: Money, status, periodStart, periodEnd, reference, paidAt, failureReason }]`

### 9.9 Admin (API only in v1; no admin UI)
* `GET /admin/partners?status=` · `POST /admin/partners/:id/approve` · `POST /admin/partners/:id/reject { reason }` · `POST /admin/partners/:id/suspend { reason }`
* `GET /admin/vehicles?status=pending_review` · `POST /admin/vehicles/:id/approve` (→ published) · `POST /admin/vehicles/:id/reject { reason }`
* `POST /admin/documents/:kind(partner|vehicle|customer)/:id/approve|reject { reason }`
* `POST /admin/payouts/generate { periodStart, periodEnd }` — creates pending payouts per partner per currency from completed bookings; `POST /admin/payouts/:id/mark-paid { reference }`
* Backend also ships `npm run admin -- <command>` CLI wrappers for local testing.

---

## 10. Shared engineering standards

* **Naming**: repos kebab-case; DB snake_case; JSON camelCase; Dart files snake_case; React components PascalCase; enums as lowercase snake_case string values identical across all three projects (e.g. `pending_partner`, `full_to_full`).
* **Money in clients**: Dart — `Money(int amountMinor, String currency)` + `intl` NumberFormat (`AED 1,250.00`, `₹1,250.00` with en_IN grouping `₹1,25,000.00`). TS — `{amountMinor:number,currency}` formatted with `Intl.NumberFormat(locale,{style:'currency',currency})` from `amountMinor/100` **only at the display edge**; never add Money values with different currencies.
* **Time in clients**: display in the vehicle/city `timezone` (Flutter: `timezone` package; web: `Intl.DateTimeFormat` with `timeZone`). Send UTC ISO strings.
* **Security**: no service-role key, DB URL or payment secrets in client repos (`.env.example` lists only public values). Never log tokens, documents or personal data. All secrets via env vars; `.env` git-ignored.
* **Errors in clients**: map the error envelope to typed failures (`ApiFailure{code,message,fields,requestId}`); show the server message for 4xx, a generic message for 5xx/network; always render loading / empty / error / success states.
* **Truthfulness**: clients never show "confirmed", "paid", "refunded", "payout completed" or "verified" unless the backend response says so.
* **Git**: Conventional Commits (`feat(bookings): …`), small commits, `main` branch. Each repo has README (setup, env, scripts, architecture), `.env.example`, and passes lint + tests before each commit.
* **Testing**: backend — Jest unit tests (pricing, state machine, cancellation policy, availability) + e2e tests against the local Supabase DB; dashboard — Vitest + Testing Library + MSW; Flutter — `flutter_test` + `bloc_test` + `mocktail`. No test needs production credentials.

---

## CHANGELOG
* v1.0 (2026-10-10) — initial contract (coordinator).
* v1.1 (2026-10-10) — backend local port changed 3000 → **4000** (3000 is used by another app on this machine). `PORT=4000` in rove-backend `.env.example`. (coordinator)
* v1.2 (2026-10-10) — accepted dashboard requests: `PartnerVehicle.requiredDocuments`; `from`/`to` formats; pagination of object payloads. (coordinator)
* v1.3 (2026-10-10) — additive, backend: `vehicles.booking_mode` per-vehicle override + `bookingMode` in the partner vehicle body (`PartnerVehicle.effectiveBookingMode` resolves it); earnings transaction `status` values, `type` and `payoutId`; `/api/v1/health` enveloped; 400 vs 422 for `VALIDATION_FAILED`; `PayoutsQuery` accepts `from`/`to` (payouts whose period overlaps the range). Additive response fields: Booking `cancelledBy`, `cancellationReason`, `rejectionReason`, `actualPickupAt`, `actualReturnAt`; PartnerBooking `nextAction`, `driver.phone` null unless confirmed/active, condition reports include `notes`/`customerChecks` for partners; PartnerVehicle `registrationMasked`, `dailyRate`, `city`, `pickupLocation`, `timezone`; Quote `delivery`; cancellation preview `policy`; `POST /favorites` → `201 { vehicleId, isFavorite: true }`. Partners never see unpaid `held` bookings in lists/detail (they appear only as blocked periods in availability). DB-only additions: `countries.payment_methods`, `bookings.{daily_rate_minor, line_items, conditional_charges, cancellation_policy, cancelled_at, payout_id}`, `booking_quotes.pricing`, `*_documents.reviewed_at`, `partners/vehicles.submitted_at`. (backend)
* v1.3 (2026-10-10) — customer `Booking.payment` (open PaymentIntent while `pay` is allowed) so payment can be resumed from My Bookings. (coordinator, from customer-app request)
