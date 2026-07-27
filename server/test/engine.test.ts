import { describe, it, expect } from 'vitest';
import { makeHarness } from './helpers.js';
import { ensureProjectDay, runDeadlineSweep, computeDayStatus, requirementActiveOn } from '../src/engine.js';
import { fixedClock } from '../src/time.js';

describe('project day generation (acceptance #13, #14)', () => {
  it('creates requirement instances only for scheduled requirements', () => {
    const h = makeHarness();
    // 2026-07-25 is a Saturday -> weekly (Sunday) photos NOT active.
    const dayId = ensureProjectDay(h.db, h.projectId, '2026-07-25', h.clock);
    const codes = (h.db.prepare(`SELECT requirementCode FROM requirement_instances WHERE projectDayId = ?`).all(dayId) as { requirementCode: string }[]).map((r) => r.requirementCode);
    expect(codes).toContain('DAILY_VIDEO');
    expect(codes).not.toContain('WEEKLY_PHOTOS');
  });

  it('includes weekly requirement on its weekday', () => {
    const h = makeHarness();
    // 2026-07-26 is a Sunday.
    const dayId = ensureProjectDay(h.db, h.projectId, '2026-07-26', h.clock);
    const codes = (h.db.prepare(`SELECT requirementCode FROM requirement_instances WHERE projectDayId = ?`).all(dayId) as { requirementCode: string }[]).map((r) => r.requirementCode);
    expect(codes).toContain('WEEKLY_PHOTOS');
  });

  it('is idempotent', () => {
    const h = makeHarness();
    const a = ensureProjectDay(h.db, h.projectId, '2026-07-20', h.clock);
    const b = ensureProjectDay(h.db, h.projectId, '2026-07-20', h.clock);
    expect(a).toBe(b);
  });

  it('attaches the active configuration to the day (acceptance #13)', () => {
    const h = makeHarness();
    const dayId = ensureProjectDay(h.db, h.projectId, '2026-07-20', h.clock);
    const row = h.db.prepare(`SELECT configurationId FROM project_days WHERE id = ?`).get(dayId) as { configurationId: string };
    expect(row.configurationId).toBeTruthy();
  });
});

describe('requirementActiveOn', () => {
  it('DAILY is always active', () => {
    expect(requirementActiveOn('DAILY', '2026-07-25', 'America/New_York')).toBe(true);
  });
  it('WEEKLY matches only the configured weekday', () => {
    expect(requirementActiveOn('WEEKLY:7', '2026-07-26', 'America/New_York')).toBe(true); // Sunday
    expect(requirementActiveOn('WEEKLY:7', '2026-07-25', 'America/New_York')).toBe(false); // Saturday
  });
});

describe('deadline sweep marks missed requirements without auto-consequence (§9.2)', () => {
  it('marks NOT_STARTED requirements MISSED after the deadline elapses', () => {
    const h = makeHarness();
    // Create the day as if "now" were the morning of 07-20.
    const morning = fixedClock('2026-07-20T12:00:00Z');
    const dayId = ensureProjectDay(h.db, h.projectId, '2026-07-20', morning);

    // Sweep with a clock well past the 23:59 ET deadline.
    const nextDay = fixedClock('2026-07-22T12:00:00Z');
    const result = runDeadlineSweep(h.db, h.projectId, nextDay);
    expect(result.missed.length).toBeGreaterThan(0);

    const statuses = (h.db.prepare(`SELECT status FROM requirement_instances WHERE projectDayId = ?`).all(dayId) as { status: string }[]).map((r) => r.status);
    expect(statuses).toContain('MISSED');
    // NO violations were created automatically.
    const vio = h.db.prepare(`SELECT COUNT(*) c FROM violations`).get() as { c: number };
    expect(vio.c).toBe(0);
    // Day status reflects deficiency.
    expect(computeDayStatus(h.db, dayId)).toBe('DEFICIENT');
  });

  it('does not mark MISSED before the deadline', () => {
    const h = makeHarness();
    const morning = fixedClock('2026-07-20T12:00:00Z');
    ensureProjectDay(h.db, h.projectId, '2026-07-20', morning);
    // Sweep at 6pm ET same day — before the 23:59 deadline.
    const beforeDeadline = fixedClock('2026-07-20T22:00:00Z');
    const result = runDeadlineSweep(h.db, h.projectId, beforeDeadline);
    expect(result.missed.length).toBe(0);
  });
});
