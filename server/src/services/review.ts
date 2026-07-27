/**
 * Accountability Partner determinations (blueprint §8.3–§8.5).
 *
 * Authority boundaries (§3.5, acceptance #7): only the AP verifies evidence,
 * issues deficiencies, and assesses violations. The participant can never reach
 * these code paths — routes guard them with requireRole('AP').
 */
import type { DB } from '../db.js';
import { newId } from '../ids.js';
import { recordAudit } from '../audit.js';
import { transition, type EvidenceState, type RequirementState } from '../stateMachines.js';
import { computeDayStatus } from '../engine.js';
import { nowIso, type Clock, systemClock } from '../time.js';
import type { ProjectConfiguration } from '../config.js';

function evidenceRow(db: DB, id: string) {
  const row = db.prepare(`SELECT * FROM evidence WHERE id = ?`).get(id) as
    | { id: string; state: EvidenceState; requirementInstanceId: string; projectId: string; projectDayId: string }
    | undefined;
  if (!row) throw new Error('evidence not found');
  return row;
}

function refreshDay(db: DB, projectDayId: string): void {
  const status = computeDayStatus(db, projectDayId);
  db.prepare(`UPDATE project_days SET overallStatus = ? WHERE id = ?`).run(status, projectDayId);
}

/** Verify a piece of evidence and its requirement (AP only). */
export function verifyEvidence(
  db: DB,
  input: { evidenceId: string; apId: string; note?: string },
  clock: Clock = systemClock,
): void {
  const ev = evidenceRow(db, input.evidenceId);
  const ri = db.prepare(`SELECT * FROM requirement_instances WHERE id = ?`).get(ev.requirementInstanceId) as {
    id: string;
    status: RequirementState;
    projectDayId: string;
  };
  const now = nowIso(clock);
  const tx = db.transaction(() => {
    const evNext = transition('evidence', ev.state, 'VERIFIED');
    db.prepare(`UPDATE evidence SET state = ? WHERE id = ?`).run(evNext, ev.id);

    // Requirement may be SUBMITTED, LATE, UNDER_REVIEW, or CORRECTION_SUBMITTED.
    let from = ri.status;
    if (from === 'SUBMITTED' || from === 'LATE') from = transition('requirement', from, 'UNDER_REVIEW');
    const reqNext = transition('requirement', from, 'VERIFIED');
    db.prepare(`UPDATE requirement_instances SET status = ?, verifiedAt = ?, verifiedBy = ? WHERE id = ?`).run(
      reqNext,
      now,
      input.apId,
      ri.id,
    );
    recordAudit(
      db,
      {
        actorId: input.apId,
        actorRole: 'AP',
        action: 'EVIDENCE_VERIFIED',
        entityType: 'evidence',
        entityId: ev.id,
        previousState: ev.state,
        newState: 'VERIFIED',
        reason: input.note ?? null,
      },
      clock,
    );
    refreshDay(db, ri.projectDayId);
  });
  tx();
}

