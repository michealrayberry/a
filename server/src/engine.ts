/**
 * Deadline & compliance engine (blueprint §9). ALL deadline math runs here on
 * the server. Nothing about timeliness depends on a device clock.
 */
import { DateTime } from 'luxon';
import type { DB } from './db.js';
import { newId } from './ids.js';
import { recordAudit } from './audit.js';
import { transition, type RequirementState } from './stateMachines.js';
import type { ProjectConfiguration } from './config.js';
import {
  applyGrace,
  dayNumber,
  evaluateTimeliness,
  localDateOf,
  nowIso,
  resolveDeadline,
  systemClock,
  type Clock,
} from './time.js';

export interface ProjectRow {
  id: string;
  name: string;
  participantId: string;
  publicSlug: string;
  timeZone: string;
  activeConfigurationId: string | null;
}

export function getProject(db: DB, projectId: string): ProjectRow | undefined {
  return db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as ProjectRow | undefined;
}

export function activeConfig(db: DB, projectId: string): { id: string; cfg: ProjectConfiguration } {
  const project = getProject(db, projectId);
  if (!project?.activeConfigurationId) throw new Error('project has no active configuration');
  const row = db
    .prepare(`SELECT id, configuration FROM configurations WHERE id = ?`)
    .get(project.activeConfigurationId) as { id: string; configuration: string };
  return { id: row.id, cfg: JSON.parse(row.configuration) as ProjectConfiguration };
}

/** Is a requirement active on a given local date, per its schedule? */
export function requirementActiveOn(schedule: string, localDate: string, zone: string): boolean {
  if (schedule === 'DAILY') return true;
  if (schedule.startsWith('WEEKLY:')) {
    const weekday = parseInt(schedule.split(':')[1] ?? '0', 10);
    return DateTime.fromISO(localDate, { zone }).weekday === weekday;
  }
  return false;
}

/**
 * Ensure a project_day row (and its requirement instances) exists for a local
 * date. Idempotent. The configuration in force is the one active on that day —
 * activating a NEW configuration later never rewrites an existing day
 * (acceptance #13, #14).
 */
export function ensureProjectDay(
  db: DB,
  projectId: string,
  localDate: string,
  clock: Clock = systemClock,
): string {
  const existing = db
    .prepare(`SELECT id FROM project_days WHERE projectId = ? AND localDate = ?`)
    .get(projectId, localDate) as { id: string } | undefined;
  if (existing) return existing.id;

  const project = getProject(db, projectId)!;
  const { id: configId, cfg } = activeConfig(db, projectId);
  const zone = cfg.identity.timeZone;
  const num = dayNumber(cfg.dates.startDate, localDate, zone);
  const dayDeadline = resolveDeadline(localDate, '23:59', zone);
  const dayId = newId('day');

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO project_days
        (id, projectId, localDate, dayNumber, configurationId, overallStatus, deadlineAt, publicStatus)
       VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
    ).run(dayId, projectId, localDate, num, configId, dayDeadline, cfg.publication.projectDaysDefault);

    for (const req of cfg.requirements) {
      if (!requirementActiveOn(req.schedule, localDate, zone)) continue;
      const deadlineAt = resolveDeadline(localDate, req.deadlineTime, zone);
      db.prepare(
        `INSERT INTO requirement_instances
          (id, projectDayId, requirementCode, name, evidenceType, mandatory, status, deadlineAt, grace, publicStatus)
         VALUES (?, ?, ?, ?, ?, ?, 'NOT_STARTED', ?, ?, ?)`,
      ).run(
        newId('rqi'),
        dayId,
        req.code,
        req.name,
        req.evidenceType,
        req.mandatory ? 1 : 0,
        deadlineAt,
        req.grace,
        req.publicationRule,
      );
    }

    recordAudit(
      db,
      {
        projectId,
        actorRole: 'SYSTEM',
        action: 'PROJECT_DAY_CREATED',
        entityType: 'project_day',
        entityId: dayId,
        newState: 'OPEN',
        reason: `Day ${num} for ${localDate}`,
      },
      clock,
    );
  });
  tx();
  return dayId;
}

interface ReqInstanceRow {
  id: string;
  projectDayId: string;
  status: RequirementState;
  mandatory: number;
  deadlineAt: string;
  grace: string | null;
  serverReceivedAt: string | null;
}

/**
 * Compute the overall day status from its requirement instances (blueprint
 * §7.3 completion rule). A day is COMPLETE only if every MANDATORY requirement
 * is VERIFIED / EXCUSED / NOT_APPLICABLE (or locked in one of those).
 */
