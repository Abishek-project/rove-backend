import { randomUUID } from 'crypto';
import { fromBuffer } from 'file-type';
import { AppException } from '../common/errors/app-exception';

export type UploadKind = 'image' | 'document';

const RULES: Record<UploadKind, { maxBytes: number; mimes: Record<string, string> }> = {
  image: {
    maxBytes: 10 * 1024 * 1024,
    mimes: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
  },
  document: {
    maxBytes: 15 * 1024 * 1024,
    mimes: {
      'application/pdf': 'pdf',
      'image/jpeg': 'jpg',
      'image/png': 'png',
    },
  },
};

/** Largest accepted upload; multer's hard limit (anything above → 413 before buffering more). */
export const MAX_UPLOAD_BYTES = RULES.document.maxBytes;

export interface UploadedFileLike {
  buffer: Buffer;
  size: number;
  originalname: string;
}

export interface CheckedFile {
  buffer: Buffer;
  size: number;
  contentType: string;
  ext: string;
  fileName: string;
}

/**
 * Validates an uploaded file by size and by sniffing its magic bytes (the client-provided
 * MIME type and extension are ignored).
 */
export async function checkUpload(file: UploadedFileLike | undefined, kind: UploadKind): Promise<CheckedFile> {
  if (!file || !file.buffer || file.size === 0) {
    throw AppException.validation({ file: ['file is required'] }, 'Please attach a file.');
  }
  const rule = RULES[kind];
  if (file.size > rule.maxBytes) {
    throw new AppException('FILE_TOO_LARGE', `The file must be ${rule.maxBytes / 1024 / 1024} MB or smaller.`, {
      maxBytes: rule.maxBytes,
    });
  }
  const sniffed = await fromBuffer(file.buffer);
  const ext = sniffed ? rule.mimes[sniffed.mime] : undefined;
  if (!sniffed || !ext) {
    throw new AppException(
      'UNSUPPORTED_FILE_TYPE',
      kind === 'image' ? 'Please upload a JPEG, PNG or WebP image.' : 'Please upload a PDF, JPEG or PNG file.',
      { allowed: Object.keys(rule.mimes) },
    );
  }
  return {
    buffer: file.buffer,
    size: file.size,
    contentType: sniffed.mime,
    ext,
    fileName: sanitizeFileName(file.originalname, ext),
  };
}

export function sanitizeFileName(name: string | undefined, ext: string): string {
  const base = (name ?? '')
    .replace(/\.[^.]*$/, '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 _-]+/g, '')
    .trim()
    .slice(0, 80);
  return `${base || 'file'}.${ext}`;
}

export function objectPath(prefix: string, ext: string): string {
  return `${prefix}/${randomUUID()}.${ext}`;
}
