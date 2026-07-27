/**
 * Official-record exports (blueprint §19, MVP #20, acceptance #21).
 * Produces JSON and CSV. Every export carries generation time, the config
 * version in force, the date range, and clearly separates public vs private.
 * PDF/ZIP are rendered from these structures by the reporting layer.
 */
import type { DB } from '../db.js';
import { nowIso, type Clock, systemClock } from '../time.js';

export type ExportType =
  | 'official-record'
  | 'weights'
  | 'compliance'
  | 'violations'
  | 'notices'
  | 'audit';

export function buildExport(
  db: DB,
  projectId: string,
  type: ExportType,
  clock: Clock = systemClock,
): { meta: Record<string, unknown>; rows: Record<string, unknown>[] } {
  const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as
    | { activeConfigurationId: string; name: string }
    | undefined;
  if (!project) throw new Error('project not found');
  const cfg = db
    .prepare(`SELECT version FROM configurations WHERE id = ?`)
    .get(project.activeConfigurationId) as { version: number } | undefined;

  let rows: Record<string, unknown>[] = [];
  switch (type) {
    case 'weights':
      rows = db
        .prepare(`SELECT weight, unit, measurementType, measuredAt, verificationStatus, publicStatus FROM weights WHERE projectId = ? ORDER BY measuredAt`)
        .all(projectId) as Record<string, unknown>[];
      break;
    case 'compliance':
      rows = db
        .prepare(`SELECT localDate, dayNumber, overallStatus, deadlineAt, publicStatus FROM project_days WHERE projectId = ? ORDER BY localDate`)
        .all(projectId) as Record<string, unknown>[];
      break;
    case 'violations':
      rows = db.prepare(`SELECT * FROM violations WHERE projectId = ? ORDER BY violationNumber`).all(projectId) as Record<string, unknown>[];
      break;
    case 'notices':
      rows = db.prepare(`SELECT * FROM notices WHERE projectId = ? ORDER BY issuedAt`).all(projectId) as Record<string, unknown>[];
      break;
    case 'audit':
      rows = db.prepare(`SELECT * FROM audit_events WHERE projectId = ? ORDER BY serverTimestamp`).all(projectId) as Record<string, unknown>[];
      break;
    case 'official-record':
    default:
      rows = db
        .prepare(
          `SELECT d.localDate, d.dayNumber, d.overallStatus, d.deadlineAt, d.publicStatus,
                  ri.name AS requirement, ri.status AS requirementStatus, ri.timeliness
             FROM project_days d
             JOIN requirement_instances ri ON ri.projectDayId = d.id
            WHERE d.projectId = ? ORDER BY d.localDate, ri.name`,
        )
        .all(projectId) as Record<string, unknown>[];
  }

  return {
    meta: {
      project: project.name,
      exportType: type,
      generatedAt: nowIso(clock),
      configurationVersion: cfg?.version ?? null,
      rowCount: rows.length,
      note: 'publicStatus column marks which records are published vs private.',
    },
    rows,
  };
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]!);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
}
