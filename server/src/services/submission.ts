/**
 * Participant submission flow (blueprint §7.4–§7.11).
 *
 * Server authority (acceptance #5, #6, #19): the *server received* time is the
 * only trusted instant. A client-asserted capture time is stored for the audit
 * trail but never determines timeliness.
 *
 * Evidence-before-status (§3.3): a requirement can only reach SUBMITTED after
 * an evidence / link / tracking record actually exists for it.
 */
import type { DB } from '../db.js';
import { newId, shortCode } from '../ids.js';
import { recordAudit } from '../audit.js';
import { transition, type EvidenceState, type RequirementState } from '../stateMachines.js';
import { evaluateTimeliness, nowIso, type Clock, systemClock } from '../time.js';

interface ReqInstanceRow {
  id: string;
  projectDayId: string;
  requirementCode: string;
  evidenceType: string;
  status: RequirementState;
  deadlineAt: string;
  grace: string | null;
}

function reqInstance(db: DB, id: string): ReqInstanceRow {
  const row = db.prepare(`SELECT * FROM requirement_instances WHERE id = ?`).get(id) as
    | ReqInstanceRow
    | undefined;
  if (!row) throw new Error('requirement instance not found');
  return row;
}

function projectIdForDay(db: DB, projectDayId: string): string {
  const row = db.prepare(`SELECT projectId FROM project_days WHERE id = ?`).get(projectDayId) as {
    projectId: string;
  };
  return row.projectId;
}

/**
 * Create an evidence record for a requirement instance. In this reference
 * implementation the "upload" is simulated: the caller supplies metadata
 * (hash, size, capture times). The server stamps serverReceivedAt itself.
 */
