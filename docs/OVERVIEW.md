# Rove — car rental marketplace (India 🇮🇳 + UAE 🇦🇪)

Rove lets customers discover, compare and book premium rental cars from verified rental companies in India and the UAE.
It's three separate repositories, built in parallel against one shared API contract.

| Repository | Stack | What it is |
|---|---|---|
| [`rove-backend`](https://github.com/Abishek-project/rove-backend) | NestJS 11 · TypeScript · Supabase (Auth, Storage, Postgres) · Kysely | REST API (`/api/v1`, 75 routes), pricing, availability, booking state machine, mock payments, uploads, admin CLI |
| [`rove-partner-dashboard`](https://github.com/Abishek-project/rove-partner-dashboard) | React 19 · TypeScript · Vite · Tailwind · TanStack Query · RHF + Zod | Web portal for rental companies: onboarding, fleet, availability, bookings, pickup/return, earnings |
| [`rove-customer-app`](https://github.com/Abishek-project/rove-customer-app) | Flutter · Dart · flutter_bloc · GoRouter · Dio · Freezed | Mobile app for customers: search, details, checkout, bookings, profile (iOS + Android) |

Shared docs: the API and schema contract is [`rove-backend/docs/CONTRACTS.md`](https://github.com/Abishek-project/rove-backend/blob/main/docs/CONTRACTS.md), and the design system is [`rove-partner-dashboard/docs/DESIGN.md`](https://github.com/Abishek-project/rove-partner-dashboard/blob/main/docs/DESIGN.md) (the same file is in the app repo).

```
Flutter app ──┐                       ┌── Supabase Auth  (Google OAuth; email login in local dev only)
              ├── HTTPS /api/v1 ──▶ NestJS ─┼── PostgreSQL     (RLS on, no client access; EXCLUDE constraint prevents double booking)
React portal ─┘   Bearer JWT              ├── Supabase Storage (public car photos, private documents via 10-min signed URLs)
                                          └── PaymentProvider  (mock today; Stripe-ready interface)
```

## Highlights
* **No double bookings**: a Postgres `EXCLUDE USING gist` constraint on `(vehicle, time range + buffer)`, plus row locks and idempotency keys. Verified with concurrent requests.
* **Money done right**: integer minor units everywhere, backend-only pricing (rental, weekly discount, delivery, service fee, VAT 5% / GST 18%, commission), never mixing INR and AED.
* **Honest states**: `held → pending_partner → confirmed → active → completed` (+ rejected/cancelled/expired), audit log, and `allowedActions` computed by the server for each caller.
* **Security**: service-role key only on the server, RLS deny-all, partner isolation by membership (never client-sent IDs), magic-byte upload checks, rate limits.
* **Design**: dark premium mobile app and a light "bento" dashboard. Real Unsplash photos, credited.

## Run everything locally
Prerequisites: Docker Desktop, Node 20+, Flutter 3.44+, Xcode (iOS simulator).

```bash
# 0. Clone the three repos side by side
mkdir Rove && cd Rove
git clone https://github.com/Abishek-project/rove-backend.git
git clone https://github.com/Abishek-project/rove-partner-dashboard.git
git clone https://github.com/Abishek-project/rove-customer-app.git

# 1. Backend + local Supabase  → http://localhost:4000  (Swagger: /api/docs)
cd rove-backend && cp .env.example .env && npm install
npx supabase start && npm run db:reset && npm run seed
npm run start:dev

# 2. Partner dashboard → http://localhost:5173   (live mode, see its README for .env.live.local)
cd ../rove-partner-dashboard && npm install && npx vite --mode live

# 3. Customer app on the iOS simulator   (paste the local anon key into dart_defines/local.json first)
cd ../rove-customer-app && flutter pub get
flutter run --dart-define-from-file=dart_defines/local.json
```
Mock mode (no backend needed): `npm run dev` in the dashboard, and `flutter run --dart-define-from-file=dart_defines/mock.json` in the app.

**Demo accounts** (local only; password = `SEED_USER_PASSWORD` in `rove-backend/.env.example`):
`customer@rove.test` (UAE), `customer.in@rove.test` (India), `partner.ae@rove.test` (Desert Drive Rentals, Dubai),
`partner.in@rove.test` (Mumbai Motors), `partner.pending@rove.test`, `newpartner@rove.test` (onboarding), `admin@rove.test`.

## Quality
| | Checks |
|---|---|
| Backend | ESLint · build · 58 unit tests · 38 e2e tests against real Postgres (auth, isolation, full lifecycle, concurrency, expiry, uploads, idempotency) · GitHub Actions CI |
| Dashboard | ESLint (0 warnings) · `tsc` · 102 Vitest + Testing Library + MSW tests · production build |
| Customer app | `dart format` · `flutter analyze` (0 issues) · 102 tests incl. bloc tests · iOS simulator build |
| Cross-system | 32-step end-to-end run: quote → hold → declined/approved payment → partner accept → pickup → return → earnings; concurrent double booking (1 wins / 1 gets 409); maintenance-block conflict |

## Cloud
A Supabase cloud project has the full schema, buckets and security applied (RLS on every table, no client grants).
Still to do: seed demo data, configure Google OAuth, and host the API and dashboard.

## Credits
Vehicle and hero photos: [Unsplash](https://unsplash.com) (free Unsplash License); see [`rove-backend/seed-assets/CREDITS.md`](https://github.com/Abishek-project/rove-backend/blob/main/seed-assets/CREDITS.md), [`rove-customer-app/assets/CREDITS.md`](https://github.com/Abishek-project/rove-customer-app/blob/main/assets/CREDITS.md) and [`rove-partner-dashboard/CREDITS.md`](https://github.com/Abishek-project/rove-partner-dashboard/blob/main/CREDITS.md). Font: Plus Jakarta Sans (OFL).
