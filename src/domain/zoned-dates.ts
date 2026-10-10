/** Offset (ms) of `timeZone` from UTC at `instant`: local wall time − UTC. */
export function tzOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant of 00:00 local time on `date` (`YYYY-MM-DD`) in `timeZone`. */
export function zonedStartOfDay(date: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let result = guess - tzOffsetMs(new Date(guess), timeZone);
  // Re-check once in case the offset differs at the result (DST transitions).
  result = guess - tzOffsetMs(new Date(result), timeZone);
  return new Date(result);
}

/** Today's calendar date (`YYYY-MM-DD`) in `timeZone`. */
export function zonedToday(timeZone: string, now: Date = new Date()): string {
  return new Date(now.getTime() + tzOffsetMs(now, timeZone)).toISOString().slice(0, 10);
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