/** Verify a weight entry and advance its linked requirement (AP only). */
export function verifyWeight(
  db: DB,
  input: { weightId: string; apId: string; publish?: boolean },
  clock: Clock = systemClock,
): void {
  const w = db.prepare(`SELECT * FROM weights WHERE id = ?`).get(input.weightId) as
    | { id: string; projectId: string; evidenceIds: string | null }
    | undefined;
  if (!w) throw new Error('weight not found');
  const now = nowIso(clock);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE weights SET verificationStatus='VERIFIED', verifiedBy=?, verifiedAt=?, publicStatus=? WHERE id=?`,
    ).run(input.apId, now, input.publish ? 'PUBLIC' : 'PRIVATE', w.id);

    const linked: string[] = w.evidenceIds ? JSON.parse(w.evidenceIds) : [];
    for (const riId of linked) {
      const ri = db.prepare(`SELECT status, projectDayId FROM requirement_instances WHERE id = ?`).get(riId) as
        | { status: RequirementState; projectDayId: string }
        | undefined;
      if (!ri) continue;
      let from = ri.status;
      if (from === 'SUBMITTED' || from === 'LATE') from = transition('requirement', from, 'UNDER_REVIEW');
      if (from === 'UNDER_REVIEW' || from === 'CORRECTION_SUBMITTED') {
        const next = transition('requirement', from, 'VERIFIED');
        db.prepare(`UPDATE requirement_instances SET status=?, verifiedAt=?, verifiedBy=? WHERE id=?`).run(
          next,
          now,
          input.apId,
          riId,
        );
        refreshDay(db, ri.projectDayId);
      }
    }
    recordAudit(
      db,
      {
        projectId: w.projectId,
        actorId: input.apId,
        actorRole: 'AP',
        action: 'WEIGHT_VERIFIED',
        entityType: 'weight',
        entityId: w.id,
        newState: 'VERIFIED',
      },
      clock,
    );
  });
  tx();
}

/** Issue a deficiency notice (AP only). Requires a reason (§8.3). */
export function issueDeficiency(
  db: DB,
  input: {
    evidenceId?: string;
    requirementInstanceId: string;
    apId: string;
    reasonCode: string;
    description: string;
    ruleCitation?: string;
    correctionAllowed?: boolean;
    correctionWindow?: string | null; // ISO duration
  },
  clock: Clock = systemClock,
): { deficiencyId: string } {
  if (!input.description?.trim()) throw new Error('deficiency requires a description');
  const ri = db.prepare(`SELECT * FROM requirement_instances WHERE id = ?`).get(input.requirementInstanceId) as {
    id: string;
    status: RequirementState;
    projectDayId: string;
  };
  const dayRow = db.prepare(`SELECT projectId FROM project_days WHERE id = ?`).get(ri.projectDayId) as {
    projectId: string;
  };
  const now = nowIso(clock);
  const id = newId('def');
  const correctionWindow = input.correctionWindow;
  const correctionDueAt = correctionWindow
    ? nowIso({ now: () => clock.now().plus(parseIsoDuration(correctionWindow)) })
    : null;

  const tx = db.transaction(() => {
    if (input.evidenceId) {
      const ev = evidenceRow(db, input.evidenceId);
      const evNext = transition('evidence', ev.state, 'DEFICIENT');
      db.prepare(`UPDATE evidence SET state = ? WHERE id = ?`).run(evNext, ev.id);
    }
    let from = ri.status;
    if (from === 'SUBMITTED' || from === 'LATE') from = transition('requirement', from, 'UNDER_REVIEW');
    const reqNext = transition('requirement', from, 'DEFICIENT');
    db.prepare(`UPDATE requirement_instances SET status = ? WHERE id = ?`).run(reqNext, ri.id);

    db.prepare(
      `INSERT INTO deficiencies
        (id, projectDayId, requirementInstanceId, issuedBy, issuedAt, reasonCode, description, ruleCitation, correctionAllowed, correctionDueAt, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
    ).run(
      id,
      ri.projectDayId,
      ri.id,
      input.apId,
      now,
      input.reasonCode,
      input.description,
      input.ruleCitation ?? null,
      input.correctionAllowed === false ? 0 : 1,
      correctionDueAt,
    );

    db.prepare(
      `INSERT INTO notices (id, projectId, projectDayId, type, title, body, issuedByRole, issuedBy, issuedAt, responseRequired, responseDueAt, publicStatus)
       VALUES (?, ?, ?, 'DEFICIENCY', ?, ?, 'AP', ?, ?, 1, ?, 'PRIVATE')`,
    ).run(
      newId('not'),
      dayRow.projectId,
      ri.projectDayId,
      'Deficiency notice',
      input.description,
      input.apId,
      now,
      correctionDueAt,
    );

    recordAudit(
      db,
      {
        projectId: dayRow.projectId,
        actorId: input.apId,
        actorRole: 'AP',
        action: 'DEFICIENCY_ISSUED',
        entityType: 'deficiency',
        entityId: id,
        newState: 'OPEN',
        reason: `${input.reasonCode}: ${input.description}`,
      },
      clock,
    );
    refreshDay(db, ri.projectDayId);
  });
  tx();
  return { deficiencyId: id };
}

