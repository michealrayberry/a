/**
 * Append-only audit trail (blueprint §8.8, §11.13, acceptance #18).
 * Every material state transition records previous/new state + reason.
 */
import type { DB } from './db.js';
import { newId } from './ids.js';
import { nowIso, type Clock, systemClock } from './time.js';

export interface AuditInput {
  projectId?: string | null;
  actorId?: string | null;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  previousState?: string | null;
  newState?: string | null;
  reason?: string | null;
  securityContext?: string | null;
}

export function recordAudit(db: DB, input: AuditInput, clock: Clock = systemClock): string {
  const id = newId('aud');
  db.prepare(
    `INSERT INTO audit_events
      (id, projectId, actorId, actorRole, action, entityType, entityId,
       previousState, newState, reason, serverTimestamp, securityContext)
     VALUES (@id, @projectId, @actorId, @actorRole, @action, @entityType, @entityId,
       @previousState, @newState, @reason, @serverTimestamp, @securityContext)`,
  ).run({
    id,
    projectId: input.projectId ?? null,
    actorId: input.actorId ?? null,
    actorRole: input.actorRole,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    previousState: input.previousState ?? null,
    newState: input.newState ?? null,
    reason: input.reason ?? null,
    serverTimestamp: nowIso(clock),
    securityContext: input.securityContext ?? null,
  });
  return id;
}

export function auditFor(db: DB, entityType: string, entityId: string) {
  return db
    .prepare(
      `SELECT * FROM audit_events WHERE entityType = ? AND entityId = ? ORDER BY serverTimestamp ASC`,
    )
    .all(entityType, entityId);
}
