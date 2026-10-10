import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { createKysely } from '../database/database';
import type { Db } from '../database/database';
import { HOUR_MS } from '../domain/rental-dates';
import { calculatePrice } from '../domain/pricing';
import { loadCountries } from '../modules/catalog/catalog.service';
import { cardPng, carSvg, samplePdf, specsSvg, svgToJpeg } from './assets';
import { loadManifest, photosFor, SeedImage } from './photos';
import { BOOKINGS, CITY, LOCATIONS, PARTNERS, PAYOUTS, seedId, seedReference, USERS, VEHICLES } from './data';

const DAY = 24 * HOUR_MS;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — copy .env.example to .env (see README).`);
  return v;
}

async function ensureUsers(admin: SupabaseClient, password: string): Promise<Map<string, string>> {
  const existing = new Map<string, string>();
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    for (const u of data.users) if (u.email) existing.set(u.email.toLowerCase(), u.id);
    if (data.users.length < 1000) break;
  }
  const ids = new Map<string, string>();
  for (const u of USERS) {
    let id = existing.get(u.email);
    if (id) {
      const { error } = await admin.auth.admin.updateUserById(id, {
        password,
        email_confirm: true,
        user_metadata: { full_name: u.fullName },
      });
      if (error) throw new Error(`update ${u.email}: ${error.message}`);
    } else {
      const { data, error } = await admin.auth.admin.createUser({
        email: u.email,
        password,
        email_confirm: true,
        user_metadata: { full_name: u.fullName },
      });
      if (error || !data.user) throw new Error(`create ${u.email}: ${error?.message}`);
      id = data.user.id;
    }
    ids.set(u.key, id);
  }
  return ids;
}

async function upload(
  admin: SupabaseClient,
  bucket: string,
  path: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const { error } = await admin.storage.from(bucket).upload(path, body, { contentType, upsert: true });
  if (error) throw new Error(`upload ${bucket}/${path}: ${error.message}`);
}

async function seed(): Promise<void> {
  const password = required('SEED_USER_PASSWORD');
  const admin = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket as never },
  });
  const db: Db = createKysely(required('DATABASE_URL'), 4);
  const now = Date.now();

  try {
    console.log('• users');
    const userIds = await ensureUsers(admin, password);
    for (const u of USERS) {
      const uid = userIds.get(u.key)!;
      const values = {
        email: u.email,
        full_name: u.fullName,
        phone: u.phone,
        country_code: u.countryCode,
        city_id: u.cityId,
        is_admin: u.isAdmin ?? false,
      };
      await db
        .insertInto('profiles')
        .values({ user_id: uid, ...values })
        .onConflict((oc) => oc.column('user_id').doUpdateSet(values))
        .execute();
    }

    console.log('• customer verification documents');
    for (const key of ['customer', 'customer_in']) {
      const uid = userIds.get(key)!;
      const u = USERS.find((x) => x.key === key)!;
      const types = u.countryCode === 'AE' ? ['driving_licence', 'passport_or_emirates_id'] : ['driving_licence'];
      for (const t of types) {
        const id = seedId(`cdoc:${key}:${t}`);
        const path = `customers/${uid}/${id}.png`;
        const png = await cardPng(t === 'driving_licence' ? 'Driving licence' : 'Passport / Emirates ID', u.fullName);
        await upload(admin, 'verification-documents', path, png, 'image/png');
        await db
          .insertInto('customer_documents')
          .values({
            id,
            user_id: uid,
            document_type: t,
            storage_path: path,
            file_name: `${t}.png`,
            content_type: 'image/png',
            size_bytes: png.length,
            status: 'approved',
            expires_on: '2030-12-31',
            reviewed_at: new Date(),
          })
          .onConflict((oc) => oc.column('id').doNothing())
          .execute();
      }
      await db.updateTable('profiles').set({ verification_status: 'verified' }).where('user_id', '=', uid).execute();
    }

    console.log('• partners');
    for (const p of PARTNERS) {
      const id = seedId(`partner:${p.key}`);
      const values = {
        legal_name: p.legalName,
        display_name: p.displayName,
        contact_name: p.contactName,
        email: p.email,
        phone: p.phone,
        country_code: p.countryCode,
        city_id: p.cityId,
        address: p.address,
        registration_number: p.registrationNumber,
        status: p.status,
        booking_mode: p.bookingMode,
        verified_at: p.status === 'approved' ? new Date(now - 120 * DAY) : null,
        submitted_at: new Date(now - (p.status === 'approved' ? 125 : 2) * DAY),
      };
      await db
        .insertInto('partners')
        .values({ id, ...values })
        .onConflict((oc) => oc.column('id').doUpdateSet(values))
        .execute();
      await db
        .insertInto('partner_members')
        .values({
          partner_id: id,
          user_id: userIds.get(p.ownerKey)!,
          role: 'owner',
        })
        .onConflict((oc) => oc.column('user_id').doNothing())
        .execute();
      for (const t of p.docs) {
        const docId = seedId(`pdoc:${p.key}:${t}`);
        const path = `partners/${id}/${docId}.pdf`;
        const pdf = samplePdf([p.legalName, t.replace(/_/g, ' ').toUpperCase(), `Reg. no. ${p.registrationNumber}`]);
        await upload(admin, 'verification-documents', path, pdf, 'application/pdf');
        await db
          .insertInto('partner_documents')
          .values({
            id: docId,
            partner_id: id,
            document_type: t,
            storage_path: path,
            file_name: `${t}.pdf`,
            content_type: 'application/pdf',
            size_bytes: pdf.length,
            status: p.status === 'approved' ? 'approved' : 'submitted',
            // One AE document expires soon so the dashboard's "expiring" state has data.
            expires_on:
              p.key === 'desert_drive' && t === 'trade_licence'
                ? new Date(now + 20 * DAY).toISOString().slice(0, 10)
                : '2028-06-30',
            reviewed_at: p.status === 'approved' ? new Date(now - 120 * DAY) : null,
          })
          .onConflict((oc) => oc.column('id').doNothing())
          .execute();
      }
    }

    console.log('• pickup locations');
    for (const l of LOCATIONS) {
      const values = {
        partner_id: seedId(`partner:${l.partnerKey}`),
        city_id: l.cityId,
        name: l.name,
        address: l.address,
        latitude: l.lat,
        longitude: l.lng,
      };
      await db
        .insertInto('pickup_locations')
        .values({ id: seedId(`loc:${l.key}`), ...values })
        .onConflict((oc) => oc.column('id').doUpdateSet(values))
        .execute();
    }

    const manifest = loadManifest();
    let photoCount = 0;
    console.log('• vehicles + images');
    const partnerCountry = new Map(PARTNERS.map((p) => [p.key, p.countryCode]));
    for (const [idx, v] of VEHICLES.entries()) {
      const id = seedId(`vehicle:${v.key}`);
      const country = partnerCountry.get(v.partnerKey)!;
      const currency = country === 'AE' ? 'AED' : 'INR';
      const values = {
        partner_id: seedId(`partner:${v.partnerKey}`),
        city_id: v.cityId,
        pickup_location_id: seedId(`loc:${v.locationKey}`),
        make: v.make,
        model: v.model,
        year: v.year,
        category: v.category,
        transmission: v.transmission,
        fuel_type: v.fuelType,
        seats: v.seats,
        doors: v.doors,
        luggage: v.luggage,
        color: v.color,
        registration_number: v.registration,
        description: v.description,
        features: v.features,
        status: 'published',
        currency,
        daily_rate_minor: v.dailyRate * 100,
        weekly_discount_bps: v.weeklyDiscountBps,
        mileage_limit_km_per_day: v.mileageLimit,
        excess_mileage_fee_minor: v.excessFee,
        fuel_policy: v.fuelPolicy,
        deposit_minor: v.deposit * 100,
        cancellation_policy: v.policy,
        delivery_available: v.delivery,
        delivery_fee_minor: v.deliveryFee * 100,
        min_rental_days: v.minDays,
        buffer_hours: 2,
        insurance_info:
          country === 'AE'
            ? 'Comprehensive insurance included. Excess AED 1,500 per incident; reduce to zero with Super CDW at pickup.'
            : 'Comprehensive insurance included. Excess ₹10,000 per incident; zero-depreciation cover available at pickup.',
        booking_mode: v.bookingMode,
        is_featured: v.featured,
        published_at: new Date(now - (90 - idx) * DAY),
        submitted_at: new Date(now - (92 - idx) * DAY),
      };
      await db
        .insertInto('vehicles')
        .values({ id, ...values })
        .onConflict((oc) => oc.column('id').doUpdateSet(values))
        .execute();

      // Real photos from the manifest when available, otherwise generated illustrations.
      const images: SeedImage[] = (await photosFor(manifest, v.key)) ?? [
        { key: '0', ...(await svgToJpeg(carSvg({ ...v }))) },
        {
          key: '1',
          ...(await svgToJpeg(
            specsSvg({
              make: v.make,
              model: v.model,
              hex: v.hex,
              specs: [
                `${v.seats} seats · ${v.doors} doors · ${v.luggage} bags`,
                `${v.transmission === 'automatic' ? 'Automatic' : 'Manual'} · ${v.fuelType}`,
                v.mileageLimit ? `${v.mileageLimit} km/day included` : 'Unlimited kilometres',
                ...v.features.slice(0, 2),
              ],
            }),
          )),
        },
      ];
      const imageIds = images.map((img) => seedId(`img:${v.key}:${img.key}`));
      // Drop images from a previous seed run that are no longer part of the set (e.g. illustrations → photos).
      const stale = await db
        .deleteFrom('vehicle_images')
        .where('vehicle_id', '=', id)
        .where('id', 'not in', imageIds)
        .returning('storage_path')
        .execute();
      if (stale.length) await admin.storage.from('car-images').remove(stale.map((s) => s.storage_path));
      await db.updateTable('vehicle_images').set({ is_cover: false }).where('vehicle_id', '=', id).execute();
      for (const [i, img] of images.entries()) {
        const imgId = imageIds[i];
        const path = `vehicles/${id}/${imgId}.jpg`;
        await upload(admin, 'car-images', path, img.buffer, 'image/jpeg');
        const row = {
          sort_order: i,
          is_cover: i === 0,
          content_type: 'image/jpeg',
          size_bytes: img.buffer.length,
          width: img.width,
          height: img.height,
        };
        await db
          .insertInto('vehicle_images')
          .values({ id: imgId, vehicle_id: id, bucket: 'car-images', storage_path: path, ...row })
          .onConflict((oc) => oc.column('id').doUpdateSet(row))
          .execute();
      }
      photoCount += manifest.vehicles[v.key]?.length ? 1 : 0;
      const docTypes = country === 'AE' ? ['mulkiya', 'insurance'] : ['registration_certificate', 'insurance'];
      for (const t of docTypes) {
        const docId = seedId(`vdoc:${v.key}:${t}`);
        const path = `vehicles/${id}/${docId}.pdf`;
        const pdf = samplePdf([
          `${v.make} ${v.model} ${v.year}`,
          t.replace(/_/g, ' ').toUpperCase(),
          `Plate ${v.registration}`,
        ]);
        await upload(admin, 'verification-documents', path, pdf, 'application/pdf');
        await db
          .insertInto('vehicle_documents')
          .values({
            id: docId,
            vehicle_id: id,
            document_type: t,
            storage_path: path,
            file_name: `${t}.pdf`,
            content_type: 'application/pdf',
            size_bytes: pdf.length,
            status: 'approved',
            expires_on: '2027-12-31',
            reviewed_at: new Date(now - 90 * DAY),
          })
          .onConflict((oc) => oc.column('id').doNothing())
          .execute();
      }
    }

    console.log(`  ${photoCount}/${VEHICLES.length} vehicles use real photos; the rest use generated illustrations`);
    console.log('• payouts');
    const lastMonthStart = new Date(now - 70 * DAY).toISOString().slice(0, 10);
    const lastMonthEnd = new Date(now - 35 * DAY).toISOString().slice(0, 10);
    for (const p of PAYOUTS) {
      await db
        .insertInto('payouts')
        .values({
          id: seedId(`payout:${p.key}`),
          partner_id: seedId(`partner:${p.partnerKey}`),
          currency: p.partnerKey === 'desert_drive' ? 'AED' : 'INR',
          amount_minor: 0,
          status: p.status,
          period_start: lastMonthStart,
          period_end: lastMonthEnd,
          provider_reference: p.reference,
          paid_at: p.status === 'paid' ? new Date(now - 30 * DAY) : null,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    }

    console.log('• bookings');
    const countries = await loadCountries(db);
    for (const b of BOOKINGS) {
      const id = seedId(`booking:${b.key}`);
      const exists = await db.selectFrom('bookings').select('id').where('id', '=', id).executeTakeFirst();
      if (exists) continue;
      const sv = VEHICLES.find((v) => v.key === b.vehicleKey)!;
      const vehicleId = seedId(`vehicle:${sv.key}`);
      const partnerId = seedId(`partner:${sv.partnerKey}`);
      const countryCode = partnerCountry.get(sv.partnerKey)!;
      const currency = countryCode === 'AE' ? 'AED' : 'INR';
      const customerId = userIds.get(b.customerKey)!;
      const customer = USERS.find((u) => u.key === b.customerKey)!;
      // Round pickup to the hour, 10:00 local-ish.
      const pickup = new Date(Math.floor((now + b.pickupOffsetDays * DAY) / HOUR_MS) * HOUR_MS);
      const ret = new Date(pickup.getTime() + b.days * DAY);
      const price = calculatePrice({
        vehicle: {
          currency,
          dailyRateMinor: sv.dailyRate * 100,
          weeklyDiscountBps: sv.weeklyDiscountBps,
          deliveryFeeMinor: sv.deliveryFee * 100,
          depositMinor: sv.deposit * 100,
          minRentalDays: sv.minDays,
          mileageLimitKmPerDay: sv.mileageLimit,
          excessMileageFeeMinor: sv.excessFee,
        },
        country: countries.get(countryCode)!,
        pickupAt: pickup,
        returnAt: ret,
        delivery: false,
      });
      const created = new Date(pickup.getTime() - (b.status === 'pending_partner' ? 2 * HOUR_MS : 10 * DAY));
      const createdAt = created.getTime() > now ? new Date(now - 2 * HOUR_MS) : created;
      const completed = b.status === 'completed';
      const started = completed || b.status === 'active';
      const payoutId = b.payoutKey ? seedId(`payout:${b.payoutKey}`) : null;

      await db
        .insertInto('bookings')
        .values({
          id,
          reference: seedReference(b.key),
          customer_id: customerId,
          vehicle_id: vehicleId,
          partner_id: partnerId,
          pickup_location_id: seedId(`loc:${sv.locationKey}`),
          pickup_at: pickup,
          return_at: ret,
          buffer_hours: 2,
          delivery: false,
          status: b.status,
          payment_status: b.status === 'pending_partner' ? 'authorized' : 'captured',
          deposit_status: completed ? 'released' : b.status === 'active' ? 'held' : 'not_held',
          booking_mode: sv.bookingMode,
          currency,
          days: price.days,
          daily_rate_minor: price.dailyRateMinor,
          rental_fee_minor: price.rentalFeeMinor,
          delivery_fee_minor: price.deliveryFeeMinor,
          discount_minor: price.discountMinor,
          platform_fee_minor: price.platformFeeMinor,
          tax_minor: price.taxMinor,
          total_minor: price.totalMinor,
          deposit_minor: price.depositMinor,
          commission_minor: price.commissionMinor,
          partner_payout_minor: price.partnerPayoutMinor,
          line_items: JSON.stringify(price.lineItems),
          conditional_charges: JSON.stringify(price.conditionalCharges),
          cancellation_policy: sv.policy,
          driver_full_name: customer.fullName,
          driver_phone: customer.phone ?? '+971500000000',
          driver_date_of_birth: '1990-04-12',
          terms_accepted_at: createdAt,
          hold_expires_at: new Date(createdAt.getTime() + 15 * 60_000),
          partner_response_due_at: b.status === 'pending_partner' ? new Date(now + 22 * HOUR_MS) : null,
          actual_pickup_at: started ? new Date(pickup.getTime() + 20 * 60_000) : null,
          actual_return_at: completed ? new Date(ret.getTime() - 30 * 60_000) : null,
          payout_id: payoutId,
          created_at: createdAt,
        })
        .execute();

      const intent = `pi_mock_${id.replace(/-/g, '')}`;
      await db
        .insertInto('payments')
        .values({
          booking_id: id,
          provider: 'mock',
          provider_reference: intent,
          kind: 'rental',
          status: b.status === 'pending_partner' ? 'authorized' : 'captured',
          amount_minor: price.totalMinor,
          currency,
          created_at: createdAt,
        })
        .execute();

      const events: {
        type: string;
        from: string | null;
        to: string;
        role: string;
        at: Date;
      }[] = [
        {
          type: 'created',
          from: null,
          to: 'held',
          role: 'customer',
          at: createdAt,
        },
      ];
      const paidAt = new Date(createdAt.getTime() + 3 * 60_000);
      if (sv.bookingMode === 'instant') {
        events.push({
          type: 'payment_authorized',
          from: 'held',
          to: 'confirmed',
          role: 'system',
          at: paidAt,
        });
      } else {
        events.push({
          type: 'payment_authorized',
          from: 'held',
          to: 'pending_partner',
          role: 'system',
          at: paidAt,
        });
        if (b.status !== 'pending_partner') {
          events.push({
            type: 'partner_accepted',
            from: 'pending_partner',
            to: 'confirmed',
            role: 'partner',
            at: new Date(paidAt.getTime() + 2 * HOUR_MS),
          });
        }
      }
      if (started) {
        events.push({
          type: 'pickup_recorded',
          from: 'confirmed',
          to: 'active',
          role: 'partner',
          at: new Date(pickup.getTime() + 20 * 60_000),
        });
        const odo = 12000 + Math.floor(Math.random() * 30000);
        await db
          .insertInto('condition_reports')
          .values({
            booking_id: id,
            stage: 'pickup',
            odometer_km: odo,
            fuel_level_pct: 100,
            notes: 'Vehicle clean, no new damage.',
            damages: JSON.stringify([
              {
                area: 'rear bumper',
                severity: 'minor',
                description: 'Light scuff (pre-existing)',
                isNew: false,
              },
            ]),
            customer_checks: JSON.stringify({
              licenceVerified: true,
              identityVerified: true,
            }),
            recorded_by: userIds.get(sv.partnerKey === 'desert_drive' ? 'partner_ae' : 'partner_in')!,
            recorded_at: new Date(pickup.getTime() + 20 * 60_000),
          })
          .execute();
        await db
          .insertInto('payments')
          .values({
            booking_id: id,
            provider: 'mock',
            provider_reference: `dh_mock_${id.replace(/-/g, '')}`,
            kind: 'deposit_hold',
            status: completed ? 'voided' : 'authorized',
            amount_minor: price.depositMinor,
            currency,
          })
          .execute();
        if (completed) {
          events.push({
            type: 'return_recorded',
            from: 'active',
            to: 'completed',
            role: 'partner',
            at: new Date(ret.getTime() - 30 * 60_000),
          });
          await db
            .insertInto('condition_reports')
            .values({
              booking_id: id,
              stage: 'return',
              odometer_km: odo + 180 * b.days,
              fuel_level_pct: 95,
              notes: 'Returned on time.',
              damages: JSON.stringify([]),
              recorded_by: userIds.get(sv.partnerKey === 'desert_drive' ? 'partner_ae' : 'partner_in')!,
              recorded_at: new Date(ret.getTime() - 30 * 60_000),
            })
            .execute();
          await db
            .insertInto('payments')
            .values({
              booking_id: id,
              provider: 'mock',
              provider_reference: `dh_mock_${id.replace(/-/g, '')}_rel`,
              kind: 'deposit_release',
              status: 'succeeded',
              amount_minor: price.depositMinor,
              currency,
            })
            .execute();
        }
      }
      await db
        .insertInto('booking_events')
        .values(
          events.map((e) => ({
            booking_id: id,
            event_type: e.type,
            from_status: e.from,
            to_status: e.to,
            actor_role: e.role,
            data: JSON.stringify({ seeded: true }),
            created_at: e.at,
          })),
        )
        .execute();
    }

    // Payout amounts = sum of the linked bookings' partner payouts.
    for (const p of PAYOUTS) {
      const pid = seedId(`payout:${p.key}`);
      const sum = await db
        .selectFrom('bookings')
        .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('partner_payout_minor'), eb.lit(0)).as('s'))
        .where('payout_id', '=', pid)
        .executeTakeFirstOrThrow();
      await db
        .updateTable('payouts')
        .set({ amount_minor: Number(sum.s) })
        .where('id', '=', pid)
        .execute();
    }

    const counts = await db
      .selectFrom('vehicles')
      .innerJoin('cities', 'cities.id', 'vehicles.city_id')
      .select(['cities.country_code', (eb) => eb.fn.countAll<number>().as('n')])
      .where('vehicles.status', '=', 'published')
      .groupBy('cities.country_code')
      .execute();
    console.log(`✓ Seed complete. Published vehicles: ${counts.map((c) => `${c.country_code}=${c.n}`).join(', ')}`);
    console.log(`  Accounts: ${USERS.map((u) => u.email).join(', ')} (password: SEED_USER_PASSWORD from .env)`);
    void CITY;
  } finally {
    await db.destroy();
  }
}

seed().catch((err: unknown) => {
  console.error('✗ Seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
