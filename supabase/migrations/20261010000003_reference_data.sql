-- Reference data (CONTRACTS §4). City ids are fixed so that clients' mock data and tests can use them.
insert into public.countries (code, name, currency_code, default_timezone, tax_label, tax_rate_bps, platform_fee_bps, commission_bps, payment_methods)
values
  ('IN', 'India',                'INR', 'Asia/Kolkata', 'GST', 1800, 500, 1500, array['card', 'upi']),
  ('AE', 'United Arab Emirates', 'AED', 'Asia/Dubai',   'VAT',  500, 500, 1500, array['card', 'apple_pay'])
on conflict (code) do nothing;

insert into public.cities (id, country_code, name, slug, timezone)
values
  ('c1a00000-0000-4000-8000-000000000001', 'AE', 'Dubai',          'dubai',          'Asia/Dubai'),
  ('c1a00000-0000-4000-8000-000000000002', 'AE', 'Abu Dhabi',      'abu-dhabi',      'Asia/Dubai'),
  ('c1a00000-0000-4000-8000-000000000003', 'AE', 'Sharjah',        'sharjah',        'Asia/Dubai'),
  ('c1a00000-0000-4000-8000-000000000004', 'AE', 'Ras Al Khaimah', 'ras-al-khaimah', 'Asia/Dubai'),
  ('c1b00000-0000-4000-8000-000000000001', 'IN', 'Mumbai',         'mumbai',         'Asia/Kolkata'),
  ('c1b00000-0000-4000-8000-000000000002', 'IN', 'Bengaluru',      'bengaluru',      'Asia/Kolkata'),
  ('c1b00000-0000-4000-8000-000000000003', 'IN', 'New Delhi',      'new-delhi',      'Asia/Kolkata'),
  ('c1b00000-0000-4000-8000-000000000004', 'IN', 'Goa',            'goa',            'Asia/Kolkata')
on conflict (id) do nothing;

insert into public.document_requirements (country_code, scope, document_type, label, is_required)
values
  ('IN', 'customer', 'driving_licence',          'Driving licence',            true),
  ('AE', 'customer', 'driving_licence',          'Driving licence',            true),
  ('AE', 'customer', 'passport_or_emirates_id',  'Passport or Emirates ID',    true),
  ('IN', 'partner',  'business_registration',    'Business registration',      true),
  ('IN', 'partner',  'gst_certificate',          'GST certificate',            true),
  ('IN', 'partner',  'owner_id',                 'Owner ID',                   true),
  ('AE', 'partner',  'trade_licence',            'Trade licence',              true),
  ('AE', 'partner',  'vat_certificate',          'VAT certificate',            true),
  ('AE', 'partner',  'owner_id',                 'Owner ID',                   true),
  ('IN', 'vehicle',  'registration_certificate', 'Registration certificate (RC)', true),
  ('IN', 'vehicle',  'insurance',                'Insurance',                  true),
  ('AE', 'vehicle',  'mulkiya',                  'Mulkiya (vehicle registration)', true),
  ('AE', 'vehicle',  'insurance',                'Insurance',                  true)
on conflict (country_code, scope, document_type) do nothing;
