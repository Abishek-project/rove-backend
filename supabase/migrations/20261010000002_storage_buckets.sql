-- Storage buckets (CONTRACTS §5). All uploads go through the backend (service role);
-- no storage.objects policies are created, so clients cannot read/write private buckets directly.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('car-images',             'car-images',             true,  10485760, array['image/jpeg', 'image/png', 'image/webp']),
  ('partner-assets',         'partner-assets',         true,  10485760, array['image/jpeg', 'image/png', 'image/webp']),
  ('verification-documents', 'verification-documents', false, 15728640, array['application/pdf', 'image/jpeg', 'image/png']),
  ('booking-evidence',       'booking-evidence',       false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
