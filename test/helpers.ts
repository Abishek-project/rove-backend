import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import WebSocket from 'ws';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { KYSELY } from '../src/database/database';
import type { Db } from '../src/database/database';
import { samplePdf } from '../src/seed/assets';

export const ACCOUNTS = {
  customer: 'customer@rove.test',
  customerIn: 'customer.in@rove.test',
  partnerAe: 'partner.ae@rove.test',
  partnerIn: 'partner.in@rove.test',
  partnerPending: 'partner.pending@rove.test',
  newPartner: 'newpartner@rove.test',
  admin: 'admin@rove.test',
} as const;

export const DUBAI = 'c1a00000-0000-4000-8000-000000000001';
export const H = 3_600_000;

export async function createApp(): Promise<{ app: INestApplication; db: Db }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: ['error'] });
  configureApp(app);
  await app.init();
  return { app, db: app.get<Db>(KYSELY) };
}

const tokenCache = new Map<string, string>();

/** Email domain/prefix for throwaway users; test/cleanup.ts deletes them. */
export const E2E_USER_PREFIX = 'e2e-';

/**
 * A brand-new signed-in user (no profile details, no partner, no documents), created through the
 * Supabase admin API so tests never mutate the shared seeded accounts other agents are using.
 */
export async function freshUserToken(): Promise<string> {
  const admin = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { persistSession: false },
    realtime: { transport: WebSocket as never },
  });
  const email = `${E2E_USER_PREFIX}${randomUUID().slice(0, 8)}@rove.test`;
  const { error } = await admin.auth.admin.createUser({
    email,
    password: process.env.SEED_USER_PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser failed: ${error.message}`);
  return tokenFor(email);
}

/** Real Supabase access token for a seeded user (password grant, like the dev login in the clients). */
export async function tokenFor(email: string): Promise<string> {
  const cached = tokenCache.get(email);
  if (cached) return cached;
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_ANON_KEY ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: process.env.SEED_USER_PASSWORD }),
  });
  const body = (await res.json()) as { access_token?: string; msg?: string };
  if (!body.access_token)
    throw new Error(`Sign-in failed for ${email} (run \`npm run seed\`): ${JSON.stringify(body)}`);
  tokenCache.set(email, body.access_token);
  return body.access_token;
}

export function api(app: INestApplication) {
  const server = app.getHttpServer();
  const withAuth = (req: request.Test, token?: string) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
  return {
    get: (url: string, token?: string) => withAuth(request(server).get(`/api/v1${url}`), token),
    post: (url: string, token?: string) => withAuth(request(server).post(`/api/v1${url}`), token),
    patch: (url: string, token?: string) => withAuth(request(server).patch(`/api/v1${url}`), token),
    put: (url: string, token?: string) => withAuth(request(server).put(`/api/v1${url}`), token),
    delete: (url: string, token?: string) => withAuth(request(server).delete(`/api/v1${url}`), token),
    raw: request(server),
  };
}

export async function pngImage(color = '#3366cc'): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: color } })
    .png()
    .toBuffer();
}

export const pdfDoc = (label = 'test') => samplePdf([label]);

/** ISO time `hours` from now, rounded to the minute. */
export function fromNow(hours: number): string {
  return new Date(Math.round((Date.now() + hours * H) / 60_000) * 60_000).toISOString();
}

let seq = 0;
/**
 * Creates and publishes a fresh vehicle for the AE partner through the real partner + admin APIs,
 * so each test owns a calendar nobody else books.
 */
export async function createPublishedVehicle(
  app: INestApplication,
  opts: {
    bookingMode?: 'instant' | 'request';
    dailyRateMinor?: number;
    policy?: 'flexible' | 'moderate' | 'strict';
    partner?: string;
  } = {},
): Promise<string> {
  const a = api(app);
  const partner = await tokenFor(opts.partner ?? ACCOUNTS.partnerAe);
  const admin = await tokenFor(ACCOUNTS.admin);
  seq += 1;
  const created = await a
    .post('/partner/vehicles', partner)
    .send({
      cityId: DUBAI,
      make: 'Test',
      model: `E2E ${Date.now().toString(36)}-${seq}`,
      year: 2024,
      category: 'sedan',
      transmission: 'automatic',
      fuelType: 'petrol',
      seats: 5,
      doors: 4,
      luggage: 2,
      color: 'White',
      registrationNumber: `T ${Math.floor(Math.random() * 90000) + 10000}`,
      dailyRateMinor: opts.dailyRateMinor ?? 20000,
      weeklyDiscountBps: 1000,
      mileageLimitKmPerDay: 250,
      excessMileageFeeMinor: 50,
      fuelPolicy: 'full_to_full',
      depositMinor: 100000,
      cancellationPolicy: opts.policy ?? 'moderate',
      deliveryAvailable: true,
      deliveryFeeMinor: 5000,
      bufferHours: 2,
      bookingMode: opts.bookingMode ?? 'request',
    })
    .expect(201);
  const id = created.body.data.id as string;
  await a
    .post(`/partner/vehicles/${id}/images`, partner)
    .attach('file', await pngImage(), 'car.png')
    .expect(201);
  for (const t of ['mulkiya', 'insurance']) {
    await a
      .post(`/partner/vehicles/${id}/documents`, partner)
      .field('documentType', t)
      .attach('file', pdfDoc(t), `${t}.pdf`)
      .expect(201);
  }
  await a.post(`/partner/vehicles/${id}/submit`, partner).expect(200);
  await a.post(`/admin/vehicles/${id}/approve`, admin).expect(200);
  return id;
}

/** Quote + book (+ optionally pay) as a customer. */
export async function book(
  app: INestApplication,
  vehicleId: string,
  opts: { customer?: string; pickupInHours?: number; hours?: number; pay?: boolean; idempotencyKey?: string } = {},
) {
  const a = api(app);
  const token = await tokenFor(opts.customer ?? ACCOUNTS.customer);
  const pickupAt = fromNow(opts.pickupInHours ?? 3);
  const returnAt = new Date(new Date(pickupAt).getTime() + (opts.hours ?? 48) * H).toISOString();
  const quote = await a
    .post('/bookings/quote', token)
    .send({ vehicleId, pickupAt, returnAt, delivery: { enabled: false } });
  if (quote.status !== 200) throw new Error(`quote failed: ${quote.status} ${JSON.stringify(quote.body)}`);
  let req = a.post('/bookings', token);
  if (opts.idempotencyKey) req = req.set('Idempotency-Key', opts.idempotencyKey);
  const created = await req.send({
    quoteId: quote.body.data.id,
    driver: { fullName: 'Test Driver', phone: '+971501112233', dateOfBirth: '1990-01-01' },
    termsAccepted: true,
  });
  if (created.status !== 201) throw new Error(`book failed: ${created.status} ${JSON.stringify(created.body)}`);
  const bookingId = created.body.data.booking.id as string;
  const intentId = created.body.data.payment.intentId as string;
  let booking = created.body.data.booking;
  if (opts.pay) {
    const paid = await a.post(`/bookings/${bookingId}/payment/confirm`, token).send({ intentId }).expect(200);
    booking = paid.body.data;
  }
  return { bookingId, intentId, booking, quote: quote.body.data, token, pickupAt, returnAt };
}
