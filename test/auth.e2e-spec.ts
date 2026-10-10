import { INestApplication } from '@nestjs/common';
import { SignJWT } from 'jose';
import request from 'supertest';
import type { Db } from '../src/database/database';
import { ACCOUNTS, api, createApp, tokenFor } from './helpers';

describe('Auth, roles & API conventions (e2e)', () => {
  let app: INestApplication;
  let db: Db;
  let a: ReturnType<typeof api>;

  beforeAll(async () => {
    ({ app, db } = await createApp());
    a = api(app);
  });
  afterAll(async () => app.close());

  it('serves health at /health (raw) and /api/v1/health (enveloped)', async () => {
    const raw = await request(app.getHttpServer()).get('/health').expect(200);
    expect(raw.body).toEqual({ status: 'ok', db: 'ok' });
    const env = await a.get('/health').expect(200);
    expect(env.body).toEqual({ data: { status: 'ok', db: 'ok' } });
  });

  it('returns the error envelope with a request id, echoing a client x-request-id', async () => {
    const res = await a.get('/me').set('x-request-id', 'req_client_12345').expect(401);
    expect(res.headers['x-request-id']).toBe('req_client_12345');
    expect(res.body).toEqual({
      error: { code: 'UNAUTHENTICATED', message: expect.any(String), details: {}, requestId: 'req_client_12345' },
    });
  });

  it('401 for missing, malformed and badly signed tokens', async () => {
    await a.get('/me').expect(401);
    await a.get('/me', 'not-a-jwt').expect(401);
    const forged = await new SignJWT({ aud: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('00000000-0000-4000-8000-000000000000')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('wrong-secret-wrong-secret-wrong-secret!!'));
    const res = await a.get('/me', forged).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('accepts a legacy HS256 token signed with SUPABASE_JWT_SECRET, rejects expired / wrong audience', async () => {
    const user = await db
      .selectFrom('profiles')
      .select('user_id')
      .where('email', '=', ACCOUNTS.customer)
      .executeTakeFirstOrThrow();
    const secret = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);
    const sign = (aud: string, exp: string | number) =>
      new SignJWT({ aud, email: ACCOUNTS.customer, role: 'authenticated' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.user_id)
        .setIssuer(process.env.SUPABASE_JWT_ISSUER || 'x')
        .setIssuedAt()
        .setExpirationTime(exp)
        .sign(secret);
    const ok = await a.get('/me', await sign('authenticated', '5m')).expect(200);
    expect(ok.body.data.user.email).toBe(ACCOUNTS.customer);
    await a.get('/me', await sign('authenticated', Math.floor(Date.now() / 1000) - 60)).expect(401);
    await a.get('/me', await sign('anon', '5m')).expect(401);
  });

  it('resolves roles server-side: customer, partner, admin', async () => {
    const me = await a.get('/me', await tokenFor(ACCOUNTS.customer)).expect(200);
    expect(me.body.data).toMatchObject({ profileComplete: true, isAdmin: false, partner: null });
    const p = await a.get('/me', await tokenFor(ACCOUNTS.partnerAe)).expect(200);
    expect(p.body.data.partner).toMatchObject({
      displayName: 'Desert Drive Rentals',
      status: 'approved',
      role: 'owner',
    });
    const ad = await a.get('/me', await tokenFor(ACCOUNTS.admin)).expect(200);
    expect(ad.body.data.isAdmin).toBe(true);
  });

  it('403 PARTNER_REQUIRED / FORBIDDEN / PARTNER_NOT_APPROVED', async () => {
    const customer = await tokenFor(ACCOUNTS.customer);
    expect((await a.get('/partner/profile', customer).expect(403)).body.error.code).toBe('PARTNER_REQUIRED');
    expect((await a.get('/partner/vehicles', await tokenFor(ACCOUNTS.newPartner)).expect(403)).body.error.code).toBe(
      'PARTNER_REQUIRED',
    );
    expect((await a.get('/admin/partners', customer).expect(403)).body.error.code).toBe('FORBIDDEN');
    expect((await a.get('/admin/partners', await tokenFor(ACCOUNTS.partnerAe)).expect(403)).body.error.code).toBe(
      'FORBIDDEN',
    );
    const pending = await tokenFor(ACCOUNTS.partnerPending);
    expect((await a.get('/partner/bookings', pending).expect(403)).body.error.code).toBe('PARTNER_NOT_APPROVED');
    expect((await a.get('/partner/overview', pending).expect(403)).body.error.code).toBe('PARTNER_NOT_APPROVED');
    // …but profile / verification / drafts stay available while pending.
    await a.get('/partner/profile', pending).expect(200);
    await a.get('/partner/verification', pending).expect(200);
    await a.get('/partner/vehicles', pending).expect(200);
  });

  it('ignores client-supplied ids/roles: onboarding twice → PARTNER_ALREADY_EXISTS', async () => {
    const res = await a
      .post('/partner/onboarding', await tokenFor(ACCOUNTS.partnerAe))
      .send({
        legalName: 'Another Co',
        displayName: 'Another',
        contactName: 'X Y',
        email: 'x@example.com',
        phone: '+971500000001',
        countryCode: 'AE',
        cityId: 'c1a00000-0000-4000-8000-000000000001',
        address: 'Somewhere 1, Dubai',
        registrationNumber: 'ABC-123',
      })
      .expect(409);
    expect(res.body.error.code).toBe('PARTNER_ALREADY_EXISTS');
  });

  it('validation errors are 400 VALIDATION_FAILED with field details; unknown fields rejected', async () => {
    const res = await a
      .patch('/me', await tokenFor(ACCOUNTS.customer))
      .send({ phone: 'abc', countryCode: 'FR', isAdmin: true })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.body.error.details.fields).sort()).toEqual(['countryCode', 'isAdmin', 'phone']);
    const bad = await a.raw
      .post('/api/v1/bookings/quote')
      .set('Authorization', `Bearer ${await tokenFor(ACCOUNTS.customer)}`)
      .set('Content-Type', 'application/json')
      .send('{bad json')
      .expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('unknown routes and malformed ids → 404 NOT_FOUND', async () => {
    expect((await a.get('/nope').expect(404)).body.error.code).toBe('NOT_FOUND');
    expect((await a.get('/vehicles/not-a-uuid').expect(404)).body.error.code).toBe('NOT_FOUND');
  });

  it('public reference data', async () => {
    const res = await a.get('/countries').expect(200);
    const ae = res.body.data.find((c: { code: string }) => c.code === 'AE');
    expect(ae).toMatchObject({
      currency: 'AED',
      timezone: 'Asia/Dubai',
      taxLabel: 'VAT',
      taxRateBps: 500,
      platformFeeBps: 500,
      paymentMethods: ['card', 'apple_pay'],
    });
    expect(ae.cities).toHaveLength(4);
    const india = res.body.data.find((c: { code: string }) => c.code === 'IN');
    expect(india).toMatchObject({ currency: 'INR', taxRateBps: 1800 });
    const loc = await a.get('/locations?countryCode=AE').expect(200);
    expect(loc.body.data.length).toBeGreaterThan(0);
  });
});
