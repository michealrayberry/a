/**
 * Web Controls service — the AP Portal's NextDNS operations (docs/NEXTDNS.md).
 *
 * Design rules:
 *  - `web_controls` is the AP's policy of record. NextDNS is reconciled TO it.
 *    A failed NextDNS write never makes the database lie: the control is marked
 *    SYNC_FAILED and the sweep keeps retrying until NextDNS matches.
 *  - Only explicit, purpose-built operations exist (blockDomain, allowDomain,
 *    grantTemporaryAccess, restoreRestriction, …). There is no pass-through.
 *  - Temporary access always expires server-side. Restoration does not depend
 *    on the AP remembering anything.
 *  - Every material action is written to the append-only audit trail with
 *    actor, action, target, previous/new state, and MANUAL vs AUTOMATIC mode.
 */
import type { DB } from '../db.js';
import { recordAudit } from '../audit.js';
import { newId } from '../ids.js';
import { nowIso, type Clock, systemClock } from '../time.js';
import { DateTime } from 'luxon';
import {
  FILTERING_SETTING_KEYS,
  NextDnsError,
  type FilteringSettings,
  type NextDnsGateway,
} from '../nextdns/gateway.js';
import {
  PROFILE_DEFINITIONS,
  PROFILE_LABELS,
  ValidationError,
  desiredRuleState,
  normalizeDomain,
  normalizeProfileId,
  normalizeServiceId,
  parseGrantMinutes,
  parseProfileLabels,
  ruleFor,
  type ControlKind,
  type ControlState,
  type IntegrityStatus,
  type ProfileLabel,
  type ProfileReportingStatus,
  type SyncStatus,
  type TargetType,
} from '../nextdns/model.js';

/** Error with an HTTP status the routes can map directly. */
export class WebControlError extends Error {
  constructor(
    message: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'WebControlError';
  }
}

/** A DNS profile is "reporting" if NextDNS logged a query within this window. */
export const REPORTING_WINDOW_MINUTES = 30;

export interface Actor {
  id: string | null;
  role: 'AP' | 'PARTICIPANT' | 'SYSTEM';
}
const SYSTEM: Actor = { id: null, role: 'SYSTEM' };

export interface ProfileRow {
  id: string;
  projectId: string;
  label: ProfileLabel;
  nextdnsProfileId: string | null;
  attribution: string;
  description: string;
  boundBy: string | null;
  boundAt: string | null;
}

export interface ControlRow {
  id: string;
  projectId: string;
  kind: ControlKind;
  targetType: TargetType;
  target: string;
  displayName: string;
  profiles: string; // JSON ProfileLabel[]
  state: ControlState;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
  lastSyncAt: string | null;
  createdBy: string;
  createdAt: string;
  removedBy: string | null;
  removedAt: string | null;
}

interface GrantRow {
  id: string;
  projectId: string;
  controlId: string;
  accessRequestId: string | null;
  grantedBy: string;
  grantedAt: string;
  durationMinutes: number;
  expiresAt: string;
  status: string;
}

interface RequestRow {
  id: string;
  projectId: string;
  controlId: string;
  requestedBy: string;
  requestedAt: string;
  requestedMinutes: number;
  reason: string;
  status: string;
}

// ---- audit -----------------------------------------------------------------

function audit(
  db: DB,
  clock: Clock,
  a: {
    projectId: string;
    actor: Actor;
    action: string;
    entityType: string;
    entityId: string;
    target: string;
    previousState?: string | null;
    newState?: string | null;
    reason: string;
  },
): void {
  recordAudit(
    db,
    {
      projectId: a.projectId,
      actorId: a.actor.id,
      actorRole: a.actor.role,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      previousState: a.previousState ?? null,
      newState: a.newState ?? null,
      reason: a.reason,
      securityContext: JSON.stringify({ mode: a.actor.role === 'SYSTEM' ? 'AUTOMATIC' : 'MANUAL', target: a.target }),
    },
    clock,
  );
}

function controlSnapshot(c: Pick<ControlRow, 'kind' | 'state'> & { syncStatus?: string }): string {
  return `${c.kind}:${c.state}`;
}

// ---- profiles --------------------------------------------------------------

/** Create the RAY-PIXEL / HOME-ROUTER records for a project if missing (unbound). */
export function ensureProfiles(db: DB, projectId: string, clock: Clock = systemClock): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO nextdns_profiles (id, projectId, label, attribution, description, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const label of PROFILE_LABELS) {
    const def = PROFILE_DEFINITIONS[label];
    insert.run(newId('ndp'), projectId, label, def.attribution, def.description, nowIso(clock));
  }
}

export function listProfiles(db: DB, projectId: string): ProfileRow[] {
  return db
    .prepare(`SELECT * FROM nextdns_profiles WHERE projectId = ? ORDER BY label DESC`)
    .all(projectId) as ProfileRow[];
}

function profileMap(db: DB, projectId: string): Map<ProfileLabel, ProfileRow> {
  return new Map(listProfiles(db, projectId).map((p) => [p.label, p]));
}

