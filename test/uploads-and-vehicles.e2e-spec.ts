import { INestApplication } from '@nestjs/common';
import type { Db } from '../src/database/database';
import { ACCOUNTS, api, createApp, createPublishedVehicle, DUBAI, pdfDoc, pngImage, tokenFor } from './helpers';

describe('Uploads, partner vehicles, catalog & profile (e2e)', () => {
  let app: INestApplication;
  let db: Db;
  let a: ReturnType<typeof api>;
  let partner: string;
  let draftId: string;

  beforeAll(async () => {
    ({ app, db } = await createApp());
    a = api(app);
    partner = await tokenFor(ACCOUNTS.partnerAe);
    const res = await a
      .post('/partner/vehicles', partner)
      .send({ make: 'Draft', model: 'Upload Test', cityId: DUBAI })
      .expect(201);
    draftId = res.body.data.id;
  });
  afterAll(async () => {
    await a.delete(`/partner/vehicles/${draftId}`, partner);
    await app.close();
  });

  it('draft vehicle: currency derived from the partner, requiredDocuments exposed, submit blocked until complete', async () => {
    const v = await a.get(`/partner/vehicles/${draftId}`, partner).expect(200);
    expect(v.body.data).toMatchObject({
      status: 'draft',
      currency: 'AED',
      allowedActions: ['edit', 'submit', 'delete'],
    });
    expect(v.body.data.requiredDocuments).toEqual([
      expect.objectContaining({ documentType: 'insurance', label: 'Insurance', isRequired: true, status: 'missing' }),
      expect.objectContaining({ documentType: 'mulkiya', isRequired: true, status: 'missing' }),
    ]);
    const res = await a.post(`/partner/vehicles/${draftId}/submit`, partner).expect(422);
    expect(Object.keys(res.body.error.details.fields)).toEqual(
      expect.arrayContaining(['year', 'dailyRateMinor', 'images', 'documents']),
    );
    await a.post('/partner/vehicles', partner).send({ currency: 'USD' }).expect(400);
  });

  it('rejects disguised and oversized files by magic bytes and size', async () => {
    // Text renamed to .jpg with an image MIME type.
    const fake = await a
      .post(`/partner/vehicles/${draftId}/images`, partner)
      .attach('file', Buffer.from('hello, I am not an image'), { filename: 'car.jpg', contentType: 'image/jpeg' })
      .expect(415);
    expect(fake.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    // A PDF is not an allowed image.
    await a
      .post(`/partner/vehicles/${draftId}/images`, partner)
      .attach('file', pdfDoc(), { filename: 'x.png', contentType: 'image/png' })
      .expect(415);
    // > 10 MB image (valid PNG header followed by padding).
    const png = await pngImage();
    const big = Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024 + 10)]);
    const tooBig = await a
      .post(`/partner/vehicles/${draftId}/images`, partner)
      .attach('file', big, 'big.png')
      .expect(413);
    expect(tooBig.body.error.code).toBe('FILE_TOO_LARGE');
    // > 15 MB document is cut off by the upload limit.
    const huge = Buffer.concat([pdfDoc(), Buffer.alloc(15 * 1024 * 1024 + 10)]);
    expect(
      (
        await a
          .post(`/partner/vehicles/${draftId}/documents`, partner)
          .field('documentType', 'insurance')
          .attach('file', huge, 'huge.pdf')
          .expect(413)
      ).body.error.code,
    ).toBe('FILE_TOO_LARGE');
    // Wrong document type for the country.
    await a
      .post(`/partner/vehicles/${draftId}/documents`, partner)
      .field('documentType', 'registration_certificate')
      .attach('file', pdfDoc(), 'rc.pdf')
      .expect(422);
    // Missing file.
    await a.post(`/partner/vehicles/${draftId}/images`, partner).expect(422);
  });

  it('images: first becomes cover, reorder, change cover, delete promotes the next', async () => {
    const i1 = (
      await a
        .post(`/partner/vehicles/${draftId}/images`, partner)
        .attach('file', await pngImage('#111111'), 'a.png')
        .expect(201)
    ).body.data;
    const i2 = (
      await a
        .post(`/partner/vehicles/${draftId}/images`, partner)
        .attach('file', await pngImage('#222222'), 'b.png')
        .expect(201)
    ).body.data;
    expect(i1).toMatchObject({ isCover: true, sortOrder: 0 });
    expect(i2).toMatchObject({ isCover: false, sortOrder: 1 });
    expect(i1.url).toContain('/storage/v1/object/public/car-images/vehicles/');
    const pub = await fetch(i1.url);
    expect(pub.status).toBe(200);
    const order = await a
      .put(`/partner/vehicles/${draftId}/images/order`, partner)
      .send({ imageIds: [i2.id, i1.id] })
      .expect(200);
    expect(order.body.data.map((i: { id: string }) => i.id)).toEqual([i2.id, i1.id]);
    await a
      .put(`/partner/vehicles/${draftId}/images/order`, partner)
      .send({ imageIds: [i2.id] })
      .expect(422);
    const cover = await a.post(`/partner/vehicles/${draftId}/images/${i2.id}/cover`, partner).expect(200);
    expect(cover.body.data.find((i: { id: string }) => i.id === i2.id).isCover).toBe(true);
    await a.delete(`/partner/vehicles/${draftId}/images/${i2.id}`, partner).expect(204);
    const v = await a.get(`/partner/vehicles/${draftId}`, partner).expect(200);
    expect(v.body.data.images).toEqual([expect.objectContaining({ id: i1.id, isCover: true })]);
  });

  it('documents are private: stored in a private bucket and returned only as short-lived signed URLs', async () => {
    const doc = (
      await a
        .post(`/partner/vehicles/${draftId}/documents`, partner)
        .field('documentType', 'insurance')
        .field('expiresOn', '2030-01-01')
        .attach('file', pdfDoc('ins'), 'Insurance (2026).pdf')
        .expect(201)
    ).body.data;
    expect(doc).toMatchObject({
      documentType: 'insurance',
      status: 'submitted',
      contentType: 'application/pdf',
      expiresOn: '2030-01-01',
      fileName: 'Insurance 2026.pdf',
    });
    const row = await db
      .selectFrom('vehicle_documents')
      .select('storage_path')
      .where('id', '=', doc.id)
      .executeTakeFirstOrThrow();
    const anon = await fetch(
      `${process.env.SUPABASE_URL}/storage/v1/object/public/verification-documents/${row.storage_path}`,
    );
    expect(anon.status).toBeGreaterThanOrEqual(400);
    const signed = await a.get(`/partner/vehicles/${draftId}/documents/${doc.id}/url`, partner).expect(200);
    expect(signed.body.data.url).toContain('token=');
    const file = await fetch(signed.body.data.url);
    expect(file.status).toBe(200);
    expect(
      Buffer.from(await file.arrayBuffer())
        .subarray(0, 4)
        .toString(),
    ).toBe('%PDF');
    const v = await a.get(`/partner/vehicles/${draftId}`, partner).expect(200);
    expect(
      v.body.data.requiredDocuments.find((d: { documentType: string }) => d.documentType === 'insurance').status,
    ).toBe('submitted');
  });

  it('published vehicle: price edits apply immediately; identity edits send it back to review', async () => {
    const id = await createPublishedVehicle(app);
    const priced = await a.patch(`/partner/vehicles/${id}`, partner).send({ dailyRateMinor: 25000 }).expect(200);
    expect(priced.body.data).toMatchObject({ status: 'published', dailyRateMinor: 25000 });
    const detail = await a.get(`/vehicles/${id}`).expect(200);
    expect(detail.body.data.dailyRate).toEqual({ amountMinor: 25000, currency: 'AED' });
    const unpub = await a.post(`/partner/vehicles/${id}/unpublish`, partner).expect(200);
    expect(unpub.body.data.status).toBe('unavailable');
    await a.get(`/vehicles/${id}`).expect(404);
    await a.post(`/partner/vehicles/${id}/republish`, partner).expect(200);
    const renamed = await a.patch(`/partner/vehicles/${id}`, partner).send({ model: 'Renamed' }).expect(200);
    expect(renamed.body.data.status).toBe('pending_review');
    await a.get(`/vehicles/${id}`).expect(404);
    await a.delete(`/partner/vehicles/${id}`, partner).expect(409);
    const admin = await tokenFor(ACCOUNTS.admin);
    const pending = await a.get('/admin/vehicles?status=pending_review&pageSize=100', admin).expect(200);
    expect(pending.body.data.map((v: { id: string }) => v.id)).toContain(id);
    await a.post(`/admin/vehicles/${id}/reject`, admin).send({ reason: 'Photos unclear' }).expect(200);
    const rejected = await a.get(`/partner/vehicles/${id}`, partner).expect(200);
    expect(rejected.body.data).toMatchObject({ status: 'rejected', rejectionReason: 'Photos unclear' });
  });

  it('catalog search: country scoping, filters, sorting and pagination', async () => {
    const all = await a.get('/vehicles?countryCode=IN&pageSize=5').expect(200);
    expect(all.body.meta).toMatchObject({ page: 1, pageSize: 5, total: expect.any(Number) });
    expect(all.body.meta.total).toBeGreaterThanOrEqual(11);
    expect(all.body.data.every((v: { dailyRate: { currency: string } }) => v.dailyRate.currency === 'INR')).toBe(true);
    const ev = await a.get('/vehicles?countryCode=IN&category=electric&sort=price_asc').expect(200);
    expect(ev.body.data.length).toBeGreaterThanOrEqual(2);
    const rates = ev.body.data.map((v: { dailyRate: { amountMinor: number } }) => v.dailyRate.amountMinor);
    expect([...rates].sort((x, y) => x - y)).toEqual(rates);
    const manual = await a.get('/vehicles?countryCode=IN&transmission=manual&minSeats=5').expect(200);
    expect(
      manual.body.data.every(
        (v: { transmission: string; seats: number }) => v.transmission === 'manual' && v.seats >= 5,
      ),
    ).toBe(true);
    await a.get('/vehicles').expect(400);
    await a
      .get(
        `/vehicles?countryCode=AE&pickupAt=${encodeURIComponent(new Date(Date.now() + 5 * 3_600_000).toISOString())}`,
      )
      .expect(422);
  });

  it('favorites round-trip', async () => {
    const t = await tokenFor(ACCOUNTS.customerIn);
    const list = await a.get('/vehicles?countryCode=IN&pageSize=1', t).expect(200);
    const id = list.body.data[0].id;
    await a.post('/favorites', t).send({ vehicleId: id }).expect(201);
    await a.post('/favorites', t).send({ vehicleId: id }).expect(201);
    expect((await a.get('/favorites', t).expect(200)).body.data.map((v: { id: string }) => v.id)).toContain(id);
    expect((await a.get(`/vehicles/${id}`, t).expect(200)).body.data.isFavorite).toBe(true);
    await a.delete(`/favorites/${id}`, t).expect(204);
    expect((await a.get('/favorites', t).expect(200)).body.data.map((v: { id: string }) => v.id)).not.toContain(id);
  });

  it('customer profile, verification documents and support', async () => {
    const t = await tokenFor(ACCOUNTS.newPartner);
    await a.patch('/me', t).send({ fullName: 'Sam Patel', phone: '+919900011122', countryCode: 'IN' }).expect(200);
    const v = await a.get('/me/verification', t).expect(200);
    expect(v.body.data.requiredDocuments).toEqual([
      expect.objectContaining({ documentType: 'driving_licence', label: 'Driving licence' }),
    ]);
    await a
      .post('/me/documents', t)
      .field('documentType', 'passport_or_emirates_id')
      .attach('file', await pngImage(), 'id.png')
      .expect(422);
    const doc = await a
      .post('/me/documents', t)
      .field('documentType', 'driving_licence')
      .attach('file', await pngImage(), 'dl.png')
      .expect(201);
    expect(doc.body.data).toMatchObject({ documentType: 'driving_licence', status: 'submitted' });
    const me = await a.get('/me', t).expect(200);
    expect(me.body.data.profile.verificationStatus).toBe('submitted');
    const support = await a
      .post('/support/requests', t)
      .send({ subject: 'Help please', message: 'I have a question about deposits.' })
      .expect(201);
    expect(support.body.data.status).toBe('open');
    expect((await a.get('/support/requests', t).expect(200)).body.data[0].id).toBe(support.body.data.id);
    // Reset for re-runs.
    await db.deleteFrom('customer_documents').where('user_id', '=', me.body.data.user.id).execute();
    await db
      .updateTable('profiles')
      .set({ full_name: 'Sam Patel', phone: null, country_code: null, verification_status: 'not_started' })
      .where('user_id', '=', me.body.data.user.id)
      .execute();
  });

  it('partner overview & payouts use partner-timezone dates', async () => {
    const o = await a.get('/partner/overview?from=2026-01-01&to=2026-12-31', partner).expect(200);
    expect(o.body.data.period).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(o.body.data.counts.totalVehicles).toBeGreaterThan(0);
    expect(o.body.data.financials.every((f: { currency: string }) => f.currency === 'AED')).toBe(true);
    const p = await a.get('/partner/payouts', partner).expect(200);
    expect(p.body.data[0]).toMatchObject({ currency: 'AED', amount: { currency: 'AED' } });
  });
});