/**
 * Assess a violation (AP only, blueprint §8.5). The consequence is validated
 * against the active consequence table; a mismatch WARNS but does not silently
 * block — the AP may override with an explicit reason (recorded in audit).
 */
export function assessViolation(
  db: DB,
  input: {
    projectId: string;
    projectDayId: string;
    requirementInstanceId?: string;
    apId: string;
    violationType: string;
    factualBasis: string;
    ruleCitation?: string;
    consequenceAmount?: number | null;
    dueAt?: string;
    override?: { reason: string };
  },
  clock: Clock = systemClock,
): { violationId: string; warnings: string[] } {
  if (!input.factualBasis?.trim()) throw new Error('violation requires a factual basis');
  const now = nowIso(clock);
  const warnings: string[] = [];

  const project = db.prepare(`SELECT activeConfigurationId FROM projects WHERE id = ?`).get(input.projectId) as {
    activeConfigurationId: string;
  };
  const cfgRow = db.prepare(`SELECT configuration FROM configurations WHERE id = ?`).get(
    project.activeConfigurationId,
  ) as { configuration: string };
  const cfg = JSON.parse(cfgRow.configuration) as ProjectConfiguration;

  const priorCount = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM violations WHERE projectId = ? AND consequenceType = ?`)
      .get(input.projectId, input.violationType) as { c: number }
  ).c;
  const occurrence = priorCount + 1;
  const rule =
    cfg.consequences.find((r) => r.violationType === input.violationType && r.occurrence === occurrence) ??
    cfg.consequences
      .filter((r) => r.violationType === input.violationType)
      .sort((a, b) => b.occurrence - a.occurrence)[0];

  let amount = input.consequenceAmount ?? rule?.amount ?? null;
  if (rule && input.consequenceAmount != null && input.consequenceAmount !== rule.amount) {
    warnings.push(
      `Proposed amount ${input.consequenceAmount} differs from configured ${rule.amount} for ${input.violationType} occurrence ${occurrence}.`,
    );
    if (!input.override) throw new Error('consequence override requires an explicit reason');
    amount = input.consequenceAmount;
  }

  const violationNumber =
    ((db.prepare(`SELECT COALESCE(MAX(violationNumber),0) AS n FROM violations WHERE projectId = ?`).get(
      input.projectId,
    ) as { n: number }).n) + 1;
  const id = newId('vio');
  const dueAt = input.dueAt ?? (rule ? nowIso({ now: () => clock.now().plus({ days: rule.dueInDays }) }) : null);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO violations
        (id, projectId, projectDayId, requirementInstanceId, violationNumber, ruleCitation, factualBasis,
         assessedBy, assessedAt, consequenceType, consequenceAmount, dueAt, state, paymentStatus, publicStatus)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ASSESSED', ?, ?)`,
    ).run(
      id,
      input.projectId,
      input.projectDayId,
      input.requirementInstanceId ?? null,
      violationNumber,
      input.ruleCitation ?? null,
      input.factualBasis,
      input.apId,
      now,
      input.violationType,
      amount,
      dueAt,
      amount != null ? 'UNPAID' : null,
      cfg.publication.violationsDefault,
    );

    if (input.requirementInstanceId) {
      const ri = db.prepare(`SELECT status FROM requirement_instances WHERE id = ?`).get(
        input.requirementInstanceId,
      ) as { status: RequirementState };
      // Route requirement into VIOLATION_PENDING then ASSESSED where legal.
      // MISSED / DEFICIENT / UNDER_REVIEW can all route into VIOLATION_PENDING.
      if (['MISSED', 'DEFICIENT', 'UNDER_REVIEW'].includes(ri.status)) {
        const pending = transition('requirement', ri.status, 'VIOLATION_PENDING');
        const assessed = transition('requirement', pending, 'VIOLATION_ASSESSED');
        db.prepare(`UPDATE requirement_instances SET status = ? WHERE id = ?`).run(assessed, input.requirementInstanceId);
      }
    }

    db.prepare(
      `INSERT INTO notices (id, projectId, projectDayId, type, title, body, issuedByRole, issuedBy, issuedAt, responseRequired, responseDueAt, publicStatus)
       VALUES (?, ?, ?, 'VIOLATION', ?, ?, 'AP', ?, ?, 1, ?, 'PRIVATE')`,
    ).run(
      newId('not'),
      input.projectId,
      input.projectDayId,
      `Violation #${violationNumber} assessed`,
      input.factualBasis,
      input.apId,
      now,
      dueAt,
    );

    recordAudit(
      db,
      {
        projectId: input.projectId,
        actorId: input.apId,
        actorRole: 'AP',
        action: 'VIOLATION_ASSESSED',
        entityType: 'violation',
        entityId: id,
        newState: 'ASSESSED',
        reason: input.override ? `OVERRIDE: ${input.override.reason}` : input.factualBasis,
      },
      clock,
    );
    refreshDay(db, input.projectDayId);
  });
  tx();
  return { violationId: id, warnings };
}