function requireGateway(gw: NextDnsGateway | null): NextDnsGateway {
  if (!gw) throw new WebControlError('nextdns_not_configured', 503);
  return gw;
}

/**
 * Bind a portal profile (RAY-PIXEL / HOME-ROUTER) to a NextDNS profile id.
 * The id is verified against the API first, so a typo cannot silently leave a
 * profile unenforced. Existing controls are re-pushed to the new binding.
 */
export async function bindProfile(
  db: DB,
  gw: NextDnsGateway | null,
  input: { projectId: string; label: unknown; nextdnsProfileId: unknown; apId: string },
  clock: Clock = systemClock,
): Promise<ProfileRow> {
  const g = requireGateway(gw);
  ensureProfiles(db, input.projectId, clock);
  const [label] = parseProfileLabels([input.label]);
  const nextdnsProfileId = normalizeProfileId(input.nextdnsProfileId);
  try {
    await g.getProfile(nextdnsProfileId);
  } catch (e) {
    throw new WebControlError(
      e instanceof NextDnsError && e.status === 404 ? 'nextdns_profile_not_found' : 'nextdns_unreachable',
      e instanceof NextDnsError && e.status === 404 ? 400 : 502,
    );
  }
  const before = profileMap(db, input.projectId).get(label!)!;
  db.transaction(() => {
    db.prepare(`UPDATE nextdns_profiles SET nextdnsProfileId = ?, boundBy = ?, boundAt = ? WHERE id = ?`).run(
      nextdnsProfileId,
      input.apId,
      nowIso(clock),
      before.id,
    );
    // Push the existing policy to the (new) profile on the next reconcile.
    db.prepare(
      `UPDATE web_controls SET syncStatus = 'PENDING'
        WHERE projectId = ? AND state != 'REMOVED' AND kind != 'MONITOR' AND profiles LIKE ?`,
    ).run(input.projectId, `%"${label}"%`);
    audit(db, clock, {
      projectId: input.projectId,
      actor: { id: input.apId, role: 'AP' },
      action: 'NEXTDNS_PROFILE_BOUND',
      entityType: 'nextdns_profile',
      entityId: before.id,
      target: label!,
      previousState: before.nextdnsProfileId ?? 'UNBOUND',
      newState: nextdnsProfileId,
      reason: `AP bound ${label} to NextDNS profile ${nextdnsProfileId}.`,
    });
  })();
  await reconcileOutstanding(db, gw, input.projectId, clock);
  return profileMap(db, input.projectId).get(label!)!;
}

// ---- reconciliation ----------------------------------------------------------

function getControl(db: DB, id: string): ControlRow {
  const c = db.prepare(`SELECT * FROM web_controls WHERE id = ?`).get(id) as ControlRow | undefined;
  if (!c) throw new WebControlError('control_not_found', 404);
  return c;
}

/**
 * Make NextDNS match the control's desired state on every target profile.
 * Records SYNC_FAILED / recovery transitions in the audit trail (once per
 * transition, not once per retry). Returns true when fully in sync.
 */
async function reconcile(
  db: DB,
  gw: NextDnsGateway | null,
  controlId: string,
  clock: Clock,
  onSuccessReason?: { action: string; reason: string; actor: Actor },
): Promise<boolean> {
  const c = getControl(db, controlId);
  const rule = ruleFor(c.kind, c.targetType, c.target);
  const errors: string[] = [];
  if (rule) {
    if (!gw) errors.push('NextDNS integration not configured');
    else {
      const desired = desiredRuleState(c.kind, c.state);
      const profiles = profileMap(db, c.projectId);
      for (const label of JSON.parse(c.profiles) as ProfileLabel[]) {
        const pid = profiles.get(label)?.nextdnsProfileId;
        if (!pid) {
          errors.push(`${label}: profile not bound`);
          continue;
        }
        try {
          if (desired === 'ABSENT') await gw.removeRule(pid, rule);
          else await gw.upsertRule(pid, rule, desired === 'ACTIVE');
        } catch (e) {
          errors.push(`${label}: ${e instanceof NextDnsError ? e.message : 'unexpected error'}`);
        }
      }
    }
  }
  const prev = getControl(db, controlId);
  // The policy changed while NextDNS calls were in flight (e.g. a grant expired):
  // leave it PENDING so the next pass applies the newer state.
  if (prev.state !== c.state) return false;
  const ok = errors.length === 0;
  db.transaction(() => {
    db.prepare(`UPDATE web_controls SET syncStatus = ?, lastSyncError = ?, lastSyncAt = ? WHERE id = ?`).run(
      ok ? 'IN_SYNC' : 'SYNC_FAILED',
      ok ? null : errors.join('; '),
      nowIso(clock),
      controlId,
    );
    if (!ok && prev.syncStatus !== 'SYNC_FAILED') {
      audit(db, clock, {
        projectId: c.projectId,
        actor: SYSTEM,
        action: 'NEXTDNS_SYNC_FAILED',
        entityType: 'web_control',
        entityId: c.id,
        target: c.target,
        previousState: prev.syncStatus,
        newState: 'SYNC_FAILED',
        reason: `NextDNS did not accept the ${c.displayName} policy (${controlSnapshot(c)}): ${errors.join('; ')}. Retrying automatically.`,
      });
    }
    if (ok && prev.syncStatus === 'SYNC_FAILED') {
      audit(db, clock, {
        projectId: c.projectId,
        actor: SYSTEM,
        action: 'NEXTDNS_SYNC_RECOVERED',
        entityType: 'web_control',
        entityId: c.id,
        target: c.target,
        previousState: 'SYNC_FAILED',
        newState: 'IN_SYNC',
        reason: `NextDNS now matches the ${c.displayName} policy (${controlSnapshot(c)}).`,
      });
    }
    if (ok && onSuccessReason) {
      audit(db, clock, {
        projectId: c.projectId,
        actor: onSuccessReason.actor,
        action: onSuccessReason.action,
        entityType: 'web_control',
        entityId: c.id,
        target: c.target,
        newState: controlSnapshot(c),
        reason: onSuccessReason.reason,
      });
    }
  })();
  return ok;
}

