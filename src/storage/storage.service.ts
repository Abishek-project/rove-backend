import { Injectable, Logger } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { AppConfig } from '../config/app-config';
import { AppException } from '../common/errors/app-exception';

export type Bucket = 'car-images' | 'partner-assets' | 'verification-documents' | 'booking-evidence';
export const PUBLIC_BUCKETS: ReadonlySet<Bucket> = new Set(['car-images', 'partner-assets']);

/** Supabase Storage via the service role. Server-only; clients never get this client. */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: ReturnType<typeof createClient>;
  private readonly internalBase: string;
  private readonly publicBase: string;

  constructor(private readonly config: AppConfig) {
    this.internalBase = config.supabaseUrl;
    this.publicBase = (config.get('STORAGE_PUBLIC_URL') || config.supabaseUrl).replace(/\/$/, '');
    this.client = createClient(config.supabaseUrl, config.get('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      // Realtime is unused, but supabase-js needs a WebSocket implementation on Node 20.
      realtime: { transport: WebSocket as never },
    });
  }

  get admin(): ReturnType<typeof createClient> {
    return this.client;
  }

  async upload(bucket: Bucket, path: string, body: Buffer, contentType: string, upsert = false): Promise<void> {
    const { error } = await this.client.storage.from(bucket).upload(path, body, {
      contentType,
      upsert,
      cacheControl: PUBLIC_BUCKETS.has(bucket) ? '31536000' : '0',
    });
    if (error) {
      this.logger.error(`Upload to ${bucket} failed: ${error.message}`);
      throw new AppException('SERVICE_UNAVAILABLE', 'File storage is unavailable. Please try again.');
    }
  }

  /** Best-effort delete; failures are logged for manual cleanup (CONTRACTS §5). */
  async remove(bucket: Bucket, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    try {
      const { error } = await this.client.storage.from(bucket).remove(paths);
      if (error) throw error;
    } catch (err) {
      this.logger.error(
        `STORAGE_CLEANUP_NEEDED bucket=${bucket} paths=${JSON.stringify(paths)} error=${(err as Error).message}`,
      );
    }
  }

  publicUrl(bucket: Bucket, path: string): string {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return `${this.publicBase}/storage/v1/object/public/${bucket}/${encoded}`;
  }

  /** Signed URL for a private object. Callers must authorize before calling. */
  async signedUrl(bucket: Bucket, path: string): Promise<{ url: string; expiresAt: string }> {
    const ttl = this.config.get('SIGNED_URL_TTL_SECONDS');
    const { data, error } = await this.client.storage.from(bucket).createSignedUrl(path, ttl);
    if (error || !data) {
      this.logger.error(`Signing ${bucket} object failed: ${error?.message}`);
      throw new AppException('SERVICE_UNAVAILABLE', 'File storage is unavailable. Please try again.');
    }
    return {
      url: this.rebase(data.signedUrl),
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  async signedUrls(bucket: Bucket, paths: string[]): Promise<Map<string, { url: string; expiresAt: string }>> {
    const out = new Map<string, { url: string; expiresAt: string }>();
    if (paths.length === 0) return out;
    const ttl = this.config.get('SIGNED_URL_TTL_SECONDS');
    const { data, error } = await this.client.storage.from(bucket).createSignedUrls(paths, ttl);
    if (error || !data) {
      this.logger.error(`Signing ${bucket} objects failed: ${error?.message}`);
      throw new AppException('SERVICE_UNAVAILABLE', 'File storage is unavailable. Please try again.');
    }
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    for (const item of data) {
      if (item.path && item.signedUrl) out.set(item.path, { url: this.rebase(item.signedUrl), expiresAt });
    }
    return out;
  }

  private rebase(url: string): string {
    return this.publicBase !== this.internalBase && url.startsWith(this.internalBase)
      ? this.publicBase + url.slice(this.internalBase.length)
      : url;
  }
}
