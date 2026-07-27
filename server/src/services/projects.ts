/**
 * Project + versioned configuration administration (blueprint §8.7).
 * An activated configuration is immutable; changes require a new version.
 */
import type { DB } from '../db.js';
import { newId } from '../ids.js';
import { recordAudit } from '../audit.js';
import { nowIso, type Clock, systemClock } from '../time.js';
import type { ProjectConfiguration } from '../config.js';

export function createProject(
  db: DB,
  input: { name: string; participantId: string; publicSlug: string; timeZone: string },
  clock: Clock = systemClock,
): string {
  const id = newId('prj');
  db.prepare(
    `INSERT INTO projects (id, name, participantId, status, publicSlug, timeZone, createdAt)
     VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)`,
  ).run(id, input.name, input.participantId, input.publicSlug, input.timeZone, nowIso(clock));
  recordAudit(
    db,
    { projectId: id, actorRole: 'AP', action: 'PROJECT_CREATED', entityType: 'project', entityId: id, newState: 'ACTIVE' },
    clock,
  );
  return id;
}

/** Draft a new configuration version (not yet active). */
export function draftConfiguration(
  db: DB,
  input: {
    projectId: string;
    title: string;
    effectiveAt: string;
    configuration: ProjectConfiguration;
    createdBy: string;
    changeSummary?: string;
    sourceAgreementId?: string;
  },
  clock: Clock = systemClock,
): string {
  const versionRow = db
    .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM configurations WHERE projectId = ?`)
    .get(input.projectId) as { v: number };
  const id = newId('cfg');
  db.prepare(
    `INSERT INTO configurations
      (id, projectId, version, title, effectiveAt, status, configuration, changeSummary, sourceAgreementId, createdBy, createdAt)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    versionRow.v + 1,
    input.title,
    input.effectiveAt,
    JSON.stringify(input.configuration),
    input.changeSummary ?? null,
    input.sourceAgreementId ?? null,
    input.createdBy,
    nowIso(clock),
  );
  recordAudit(
    db,
    {
      projectId: input.projectId,
      actorId: input.createdBy,
      actorRole: 'AP',
      action: 'CONFIG_DRAFTED',
      entityType: 'configuration',
      entityId: id,
      newState: 'DRAFT',
      reason: input.changeSummary ?? null,
    },
    clock,
  );
  return id;
}

/**
 * Activate a configuration version. The AP must have compared it against the
 * signed agreement (blueprint §28); this call records that explicit approval.
 * Prior project days are NOT rewritten — each day keeps the config it was
 * created under.
 */
export function activateConfiguration(
  db: DB,
  configId: string,
  activatedBy: string,
  clock: Clock = systemClock,
): void {
  const cfg = db.prepare(`SELECT * FROM configurations WHERE id = ?`).get(configId) as
    | { id: string; projectId: string; status: string }
    | undefined;
  if (!cfg) throw new Error('configuration not found');
  if (cfg.status === 'ACTIVE') return;

  const tx = db.transaction(() => {
    db.prepare(`UPDATE configurations SET status = 'SUPERSEDED' WHERE projectId = ? AND status = 'ACTIVE'`).run(
      cfg.projectId,
    );
    db.prepare(`UPDATE configurations SET status = 'ACTIVE', activatedBy = ?, activatedAt = ? WHERE id = ?`).run(
      activatedBy,
      nowIso(clock),
      configId,
    );
    db.prepare(`UPDATE projects SET activeConfigurationId = ? WHERE id = ?`).run(configId, cfg.projectId);
    recordAudit(
      db,
      {
        projectId: cfg.projectId,
        actorId: activatedBy,
        actorRole: 'AP',
        action: 'CONFIG_ACTIVATED',
        entityType: 'configuration',
        entityId: configId,
        previousState: 'DRAFT',
        newState: 'ACTIVE',
        reason: 'AP approved configuration against controlling agreement',
      },
      clock,
    );
  });
  tx();
}