async function reconcileOutstanding(db: DB, gw: NextDnsGateway | null, projectId: string | null, clock: Clock) {
  const rows = db
    .prepare(
      `SELECT id FROM web_controls
        WHERE syncStatus IN ('PENDING','SYNC_FAILED') ${projectId ? 'AND projectId = ?' : ''}
        ORDER BY createdAt ASC`,
    )
    .all(...(projectId ? [projectId] : [])) as { id: string }[];
  let synced = 0;
  for (const r of rows) if (await reconcile(db, gw, r.id, clock)) synced++;
  return { attempted: rows.length, synced };
}

// ---- policy controls (Phase 2) ---------------------------------------------

async function createControl(
  db: DB,
  gw: NextDnsGateway | null,
  input: {
    projectId: string;
    kind: ControlKind;
    targetType?: unknown;
    target: unknown;
    displayName?: unknown;
    profiles?: unknown;
    apId: string;
  },
  clock: Clock,
): Promise<ControlRow> {
  ensureProfiles(db, input.projectId, clock);
  const targetType: TargetType = input.targetType === 'SERVICE' ? 'SERVICE' : 'DOMAIN';
  const target = targetType === 'SERVICE' ? normalizeServiceId(input.target) : normalizeDomain(input.target);
  const profiles = parseProfileLabels(input.profiles);
  ruleFor(input.kind, targetType, target); // validates combination
  const displayName =
    typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName.trim().slice(0, 80) : target;

  if (input.kind !== 'MONITOR') {
    requireGateway(gw);
    const pm = profileMap(db, input.projectId);
    const unbound = profiles.filter((l) => !pm.get(l)?.nextdnsProfileId);
    if (unbound.length) throw new WebControlError(`profile_not_bound:${unbound.join(',')}`, 409);
  }
  const live = db
    .prepare(
      `SELECT id FROM web_controls WHERE projectId = ? AND kind = ? AND targetType = ? AND target = ? AND state != 'REMOVED'`,
    )
    .get(input.projectId, input.kind, targetType, target);
  if (live) throw new WebControlError('control_already_exists', 409);
  if (input.kind !== 'MONITOR') {
    const opposite = db
      .prepare(
        `SELECT id FROM web_controls WHERE projectId = ? AND kind = ? AND target = ? AND state != 'REMOVED'`,
      )
      .get(input.projectId, input.kind === 'BLOCK' ? 'ALLOW' : 'BLOCK', target);
    if (opposite) throw new WebControlError('conflicting_control_exists', 409);
  }

  const id = newId('wctl');
  const verb = { BLOCK: 'blocked', ALLOW: 'allowlisted', MONITOR: 'added to monitored domains' }[input.kind];
  db.transaction(() => {
    db.prepare(
      `INSERT INTO web_controls (id, projectId, kind, targetType, target, displayName, profiles, state, syncStatus, createdBy, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'PENDING', ?, ?)`,
    ).run(id, input.projectId, input.kind, targetType, target, displayName, JSON.stringify(profiles), input.apId, nowIso(clock));
    audit(db, clock, {
      projectId: input.projectId,
      actor: { id: input.apId, role: 'AP' },
      action: `WEB_CONTROL_${input.kind}_ADDED`,
      entityType: 'web_control',
      entityId: id,
      target,
      previousState: 'NONE',
      newState: `${input.kind}:ACTIVE`,
      reason: `AP ${verb} ${target}${displayName !== target ? ` (${displayName})` : ''} on ${profiles.join(', ')}.`,
    });
  })();
  await reconcile(db, gw, id, clock);
  return getControl(db, id);
}

export const blockDomain = (db: DB, gw: NextDnsGateway | null, i: Omit<Parameters<typeof createControl>[2], 'kind'>, clock: Clock = systemClock) =>
  createControl(db, gw, { ...i, kind: 'BLOCK' }, clock);
export const allowDomain = (db: DB, gw: NextDnsGateway | null, i: Omit<Parameters<typeof createControl>[2], 'kind'>, clock: Clock = systemClock) =>
  createControl(db, gw, { ...i, kind: 'ALLOW', targetType: 'DOMAIN' }, clock);