export function submitEvidence(
  db: DB,
  input: {
    requirementInstanceId: string;
    actorId: string;
    type: string;
    sha256?: string;
    sizeBytes?: number;
    durationMs?: number;
    captureStartedAt?: string;
    captureCompletedAt?: string;
    appVersion?: string;
    scriptVersion?: string;
    recordingTemplateVersion?: string;
    storagePath?: string;
  },
  clock: Clock = systemClock,
): { evidenceId: string; shortCode: string; serverReceivedAt: string } {
  const ri = reqInstance(db, input.requirementInstanceId);
  const projectId = projectIdForDay(db, ri.projectDayId);
  const now = nowIso(clock);
  const id = newId('evi');

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO evidence
        (id, projectId, projectDayId, requirementInstanceId, type, state,
         originalStoragePath, sha256, sizeBytes, durationMs, captureStartedAt, captureCompletedAt,
         uploadedAt, serverReceivedAt, processingStatus, validationStatus,
         scriptVersion, recordingTemplateVersion, appVersion, publicStatus, createdAt)
       VALUES (?, ?, ?, ?, ?, 'READY_FOR_REVIEW', ?, ?, ?, ?, ?, ?, ?, ?, 'READY', 'PENDING', ?, ?, ?, 'PRIVATE', ?)`,
    ).run(
      id,
      projectId,
      ri.projectDayId,
      ri.id,
      input.type,
      input.storagePath ?? null,
      input.sha256 ?? null,
      input.sizeBytes ?? null,
      input.durationMs ?? null,
      input.captureStartedAt ?? null,
      input.captureCompletedAt ?? null,
      now, // uploadedAt
      now, // serverReceivedAt — TRUSTED
      input.scriptVersion ?? null,
      input.recordingTemplateVersion ?? null,
      input.appVersion ?? null,
      now,
    );

    // Move the requirement toward SUBMITTED if it isn't already past that.
    let next: RequirementState = ri.status;
    if (ri.status === 'NOT_STARTED') next = transition('requirement', ri.status, 'IN_PROGRESS');
    if (next === 'IN_PROGRESS') next = transition('requirement', 'IN_PROGRESS', 'SUBMITTED');
    else if (ri.status === 'DEFICIENT') next = transition('requirement', ri.status, 'CORRECTION_SUBMITTED');

    const timeliness = evaluateTimeliness({
      serverReceivedAtIso: now,
      deadlineIso: ri.deadlineAt,
      graceIso: ri.grace,
      nowIso: now,
    });

    db.prepare(
      `UPDATE requirement_instances SET status = ?, submittedAt = ?, serverReceivedAt = ?, timeliness = ? WHERE id = ?`,
    ).run(next, now, now, timeliness, ri.id);

    recordAudit(
      db,
      {
        projectId,
        actorId: input.actorId,
        actorRole: 'PARTICIPANT',
        action: 'EVIDENCE_SUBMITTED',
        entityType: 'evidence',
        entityId: id,
        newState: 'READY_FOR_REVIEW',
        reason: `${input.type} for ${ri.requirementCode}; timeliness=${timeliness}`,
      },
      clock,
    );
  });
  tx();

  return { evidenceId: id, shortCode: shortCode(id), serverReceivedAt: now };
}

/** Record a structured weight entry (blueprint §7.9, §11.8). */
export function submitWeight(
  db: DB,
  input: {
    projectDayId: string;
    actorId: string;
    weight: number;
    unit: string;
    measurementType?: string;
    measuredAt?: string;
    supersedesEntryId?: string;
    correctionReason?: string;
    /** Optional link to the DAILY_WEIGHT requirement instance to advance it. */
    requirementInstanceId?: string;
  },
  clock: Clock = systemClock,
): { weightId: string } {
  if (input.weight <= 0 || input.weight > 2000) {
    throw new Error('weight out of plausible range');
  }
  const projectId = projectIdForDay(db, input.projectDayId);
  const id = newId('wgt');
  const now = nowIso(clock);
  const tx = db.transaction(() => {
  db.prepare(
    `INSERT INTO weights
      (id, projectId, projectDayId, weight, unit, measurementType, measuredAt, submittedAt,
       verificationStatus, supersedesEntryId, correctionReason, publicStatus)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, 'PRIVATE')`,
  ).run(
    id,
    projectId,
    input.projectDayId,
    input.weight,
    input.unit,
    input.measurementType ?? 'STANDARD',
    input.measuredAt ?? now,
    now,
    input.supersedesEntryId ?? null,
    input.correctionReason ?? null,
  );
  if (input.requirementInstanceId) {
    const ri = reqInstance(db, input.requirementInstanceId);
    let next: RequirementState = ri.status;
    if (ri.status === 'NOT_STARTED') next = transition('requirement', ri.status, 'IN_PROGRESS');
    if (next === 'IN_PROGRESS') next = transition('requirement', 'IN_PROGRESS', 'SUBMITTED');
    else if (ri.status === 'DEFICIENT') next = transition('requirement', ri.status, 'CORRECTION_SUBMITTED');
    const timeliness = evaluateTimeliness({
      serverReceivedAtIso: now,
      deadlineIso: ri.deadlineAt,
      graceIso: ri.grace,
      nowIso: now,
    });
    db.prepare(
      `UPDATE requirement_instances SET status = ?, submittedAt = ?, serverReceivedAt = ?, timeliness = ? WHERE id = ?`,
    ).run(next, now, now, timeliness, ri.id);
    db.prepare(`UPDATE weights SET evidenceIds = ? WHERE id = ?`).run(JSON.stringify([ri.id]), id);
  }
  recordAudit(
    db,
    {
      projectId,
      actorId: input.actorId,
      actorRole: 'PARTICIPANT',
      action: 'WEIGHT_SUBMITTED',
      entityType: 'weight',
      entityId: id,
      newState: 'PENDING',
      reason: input.supersedesEntryId ? `correction: ${input.correctionReason ?? ''}` : null,
    },
    clock,
  );
  });
  tx();
  return { weightId: id };
}

/** Record an external publication link (blueprint §7.8, §11.9). */
export function submitExternalLink(
  db: DB,
  input: {
    requirementInstanceId: string;
    actorId: string;
    platform: string;
    url: string;
    visibility?: string;
  },
  clock: Clock = systemClock,
): { publicationId: string } {
  const ri = reqInstance(db, input.requirementInstanceId);
  const projectId = projectIdForDay(db, ri.projectDayId);
  const now = nowIso(clock);
  if (!/^https?:\/\/.+/i.test(input.url)) throw new Error('invalid url');
  const id = newId('ext');
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO external_publications
        (id, projectDayId, requirementInstanceId, platform, url, visibility, submittedAt, accessibilityStatus, validationMethod, publicStatus)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'MANUAL_REVIEW_REQUIRED', 'MANUAL', 'PRIVATE')`,
    ).run(id, ri.projectDayId, ri.id, input.platform, input.url, input.visibility ?? 'PUBLIC', now);

    let next: RequirementState = ri.status;
    if (ri.status === 'NOT_STARTED') next = transition('requirement', ri.status, 'IN_PROGRESS');
    if (next === 'IN_PROGRESS') next = transition('requirement', 'IN_PROGRESS', 'SUBMITTED');
    const timeliness = evaluateTimeliness({
      serverReceivedAtIso: now,
      deadlineIso: ri.deadlineAt,
      graceIso: ri.grace,
      nowIso: now,
    });
    db.prepare(
      `UPDATE requirement_instances SET status = ?, submittedAt = ?, serverReceivedAt = ?, timeliness = ? WHERE id = ?`,
    ).run(next, now, now, timeliness, ri.id);

    recordAudit(
      db,
      {
        projectId,
        actorId: input.actorId,
        actorRole: 'PARTICIPANT',
        action: 'EXTERNAL_LINK_SUBMITTED',
        entityType: 'external_publication',
        entityId: id,
        newState: 'MANUAL_REVIEW_REQUIRED',
        reason: `${input.platform}`,
      },
      clock,
    );
  });
  tx();
  return { publicationId: id };
}

export type { EvidenceState };
