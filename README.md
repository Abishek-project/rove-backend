# Rove backend

> Part of **Rove**: [backend (NestJS)](https://github.com/Abishek-project/rove-backend) · [partner dashboard (React)](https://github.com/Abishek-project/rove-partner-dashboard) · [customer app (Flutter)](https://github.com/Abishek-project/rove-customer-app) · [project overview](docs/OVERVIEW.md)

The API for **Rove**, a car rental marketplace for India (INR) and the UAE (AED). It serves the Flutter customer app and the React partner dashboard.

- **NestJS 11** + TypeScript (strict), REST under `/api/v1`
- **Supabase**: Auth (sign-in only), Postgres (all data), Storage (images and documents)
- **Kysely** typed SQL over `pg`; migrations are plain SQL in `supabase/migrations`
- Mock payments behind a `PaymentProvider` interface, so Stripe can be added later

The binding API contract is [`docs/CONTRACTS.md`](docs/CONTRACTS.md). Interactive docs run at **http://localhost:4000/api/docs**, and the OpenAPI JSON at `/api/docs-json`.

---

## Architecture

```
Flutter app ─┐                          ┌─ Supabase Auth  (JWT issuer; JWKS)
             ├─ Bearer <access token> ─▶ NestJS ─┼─ Postgres  (RLS on, no policies → only the backend can read)
React portal ┘     /api/v1/*             │       ├─ Storage   (car-images / partner-assets public; documents & evidence private)
                                         │       └─ PaymentProvider (MockPaymentProvider)
```

Clients use Supabase **only** to sign in. All data, uploads and file URLs go through this API. The service-role key and `DATABASE_URL` never leave the server.

### Request pipeline
`RequestIdMiddleware` → `AuthGuard` (verify JWT, upsert profile, resolve customer / partner role / admin) → `UserThrottlerGuard` (120 req/min per user, 60 writes/min) → `ValidationPipe` → controller → `EnvelopeInterceptor` (`{ data, meta? }`). Every error is rendered by `AllExceptionsFilter` as `{ error: { code, message, details, requestId } }`.

### Key guarantees
| Concern | How |
|---|---|
| **Double booking** | The vehicle row is locked (`FOR UPDATE`) while availability is checked and the booking is inserted. The final backstop is a Postgres `EXCLUDE USING gist (vehicle_id WITH =, blocking_period WITH &&)` on active statuses, where `blocking_period` includes the vehicle's buffer hours. A constraint violation returns `409 VEHICLE_UNAVAILABLE`. |
| **State machine** | `src/domain/booking-state.ts`: a pure transition table. Every transition runs in a transaction with `SELECT … FOR UPDATE` and writes a `booking_events` audit row (the table is append-only by trigger). `allowedActions` is computed for the caller. |
| **Pricing** | `src/domain/pricing.ts`: integer minor units, round half up, exactly CONTRACTS §7. Quotes freeze the price for 15 minutes. |
| **Expiry** | Holds (15 min) and partner response deadlines expire through a per-minute cron, **and** lazily before every availability check or booking read. |
| **Idempotency** | `Idempotency-Key` (UUID) on booking create, payment confirm, cancel and partner accept/reject/pickup/return/cancel. The same key with the same request replays the stored result (`Idempotent-Replayed: true`). The same key with a different request returns `409 IDEMPOTENCY_CONFLICT`. |
| **Partner isolation** | Partner routes have no partner id in the URL. The partner is resolved from `partner_members` for the caller, and every query is scoped by it. Another partner's resource returns 404. |
| **Uploads** | Multipart to the backend. Size is checked, magic bytes are sniffed (`file-type`), the object is written with the service role, then metadata is inserted. A failed insert deletes the object. Private files are returned only as signed URLs with a 10-minute TTL, after an authorization check. |

### Layout
```
src/
  config/        env validation (class-validator) + typed AppConfig
  common/        auth (JWT verifier, guard, decorators), errors, envelope, idempotency, throttling, validation
  database/      Kysely provider; db.types.ts generated from the live schema (npm run db:types)
  domain/        pure logic: pricing, cancellation policy, booking state machine, dates/timezones (unit-tested)
  payments/      PaymentProvider interface + MockPaymentProvider
  storage/       Supabase Storage service, upload validation
  modules/       health, reference, catalog (search/detail/favorites), me (profile/verification/support),
                 bookings (quote/book/pay/cancel, partner ops, expiry), partner (profile/onboarding/vehicles/
                 availability), finance (overview/earnings/payouts), admin
  seed/          idempotent seed + locally generated SVG→JPEG car illustrations and sample PDFs
  cli/admin.ts   npm run admin -- <command>
supabase/        config.toml + migrations (schema, buckets, reference data)
test/            e2e suites (supertest against the local Supabase stack)
```

---

## Setup

Prerequisites: Node ≥ 20.19, npm, Docker Desktop (about 4 GB free for the Supabase containers).

```bash
npm install
cp .env.example .env          # safe local defaults (local Supabase demo keys only)
npx supabase start            # starts Postgres/Auth/Storage/Studio on 5432x ports
npm run db:reset              # applies supabase/migrations (schema, buckets, reference data)
npm run seed                  # test accounts, partners, vehicles, images, bookings, payouts
npm run start:dev             # http://localhost:4000  (Swagger: /api/docs)
```

`npm run db:fresh` runs reset and seed together. The seed is idempotent, so you can re-run it at any time. It refreshes the accounts, partners and vehicles and leaves existing bookings alone. For brand-new demo dates (upcoming, active and pending bookings), run `npm run db:fresh`.

Local services: API `http://127.0.0.1:54321`, Postgres `127.0.0.1:54322`, Studio `http://127.0.0.1:54323`, Mailpit `http://127.0.0.1:54324`.

### Seeded accounts
All accounts share the password `SEED_USER_PASSWORD` from `.env.example`. Clients sign in with Supabase email + password when their dev-login flag is on.

| Email | Role |
|---|---|
| `customer@rove.test` | customer, profile complete, verified (AE) |
| `customer.in@rove.test` | customer, profile complete, verified (IN) |
| `partner.ae@rove.test` | owner of **Desert Drive Rentals** (approved, Dubai, AED) |
| `partner.in@rove.test` | owner of **Mumbai Motors** (approved, Mumbai, INR) |
| `partner.pending@rove.test` | owner of **Gulf Coast Cars** (`pending_verification`) |
| `newpartner@rove.test` | signed-in user with no partner (onboarding flow) |
| `admin@rove.test` | admin |

The seed also creates 7 pickup locations and 22 published vehicles (11 per country, every category, a mix of instant and request booking). Their images are generated locally with `sharp` from SVG, with no third-party photos. It also adds completed, upcoming, active and pending bookings, one paid payout (AE) and one pending payout (IN).

---

## Environment variables

| Variable | Default (local) | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `development` / `test` / `production` |
| `PORT` | `4000` | HTTP port |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Allowed browser origins (dashboard) |
| `LOG_LEVEL` | `log` | `fatal`…`verbose` |
| `SUPABASE_URL` | `http://127.0.0.1:54321` | Supabase API (Auth JWKS, Storage) |
| `SUPABASE_SERVICE_ROLE_KEY` | local demo key | **Server only.** Storage writes and the admin API |
| `SUPABASE_ANON_KEY` | local demo key | Used only by the seed/e2e tests to sign in like a client |
| `SUPABASE_JWT_SECRET` | local demo secret | HS256 fallback for legacy symmetric tokens |
| `SUPABASE_JWT_ISSUER` | `http://127.0.0.1:54321/auth/v1` | Expected `iss`; leave empty to skip the issuer check |
| `STORAGE_PUBLIC_URL` | *(empty → SUPABASE_URL)* | Host used in returned file URLs (for example `http://10.0.2.2:54321` for the Android emulator) |
| `SIGNED_URL_TTL_SECONDS` | `600` | Signed URL lifetime for private files |
| `DATABASE_URL` | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` | Postgres (the backend bypasses RLS) |
| `DB_POOL_MAX` | `10` | pg pool size |
| `PAYMENT_PROVIDER` | `mock` | Only `mock` in v1. `simulateOutcome` is honoured only here |
| `THROTTLE_TTL_MS` / `THROTTLE_LIMIT` / `THROTTLE_WRITE_LIMIT` | `60000` / `120` / `60` | Rate limits per user (per IP when anonymous) |
| `ENABLE_CRON` | `true` | Per-minute hold and response expiry job |
| `SEED_USER_PASSWORD` | dev default | Password for seeded accounts (seed and e2e only) |
| `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` / `_SECRET` | *(empty)* | Google OAuth for local Supabase Auth (see below) |

The app validates its configuration at boot and refuses to start with a clear message if a variable is missing. `.env` is git-ignored; never commit real secrets.

---

## Scripts

| Script | What it does |
|---|---|
| `npm run start:dev` | Dev server with watch (port 4000) |
| `npm run build` / `npm run start:prod` | Compile to `dist/` / run it |
| `npm run lint` / `npm run lint:fix` | ESLint (type-aware) + Prettier |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (pricing, cancellation, state machine, dates/timezones) |
| `npm run test:e2e` | E2E against the local Supabase stack. Needs `supabase start` + `db:reset` + `seed`, and removes the data it creates |
| `npm run db:reset` / `db:fresh` | Re-apply migrations / plus seed |
| `npm run db:types` | Regenerate `src/database/db.types.ts` from the live schema |
| `npm run seed` | Idempotent seed |
| `npm run seed:credits` | Regenerate `seed-assets/CREDITS.md` from the photo manifest |
| `npm run admin -- <command>` | Admin CLI (below) |

### Admin CLI
```bash
npm run admin -- help
npm run admin -- partners pending_verification
npm run admin -- approve-partner partner.pending@rove.test     # id or owner email
npm run admin -- vehicles                                      # pending_review by default
npm run admin -- approve-vehicle <vehicleId>
npm run admin -- reject-vehicle <vehicleId> Photos are blurry
npm run admin -- approve-doc customer <documentId>
npm run admin -- generate-payouts 2026-10-01 2026-10-31
npm run admin -- mark-paid <payoutId> TRF-123
npm run admin -- expire-bookings
npm run admin -- make-admin someone@example.com
```
The same operations are available over HTTP under `/api/v1/admin/*` for admins.

---

## Enabling Google sign-in (local)

1. In Google Cloud Console → *APIs & Services → Credentials*, create an **OAuth client ID** (type *Web application*).
   - Authorized redirect URI: `http://127.0.0.1:54321/auth/v1/callback`
   - For the mobile app, also create iOS/Android client IDs if you use native Google sign-in.
2. Put the credentials in `.env` (never commit them):
   ```
   SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=<client id>
   SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=<client secret>
   ```
3. In `supabase/config.toml`, set `enabled = true` under `[auth.external.google]`. The client id and secret are read from the env vars above via `env(...)`.
4. Export the two variables in the shell where you run the Supabase CLI (for example `set -a; . ./.env; set +a`), then restart it: `npx supabase stop && npx supabase start`.
5. The allowed redirect URLs (`additional_redirect_urls`) already include the dashboard (`http://localhost:5173/auth/callback`) and the app deep link (`com.rove.customer://login-callback`).

The backend needs no change: it verifies any Supabase-issued access token.

---

## Testing

```bash
npm run lint && npm run typecheck && npm test
npx supabase start && npm run db:fresh && npm run test:e2e
```
The e2e suites (`test/*.e2e-spec.ts`) boot the real Nest app in-process with supertest and sign in as the seeded users to get real Supabase JWTs. Each test creates its own vehicles through the partner and admin APIs, so calendars never collide. They cover:
- auth 401/403, role resolution and the HS256 fallback
- partner isolation
- the full lifecycle (quote → book → pay → accept → pickup → return → completed → earnings → payout)
- instant booking, rejection, payment failure, hold and response expiry
- sequential and **concurrent** double booking, plus the EXCLUDE backstop
- availability-block conflicts, upload type and size rejection, idempotent replay and key conflicts

A global setup and teardown removes the data the suites create.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, build and unit tests on every push and PR.

---

## Seed images & credits

All 23 seeded vehicles use real photos from Unsplash (free Unsplash License, listed in `seed-assets/vehicles/manifest.json`).
A vehicle without manifest entries falls back to two locally generated illustrations (SVG → JPEG with `sharp`). To add or change photos:

1. Put ~1600 px JPEGs in `seed-assets/vehicles/` (free **Unsplash License** photos only; never Unsplash+ / `plus.unsplash.com`).
2. List them per vehicle key (see `src/seed/data.ts`, e.g. `ae_911`) in `seed-assets/vehicles/manifest.json`:
   ```json
   { "vehicles": { "ae_911": [
     { "file": "ae-911-1.jpg", "photoUrl": "https://unsplash.com/photos/<id>",
       "photographer": "Jane Doe" }
   ] } }
   ```
   The first file becomes the cover. The seed validates the manifest: the files must exist, the photo URL must be an `unsplash.com/photos/…` page, the photographer name is required, and `photographerUrl` (`https://unsplash.com/@…`) is optional. Download photos through `https://unsplash.com/photos/<id>/download` and keep only files served from `images.unsplash.com`.
3. `npm run seed:credits` regenerates [`seed-assets/CREDITS.md`](seed-assets/CREDITS.md) ("Photo by X on Unsplash" for each image), then `npm run db:fresh` (or `npm run seed`) uploads the photos to `car-images` and replaces the illustrations.

Credits for all photos in use are listed in [`seed-assets/CREDITS.md`](seed-assets/CREDITS.md).

---

## Notes and decisions
- **NestJS 11 (not 12).** Nest 12 (Aug 2026) is ESM-only, and kysely 0.29 / file-type 22 require Node 22. This project targets Node 20 with Jest/ts-jest (CommonJS), so it uses Nest 11, kysely 0.28 and file-type 16. The APIs are the same.
- Money is always `{ amountMinor, currency }`. Sums are never mixed across currencies, and financial endpoints return one entry per currency.
- Partners never see unpaid `held` bookings in lists or detail. Those appear only as blocked periods in their availability calendar.
- Deposit: held at pickup and fully released at return. Damage claims are out of scope for v1 and go to support.