export const monitorDomain = (db: DB, i: Omit<Parameters<typeof createControl>[2], 'kind'>, clock: Clock = systemClock) =>
  createControl(db, null, { ...i, kind: 'MONITOR', targetType: 'DOMAIN' }, clock);

/** Permanently lift a control. A reason is required; any active grant is revoked. */
export async function removeControl(
  db: DB,
  gw: NextDnsGateway | null,
  input: { controlId: string; apId: string; reason: unknown },
  clock: Clock = systemClock,
): Promise<ControlRow> {
  const c = getControl(db, input.controlId);
  if (c.state === 'REMOVED') throw new WebControlError('control_already_removed', 409);
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) throw new ValidationError('reason_required');
  if (c.kind !== 'MONITOR') requireGateway(gw);
  db.transaction(() => {
    db.prepare(
      `UPDATE web_temporary_grants SET status = 'REVOKED', endedAt = ?, endedBy = ? WHERE controlId = ? AND status = 'ACTIVE'`,
    ).run(nowIso(clock), input.apId, c.id);
    db.prepare(
      `UPDATE web_access_requests SET status = 'DENIED', decidedBy = ?, decidedAt = ?, decisionNote = 'Control removed'
        WHERE controlId = ? AND status = 'PENDING'`,
    ).run(input.apId, nowIso(clock), c.id);
    db.prepare(
      `UPDATE web_controls SET state = 'REMOVED', syncStatus = 'PENDING', removedBy = ?, removedAt = ? WHERE id = ?`,
    ).run(input.apId, nowIso(clock), c.id);
    audit(db, clock, {
      projectId: c.projectId,
      actor: { id: input.apId, role: 'AP' },
      action: 'WEB_CONTROL_REMOVED',
      entityType: 'web_control',
      entityId: c.id,
      target: c.target,
      previousState: controlSnapshot(c),
      newState: `${c.kind}:REMOVED`,
      reason: `AP removed ${c.kind.toLowerCase()} control for ${c.target}. Reason: ${reason}`,
    });
  })();
  await reconcile(db, gw, c.id, clock);
  return getControl(db, c.id);
}

/** Change selected NextDNS filtering settings on one profile. */
export async function updateFilteringSettings(
  db: DB,
  gw: NextDnsGateway | null,
  input: { projectId: string; label: unknown; settings: unknown; apId: string },
  clock: Clock = systemClock,
): Promise<FilteringSettings> {
  const g = requireGateway(gw);
  ensureProfiles(db, input.projectId, clock);
  const [label] = parseProfileLabels([input.label]);
  const profile = profileMap(db, input.projectId).get(label!)!;
  if (!profile.nextdnsProfileId) throw new WebControlError(`profile_not_bound:${label}`, 409);
  const raw = (input.settings ?? {}) as Record<string, unknown>;
  const patch: Partial<FilteringSettings> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!FILTERING_SETTING_KEYS.includes(k as keyof FilteringSettings)) throw new ValidationError(`setting_not_permitted:${k}`);
    if (typeof v !== 'boolean') throw new ValidationError(`setting_must_be_boolean:${k}`);
    patch[k as keyof FilteringSettings] = v;
  }
  if (!Object.keys(patch).length) throw new ValidationError('no_settings_supplied');
  let before: FilteringSettings;
  try {
    before = (await g.getProfile(profile.nextdnsProfileId)).filtering;
    await g.updateFilteringSettings(profile.nextdnsProfileId, patch);
  } catch (e) {
    throw new WebControlError(e instanceof NextDnsError ? e.message : 'nextdns_unreachable', 502);
  }
  const after = { ...before, ...patch };
  audit(db, clock, {
    projectId: input.projectId,
    actor: { id: input.apId, role: 'AP' },
    action: 'FILTERING_SETTINGS_CHANGED',
    entityType: 'nextdns_profile',
    entityId: profile.id,
    target: label!,
    previousState: JSON.stringify(before),
    newState: JSON.stringify(after),
    reason: `AP changed ${label} filtering: ${Object.entries(patch)
      .map(([k, v]) => `${k} ${v ? 'ON' : 'OFF'}`)
      .join(', ')}.`,
  });
  return after;
}

// ---- temporary access (Phase 3) ----------------------------------------------

const mins = (n: number) => `${n} minute${n === 1 ? '' : 's'}`;

/** "9:12 PM EDT" in the project's time zone, for human-readable audit text. */
function localTime(db: DB, projectId: string, iso: string): string {
  const p = db.prepare(`SELECT timeZone FROM projects WHERE id = ?`).get(projectId) as { timeZone: string } | undefined;
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(p?.timeZone ?? 'utc').toFormat('h:mm a ZZZZ');
}

