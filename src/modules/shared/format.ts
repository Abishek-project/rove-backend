/** "•••• 4821" — partners see their own plates unmasked only on the detail view. */
export function maskRegistration(reg: string | null): string | null {
  if (!reg) return null;
  const compact = reg.replace(/\s+/g, '');
  return `•••• ${compact.slice(-4)}`;
}

/** "Aisha K." — what partners see instead of the customer's full identity. */
export function customerDisplayName(fullName: string | null): string {
  if (!fullName?.trim()) return 'Customer';
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