/** Participant acknowledges a violation without editing it (acceptance #12). */
export function acknowledgeViolation(
  db: DB,
  input: { violationId: string; participantId: string },
  clock: Clock = systemClock,
): void {
  const v = db.prepare(`SELECT * FROM violations WHERE id = ?`).get(input.violationId) as
    | { id: string; state: string; projectId: string }
    | undefined;
  if (!v) throw new Error('violation not found');
  const next = transition('violation', v.state, 'ACKNOWLEDGED');
  db.prepare(`UPDATE violations SET state = ?, acknowledgedAt = ? WHERE id = ?`).run(
    next,
    nowIso(clock),
    v.id,
  );
  recordAudit(
    db,
    {
      projectId: v.projectId,
      actorId: input.participantId,
      actorRole: 'PARTICIPANT',
      action: 'VIOLATION_ACKNOWLEDGED',
      entityType: 'violation',
      entityId: v.id,
      previousState: v.state,
      newState: 'ACKNOWLEDGED',
    },
    clock,
  );
}

/** Publish a record to the public feed (AP only, blueprint §3.6). */
export function setPublicStatus(
  db: DB,
  input: { table: 'project_days' | 'weights' | 'violations' | 'evidence'; id: string; status: string; apId: string },
  clock: Clock = systemClock,
): void {
  const allowed = ['PRIVATE', 'PENDING', 'PUBLIC', 'UNLISTED', 'WITHHELD', 'REMOVED'];
  if (!allowed.includes(input.status)) throw new Error('invalid publication status');
  const publishedCol = input.table === 'project_days' ? ', publicPublishedAt = ?' : '';
  const stmt =
    input.table === 'project_days'
      ? db.prepare(`UPDATE project_days SET publicStatus = ?${publishedCol} WHERE id = ?`)
      : db.prepare(`UPDATE ${input.table} SET publicStatus = ? WHERE id = ?`);
  if (input.table === 'project_days') stmt.run(input.status, nowIso(clock), input.id);
  else stmt.run(input.status, input.id);
  recordAudit(
    db,
    {
      actorId: input.apId,
      actorRole: 'AP',
      action: 'PUBLICATION_STATUS_SET',
      entityType: input.table,
      entityId: input.id,
      newState: input.status,
    },
    clock,
  );
}

function parseIsoDuration(iso: string): { hours?: number; minutes?: number } {
  // Minimal PTnHnM parser sufficient for correction windows.
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(iso);
  return { hours: m?.[1] ? parseInt(m[1], 10) : 0, minutes: m?.[2] ? parseInt(m[2], 10) : 0 };
}