function grantInsert(
  db: DB,
  c: ControlRow,
  minutes: number,
  actor: Actor & { id: string },
  accessRequestId: string | null,
  clock: Clock,
): GrantRow {
  if (c.kind !== 'BLOCK') throw new WebControlError('only_blocked_controls_can_be_temporarily_allowed', 409);
  if (c.state !== 'ACTIVE') throw new WebControlError(`control_not_restricted:${c.state}`, 409);
  const grantedAt = clock.now();
  const grant: GrantRow = {
    id: newId('wgr'),
    projectId: c.projectId,
    controlId: c.id,
    accessRequestId,
    grantedBy: actor.id,
    grantedAt: grantedAt.toISO()!,
    durationMinutes: minutes,
    expiresAt: grantedAt.plus({ minutes }).toISO()!,
    status: 'ACTIVE',
  };
  db.prepare(
    `INSERT INTO web_temporary_grants (id, projectId, controlId, accessRequestId, grantedBy, grantedAt, durationMinutes, expiresAt, status)
     VALUES (@id, @projectId, @controlId, @accessRequestId, @grantedBy, @grantedAt, @durationMinutes, @expiresAt, @status)`,
  ).run(grant);
  db.prepare(`UPDATE web_controls SET state = 'TEMPORARILY_ALLOWED', syncStatus = 'PENDING' WHERE id = ?`).run(c.id);
  audit(db, clock, {
    projectId: c.projectId,
    actor,
    action: 'TEMP_ACCESS_GRANTED',
    entityType: 'web_control',
    entityId: c.id,
    target: c.target,
    previousState: controlSnapshot(c),
    newState: 'BLOCK:TEMPORARILY_ALLOWED',
    reason: `AP granted ${c.displayName} access for ${mins(minutes)}. Expires ${localTime(db, c.projectId, grant.expiresAt)}.`,
  });
  return grant;
}

/** Direct AP grant (no participant request). */
export async function grantTemporaryAccess(
  db: DB,
  gw: NextDnsGateway | null,
  input: { controlId: string; minutes: unknown; apId: string },
  clock: Clock = systemClock,
) {
  requireGateway(gw);
  const minutes = parseGrantMinutes(input.minutes);
  const c = getControl(db, input.controlId);
  const grant = db.transaction(() => grantInsert(db, c, minutes, { id: input.apId, role: 'AP' }, null, clock))();
  const synced = await reconcile(db, gw, c.id, clock);
  return { grant, control: getControl(db, c.id), synced };
}

/** End an active grant early (AP) and restore the restriction. */
export async function restoreRestriction(
  db: DB,
  gw: NextDnsGateway | null,
  input: { controlId: string; apId: string; reason?: unknown },
  clock: Clock = systemClock,
) {
  const c = getControl(db, input.controlId);
  const grant = db
    .prepare(`SELECT * FROM web_temporary_grants WHERE controlId = ? AND status = 'ACTIVE'`)
    .get(c.id) as GrantRow | undefined;
  if (!grant || c.state !== 'TEMPORARILY_ALLOWED') throw new WebControlError('no_active_temporary_access', 409);
  const note = typeof input.reason === 'string' && input.reason.trim() ? ` Reason: ${input.reason.trim()}` : '';
  endGrant(db, c, grant, 'REVOKED', { id: input.apId, role: 'AP' }, `AP ended ${c.displayName} temporary access early.${note}`, clock);
  const synced = await reconcile(db, gw, c.id, clock, {
    action: 'RESTRICTION_RESTORED',
    actor: { id: input.apId, role: 'AP' },
    reason: `${c.displayName} restriction restored on NextDNS.`,
  });
  return { control: getControl(db, c.id), synced };
}

function endGrant(
  db: DB,
  c: ControlRow,
  grant: GrantRow,
  status: 'EXPIRED' | 'REVOKED',
  actor: Actor,
  reason: string,
  clock: Clock,
) {
  db.transaction(() => {
    db.prepare(`UPDATE web_temporary_grants SET status = ?, endedAt = ?, endedBy = ? WHERE id = ?`).run(
      status,
      nowIso(clock),
      actor.id ?? 'SYSTEM',
      grant.id,
    );
    db.prepare(`UPDATE web_controls SET state = 'ACTIVE', syncStatus = 'PENDING' WHERE id = ?`).run(c.id);
    audit(db, clock, {
      projectId: c.projectId,
      actor,
      action: status === 'EXPIRED' ? 'TEMP_ACCESS_EXPIRED' : 'TEMP_ACCESS_REVOKED',
      entityType: 'web_control',
      entityId: c.id,
      target: c.target,
      previousState: 'BLOCK:TEMPORARILY_ALLOWED',
      newState: 'BLOCK:ACTIVE',
      reason,
    });
  })();
}

// ---- access requests --------------------------------------------------------

