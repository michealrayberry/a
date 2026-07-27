import { describe, it, expect } from 'vitest';
import {
  resolveDeadline,
  evaluateTimeliness,
  dayNumber,
  applyGrace,
  localDateOf,
} from '../src/time.js';

const NY = 'America/New_York';

describe('deadline resolution is timezone-aware (blueprint §9, acceptance #19)', () => {
  it('resolves a wall-clock deadline to the correct UTC instant in EDT', () => {
    // July: EDT = UTC-4. 23:59 local -> 03:59:59.999 next-day UTC.
    expect(resolveDeadline('2026-07-26', '23:59', NY)).toBe('2026-07-27T03:59:59.999Z');
  });

  it('resolves the same wall-clock deadline correctly in EST (winter)', () => {
    // January: EST = UTC-5. 23:59 local -> 04:59:59.999 next-day UTC.
    expect(resolveDeadline('2026-01-15', '23:59', NY)).toBe('2026-01-16T04:59:59.999Z');
  });

  it('handles the spring-forward DST boundary', () => {
    // 2026-03-08: clocks jump 02:00 -> 03:00 EST->EDT. A 23:59 deadline is EDT.
    expect(resolveDeadline('2026-03-08', '23:59', NY)).toBe('2026-03-09T03:59:59.999Z');
  });
});

describe('day numbering counts calendar days, not 24h blocks (DST-safe)', () => {
  it('start date is day 1', () => {
    expect(dayNumber('2026-06-18', '2026-06-18', NY)).toBe(1);
  });
  it('counts across a DST transition without drift', () => {
    // From before spring-forward to after: pure calendar-day count.
    expect(dayNumber('2026-03-01', '2026-03-15', NY)).toBe(15);
  });
});

describe('timeliness uses trusted server instant only (acceptance #6, #19)', () => {
  const deadline = resolveDeadline('2026-07-26', '23:59', NY);

  it('ON_TIME when server-received before deadline', () => {
    expect(
      evaluateTimeliness({ serverReceivedAtIso: '2026-07-27T03:00:00.000Z', deadlineIso: deadline, nowIso: deadline }),
    ).toBe('ON_TIME');
  });

  it('exactly at the deadline instant is ON_TIME (boundary)', () => {
    expect(
      evaluateTimeliness({ serverReceivedAtIso: deadline, deadlineIso: deadline, nowIso: deadline }),
    ).toBe('ON_TIME');
  });

  it('one millisecond after the deadline is LATE (boundary)', () => {
    const after = '2026-07-27T04:00:00.000Z';
    expect(
      evaluateTimeliness({ serverReceivedAtIso: after, deadlineIso: deadline, nowIso: after }),
    ).toBe('LATE');
  });

  it('GRACE window is honored, then LATE', () => {
    const grace = 'PT1H';
    const inGrace = '2026-07-27T04:30:00.000Z';
    const afterGrace = '2026-07-27T05:30:00.000Z';
    expect(evaluateTimeliness({ serverReceivedAtIso: inGrace, deadlineIso: deadline, graceIso: grace, nowIso: inGrace })).toBe('GRACE');
    expect(evaluateTimeliness({ serverReceivedAtIso: afterGrace, deadlineIso: deadline, graceIso: grace, nowIso: afterGrace })).toBe('LATE');
  });

  it('NOT_SUBMITTED once now passes the deadline with no submission', () => {
    expect(
      evaluateTimeliness({ serverReceivedAtIso: null, deadlineIso: deadline, nowIso: '2026-07-27T06:00:00.000Z' }),
    ).toBe('NOT_SUBMITTED');
  });
});

describe('applyGrace', () => {
  it('adds the ISO duration to the deadline', () => {
    expect(applyGrace('2026-07-27T03:59:59.999Z', 'PT1H')).toBe('2026-07-27T04:59:59.999Z');
  });
  it('is a no-op when grace is null', () => {
    expect(applyGrace('2026-07-27T03:59:59.999Z', null)).toBe('2026-07-27T03:59:59.999Z');
  });
});

describe('localDateOf', () => {
  it('maps a UTC instant to the participant local date', () => {
    // 2026-07-27T02:00Z is still 2026-07-26 in New York (EDT).
    expect(localDateOf('2026-07-27T02:00:00.000Z', NY)).toBe('2026-07-26');
  });
});
