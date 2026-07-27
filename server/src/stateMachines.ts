/**
 * Explicit state machines (blueprint §24) — no scattered booleans.
 *
 * A transition that is not present in the map is rejected by `transition()`,
 * which throws `IllegalTransition`. This is the single choke point that keeps
 * records from skipping required steps (e.g. an evidence record cannot become
 * VERIFIED without first being READY_FOR_REVIEW).
 */

export class IllegalTransition extends Error {
  constructor(machine: string, from: string, to: string) {
    super(`Illegal ${machine} transition: ${from} -> ${to}`);
    this.name = 'IllegalTransition';
  }
}

// ---- Evidence -------------------------------------------------------------
export type EvidenceState =
  | 'DRAFT'
  | 'CAPTURED'
  | 'QUEUED'
  | 'UPLOADING'
  | 'UPLOADED'
  | 'PROCESSING'
  | 'READY_FOR_REVIEW'
  | 'VERIFIED'
  | 'DEFICIENT'
  | 'REPLACEMENT_SUBMITTED'
  | 'REJECTED'
  | 'FAILED';

const EVIDENCE: Record<EvidenceState, EvidenceState[]> = {
  DRAFT: ['CAPTURED'],
  CAPTURED: ['QUEUED'],
  QUEUED: ['UPLOADING'],
  UPLOADING: ['UPLOADED', 'FAILED'],
  UPLOADED: ['PROCESSING'],
  PROCESSING: ['READY_FOR_REVIEW', 'FAILED'],
  READY_FOR_REVIEW: ['VERIFIED', 'DEFICIENT', 'REJECTED'],
  VERIFIED: [],
  DEFICIENT: ['REPLACEMENT_SUBMITTED'],
  REPLACEMENT_SUBMITTED: ['VERIFIED', 'DEFICIENT', 'REJECTED'],
  REJECTED: [],
  FAILED: ['QUEUED'], // retry re-queues; original is never destroyed
};

// ---- Requirement ----------------------------------------------------------
export type RequirementState =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'VERIFIED'
  | 'LOCKED'
  | 'LATE'
  | 'MISSED'
  | 'DEFICIENT'
  | 'CORRECTION_SUBMITTED'
  | 'EXCUSED'
  | 'NOT_APPLICABLE'
  | 'VIOLATION_PENDING'
  | 'VIOLATION_ASSESSED';

const REQUIREMENT: Record<RequirementState, RequirementState[]> = {
  NOT_STARTED: ['IN_PROGRESS', 'MISSED', 'EXCUSED', 'NOT_APPLICABLE'],
  IN_PROGRESS: ['SUBMITTED', 'MISSED', 'EXCUSED', 'NOT_APPLICABLE'],
  SUBMITTED: ['UNDER_REVIEW', 'LATE'],
  LATE: ['UNDER_REVIEW'],
  UNDER_REVIEW: ['VERIFIED', 'DEFICIENT', 'EXCUSED', 'NOT_APPLICABLE', 'VIOLATION_PENDING'],
  VERIFIED: ['LOCKED'],
  DEFICIENT: ['CORRECTION_SUBMITTED', 'VIOLATION_PENDING'],
  CORRECTION_SUBMITTED: ['UNDER_REVIEW', 'VERIFIED'],
  MISSED: ['VIOLATION_PENDING', 'EXCUSED'],
  VIOLATION_PENDING: ['VIOLATION_ASSESSED', 'EXCUSED'],
  VIOLATION_ASSESSED: ['LOCKED'],
  EXCUSED: ['LOCKED'],
  NOT_APPLICABLE: ['LOCKED'],
  LOCKED: [],
};

// ---- Violation ------------------------------------------------------------
export type ViolationState =
  | 'PROPOSED'
  | 'ASSESSED'
  | 'ACKNOWLEDGED'
  | 'COMPLETED'
  | 'ARCHIVED'
  | 'OVERDUE'
  | 'ESCALATED'
  | 'FACTUAL_REVIEW'
  | 'CONFIRMED'
  | 'REVERSED';

const VIOLATION: Record<ViolationState, ViolationState[]> = {
  PROPOSED: ['ASSESSED'],
  ASSESSED: ['ACKNOWLEDGED', 'OVERDUE', 'FACTUAL_REVIEW'],
  ACKNOWLEDGED: ['COMPLETED', 'OVERDUE', 'FACTUAL_REVIEW'],
  COMPLETED: ['ARCHIVED'],
  OVERDUE: ['ESCALATED', 'COMPLETED', 'FACTUAL_REVIEW'],
  ESCALATED: ['COMPLETED', 'FACTUAL_REVIEW', 'ARCHIVED'],
  FACTUAL_REVIEW: ['CONFIRMED', 'REVERSED'],
  CONFIRMED: ['ACKNOWLEDGED', 'ARCHIVED'],
  REVERSED: ['ARCHIVED'],
  ARCHIVED: [],
};

const MACHINES = {
  evidence: EVIDENCE,
  requirement: REQUIREMENT,
  violation: VIOLATION,
} as const;

export type MachineName = keyof typeof MACHINES;

export function canTransition(machine: MachineName, from: string, to: string): boolean {
  const table = MACHINES[machine] as Record<string, string[]>;
  const allowed = table[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/** Assert-and-return the target state, or throw IllegalTransition. */
export function transition<T extends string>(machine: MachineName, from: T, to: T): T {
  if (!canTransition(machine, from, to)) {
    throw new IllegalTransition(machine, from, to);
  }
  return to;
}

export function terminalStates(machine: MachineName): string[] {
  const table = MACHINES[machine] as Record<string, string[]>;
  return Object.entries(table)
    .filter(([, next]) => next.length === 0)
    .map(([state]) => state);
}