export function submitAccessRequest(
  db: DB,
  input: { projectId: string; participantId: string; controlId: unknown; minutes: unknown; reason: unknown },
  clock: Clock = systemClock,
): RequestRow {
  const c = getControl(db, String(input.controlId ?? ''));
  if (c.projectId !== input.projectId) throw new WebControlError('control_not_found', 404);
  if (c.kind !== 'BLOCK' || c.state !== 'ACTIVE') throw new WebControlError('control_not_currently_restricted', 409);
  const minutes = parseGrantMinutes(input.minutes);
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
  if (!reason) throw new ValidationError('reason_required');
  const pending = db
    .prepare(`SELECT id FROM web_access_requests WHERE controlId = ? AND status = 'PENDING'`)
    .get(c.id);
  if (pending) throw new WebControlError('request_already_pending', 409);
  const row: RequestRow = {
    id: newId('wreq'),
    projectId: c.projectId,
    controlId: c.id,
    requestedBy: input.participantId,
    requestedAt: nowIso(clock),
    requestedMinutes: minutes,
    reason,
    status: 'PENDING',
  };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO web_access_requests (id, projectId, controlId, requestedBy, requestedAt, requestedMinutes, reason, status)
       VALUES (@id, @projectId, @controlId, @requestedBy, @requestedAt, @requestedMinutes, @reason, @status)`,
    ).run(row);
    audit(db, clock, {
      projectId: c.projectId,
      actor: { id: input.participantId, role: 'PARTICIPANT' },
      action: 'ACCESS_REQUEST_SUBMITTED',
      entityType: 'web_access_request',
      entityId: row.id,
      target: c.target,
      newState: 'PENDING',
      reason: `Participant requested ${c.displayName} access for ${mins(minutes)}. Reason: ${reason}`,
    });
  })();
  return row;
}

function getPendingRequest(db: DB, id: string): RequestRow {
  const r = db.prepare(`SELECT * FROM web_access_requests WHERE id = ?`).get(id) as RequestRow | undefined;
  if (!r) throw new WebControlError('request_not_found', 404);
  if (r.status !== 'PENDING') throw new WebControlError(`request_not_pending:${r.status}`, 409);
  return r;
}

export function withdrawAccessRequest(
  db: DB,
  input: { requestId: string; participantId: string },
  clock: Clock = systemClock,
): void {
  const r = getPendingRequest(db, input.requestId);
  if (r.requestedBy !== input.participantId) throw new WebControlError('request_not_found', 404);
  db.transaction(() => {
    db.prepare(`UPDATE web_access_requests SET status = 'WITHDRAWN', decidedAt = ? WHERE id = ?`).run(nowIso(clock), r.id);
    audit(db, clock, {
      projectId: r.projectId,
      actor: { id: input.participantId, role: 'PARTICIPANT' },
      action: 'ACCESS_REQUEST_WITHDRAWN',
      entityType: 'web_access_request',
      entityId: r.id,
      target: getControl(db, r.controlId).target,
      previousState: 'PENDING',
      newState: 'WITHDRAWN',
      reason: 'Participant withdrew the access request.',
    });
  })();
}

/** APPROVE or APPROVE WITH DIFFERENT DURATION (pass `minutes`). */
export async function approveAccessRequest(
  db: DB,
  gw: NextDnsGateway | null,
  input: { requestId: string; apId: string; minutes?: unknown; note?: unknown },
  clock: Clock = systemClock,
) {
  requireGateway(gw);
  const r = getPendingRequest(db, input.requestId);
  const minutes = input.minutes === undefined || input.minutes === null || input.minutes === ''
    ? r.requestedMinutes
    : parseGrantMinutes(input.minutes);
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) : null;
  const c = getControl(db, r.controlId);
  const grant = db.transaction(() => {
    const g = grantInsert(db, c, minutes, { id: input.apId, role: 'AP' }, r.id, clock);
    db.prepare(
      `UPDATE web_access_requests SET status = 'APPROVED', decidedBy = ?, decidedAt = ?, approvedMinutes = ?, decisionNote = ?, grantId = ?
        WHERE id = ?`,
    ).run(input.apId, nowIso(clock), minutes, note, g.id, r.id);
    audit(db, clock, {
      projectId: r.projectId,
      actor: { id: input.apId, role: 'AP' },
      action: 'ACCESS_REQUEST_APPROVED',
      entityType: 'web_access_request',
      entityId: r.id,
      target: c.target,
      previousState: 'PENDING',
      newState: 'APPROVED',
      reason:
        minutes === r.requestedMinutes
          ? `AP approved ${c.displayName} access for ${mins(minutes)}.`
          : `AP approved ${c.displayName} access for ${mins(minutes)} (requested ${mins(r.requestedMinutes)}).`,
    });
    return g;
  })();
  const synced = await reconcile(db, gw, c.id, clock);
  return { grant, control: getControl(db, c.id), synced };
}

export function denyAccessRequest(
  db: DB,
  input: { requestId: string; apId: string; note?: unknown },
  clock: Clock = systemClock,
): void {
  const r = getPendingRequest(db, input.requestId);
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 500) : null;
  const c = getControl(db, r.controlId);
  db.transaction(() => {
    db.prepare(
      `UPDATE web_access_requests SET status = 'DENIED', decidedBy = ?, decidedAt = ?, decisionNote = ? WHERE id = ?`,
    ).run(input.apId, nowIso(clock), note, r.id);
    audit(db, clock, {
      projectId: r.projectId,
      actor: { id: input.apId, role: 'AP' },
      action: 'ACCESS_REQUEST_DENIED',
      entityType: 'web_access_request',
      entityId: r.id,
      target: c.target,
      previousState: 'PENDING',
      newState: 'DENIED',
      reason: `AP denied ${c.displayName} access request.${note ? ` Note: ${note}` : ''}`,
    });
  })();
}

// ---- sweep ------------------------------------------------------------------

let sweepRunning = false;

/**
 * Scheduled job (every minute; Cloudflare Cron Trigger on the Worker target):
 *  1. Expire due temporary grants and restore the restriction automatically.
 *  2. Retry every control whose NextDNS state does not yet match policy.
 */
export async function runWebControlSweep(db: DB, gw: NextDnsGateway | null, clock: Clock = systemClock) {
  if (sweepRunning) return { skipped: true, expired: 0, attempted: 0, synced: 0 };
  sweepRunning = true;
  try {
    const due = db
      .prepare(`SELECT * FROM web_temporary_grants WHERE status = 'ACTIVE' AND expiresAt <= ? ORDER BY expiresAt`)
      .all(nowIso(clock)) as GrantRow[];
    for (const g of due) {
      const c = getControl(db, g.controlId);
      endGrant(db, c, g, 'EXPIRED', SYSTEM, `Temporary ${c.displayName} access expired automatically.`, clock);
      await reconcile(db, gw, c.id, clock, {
        action: 'RESTRICTION_RESTORED',
        actor: SYSTEM,
        reason: `Temporary access expired. ${c.displayName} restriction restored.`,
      });
    }
    const r = await reconcileOutstanding(db, gw, null, clock);
    return { skipped: false, expired: due.length, ...r };
  } finally {
    sweepRunning = false;
  }
}

// ---- reads ------------------------------------------------------------------

export function resolveProjectId(db: DB, given: unknown): string {
  if (typeof given === 'string' && given) {
    if (!db.prepare(`SELECT id FROM projects WHERE id = ?`).get(given)) throw new WebControlError('project_not_found', 404);
    return given;
  }
  const rows = db.prepare(`SELECT id FROM projects WHERE status = 'ACTIVE'`).all() as { id: string }[];
  if (rows.length !== 1) throw new WebControlError('project_id_required', 400);
  return rows[0]!.id;
}

function decorate(c: ControlRow) {
  return { ...c, profiles: JSON.parse(c.profiles) as ProfileLabel[] };
}

export function getWebControls(db: DB, projectId: string, clock: Clock = systemClock) {
  ensureProfiles(db, projectId, clock);
  const project = db.prepare(`SELECT timeZone FROM projects WHERE id = ?`).get(projectId) as { timeZone: string };
  const controls = (
    db
      .prepare(`SELECT * FROM web_controls WHERE projectId = ? AND state != 'REMOVED' ORDER BY kind, displayName`)
      .all(projectId) as ControlRow[]
  ).map(decorate);
  const grants = db
    .prepare(`SELECT * FROM web_temporary_grants WHERE projectId = ? AND status = 'ACTIVE'`)
    .all(projectId) as GrantRow[];
  const byControl = new Map(grants.map((g) => [g.controlId, g]));
  return {
    serverTime: nowIso(clock),
    timeZone: project.timeZone,
    controls: controls.map((c) => ({ ...c, activeGrant: byControl.get(c.id) ?? null })),
    pendingRequests: db
      .prepare(
        `SELECT r.*, c.displayName, c.target FROM web_access_requests r JOIN web_controls c ON c.id = r.controlId
          WHERE r.projectId = ? AND r.status = 'PENDING' ORDER BY r.requestedAt`,
      )
      .all(projectId),
  };
}

/** What the participant may see: the restriction list and their own requests. */
export function getParticipantWebControls(db: DB, projectId: string, participantId: string, clock: Clock = systemClock) {
  const all = getWebControls(db, projectId, clock);
  return {
    serverTime: all.serverTime,
    timeZone: all.timeZone,
    restrictions: all.controls
      .filter((c) => c.kind === 'BLOCK')
      .map((c) => ({
        id: c.id,
        displayName: c.displayName,
        target: c.target,
        state: c.state,
        expiresAt: c.activeGrant?.expiresAt ?? null,
      })),
    requests: db
      .prepare(
        `SELECT r.id, r.controlId, c.displayName, r.requestedAt, r.requestedMinutes, r.reason, r.status,
                r.decidedAt, r.approvedMinutes, r.decisionNote
           FROM web_access_requests r JOIN web_controls c ON c.id = r.controlId
          WHERE r.projectId = ? AND r.requestedBy = ? ORDER BY r.requestedAt DESC LIMIT 50`,
      )
      .all(projectId, participantId),
  };
}

export function webControlHistory(db: DB, projectId: string, limit = 200) {
  return db
    .prepare(
      `SELECT id, serverTimestamp, actorId, actorRole, action, entityType, entityId, previousState, newState, reason,
              json_extract(securityContext, '$.mode') AS mode, json_extract(securityContext, '$.target') AS target
         FROM audit_events
        WHERE projectId = ? AND entityType IN ('web_control','web_access_request','nextdns_profile')
        ORDER BY serverTimestamp DESC, rowid DESC LIMIT ?`,
    )
    .all(projectId, Math.min(Math.max(limit, 1), 1000));
}

export interface ProfileStatus {
  label: ProfileLabel;
  attribution: string;
  description: string;
  nextdnsProfileId: string | null;
  status: ProfileReportingStatus;
  lastQueryAt: string | null;
  filtering: FilteringSettings | null;
  detail: string;
}

/** getNextDnsStatus(): integration + per-profile reporting state. */
export async function getNextDnsStatus(db: DB, gw: NextDnsGateway | null, projectId: string, clock: Clock = systemClock) {
  ensureProfiles(db, projectId, clock);
  const profiles: ProfileStatus[] = [];
  for (const p of listProfiles(db, projectId)) {
    const base = {
      label: p.label,
      attribution: p.attribution,
      description: p.description,
      nextdnsProfileId: p.nextdnsProfileId,
      lastQueryAt: null,
      filtering: null,
    };
    if (!gw || !p.nextdnsProfileId) {
      profiles.push({ ...base, status: 'NOT_CONFIGURED', detail: !gw ? 'NextDNS integration not configured.' : 'Profile not bound.' });
      continue;
    }
    try {
      const info = await gw.getProfile(p.nextdnsProfileId);
      const lastQueryAt = await gw.getLastQueryAt(p.nextdnsProfileId);
      const recent =
        !!lastQueryAt &&
        clock.now().diff(DateTime.fromISO(lastQueryAt, { zone: 'utc' }), 'minutes').minutes <= REPORTING_WINDOW_MINUTES;
      profiles.push({
        ...base,
        lastQueryAt,
        filtering: info.filtering,
        status: recent ? 'REPORTING' : 'NO_RECENT_ACTIVITY',
        detail: recent
          ? `DNS activity within the last ${REPORTING_WINDOW_MINUTES} minutes.`
          : `No DNS activity in the last ${REPORTING_WINDOW_MINUTES} minutes. This alone does not indicate a bypass (device asleep, offline, or idle).`,
      });
    } catch (e) {
      profiles.push({ ...base, status: 'UNVERIFIED', detail: e instanceof NextDnsError ? e.message : 'NextDNS unreachable.' });
    }
  }
  const integration = !gw ? 'NOT_CONFIGURED' : gw.mode;
  const overall: IntegrityStatus = !gw
    ? 'NOT_CONFIGURED'
    : profiles.every((p) => p.status === 'REPORTING')
      ? 'ACTIVE'
      : 'DEGRADED';
  return { checkedAt: nowIso(clock), integration, overall, profiles };
}

/**
 * getIntegrityStatus(): the accountability-system view. Phase 1 components are
 * NextDNS, each profile, and policy sync. Phone heartbeat and Recording
 * Assistant are reported as NOT_IMPLEMENTED until Phase 5 rather than being
 * shown as healthy.
 */
export async function getIntegrityStatus(db: DB, gw: NextDnsGateway | null, projectId: string, clock: Clock = systemClock) {
  const status = await getNextDnsStatus(db, gw, projectId, clock);
  const unsynced = db
    .prepare(
      `SELECT id, displayName, target, state, syncStatus, lastSyncError, lastSyncAt FROM web_controls
        WHERE projectId = ? AND syncStatus != 'IN_SYNC'`,
    )
    .all(projectId) as { syncStatus: string }[];
  const failed = unsynced.filter((u) => u.syncStatus === 'SYNC_FAILED');
  const reachable = status.profiles.some((p) => p.status === 'REPORTING' || p.status === 'NO_RECENT_ACTIVITY');
  const nextDnsComponent =
    status.integration !== 'LIVE' ? status.integration : reachable ? 'ACTIVE' : 'UNVERIFIED';
  const components = [
    { component: 'NextDNS', status: nextDnsComponent },
    ...status.profiles.map((p) => ({ component: `${p.label} profile`, status: p.status })),
    { component: 'Policy sync', status: failed.length ? 'SYNC_FAILED' : unsynced.length ? 'PENDING' : 'IN_SYNC' },
    { component: 'Phone heartbeat', status: 'NOT_IMPLEMENTED' },
    { component: 'Recording Assistant', status: 'NOT_IMPLEMENTED' },
  ];
  const overall: IntegrityStatus =
    status.overall === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : status.overall === 'ACTIVE' && !failed.length ? 'ACTIVE' : 'DEGRADED';
  return {
    checkedAt: status.checkedAt,
    overall,
    summary:
      status.integration === 'SIMULATED'
        ? 'INTEGRITY: SIMULATED NEXTDNS — NOT REAL ENFORCEMENT'
        : overall === 'ACTIVE'
        ? 'INTEGRITY: ALL IMPLEMENTED SYSTEMS REPORTING'
        : overall === 'NOT_CONFIGURED'
          ? 'INTEGRITY: NEXTDNS NOT CONFIGURED'
          : 'INTEGRITY: DEGRADED — AP REVIEW',
    components,
    unsyncedControls: unsynced,
  };
}
