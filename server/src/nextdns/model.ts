/**
 * Web-controls domain model: the two NextDNS profiles, control kinds, state
 * enums, and strict input validation (NextDNS direction §2, §10, §14).
 */
import type { RuleRef } from './gateway.js';

/**
 * The two logically separate NextDNS contexts. RAY-PIXEL is the participant's
 * own phone (Android Private DNS, Wi-Fi + cellular). HOME-ROUTER is the shared
 * Google Nest Wifi network: its traffic includes computers, TVs, smart-home
 * devices and guests, so it is NEVER attributed to the participant personally.
 */
export const PROFILE_LABELS = ['RAY-PIXEL', 'HOME-ROUTER'] as const;
export type ProfileLabel = (typeof PROFILE_LABELS)[number];

export const PROFILE_DEFINITIONS: Record<
  ProfileLabel,
  { attribution: 'PARTICIPANT_DEVICE' | 'SHARED_NETWORK'; description: string }
> = {
  'RAY-PIXEL': {
    attribution: 'PARTICIPANT_DEVICE',
    description: 'Primary Android phone via Android Private DNS (Wi-Fi and cellular). Preferred source for phone-specific accountability.',
  },
  'HOME-ROUTER': {
    attribution: 'SHARED_NETWORK',
    description: 'Google Nest Wifi home network. Shared by other devices and guests; not attributable to the participant personally.',
  },
};

/** BLOCK → denylist / service block; ALLOW → allowlist; MONITOR → portal-side only. */
export type ControlKind = 'BLOCK' | 'ALLOW' | 'MONITOR';
export type TargetType = 'DOMAIN' | 'SERVICE';
export type ControlState = 'ACTIVE' | 'TEMPORARILY_ALLOWED' | 'REMOVED';
/** PENDING/SYNC_FAILED controls are reconciled to NextDNS by the sweep until IN_SYNC. */
export type SyncStatus = 'IN_SYNC' | 'PENDING' | 'SYNC_FAILED';

export type GrantStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';
export type AccessRequestStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'WITHDRAWN';

/**
 * Status vocabulary for monitoring integrity (§7). Phase 1 can produce ACTIVE,
 * DEGRADED and NOT_CONFIGURED. INTERRUPTED and RESTORED require positive
 * confirmation (phone heartbeat, Phase 5) — missing DNS traffic alone is never
 * treated as an interruption, let alone as misconduct.
 */
export type IntegrityStatus = 'ACTIVE' | 'DEGRADED' | 'INTERRUPTED' | 'RESTORED' | 'NOT_CONFIGURED';

/** Per-profile reporting state. NO_RECENT_ACTIVITY is informational, not accusatory. */
export type ProfileReportingStatus = 'REPORTING' | 'NO_RECENT_ACTIVITY' | 'UNVERIFIED' | 'NOT_CONFIGURED';

export const MIN_GRANT_MINUTES = 1;
export const MAX_GRANT_MINUTES = 24 * 60;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const SERVICE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PROFILE_ID_RE = /^[a-z0-9]{4,32}$/i;

/** Accept a bare hostname only — no scheme, path, port, wildcard, or IP literal. */
export function normalizeDomain(input: unknown): string {
  if (typeof input !== 'string') throw new ValidationError('domain_required');
  const d = input.trim().toLowerCase().replace(/\.$/, '');
  if (!DOMAIN_RE.test(d)) throw new ValidationError('invalid_domain');
  return d;
}

export function normalizeServiceId(input: unknown): string {
  if (typeof input !== 'string') throw new ValidationError('service_required');
  const s = input.trim().toLowerCase();
  if (!SERVICE_RE.test(s)) throw new ValidationError('invalid_service_id');
  return s;
}

export function normalizeProfileId(input: unknown): string {
  if (typeof input !== 'string' || !PROFILE_ID_RE.test(input.trim())) {
    throw new ValidationError('invalid_nextdns_profile_id');
  }
  return input.trim();
}

export function parseProfileLabels(input: unknown): ProfileLabel[] {
  const list = input === undefined ? [...PROFILE_LABELS] : input;
  if (!Array.isArray(list) || list.length === 0) throw new ValidationError('profiles_required');
  const out = new Set<ProfileLabel>();
  for (const l of list) {
    if (!PROFILE_LABELS.includes(l as ProfileLabel)) throw new ValidationError(`unknown_profile:${String(l)}`);
    out.add(l as ProfileLabel);
  }
  return [...out];
}

export function parseGrantMinutes(input: unknown): number {
  const n = typeof input === 'string' ? Number(input) : input;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < MIN_GRANT_MINUTES || n > MAX_GRANT_MINUTES) {
    throw new ValidationError(`duration_minutes_must_be_${MIN_GRANT_MINUTES}_to_${MAX_GRANT_MINUTES}`);
  }
  return n;
}

/** Map a control to its NextDNS rule. MONITOR controls have none. */
export function ruleFor(kind: ControlKind, targetType: TargetType, target: string): RuleRef | null {
  if (kind === 'MONITOR') return null;
  if (targetType === 'SERVICE') {
    if (kind !== 'BLOCK') throw new ValidationError('services_can_only_be_blocked');
    return { collection: 'services', id: target };
  }
  return { collection: kind === 'BLOCK' ? 'denylist' : 'allowlist', id: target };
}

/**
 * Desired remote state for a control. A temporarily allowed BLOCK keeps its
 * NextDNS entry but deactivated, so restoring is a single flag flip.
 */
export function desiredRuleState(kind: ControlKind, state: ControlState): 'ACTIVE' | 'INACTIVE' | 'ABSENT' {
  if (state === 'REMOVED') return 'ABSENT';
  if (kind === 'BLOCK' && state === 'TEMPORARILY_ALLOWED') return 'INACTIVE';
  return 'ACTIVE';
}
