/**
 * Server-authoritative time.
 *
 * PRINCIPLE (blueprint §3.2): critical dates/times are computed from a trusted
 * server clock. The device clock is never allowed to determine timeliness.
 *
 * All deadline math is timezone-aware (DST-safe) via Luxon. A "local date" like
 * "2026-07-26" combined with a wall-clock time like "23:59" resolves to a
 * concrete UTC instant *in the project's IANA time zone*, which is what the
 * deadline engine compares trusted receipt instants against.
 */
import { DateTime, Duration } from 'luxon';

/** Injectable clock so tests can pin "now" deterministically. */
export interface Clock {
  now(): DateTime; // always UTC
}

export const systemClock: Clock = {
  now: () => DateTime.utc(),
};

/** A frozen clock for tests and for deterministic engine runs. */
export function fixedClock(iso: string): Clock {
  const instant = DateTime.fromISO(iso, { zone: 'utc' });
  if (!instant.isValid) throw new Error(`fixedClock: invalid ISO ${iso}`);
  return { now: () => instant };
}

export function nowIso(clock: Clock = systemClock): string {
  return clock.now().toISO()!;
}

/**
 * Resolve a local calendar date + wall-clock time in a given IANA zone to a
 * concrete UTC ISO instant. Correct across DST transitions because Luxon knows
 * the offset in effect on that date.
 *
 * @param localDate  e.g. "2026-07-26"
 * @param wallTime   e.g. "23:59" (24h) — the last minute of the day, etc.
 * @param zone       e.g. "America/New_York"
 */
export function resolveDeadline(localDate: string, wallTime: string, zone: string): string {
  const [h, m] = wallTime.split(':').map((n) => parseInt(n, 10));
  const dt = DateTime.fromISO(localDate, { zone }).set({
    hour: h,
    minute: m,
    second: 59,
    millisecond: 999,
  });
  if (!dt.isValid) {
    throw new Error(`resolveDeadline: invalid ${localDate} ${wallTime} ${zone}: ${dt.invalidReason}`);
  }
  return dt.toUTC().toISO()!;
}

/** The participant's "local date" for a given instant, in the project zone. */
export function localDateOf(instant: DateTime | string, zone: string): string {
  const dt = typeof instant === 'string' ? DateTime.fromISO(instant, { zone: 'utc' }) : instant;
  return dt.setZone(zone).toISODate()!;
}

/**
 * Whole-day project-day number, 1-based and inclusive of the start date.
 * Uses calendar days in the project zone so DST does not shift the count.
 */
export function dayNumber(startLocalDate: string, forLocalDate: string, zone: string): number {
  const start = DateTime.fromISO(startLocalDate, { zone }).startOf('day');
  const day = DateTime.fromISO(forLocalDate, { zone }).startOf('day');
  return Math.floor(day.diff(start, 'days').days) + 1;
}

/** Add a grace duration (ISO-8601 like "PT30M" or "PT2H") to a deadline instant. */
export function applyGrace(deadlineIso: string, graceIso: string | null | undefined): string {
  if (!graceIso) return deadlineIso;
  const base = DateTime.fromISO(deadlineIso, { zone: 'utc' });
  const dur = Duration.fromISO(graceIso);
  return base.plus(dur).toISO()!;
}

export type Timeliness =
  | 'BEFORE_DEADLINE'
  | 'ON_TIME'
  | 'GRACE'
  | 'LATE'
  | 'NOT_SUBMITTED';

/**
 * Determine timeliness from *trusted* instants only. The submission instant is
 * the server-received time, never a client-asserted time.
 */
export function evaluateTimeliness(params: {
  serverReceivedAtIso: string | null;
  deadlineIso: string;
  graceIso?: string | null;
  nowIso: string;
}): Timeliness {
  const { serverReceivedAtIso, deadlineIso, graceIso, nowIso } = params;
  const deadline = DateTime.fromISO(deadlineIso, { zone: 'utc' });
  const graceEnd = DateTime.fromISO(applyGrace(deadlineIso, graceIso), { zone: 'utc' });

  if (!serverReceivedAtIso) {
    const now = DateTime.fromISO(nowIso, { zone: 'utc' });
    return now <= deadline ? 'BEFORE_DEADLINE' : 'NOT_SUBMITTED';
  }
  const received = DateTime.fromISO(serverReceivedAtIso, { zone: 'utc' });
  if (received <= deadline) return 'ON_TIME';
  if (received <= graceEnd) return 'GRACE';
  return 'LATE';
}
