export interface Money {
  amountMinor: number;
  currency: string;
}

export const money = (amountMinor: number, currency: string): Money => ({
  amountMinor: Math.trunc(amountMinor),
  currency: currency.trim(),
});

/** Round-half-up of `value × bps / 10000` on non-negative integers (CONTRACTS §7). */
export function applyBps(value: number, bps: number): number {
  if (!Number.isInteger(value) || !Number.isInteger(bps)) {
    throw new Error('applyBps requires integers');
  }
  const sign = value < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(value) * bps + 5000) / 10000);
}

/** `AED 1,250.00` — used only in human-readable labels; clients format Money themselves. */
export function formatMoneyLabel(amountMinor: number, currency: string): string {
  const major = (Math.abs(amountMinor) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${amountMinor < 0 ? '-' : ''}${currency.trim()} ${major}`;
}

export function formatBpsPercent(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(2).replace(/0+$/, '')}%`;
}
