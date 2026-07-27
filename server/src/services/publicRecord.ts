/**
 * Public read-only projection (blueprint §5.4, §14, acceptance #15, #16).
 *
 * ONLY records explicitly marked PUBLIC/UNLISTED are exposed, and every field
 * that could leak private data (user ids, emails, storage paths, AP identity,
 * internal notes, raw hashes of private media) is stripped here. The public
 * layer never runs a query that can return a PRIVATE row.
 */
import type { DB } from '../db.js';
import type { ProjectConfiguration } from '../config.js';

function project(db: DB, slug: string) {
  return db.prepare(`SELECT * FROM projects WHERE publicSlug = ?`).get(slug) as
    | { id: string; name: string; publicSlug: string; timeZone: string; activeConfigurationId: string | null; status: string }
    | undefined;
}

function config(db: DB, configId: string): ProjectConfiguration {
  const row = db.prepare(`SELECT configuration FROM configurations WHERE id = ?`).get(configId) as {
    configuration: string;
  };
  return JSON.parse(row.configuration);
}

export function publicProject(db: DB, slug: string) {
  const p = project(db, slug);
  if (!p?.activeConfigurationId) return null;
  const cfg = config(db, p.activeConfigurationId);
  return {
    name: cfg.identity.projectName,
    participant: cfg.identity.participantDisplayName,
    domain: cfg.identity.publicDomain,
    timeZone: cfg.identity.timeZone,
    startWeight: cfg.measurements.startWeight,
    goalWeight: cfg.measurements.goalWeight,
    unit: cfg.measurements.unit,
    milestones: cfg.measurements.milestones,
    startDate: cfg.dates.startDate,
    status: p.status,
  };
}

export function publicStatus(db: DB, slug: string) {
  const p = project(db, slug);
  if (!p?.activeConfigurationId) return null;
  const cfg = config(db, p.activeConfigurationId);
  const latestWeight = db
    .prepare(
      `SELECT weight, unit, measuredAt FROM weights
       WHERE projectId = ? AND verificationStatus = 'VERIFIED' AND publicStatus IN ('PUBLIC','UNLISTED')
       ORDER BY measuredAt DESC LIMIT 1`,
    )
    .get(p.id) as { weight: number; unit: string; measuredAt: string } | undefined;
  const latestDay = db
    .prepare(
      `SELECT localDate, dayNumber, overallStatus, publicPublishedAt FROM project_days
       WHERE projectId = ? AND publicStatus IN ('PUBLIC','UNLISTED')
       ORDER BY localDate DESC LIMIT 1`,
    )
    .get(p.id) as { localDate: string; dayNumber: number; overallStatus: string; publicPublishedAt: string } | undefined;

  const current = latestWeight?.weight ?? null;
  return {
    project: cfg.identity.projectName,
    currentVerifiedWeight: current,
    startWeight: cfg.measurements.startWeight,
    goalWeight: cfg.measurements.goalWeight,
    unit: cfg.measurements.unit,
    totalVerifiedChange: current != null ? +(current - cfg.measurements.startWeight).toFixed(cfg.measurements.precision) : null,
    currentProjectDay: latestDay?.dayNumber ?? null,
    latestDayStatus: latestDay?.overallStatus ?? null,
    lastUpdated: latestDay?.publicPublishedAt ?? latestWeight?.measuredAt ?? null,
  };
}

export function publicProjectDays(db: DB, slug: string) {
  const p = project(db, slug);
  if (!p) return [];
  return db
    .prepare(
      `SELECT localDate, dayNumber, overallStatus, publicPublishedAt FROM project_days
       WHERE projectId = ? AND publicStatus IN ('PUBLIC','UNLISTED')
       ORDER BY localDate DESC`,
    )
    .all(p.id);
}

export function publicProjectDay(db: DB, slug: string, localDate: string) {
  const p = project(db, slug);
  if (!p) return null;
  const day = db
    .prepare(
      `SELECT id, localDate, dayNumber, overallStatus, publicPublishedAt FROM project_days
       WHERE projectId = ? AND localDate = ? AND publicStatus IN ('PUBLIC','UNLISTED')`,
    )
    .get(p.id, localDate) as { id: string; localDate: string; dayNumber: number; overallStatus: string } | undefined;
  if (!day) return null;
  const requirements = db
    .prepare(
      `SELECT name, evidenceType, status, timeliness FROM requirement_instances WHERE projectDayId = ? AND publicStatus IN ('PUBLIC','UNLISTED')`,
    )
    .all(day.id);
  const links = db
    .prepare(
      `SELECT platform, url, visibility FROM external_publications WHERE projectDayId = ? AND publicStatus IN ('PUBLIC','UNLISTED')`,
    )
    .all(day.id);
  return { ...day, id: undefined, requirements, publishedLinks: links };
}

export function publicWeights(db: DB, slug: string) {
  const p = project(db, slug);
  if (!p) return [];
  return db
    .prepare(
      `SELECT weight, unit, measuredAt FROM weights
       WHERE projectId = ? AND verificationStatus = 'VERIFIED' AND publicStatus IN ('PUBLIC','UNLISTED')
       ORDER BY measuredAt ASC`,
    )
    .all(p.id);
}

export function publicViolations(db: DB, slug: string) {
  const p = project(db, slug);
  if (!p) return [];
  return db
    .prepare(
      `SELECT violationNumber, ruleCitation, factualBasis, consequenceType, consequenceAmount, dueAt, state, assessedAt
       FROM violations WHERE projectId = ? AND publicStatus IN ('PUBLIC','UNLISTED')
       ORDER BY violationNumber ASC`,
    )
    .all(p.id);
}

/** Combined chronological public feed. */
export function publicFeed(db: DB, slug: string) {
  const days = (publicProjectDays(db, slug) as { localDate: string; dayNumber: number; overallStatus: string; publicPublishedAt: string }[]).map(
    (d) => ({ kind: 'DAY', date: d.publicPublishedAt ?? d.localDate, ...d }),
  );
  const violations = (publicViolations(db, slug) as { assessedAt: string }[]).map((v) => ({ kind: 'VIOLATION', date: v.assessedAt, ...v }));
  return [...days, ...violations].sort((a, b) => (a.date < b.date ? 1 : -1));
}