export function computeDayStatus(db: DB, projectDayId: string): string {
  const reqs = db
    .prepare(`SELECT status, mandatory FROM requirement_instances WHERE projectDayId = ?`)
    .all(projectDayId) as { status: RequirementState; mandatory: number }[];
  if (reqs.length === 0) return 'NO_ACTIVE_REQUIREMENTS';

  const mandatory = reqs.filter((r) => r.mandatory === 1);
  const done = (s: RequirementState) =>
    s === 'VERIFIED' || s === 'EXCUSED' || s === 'NOT_APPLICABLE' || s === 'LOCKED';
  const terminalBad = (s: RequirementState) =>
    s === 'MISSED' || s === 'VIOLATION_PENDING' || s === 'VIOLATION_ASSESSED';

  if (mandatory.some((r) => terminalBad(r.status))) return 'DEFICIENT';
  if (reqs.some((r) => r.status === 'DEFICIENT')) return 'DEFICIENT';
  if (mandatory.every((r) => done(r.status))) return 'COMPLETE';
  if (reqs.some((r) => r.status === 'SUBMITTED' || r.status === 'UNDER_REVIEW' || r.status === 'LATE'))
    return 'PENDING_REVIEW';
  return 'OPEN';
}

export interface DeadlineSweepResult {
  evaluated: number;
  missed: string[]; // requirement instance ids newly marked MISSED
  late: string[]; // instances flagged LATE
  notices: number;
}

/**
 * The scheduled deadline sweep (blueprint §9.2). For every active requirement
 * instance:
 *  - if unmet and past deadline+grace → MISSED + notice + review item
 *  - discretionary consequences are NEVER auto-assessed; the AP must act.
 */
export function runDeadlineSweep(
  db: DB,
  projectId: string,
  clock: Clock = systemClock,
): DeadlineSweepResult {
  const now = nowIso(clock);
  const result: DeadlineSweepResult = { evaluated: 0, missed: [], late: [], notices: 0 };

  const openReqs = db
    .prepare(
      `SELECT ri.* FROM requirement_instances ri
       JOIN project_days d ON d.id = ri.projectDayId
       WHERE d.projectId = ?
         AND ri.status IN ('NOT_STARTED','IN_PROGRESS','SUBMITTED','LATE')`,
    )
    .all(projectId) as ReqInstanceRow[];

  const tx = db.transaction(() => {
    for (const ri of openReqs) {
      result.evaluated++;
      const timeliness = evaluateTimeliness({
        serverReceivedAtIso: ri.serverReceivedAt,
        deadlineIso: ri.deadlineAt,
        graceIso: ri.grace,
        nowIso: now,
      });

      if (ri.status === 'SUBMITTED' && (timeliness === 'LATE' || timeliness === 'GRACE')) {
        // Submitted, but server received it after the deadline → mark LATE.
        const next = transition('requirement', ri.status, 'LATE');
        db.prepare(`UPDATE requirement_instances SET status = ?, timeliness = ? WHERE id = ?`).run(
          next,
          timeliness,
          ri.id,
        );
        result.late.push(ri.id);
        recordAudit(
          db,
          {
            projectId,
            actorRole: 'SYSTEM',
            action: 'REQUIREMENT_LATE',
            entityType: 'requirement_instance',
            entityId: ri.id,
            previousState: 'SUBMITTED',
            newState: 'LATE',
            reason: `Server-received after deadline (${timeliness})`,
          },
          clock,
        );
        continue;
      }

      if (
        (ri.status === 'NOT_STARTED' || ri.status === 'IN_PROGRESS') &&
        timeliness === 'NOT_SUBMITTED'
      ) {
        const deadlineEnd = applyGrace(ri.deadlineAt, ri.grace);
        if (DateTime.fromISO(now) <= DateTime.fromISO(deadlineEnd)) continue; // still within grace
        const next = transition('requirement', ri.status, 'MISSED');
        db.prepare(`UPDATE requirement_instances SET status = ?, timeliness = 'NOT_SUBMITTED' WHERE id = ?`).run(
          next,
          ri.id,
        );
        result.missed.push(ri.id);
        recordAudit(
          db,
          {
            projectId,
            actorRole: 'SYSTEM',
            action: 'REQUIREMENT_MISSED',
            entityType: 'requirement_instance',
            entityId: ri.id,
            previousState: ri.status,
            newState: 'MISSED',
            reason: 'Deadline (and grace) elapsed with no valid submission',
          },
          clock,
        );
        // Notice to participant + AP; NO automatic consequence.
        db.prepare(
          `INSERT INTO notices (id, projectId, projectDayId, type, title, body, issuedByRole, issuedAt, responseRequired, publicStatus)
           VALUES (?, ?, ?, 'SYSTEM_ALERT', ?, ?, 'SYSTEM', ?, 0, 'PRIVATE')`,
        ).run(
          newId('not'),
          projectId,
          ri.projectDayId,
          'Requirement missed',
          'A requirement deadline elapsed without a valid submission. The Accountability Partner will review under the active rules.',
          now,
        );
        result.notices++;
      }
    }

    // Recompute overall status for affected days.
    const days = new Set(openReqs.map((r) => r.projectDayId));
    for (const dayId of days) {
      const status = computeDayStatus(db, dayId);
      db.prepare(`UPDATE project_days SET overallStatus = ? WHERE id = ?`).run(status, dayId);
    }
  });
  tx();
  return result;
}

/** Convenience: today's local date in the project zone. */
export function projectToday(db: DB, projectId: string, clock: Clock = systemClock): string {
  const project = getProject(db, projectId)!;
  return localDateOf(nowIso(clock), project.timeZone);
}
