import { INestApplication } from '@nestjs/common';
import type { Db } from '../src/database/database';
import { seedId, VEHICLES } from '../src/seed/data';
import { ACCOUNTS, api, createApp, pdfDoc, tokenFor } from './helpers';

describe('Partner isolation (e2e)', () => {
  let app: INestApplication;
  let db: Db;
  let a: ReturnType<typeof api>;
  let ae: string;
  let inTok: string;
  const inVehicle = seedId('vehicle:in_3series');
  const inPartner = seedId('partner:mumbai_motors');

  beforeAll(async () => {
    ({ app, db } = await createApp());
    a = api(app);
    ae = await tokenFor(ACCOUNTS.partnerAe);
    inTok = await tokenFor(ACCOUNTS.partnerIn);
  });
  afterAll(async () => app.close());

  it("lists only the caller's own vehicles", async () => {
    const res = await a.get('/partner/vehicles?pageSize=100', ae).expect(200);
    const ids: string[] = res.body.data.map((v: { id: string }) => v.id);
    const own = await db
      .selectFrom('vehicles')
      .select('id')
      .where('partner_id', '=', seedId('partner:desert_drive'))
      .execute();
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids)).toEqual(new Set(own.map((o) => o.id)));
    expect(ids).not.toContain(inVehicle);
  });

  it("partner A cannot read, edit or manage partner B's vehicle", async () => {
    await a.get(`/partner/vehicles/${inVehicle}`, ae).expect(404);
    await a.patch(`/partner/vehicles/${inVehicle}`, ae).send({ dailyRateMinor: 100 }).expect(404);
    await a.post(`/partner/vehicles/${inVehicle}/unpublish`, ae).expect(404);
    await a.get(`/partner/vehicles/${inVehicle}/availability`, ae).expect(404);
    await a
      .post(`/partner/vehicles/${inVehicle}/availability`, ae)
      .send({
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        reason: 'maintenance',
      })
      .expect(404);
    await a.get(`/partner/vehicles/${inVehicle}/documents`, ae).expect(404);
    await a
      .post(`/partner/vehicles/${inVehicle}/documents`, ae)
      .field('documentType', 'insurance')
      .attach('file', pdfDoc(), 'x.pdf')
      .expect(404);
    const doc = await db
      .selectFrom('vehicle_documents')
      .select('id')
      .where('vehicle_id', '=', inVehicle)
      .executeTakeFirstOrThrow();
    await a.get(`/partner/vehicles/${inVehicle}/documents/${doc.id}/url`, ae).expect(404);
    // Still untouched for its owner.
    const own = await a.get(`/partner/vehicles/${inVehicle}`, inTok).expect(200);
    expect(own.body.data.dailyRateMinor).toBe(VEHICLES.find((v) => v.key === 'in_3series')!.dailyRate * 100);
  });

  it("partner A cannot read or act on partner B's bookings or documents", async () => {
    const bBooking = await db
      .selectFrom('bookings')
      .select('id')
      .where('partner_id', '=', inPartner)
      .where('status', '!=', 'held')
      .executeTakeFirstOrThrow();
    await a.get(`/partner/bookings/${bBooking.id}`, ae).expect(404);
    await a.post(`/partner/bookings/${bBooking.id}/accept`, ae).expect(404);
    await a.post(`/partner/bookings/${bBooking.id}/cancel`, ae).send({ reason: 'not mine at all' }).expect(404);
    await a.get(`/partner/bookings/${bBooking.id}/evidence`, ae).expect(404);
    const list = await a.get('/partner/bookings?pageSize=100', ae).expect(200);
    expect(list.body.data.map((b: { id: string }) => b.id)).not.toContain(bBooking.id);
    const pdoc = await db
      .selectFrom('partner_documents')
      .select('id')
      .where('partner_id', '=', inPartner)
      .executeTakeFirstOrThrow();
    await a.get(`/partner/documents/${pdoc.id}/url`, ae).expect(404);
    const own = await a.get(`/partner/documents/${pdoc.id}/url`, inTok).expect(200);
    expect(own.body.data.url).toContain('token=');
    expect(new Date(own.body.data.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(600_000 + 5_000);
  });

  it('customers cannot read other customers’ bookings; partner earnings never mix', async () => {
    const other = await db
      .selectFrom('bookings')
      .select('id')
      .where('partner_id', '=', inPartner)
      .executeTakeFirstOrThrow();
    await a.get(`/bookings/${other.id}`, await tokenFor(ACCOUNTS.customer)).expect(404);
    const earnings = await a.get('/partner/earnings?from=2026-01-01', ae).expect(200);
    for (const s of earnings.body.data.summaries) expect(s.currency).toBe('AED');
    for (const t of earnings.body.data.transactions) expect(t.currency).toBe('AED');
  });

  it('partner payload never exposes customer email, DOB or documents', async () => {
    const b = await db
      .selectFrom('bookings')
      .select('id')
      .where('partner_id', '=', seedId('partner:desert_drive'))
      .where('status', '=', 'confirmed')
      .executeTakeFirstOrThrow();
    const res = await a.get(`/partner/bookings/${b.id}`, ae).expect(200);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain(ACCOUNTS.customer);
    expect(json).not.toContain('1990-04-12');
    expect(res.body.data.customer).toEqual({
      displayName: 'Aisha K.',
      phone: '+971501234567',
      verificationStatus: 'verified',
    });
  });
});
