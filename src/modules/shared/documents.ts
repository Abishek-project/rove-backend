import type { DbOrTx } from '../../database/database';

export type DocScope = 'customer' | 'partner' | 'vehicle';
export type RequirementStatus = 'missing' | 'submitted' | 'approved' | 'rejected' | 'expired';

export interface Requirement {
  documentType: string;
  label: string;
  isRequired: boolean;
}

export interface DocRow {
  id: string;
  document_type: string;
  status: string;
  rejection_reason: string | null;
  expires_on: string | null;
  created_at: Date;
}

export interface RequirementState extends Requirement {
  status: RequirementStatus;
  rejectionReason: string | null;
  expiresOn: string | null;
  documentId: string | null;
}

export async function requirementsFor(db: DbOrTx, countryCode: string | null, scope: DocScope): Promise<Requirement[]> {
  if (!countryCode) return [];
  const rows = await db
    .selectFrom('document_requirements')
    .select(['document_type', 'label', 'is_required'])
    .where('country_code', '=', countryCode)
    .where('scope', '=', scope)
    .orderBy('is_required', 'desc')
    .orderBy('label')
    .execute();
  return rows.map((r) => ({
    documentType: r.document_type,
    label: r.label,
    isRequired: r.is_required,
  }));
}

export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function effectiveDocStatus(
  doc: Pick<DocRow, 'status' | 'expires_on'>,
  now: Date = new Date(),
): RequirementStatus {
  if (doc.status === 'expired') return 'expired';
  if (doc.expires_on && doc.expires_on < todayUtc(now) && doc.status !== 'rejected') return 'expired';
  return doc.status as RequirementStatus;
}

/** Latest document per type, matched against the requirement list. */
export function summarizeRequirements(reqs: Requirement[], docs: DocRow[], now: Date = new Date()): RequirementState[] {
  const latest = new Map<string, DocRow>();
  for (const d of [...docs].sort((a, b) => b.created_at.getTime() - a.created_at.getTime())) {
    if (!latest.has(d.document_type)) latest.set(d.document_type, d);
  }
  return reqs.map((r) => {
    const doc = latest.get(r.documentType);
    return {
      ...r,
      status: doc ? effectiveDocStatus(doc, now) : 'missing',
      rejectionReason: doc?.rejection_reason ?? null,
      expiresOn: doc?.expires_on ?? null,
      documentId: doc?.id ?? null,
    };
  });
}

/** All required documents present and usable (submitted or approved). */
export function requiredDocsPresent(states: RequirementState[]): boolean {
  return states.filter((s) => s.isRequired).every((s) => s.status === 'submitted' || s.status === 'approved');
}

export function requiredDocsApproved(states: RequirementState[]): boolean {
  return states.filter((s) => s.isRequired).every((s) => s.status === 'approved');
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
