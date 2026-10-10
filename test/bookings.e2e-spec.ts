import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Db } from '../src/database/database';
import {
  ACCOUNTS,
  api,
  book,
  createApp,
  createPublishedVehicle,
  freshUserToken,
  fromNow,
  H,
  pngImage,
  tokenFor,
} from './helpers';

describe('Bookings (e2e)', () => {
  let app: INestApplication;
  let db: Db;
  let a: ReturnType<typeof api>;
  let customer: string;
  let partner: string;

  beforeAll(async () => {
    ({ app, db } = await createApp());
    a = api(app);
    customer = await tokenFor(ACCOUNTS.customer);
    partner = await tokenFor(ACCOUNTS.partnerAe);
  });
  afterAll(async () => app.close());

  it('full request-mode flow: quote → book → pay → accept → pickup → return → completed → earnings → payout', async () => {
    const vehicleId = await createPublishedVehicle(app, { bookingMode: 'request', dailyRateMinor: 20000 });

    // Search with dates includes the vehicle with an estimated total.
    const pickupAt = fromNow(3);
    const returnAt = new Date(new Date(pickupAt).getTime() + 48 * H).toISOString();
    const search = await a
      .get(
        `/vehicles?countryCode=AE&pickupAt=${encodeURIComponent(pickupAt)}&returnAt=${encodeURIComponent(returnAt)}&pageSize=100&category=sedan`,
      )
      .expect(200);
    const hit = search.body.data.find((v: { id: string }) => v.id === vehicleId);
    expect(hit).toBeDefined();
    expect(hit.days).toBe(2);
    expect(hit.estimatedTotal).toEqual({ amountMinor: 44100, currency: 'AED' }); // 40000 + 2000 fee + 2100 VAT

    const detail = await a
      .get(`/vehicles/${vehicleId}?pickupAt=${encodeURIComponent(pickupAt)}&returnAt=${encodeURIComponent(returnAt)}`)
      .expect(200);
    expect(detail.body.data).toMatchObject({
      bookingMode: 'request',
      availability: { checked: true, available: true },
      timezone: 'Asia/Dubai',
    });

    // Quote.
    const quote = await a
      .post('/bookings/quote', customer)
      .send({ vehicleId, pickupAt, returnAt, delivery: { enabled: false } })
      .expect(200);
    expect(quote.body.data).toMatchObject({
      days: 2,
      total: { amountMinor: 44100, currency: 'AED' },
      deposit: { amountMinor: 100000, currency: 'AED' },
      bookingMode: 'request',
    });
    expect(quote.body.data.lineItems.map((l: { code: string }) => l.code)).toEqual([
      'rental_fee',
      'platform_fee',
      'tax',
    ]);

    // Book (idempotent).
    const key = randomUUID();
    const body = {
      quoteId: quote.body.data.id,
      driver: { fullName: 'Aisha Khan', phone: '+971501234567', dateOfBirth: '1992-05-01' },
      termsAccepted: true,
    };
    const created = await a.post('/bookings', customer).set('Idempotency-Key', key).send(body).expect(201);
    const { booking, payment } = created.body.data;
    expect(booking).toMatchObject({
      status: 'held',
      paymentStatus: 'unpaid',
      reference: expect.stringMatching(/^RV-[A-Z0-9]{6}$/),
    });
    expect(booking.allowedActions).toEqual(['pay', 'cancel', 'contact_support']);
    // CONTRACTS v1.3: the open intent is resumable from the booking itself.
    expect(booking.payment).toEqual({ ...payment, status: 'requires_confirmation' });
    const resumed = await a.get(`/bookings/${booking.id}`, customer).expect(200);
    expect(resumed.body.data.payment).toMatchObject({
      intentId: payment.intentId,
      clientSecret: payment.clientSecret,
      amount: payment.amount,
    });
    expect(payment).toMatchObject({
      provider: 'mock',
      status: 'requires_confirmation',
      amount: { amountMinor: 44100, currency: 'AED' },
    });

    // Replay with the same key → identical result, no second booking.
    const replay = await a.post('/bookings', customer).set('Idempotency-Key', key).send(body).expect(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.booking.id).toBe(booking.id);
    const count = await db
      .selectFrom('bookings')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('vehicle_id', '=', vehicleId)
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);
    // Same key, different body → 409.
    const conflict = await a
      .post('/bookings', customer)
      .set('Idempotency-Key', key)
      .send({ ...body, driver: { ...body.driver, fullName: 'Someone Else' } })
      .expect(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    // Partners don't see unpaid holds.
    await a.get(`/partner/bookings/${booking.id}`, partner).expect(404);

    // Pay → pending_partner.
    const payKey = randomUUID();
    const paid = await a
      .post(`/bookings/${booking.id}/payment/confirm`, customer)
      .set('Idempotency-Key', payKey)
      .send({ intentId: payment.intentId })
      .expect(200);
    expect(paid.body.data).toMatchObject({ status: 'pending_partner', paymentStatus: 'authorized' });
    expect(paid.body.data.partnerResponseDueAt).toBeTruthy();
    expect(paid.body.data.allowedActions).toEqual(['cancel', 'contact_support']);
    expect(paid.body.data.payment).toBeNull();
    const paidReplay = await a
      .post(`/bookings/${booking.id}/payment/confirm`, customer)
      .set('Idempotency-Key', payKey)
      .send({ intentId: payment.intentId })
      .expect(200);
    expect(paidReplay.body.data.status).toBe('pending_partner');
    // A second, new payment attempt is an illegal transition.
    expect(
      (
        await a
          .post(`/bookings/${booking.id}/payment/confirm`, customer)
          .send({ intentId: payment.intentId })
          .expect(409)
      ).body.error.code,
    ).toBe('INVALID_STATE_TRANSITION');

    // Partner sees it as pending with accept/reject.
    const pending = await a.get('/partner/bookings?filter=pending&pageSize=100', partner).expect(200);
    const row = pending.body.data.find((b: { id: string }) => b.id === booking.id);
    expect(row).toMatchObject({
      status: 'pending_partner',
      nextAction: 'respond',
      partnerPayout: { amountMinor: 34000, currency: 'AED' },
      customer: { displayName: 'Aisha K.' },
    });
    const pb = await a.get(`/partner/bookings/${booking.id}`, partner).expect(200);
    expect(pb.body.data.allowedActions).toEqual(['accept', 'reject', 'cancel']);
    expect(pb.body.data).not.toHaveProperty('payment'); // never shown to partners
    expect(pb.body.data.customer.phone).toBeNull(); // not shared until confirmed

    // Accept (idempotent) → confirmed + captured.
    const acceptKey = randomUUID();
    const accepted = await a
      .post(`/partner/bookings/${booking.id}/accept`, partner)
      .set('Idempotency-Key', acceptKey)
      .expect(200);
    expect(accepted.body.data).toMatchObject({ status: 'confirmed', paymentStatus: 'captured' });
    expect(accepted.body.data.customer.phone).toBe('+971501234567');
    await a.post(`/partner/bookings/${booking.id}/accept`, partner).set('Idempotency-Key', acceptKey).expect(200);
    expect((await a.post(`/partner/bookings/${booking.id}/accept`, partner).expect(409)).body.error.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
    const cust = await a.get(`/bookings/${booking.id}`, customer).expect(200);
    expect(cust.body.data).toMatchObject({ status: 'confirmed', paymentStatus: 'captured' });
    expect(cust.body.data.events.map((e: { type: string }) => e.type)).toEqual([
      'created',
      'payment_authorized',
      'partner_accepted',
    ]);
    expect(
      (await a.get('/bookings?group=upcoming&pageSize=100', customer).expect(200)).body.data.map(
        (b: { id: string }) => b.id,
      ),
    ).toContain(booking.id);

    // Pickup: checks must be true.
    await a
      .post(`/partner/bookings/${booking.id}/pickup`, partner)
      .send({
        odometerKm: 1000,
        fuelLevelPct: 100,
        damages: [],
        customerChecks: { licenceVerified: false, identityVerified: true },
      })
      .expect(400);
    await a
      .post(`/partner/bookings/${booking.id}/evidence`, partner)
      .field('stage', 'pickup')
      .attach('file', await pngImage('#aa0000'), 'front.png')
      .expect(201);
    const picked = await a
      .post(`/partner/bookings/${booking.id}/pickup`, partner)
      .set('Idempotency-Key', randomUUID())
      .send({
        odometerKm: 1000,
        fuelLevelPct: 100,
        notes: 'ok',
        damages: [{ area: 'front bumper', severity: 'minor', description: 'scratch', isNew: false }],
        customerChecks: { licenceVerified: true, identityVerified: true },
      })
      .expect(200);
    expect(picked.body.data).toMatchObject({
      status: 'active',
      depositStatus: 'held',
      pickupReport: { odometerKm: 1000, fuelLevelPct: 100, photoCount: 1 },
    });
    expect(picked.body.data.allowedActions).toEqual(['record_return']);

    const evidence = await a.get(`/partner/bookings/${booking.id}/evidence`, partner).expect(200);
    expect(evidence.body.data).toHaveLength(1);
    expect(evidence.body.data[0].url).toContain('token=');

    // Return: odometer can't go backwards.
    expect(
      (
        await a
          .post(`/partner/bookings/${booking.id}/return`, partner)
          .send({ odometerKm: 999, fuelLevelPct: 90, damages: [] })
          .expect(422)
      ).body.error.code,
    ).toBe('VALIDATION_FAILED');
    const returned = await a
      .post(`/partner/bookings/${booking.id}/return`, partner)
      .set('Idempotency-Key', randomUUID())
      .send({ odometerKm: 1350, fuelLevelPct: 90, damages: [] })
      .expect(200);
    expect(returned.body.data).toMatchObject({
      status: 'completed',
      depositStatus: 'released',
      returnReport: { odometerKm: 1350 },
    });
    const done = await a.get(`/bookings/${booking.id}`, customer).expect(200);
    expect(done.body.data).toMatchObject({ status: 'completed', allowedActions: ['contact_support'] });

    // Audit log has every transition.
    const events = await db
      .selectFrom('booking_events')
      .select(['event_type', 'from_status', 'to_status'])
      .where('booking_id', '=', booking.id)
      .orderBy('created_at')
      .execute();
    expect(events.map((e) => `${e.from_status}->${e.to_status}`)).toEqual([
      'null->held',
      'held->pending_partner',
      'pending_partner->confirmed',
      'confirmed->active',
      'active->completed',
    ]);

    // Earnings include it (unpaid), then a payout picks it up.
    const earnings = await a.get('/partner/earnings?pageSize=100', partner).expect(200);
    const tx = earnings.body.data.transactions.find((t: { bookingId: string }) => t.bookingId === booking.id);
    expect(tx).toMatchObject({
      gross: { amountMinor: 40000, currency: 'AED' },
      commission: { amountMinor: 6000, currency: 'AED' },
      net: { amountMinor: 34000, currency: 'AED' },
      status: 'unpaid',
      type: 'rental',
    });
    expect(earnings.body.meta).toMatchObject({ page: 1, pageSize: 100 });
    const csv = await a.get('/partner/earnings/export.csv', partner).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain(booking.reference);

    const admin = await tokenFor(ACCOUNTS.admin);
    const today = new Date().toISOString().slice(0, 10);
    const gen = await a
      .post('/admin/payouts/generate', admin)
      .send({ periodStart: today, periodEnd: today })
      .expect(200);
    const mine = gen.body.data.find(
      (p: { partnerId: string; currency: string }) => p.currency === 'AED' && p.partnerId,
    );
    expect(mine.amount.amountMinor).toBeGreaterThanOrEqual(34000);
    await a.post(`/admin/payouts/${mine.id}/mark-paid`, admin).send({ reference: 'TRF-E2E-1' }).expect(200);
    const after = await a.get('/partner/earnings?pageSize=100', partner).expect(200);
    expect(after.body.data.transactions.find((t: { bookingId: string }) => t.bookingId === booking.id).status).toBe(
      'paid',
    );
    const payouts = await a.get('/partner/payouts?status=paid', partner).expect(200);
    expect(payouts.body.data.map((p: { id: string }) => p.id)).toContain(mine.id);
  });

  it('instant booking: payment confirms immediately and captures', async () => {
    const vehicleId = await createPublishedVehicle(app, { bookingMode: 'instant' });
    const { booking } = await book(app, vehicleId, { pay: true });
    expect(booking).toMatchObject({ status: 'confirmed', paymentStatus: 'captured', bookingMode: 'instant' });
  });

  it('partner rejection voids the authorization and requires a reason', async () => {
    const vehicleId = await createPublishedVehicle(app);
    const { bookingId } = await book(app, vehicleId, { pay: true });
    await a.post(`/partner/bookings/${bookingId}/reject`, partner).send({ reason: 'no' }).expect(400);
    const res = await a
      .post(`/partner/bookings/${bookingId}/reject`, partner)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Car is in the workshop' })
      .expect(200);
    expect(res.body.data).toMatchObject({
      status: 'rejected',
      paymentStatus: 'voided',
      rejectionReason: 'Car is in the workshop',
      refund: { amountMinor: res.body.data.total.amountMinor },
    });
    const c = await a.get(`/bookings/${bookingId}`, customer).expect(200);
    expect(c.body.data.status).toBe('rejected');
    // Dates are free again.
    await book(app, vehicleId);
  });

  it('payment failure keeps the hold and returns 402 with the booking; retry succeeds', async () => {
    const vehicleId = await createPublishedVehicle(app, { bookingMode: 'instant' });
    const { bookingId, intentId } = await book(app, vehicleId);
    const failed = await a
      .post(`/bookings/${bookingId}/payment/confirm`, customer)
      .send({ intentId, simulateOutcome: 'fail' })
      .expect(402);
    expect(failed.body.error.code).toBe('PAYMENT_FAILED');
    expect(failed.body.error.details.booking).toMatchObject({ id: bookingId, status: 'held', paymentStatus: 'failed' });
    expect(failed.body.error.details.booking.allowedActions).toContain('pay');
    expect(failed.body.error.details.booking.payment).toMatchObject({ intentId, status: 'failed' });
    const ok = await a.post(`/bookings/${bookingId}/payment/confirm`, customer).send({ intentId }).expect(200);
    expect(ok.body.data.status).toBe('confirmed');
    expect(ok.body.data.payment).toBeNull();
  });

  it('hold expiry: lazily expires, blocks payment and frees the dates', async () => {
    const vehicleId = await createPublishedVehicle(app);
    const { bookingId, intentId } = await book(app, vehicleId, { pickupInHours: 30 });
    await db
      .updateTable('bookings')
      .set({ hold_expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', bookingId)
      .execute();
    const res = await a.post(`/bookings/${bookingId}/payment/confirm`, customer).send({ intentId }).expect(409);
    expect(res.body.error.code).toBe('HOLD_EXPIRED');
    const b = await a.get(`/bookings/${bookingId}`, customer).expect(200);
    expect(b.body.data).toMatchObject({
      status: 'expired',
      paymentStatus: 'voided',
      allowedActions: ['contact_support'],
    });
    expect(b.body.data.events.map((e: { type: string }) => e.type)).toContain('hold_expired');
    await book(app, vehicleId, { pickupInHours: 30 }); // same dates bookable again
  });

  it('partner response deadline expiry via the expiry job', async () => {
    const vehicleId = await createPublishedVehicle(app);
    const { bookingId } = await book(app, vehicleId, { pay: true });
    await db
      .updateTable('bookings')
      .set({ partner_response_due_at: new Date(Date.now() - 1000) })
      .where('id', '=', bookingId)
      .execute();
    const p = await a.get(`/partner/bookings/${bookingId}`, partner).expect(200);
    expect(p.body.data).toMatchObject({ status: 'expired', paymentStatus: 'voided', allowedActions: [] });
  });

  it('double booking is rejected (sequential)', async () => {
    const vehicleId = await createPublishedVehicle(app);
    const first = await book(app, vehicleId, { pickupInHours: 50 });
    const res = await a
      .post('/bookings/quote', await tokenFor(ACCOUNTS.customerIn))
      .send({ vehicleId, pickupAt: first.pickupAt, returnAt: first.returnAt })
      .expect(409);
    expect(res.body.error.code).toBe('VEHICLE_UNAVAILABLE');
    // Overlap within the 2h buffer after return is also blocked…
    const inBuffer = new Date(new Date(first.returnAt).getTime() + H).toISOString();
    await a
      .post('/bookings/quote', customer)
      .send({ vehicleId, pickupAt: inBuffer, returnAt: new Date(new Date(inBuffer).getTime() + 30 * H).toISOString() })
      .expect(409);
    // …but right after the buffer is fine.
    const afterBuffer = new Date(new Date(first.returnAt).getTime() + 2 * H).toISOString();
    await a
      .post('/bookings/quote', customer)
      .send({
        vehicleId,
        pickupAt: afterBuffer,
        returnAt: new Date(new Date(afterBuffer).getTime() + 30 * H).toISOString(),
      })
      .expect(200);
    // Search hides it for the taken dates.
    const s = await a
      .get(
        `/vehicles?countryCode=AE&pageSize=100&pickupAt=${encodeURIComponent(first.pickupAt)}&returnAt=${encodeURIComponent(first.returnAt)}`,
      )
      .expect(200);
    expect(s.body.data.map((v: { id: string }) => v.id)).not.toContain(vehicleId);
  });

  it('double booking is rejected for two concurrent requests', async () => {
    const vehicleId = await createPublishedVehicle(app);
    const pickupAt = fromNow(72);
    const returnAt = new Date(new Date(pickupAt).getTime() + 48 * H).toISOString();
    const tokens = [await tokenFor(ACCOUNTS.customer), await tokenFor(ACCOUNTS.customerIn)];
    // Both quotes succeed (no booking exists yet)…
    const quotes = await Promise.all(
      tokens.map((t) => a.post('/bookings/quote', t).send({ vehicleId, pickupAt, returnAt }).expect(200)),
    );
    // …then both try to book at the same moment.
    const results = await Promise.all(
      tokens.map((t, i) =>
        a.post('/bookings', t).send({
          quoteId: quotes[i].body.data.id,
          driver: { fullName: 'Racer', phone: '+971501112233', dateOfBirth: '1990-01-01' },
          termsAccepted: true,
        }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('VEHICLE_UNAVAILABLE');
    const n = await db
      .selectFrom('bookings')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('vehicle_id', '=', vehicleId)
      .executeTakeFirstOrThrow();
    expect(Number(n.n)).toBe(1);
  });

  it('the EXCLUDE constraint rejects an overlapping row even when written directly to the DB', async () => {
    const vehicleId = await createPublishedVehicle(app);
    const { bookingId } = await book(app, vehicleId, { pickupInHours: 100 });
    const row = await db.selectFrom('bookings').selectAll().where('id', '=', bookingId).executeTakeFirstOrThrow();
    const { id: _id, blocking_period: _bp, reference: _r, created_at: _c, updated_at: _u, ...rest } = row;
    void _id;
    void _bp;
    void _r;
    void _c;
    void _u;
    await expect(
      db
        .insertInto('bookings')
        .values({
          ...rest,
          reference: 'RV-ZZZZZ9',
          pickup_at: new Date(row.pickup_at.getTime() + H),
          line_items: JSON.stringify(row.line_items),
          conditional_charges: JSON.stringify(row.conditional_charges),
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23P01', constraint: 'bookings_no_overlap' });
  });

  it('availability blocks: conflicts with bookings (incl. buffer) and blocks; hides the car from search', async () => {
    const vehicleId = await createPublishedVehicle(app);
    const { pickupAt, returnAt, bookingId } = await book(app, vehicleId, { pickupInHours: 24 * 10, hours: 48 });
    // Inside the post-return buffer → conflict with the booking.
    const startInBuffer = new Date(new Date(returnAt).getTime() + H).toISOString();
    const c1 = await a
      .post(`/partner/vehicles/${vehicleId}/availability`, partner)
      .send({
        startsAt: startInBuffer,
        endsAt: new Date(new Date(startInBuffer).getTime() + 24 * H).toISOString(),
        reason: 'maintenance',
      })
      .expect(409);
    expect(c1.body.error.code).toBe('AVAILABILITY_CONFLICT');
    expect(c1.body.error.details.conflicts.bookings.map((b: { id: string }) => b.id)).toEqual([bookingId]);
    // A free window works.
    const start = new Date(new Date(returnAt).getTime() + 5 * 24 * H).toISOString();
    const end = new Date(new Date(start).getTime() + 48 * H).toISOString();
    const block = await a
      .post(`/partner/vehicles/${vehicleId}/availability`, partner)
      .send({ startsAt: start, endsAt: end, reason: 'maintenance', note: 'Service' })
      .expect(201);
    // Overlapping another block → conflict.
    const c2 = await a
      .post(`/partner/vehicles/${vehicleId}/availability`, partner)
      .send({ startsAt: new Date(new Date(start).getTime() + H).toISOString(), endsAt: end, reason: 'other' })
      .expect(409);
    expect(c2.body.error.details.conflicts.blocks).toHaveLength(1);
    // Calendar view.
    const cal = await a
      .get(`/partner/vehicles/${vehicleId}/availability?from=${new Date().toISOString().slice(0, 10)}`, partner)
      .expect(200);
    expect(cal.body.data).toMatchObject({ timezone: 'Asia/Dubai', bufferHours: 2 });
    expect(cal.body.data.blocks.map((b: { id: string }) => b.id)).toContain(block.body.data.id);
    expect(cal.body.data.bookings.map((b: { id: string }) => b.id)).toContain(bookingId);
    // Customers can't book or find it for blocked dates.
    expect(
      (await a.post('/bookings/quote', customer).send({ vehicleId, pickupAt: start, returnAt: end }).expect(409)).body
        .error.code,
    ).toBe('VEHICLE_UNAVAILABLE');
    const s = await a
      .get(
        `/vehicles?countryCode=AE&pageSize=100&pickupAt=${encodeURIComponent(start)}&returnAt=${encodeURIComponent(end)}`,
      )
      .expect(200);
    expect(s.body.data.map((v: { id: string }) => v.id)).not.toContain(vehicleId);
    // Deleting the block frees it.
    await a.delete(`/partner/vehicles/${vehicleId}/availability/${block.body.data.id}`, partner).expect(204);
    await a.post('/bookings/quote', customer).send({ vehicleId, pickupAt: start, returnAt: end }).expect(200);
    void pickupAt;
  });

  it('customer cancellation: preview and policy fee (moderate, < 72h → 50% of rental)', async () => {
    const vehicleId = await createPublishedVehicle(app, {
      bookingMode: 'instant',
      policy: 'moderate',
      dailyRateMinor: 30000,
    });
    const { bookingId } = await book(app, vehicleId, { pay: true, pickupInHours: 10, hours: 48 });
    const preview = await a.get(`/bookings/${bookingId}/cancellation-preview`, customer).expect(200);
    expect(preview.body.data).toMatchObject({
      eligible: true,
      free: false,
      fee: { amountMinor: 30000, currency: 'AED' },
    });
    const res = await a
      .post(`/bookings/${bookingId}/cancel`, customer)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Plans changed' })
      .expect(200);
    expect(res.body.data).toMatchObject({
      status: 'cancelled',
      paymentStatus: 'partially_refunded',
      cancellationFee: { amountMinor: 30000 },
      refund: { amountMinor: res.body.data.total.amountMinor - 30000 },
      allowedActions: ['contact_support'],
    });
    await a.post(`/bookings/${bookingId}/cancel`, customer).send({}).expect(409);
    // Partner earns the retained fee net of commission.
    const e = await a.get('/partner/earnings?pageSize=100', partner).expect(200);
    expect(e.body.data.transactions.find((t: { bookingId: string }) => t.bookingId === bookingId)).toMatchObject({
      type: 'cancellation_fee',
      net: { amountMinor: 25500 },
    });
  });

  it('cancelling a held booking is free; partner cancellation refunds in full', async () => {
    const v1 = await createPublishedVehicle(app);
    const held = await book(app, v1);
    const r1 = await a.post(`/bookings/${held.bookingId}/cancel`, customer).send({}).expect(200);
    expect(r1.body.data).toMatchObject({
      status: 'cancelled',
      paymentStatus: 'voided',
      cancellationFee: { amountMinor: 0 },
      refund: { amountMinor: 0 },
    });

    const v2 = await createPublishedVehicle(app, { bookingMode: 'instant', policy: 'strict' });
    const conf = await book(app, v2, { pay: true });
    await a.post(`/partner/bookings/${conf.bookingId}/cancel`, partner).send({ reason: 'x' }).expect(400);
    const r2 = await a
      .post(`/partner/bookings/${conf.bookingId}/cancel`, partner)
      .send({ reason: 'Vehicle damaged yesterday' })
      .expect(200);
    expect(r2.body.data).toMatchObject({
      status: 'cancelled',
      paymentStatus: 'refunded',
      cancelledBy: 'partner',
      refund: { amountMinor: r2.body.data.total.amountMinor },
    });
  });

  it('booking guards: quote expiry, ownership, driver age, verification, date rules', async () => {
    const vehicleId = await createPublishedVehicle(app);
    const pickupAt = fromNow(200);
    const returnAt = new Date(new Date(pickupAt).getTime() + 24 * H).toISOString();
    const q = await a.post('/bookings/quote', customer).send({ vehicleId, pickupAt, returnAt }).expect(200);
    const driver = { fullName: 'Young Driver', phone: '+971501112233', dateOfBirth: '2010-01-01' };
    const young = await a
      .post('/bookings', customer)
      .send({ quoteId: q.body.data.id, driver, termsAccepted: true })
      .expect(422);
    expect(young.body.error.details.reason).toBe('driver_age');
    // Another user's quote is invisible.
    await a
      .post('/bookings', await tokenFor(ACCOUNTS.customerIn))
      .send({ quoteId: q.body.data.id, driver: { ...driver, dateOfBirth: '1990-01-01' }, termsAccepted: true })
      .expect(404);
    // Terms must be accepted.
    await a
      .post('/bookings', customer)
      .send({ quoteId: q.body.data.id, driver: { ...driver, dateOfBirth: '1990-01-01' }, termsAccepted: false })
      .expect(400);
    // Expired quote.
    await db
      .updateTable('booking_quotes')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', q.body.data.id)
      .execute();
    const exp = await a
      .post('/bookings', customer)
      .send({ quoteId: q.body.data.id, driver: { ...driver, dateOfBirth: '1990-01-01' }, termsAccepted: true })
      .expect(409);
    expect(exp.body.error.code).toBe('QUOTE_EXPIRED');
    // Unverified customer (a fresh user has no profile details or documents).
    const fresh = await freshUserToken();
    const q2 = await a.post('/bookings/quote', fresh).send({ vehicleId, pickupAt, returnAt }).expect(200);
    const unverified = await a
      .post('/bookings', fresh)
      .send({ quoteId: q2.body.data.id, driver: { ...driver, dateOfBirth: '1990-01-01' }, termsAccepted: true })
      .expect(422);
    expect(['profile_incomplete', 'verification_required']).toContain(unverified.body.error.details.reason);
    // Date validation.
    const tooSoon = await a
      .post('/bookings/quote', customer)
      .send({ vehicleId, pickupAt: fromNow(1), returnAt: fromNow(30) })
      .expect(422);
    expect(tooSoon.body.error.details.fields.pickupAt).toBeDefined();
    await a
      .post('/bookings/quote', customer)
      .send({ vehicleId, pickupAt: fromNow(5), returnAt: fromNow(5 + 24 * 31) })
      .expect(422);
    await a
      .post('/bookings/quote', customer)
      .send({ vehicleId, pickupAt: fromNow(5), returnAt: fromNow(20) })
      .expect(422);
  });

  it('pickup cannot be recorded more than 6h before the scheduled pickup', async () => {
    const vehicleId = await createPublishedVehicle(app, { bookingMode: 'instant' });
    const { bookingId } = await book(app, vehicleId, { pay: true, pickupInHours: 30 });
    const res = await a
      .post(`/partner/bookings/${bookingId}/pickup`, partner)
      .send({
        odometerKm: 1,
        fuelLevelPct: 50,
        damages: [],
        customerChecks: { licenceVerified: true, identityVerified: true },
      })
      .expect(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(res.body.error.details.opensAt).toBeDefined();
  });
});
