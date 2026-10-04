/**
 * Monitoring integrity (NextDNS direction §6, §7, §15; Phase 5).
 *
 * The accountability infrastructure is itself monitored. Two kinds of signal:
 *
 *  - CONFIRMED: the phone's own heartbeat reports Private DNS off or pointed
 *    somewhere other than the RAY-PIXEL profile. That is an INTERRUPTED
 *    incident and always requires AP review.
 *  - CIRCUMSTANTIAL: heartbeat silence, DNS silence, NextDNS unreachable, or a
 *    heartbeat that claims compliance while NextDNS sees no Pixel traffic.
 *    These are DEGRADED incidents. Silence alone is never labelled an
 *    interruption, let alone misconduct.
 *
 * Restoration closes an incident but never erases it: the outage, the
 * restoration, any participant explanation and the AP determination are all
 * preserved (incidents cannot be deleted; every transition is audited).
 * Loss of monitoring does not suspend the underlying accountability rule.
 */
import { DateTime } from 'luxon';
import type { DB } from '../db.js';
import { recordAudit } from '../audit.js';
import { newId } from '../ids.js';
import { nowIso, type Clock, systemClock } from '../time.js';
import type { NextDnsGateway } from '../nextdns/gateway.js';
import { NextDnsError } from '../nextdns/gateway.js';
import { ValidationError, type IntegrityStatus } from '../nextdns/model.js';
import { WebControlError, ensureProfiles, getNextDnsStatus, listProfiles } from './webControls.js';

// ---- tunables ---------------------------------------------------------------

/** The Android app sends a heartbeat at least this often (WorkManager's minimum). */
export const HEARTBEAT_INTERVAL_MINUTES = 15;
/** Two-plus missed heartbeats before the heartbeat is considered lost. */
export const HEARTBEAT_STALE_MINUTES = 45;
/** How often the sweep asks NextDNS for profile activity. */
export const NEXTDNS_CHECK_INTERVAL_MINUTES = 5;
/** Heartbeat says Private DNS is on and network is up, yet no RAY-PIXEL query for this long. */
export const DNS_MISMATCH_MINUTES = 60;
/** A whole household network silent this long is worth recording. */
export const HOME_ROUTER_SILENT_MINUTES = 120;

export type IncidentType =
  | 'PRIVATE_DNS_DISABLED'
  | 'PHONE_HEARTBEAT_LOST'
  | 'DNS_HEARTBEAT_MISMATCH'
  | 'HOME_ROUTER_SILENT'
  | 'NEXTDNS_API_UNREACHABLE';

type ExemptComponent = 'PRIVATE_DNS' | 'PHONE_HEARTBEAT';

const INCIDENT_RULES: Record<
  IncidentType,
  {
    severity: 'INTERRUPTED' | 'DEGRADED';
    title: string;
    /** null = never needs AP review; 0 = always; n = if the outage lasted ≥ n minutes. */
    reviewAfterMinutes: number | null;
    exemptComponent: ExemptComponent | null;
    notifyParticipant: boolean;
  }
> = {
  PRIVATE_DNS_DISABLED: {
    severity: 'INTERRUPTED',
    title: 'DNS ACCOUNTABILITY INTERRUPTED',
    reviewAfterMinutes: 0,
    exemptComponent: 'PRIVATE_DNS',
    notifyParticipant: true,
  },
  DNS_HEARTBEAT_MISMATCH: {
    severity: 'DEGRADED',
    title: 'HEARTBEAT / DNS MISMATCH',
    reviewAfterMinutes: 0,
    exemptComponent: 'PRIVATE_DNS',
    notifyParticipant: true,
  },
  PHONE_HEARTBEAT_LOST: {
    severity: 'DEGRADED',
    title: 'PHONE HEARTBEAT LOST',
    reviewAfterMinutes: 180,
    exemptComponent: 'PHONE_HEARTBEAT',
    notifyParticipant: false,
  },
  HOME_ROUTER_SILENT: {
    severity: 'DEGRADED',
    title: 'HOME NETWORK NOT REPORTING',
    reviewAfterMinutes: null,
    exemptComponent: null,
    notifyParticipant: false,
  },
  NEXTDNS_API_UNREACHABLE: {
    severity: 'DEGRADED',
    title: 'NEXTDNS API UNREACHABLE',
    reviewAfterMinutes: null,
    exemptComponent: null,
    notifyParticipant: false,
  },
};

export const DETERMINATIONS = [
  'TECHNICAL_FAILURE',
  'AUTHORIZED_EXCEPTION',
  'UNAUTHORIZED_INTERRUPTION',
  'INCONCLUSIVE',
] as const;
export type Determination = (typeof DETERMINATIONS)[number];

type Component =
  | 'PHONE_HEARTBEAT'
  | 'PRIVATE_DNS'
  | 'RECORDING_ASSISTANT'
  | 'NEXTDNS_API'
  | 'RAY_PIXEL_DNS'
  | 'HOME_ROUTER_DNS';

interface CheckRow {
  component: Component;
  state: string;
  lastVerifiedAt: string | null;
  lastCheckedAt: string;
  detail: string | null;
}

export interface IncidentRow {
  id: string;
  projectId: string;
  type: IncidentType;
  severity: 'INTERRUPTED' | 'DEGRADED';
  status: 'OPEN' | 'AP_REVIEW_REQUIRED' | 'CLOSED' | 'REVIEWED';
  lastVerifiedAt: string | null;
  detectedAt: string;
  restoredAt: string | null;
  detail: string;
  restoreDetail: string | null;
  exemptionId: string | null;
  participantExplanation: string | null;
  participantExplainedAt: string | null;
  determination: string | null;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

interface ExemptionRow {
  id: string;
  projectId: string;
  component: ExemptComponent | 'ALL';
  startsAt: string;
  endsAt: string;
  reason: string;
  grantedBy: string;
  revokedAt: string | null;
}

// ---- helpers ------------------------------------------------------------------

const iso = (s: string) => DateTime.fromISO(s, { zone: 'utc' });
const minutesBetween = (a: string, b: string) => Math.max(0, Math.round(iso(b).diff(iso(a), 'minutes').minutes));

function audit(
  db: DB,
  clock: Clock,
  a: {
    projectId: string;
    actorId: string | null;
    actorRole: 'AP' | 'PARTICIPANT' | 'SYSTEM';
    action: string;
    entityType: string;
    entityId: string;
    previousState?: string | null;
    newState?: string | null;
    reason: string;
    target: string;
  },
) {
  recordAudit(
    db,
    {
      projectId: a.projectId,
      actorId: a.actorId,
      actorRole: a.actorRole,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      previousState: a.previousState ?? null,
      newState: a.newState ?? null,
      reason: a.reason,
      securityContext: JSON.stringify({ mode: a.actorRole === 'SYSTEM' ? 'AUTOMATIC' : 'MANUAL', target: a.target }),
    },
    clock,
  );
}

function localTime(db: DB, projectId: string, at: string): string {
  const p = db.prepare(`SELECT timeZone FROM projects WHERE id = ?`).get(projectId) as { timeZone: string } | undefined;
  return iso(at).setZone(p?.timeZone ?? 'utc').toFormat('h:mm a ZZZZ');
}

function getCheck(db: DB, projectId: string, component: Component): CheckRow | undefined {
  return db
    .prepare(`SELECT * FROM integrity_checks WHERE projectId = ? AND component = ?`)
    .get(projectId, component) as CheckRow | undefined;
}

function setCheck(
  db: DB,
  projectId: string,
  component: Component,
  state: string,
  verifiedAt: string | null,
  detail: string | null,
  clock: Clock,
) {
  const prev = getCheck(db, projectId, component);
  db.prepare(
    `INSERT INTO integrity_checks (projectId, component, state, lastVerifiedAt, lastCheckedAt, detail)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (projectId, component) DO UPDATE SET
       state = excluded.state, lastVerifiedAt = excluded.lastVerifiedAt,
       lastCheckedAt = excluded.lastCheckedAt, detail = excluded.detail`,
  ).run(projectId, component, state, verifiedAt ?? prev?.lastVerifiedAt ?? null, nowIso(clock), detail);
}

function openIncident(db: DB, projectId: string, type: IncidentType): IncidentRow | undefined {
  return db
    .prepare(`SELECT * FROM integrity_incidents WHERE projectId = ? AND type = ? AND status = 'OPEN'`)
    .get(projectId, type) as IncidentRow | undefined;
}

function activeExemption(db: DB, projectId: string, component: ExemptComponent, at: string): ExemptionRow | undefined {
  return db
    .prepare(
      `SELECT * FROM integrity_exemptions
        WHERE projectId = ? AND component IN (?, 'ALL') AND startsAt <= ? AND endsAt > ? AND revokedAt IS NULL
        ORDER BY endsAt DESC LIMIT 1`,
    )
    .get(projectId, component, at, at) as ExemptionRow | undefined;
}

/** Open an incident of this type unless one is already open. */
function raise(
  db: DB,
  projectId: string,
  type: IncidentType,
  input: { lastVerifiedAt: string | null; detectedAt: string; detail: string },
  clock: Clock,
): IncidentRow | null {
  if (openIncident(db, projectId, type)) return null;
  const rule = INCIDENT_RULES[type];
  const exemption = rule.exemptComponent ? activeExemption(db, projectId, rule.exemptComponent, input.detectedAt) : undefined;
  const id = newId('inc');
  db.transaction(() => {
    db.prepare(
      `INSERT INTO integrity_incidents (id, projectId, type, severity, status, lastVerifiedAt, detectedAt, detail, exemptionId)
       VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
    ).run(id, projectId, type, rule.severity, input.lastVerifiedAt, input.detectedAt, input.detail, exemption?.id ?? null);
    const lv = input.lastVerifiedAt ? localTime(db, projectId, input.lastVerifiedAt) : 'never';
    audit(db, clock, {
      projectId,
      actorId: null,
      actorRole: 'SYSTEM',
      action: 'INTEGRITY_INCIDENT_OPENED',
      entityType: 'integrity_incident',
      entityId: id,
      target: type,
      newState: `${rule.severity}:OPEN`,
      reason: `${rule.title}. Last verified active: ${lv}. Detected: ${localTime(db, projectId, input.detectedAt)}. ${input.detail}${
        exemption ? ` Within AP-authorized window (${exemption.reason}).` : ''
      }`,
    });
    if (rule.notifyParticipant && !exemption) {
      db.prepare(
        `INSERT INTO notices (id, projectId, type, title, body, issuedByRole, issuedAt, responseRequired, publicStatus)
         VALUES (?, ?, 'INTEGRITY', ?, ?, 'SYSTEM', ?, 0, 'PRIVATE')`,
      ).run(
        newId('not'),
        projectId,
        rule.title,
        `${input.detail} This has been recorded and referred to your Accountability Partner. ` +
          `Loss of monitoring does not suspend the underlying accountability requirement. ` +
          `If this was necessary for safety, emergency access, or device recovery, submit an explanation.`,
        nowIso(clock),
      );
    }
  })();
  return db.prepare(`SELECT * FROM integrity_incidents WHERE id = ?`).get(id) as IncidentRow;
}

/** Close the open incident of this type, if any. The record is kept. */
function restore(db: DB, projectId: string, type: IncidentType, restoredAt: string, detail: string, clock: Clock): IncidentRow | null {
  const inc = openIncident(db, projectId, type);
  if (!inc) return null;
  const rule = INCIDENT_RULES[type];
  const minutes = minutesBetween(inc.detectedAt, restoredAt);
  const exemption = inc.exemptionId
    ? (db.prepare(`SELECT * FROM integrity_exemptions WHERE id = ?`).get(inc.exemptionId) as ExemptionRow | undefined)
    : undefined;
  const exemptionEnd = exemption ? (exemption.revokedAt && exemption.revokedAt < exemption.endsAt ? exemption.revokedAt : exemption.endsAt) : null;
  const covered = !!exemptionEnd && restoredAt <= exemptionEnd;
  const needsReview =
    !covered && rule.reviewAfterMinutes !== null && minutes >= rule.reviewAfterMinutes;
  const status = needsReview ? 'AP_REVIEW_REQUIRED' : 'CLOSED';
  const restoreDetail = covered ? `${detail} Restored within the AP-authorized window.` : detail;
  db.transaction(() => {
    db.prepare(`UPDATE integrity_incidents SET status = ?, restoredAt = ?, restoreDetail = ? WHERE id = ?`).run(
      status,
      restoredAt,
      restoreDetail,
      inc.id,
    );
    audit(db, clock, {
      projectId,
      actorId: null,
      actorRole: 'SYSTEM',
      action: 'INTEGRITY_INCIDENT_RESTORED',
      entityType: 'integrity_incident',
      entityId: inc.id,
      target: type,
      previousState: `${inc.severity}:OPEN`,
      newState: `${inc.severity}:${status}`,
      reason: `${rule.title} — restored ${localTime(db, projectId, restoredAt)}. Interruption: ${minutes} minute${
        minutes === 1 ? '' : 's'
      }. ${restoreDetail}${needsReview ? ' Status: AP REVIEW REQUIRED.' : ''}`,
    });
  })();
  return db.prepare(`SELECT * FROM integrity_incidents WHERE id = ?`).get(inc.id) as IncidentRow;
}

// ---- heartbeat ------------------------------------------------------------------

const MODES = ['off', 'opportunistic', 'hostname', 'unknown'] as const;
const NETWORKS = ['WIFI', 'CELLULAR', 'OTHER', 'NONE'] as const;
export type PrivateDnsState = 'CONFIRMED' | 'DISABLED' | 'MISCONFIGURED' | 'UNKNOWN';

/**
 * Android Private DNS hostnames for a NextDNS profile look like
 * `abc123.dns.nextdns.io` or `Device--Name-abc123.dns.nextdns.io`.
 */
export function privateDnsMatchesProfile(host: string | null | undefined, profileId: string): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  const suffix = `${profileId.toLowerCase()}.dns.nextdns.io`;
  return h === suffix || h.endsWith(`-${suffix}`);
}

export function evaluatePrivateDns(
  mode: (typeof MODES)[number],
  host: string | null,
  expectedProfileId: string | null,
): PrivateDnsState {
  if (mode === 'unknown' || !expectedProfileId) return 'UNKNOWN';
  if (mode !== 'hostname') return 'DISABLED';
  return privateDnsMatchesProfile(host, expectedProfileId) ? 'CONFIRMED' : 'MISCONFIGURED';
}

export function recordHeartbeat(
  db: DB,
  input: { projectId: string; participantId: string; body: Record<string, unknown> },
  clock: Clock = systemClock,
) {
  const b = input.body ?? {};
  const deviceId = typeof b.deviceId === 'string' ? b.deviceId.trim().slice(0, 100) : '';
  if (!deviceId) throw new ValidationError('deviceId_required');
  const mode = b.privateDnsMode as (typeof MODES)[number];
  if (!MODES.includes(mode)) throw new ValidationError('invalid_privateDnsMode');
  const network = b.network as (typeof NETWORKS)[number];
  if (!NETWORKS.includes(network)) throw new ValidationError('invalid_network');
  const host = typeof b.privateDnsHost === 'string' ? b.privateDnsHost.trim().slice(0, 253) : null;
  const recordingReady = typeof b.recordingReady === 'boolean' ? b.recordingReady : null;
  const appVersion = typeof b.appVersion === 'string' ? b.appVersion.slice(0, 40) : null;
  const clientTime = typeof b.clientTime === 'string' ? b.clientTime.slice(0, 40) : null;

  ensureProfiles(db, input.projectId, clock);
  const pixel = listProfiles(db, input.projectId).find((p) => p.label === 'RAY-PIXEL');
  const state = evaluatePrivateDns(mode, host, pixel?.nextdnsProfileId ?? null);
  const receivedAt = nowIso(clock);

  const knownDevice = db
    .prepare(`SELECT 1 FROM device_heartbeats WHERE projectId = ? AND deviceId = ? LIMIT 1`)
    .get(input.projectId, deviceId);
  const id = newId('hb');
  db.transaction(() => {
    db.prepare(
      `INSERT INTO device_heartbeats (id, projectId, participantId, deviceId, serverReceivedAt, clientTime,
         privateDnsMode, privateDnsHost, privateDnsState, network, recordingReady, appVersion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.projectId,
      input.participantId,
      deviceId,
      receivedAt,
      clientTime,
      mode,
      host,
      state,
      network,
      recordingReady === null ? null : recordingReady ? 1 : 0,
      appVersion,
    );
    if (!knownDevice) {
      audit(db, clock, {
        projectId: input.projectId,
        actorId: input.participantId,
        actorRole: 'PARTICIPANT',
        action: 'PHONE_DEVICE_REGISTERED',
        entityType: 'device_heartbeat',
        entityId: id,
        target: deviceId,
        newState: state,
        reason: `First heartbeat from device ${deviceId}${appVersion ? ` (app ${appVersion})` : ''}.`,
      });
    }
  })();

  // Phone heartbeat is alive.
  setCheck(db, input.projectId, 'PHONE_HEARTBEAT', 'ONLINE', receivedAt, `Last heartbeat via ${network}.`, clock);
  restore(db, input.projectId, 'PHONE_HEARTBEAT_LOST', receivedAt, 'Phone heartbeat resumed.', clock);

  // Private DNS (confirmed signal, evaluated immediately).
  const lastVerified = getCheck(db, input.projectId, 'PRIVATE_DNS')?.lastVerifiedAt ?? null;
  if (state === 'CONFIRMED') {
    setCheck(db, input.projectId, 'PRIVATE_DNS', 'CONFIRMED', receivedAt, host, clock);
    restore(db, input.projectId, 'PRIVATE_DNS_DISABLED', receivedAt, `Phone reports Private DNS ${host}.`, clock);
  } else if (state === 'DISABLED' || state === 'MISCONFIGURED') {
    const detail =
      state === 'DISABLED'
        ? `Phone reports Private DNS mode "${mode}" (not the RAY-PIXEL NextDNS hostname).`
        : `Phone reports Private DNS hostname "${host}", which is not the RAY-PIXEL profile.`;
    setCheck(db, input.projectId, 'PRIVATE_DNS', state, null, detail, clock);
    raise(db, input.projectId, 'PRIVATE_DNS_DISABLED', { lastVerifiedAt: lastVerified, detectedAt: receivedAt, detail }, clock);
    // A mismatch can't be meaningful while DNS is confirmed off.
    restore(db, input.projectId, 'DNS_HEARTBEAT_MISMATCH', receivedAt, 'Superseded by confirmed Private DNS state.', clock);
  } else {
    setCheck(
      db,
      input.projectId,
      'PRIVATE_DNS',
      'UNKNOWN',
      null,
      network === 'NONE' ? 'Phone offline; Private DNS state not observable.' : 'Private DNS state not observable.',
      clock,
    );
  }

  if (recordingReady !== null) {
    setCheck(db, input.projectId, 'RECORDING_ASSISTANT', recordingReady ? 'READY' : 'NOT_READY', recordingReady ? receivedAt : null, null, clock);
  }

  return { heartbeatId: id, serverReceivedAt: receivedAt, privateDns: state, nextHeartbeatWithinMinutes: HEARTBEAT_INTERVAL_MINUTES };
}

// ---- sweep ----------------------------------------------------------------------

let sweepRunning = false;

/** Scheduled (every minute): heartbeat staleness + throttled NextDNS health checks. */
export async function runIntegritySweep(
  db: DB,
  gw: NextDnsGateway | null,
  clock: Clock = systemClock,
  opts: { forceNextDnsCheck?: boolean } = {},
) {
  if (sweepRunning) return { skipped: true };
  sweepRunning = true;
  try {
    const projects = db.prepare(`SELECT id FROM projects WHERE status = 'ACTIVE'`).all() as { id: string }[];
    for (const { id: projectId } of projects) await sweepProject(db, gw, projectId, clock, !!opts.forceNextDnsCheck);
    return { skipped: false, projects: projects.length };
  } finally {
    sweepRunning = false;
  }
}

async function sweepProject(db: DB, gw: NextDnsGateway | null, projectId: string, clock: Clock, force: boolean) {
  const now = clock.now();
  const nowS = nowIso(clock);

  // 1. Heartbeat staleness. Never-seen phones produce no incident (nothing was lost).
  const hb = getCheck(db, projectId, 'PHONE_HEARTBEAT');
  if (hb?.lastVerifiedAt && now.diff(iso(hb.lastVerifiedAt), 'minutes').minutes > HEARTBEAT_STALE_MINUTES) {
    setCheck(db, projectId, 'PHONE_HEARTBEAT', 'STALE', null, `No heartbeat for over ${HEARTBEAT_STALE_MINUTES} minutes.`, clock);
    raise(
      db,
      projectId,
      'PHONE_HEARTBEAT_LOST',
      {
        lastVerifiedAt: hb.lastVerifiedAt,
        detectedAt: nowS,
        detail: `No phone heartbeat for over ${HEARTBEAT_STALE_MINUTES} minutes. Possible causes include the phone being off, asleep (Doze), offline, or the app being stopped.`,
      },
      clock,
    );
  }

  // 2. NextDNS health (throttled).
  if (!gw) return;
  const api = getCheck(db, projectId, 'NEXTDNS_API');
  if (!force && api && now.diff(iso(api.lastCheckedAt), 'minutes').minutes < NEXTDNS_CHECK_INTERVAL_MINUTES) return;

  const profiles = listProfiles(db, projectId).filter((p) => p.nextdnsProfileId);
  const lastQuery = new Map<string, string | null>();
  let apiError: string | null = null;
  for (const p of profiles) {
    try {
      lastQuery.set(p.label, await gw.getLastQueryAt(p.nextdnsProfileId!));
    } catch (e) {
      apiError = e instanceof NextDnsError ? e.message : 'NextDNS unreachable';
    }
  }
  if (apiError) {
    setCheck(db, projectId, 'NEXTDNS_API', 'UNREACHABLE', null, apiError, clock);
    raise(db, projectId, 'NEXTDNS_API_UNREACHABLE', { lastVerifiedAt: api?.lastVerifiedAt ?? null, detectedAt: nowS, detail: apiError }, clock);
    return; // can't evaluate profile activity without the API
  }
  if (!profiles.length) return;
  setCheck(db, projectId, 'NEXTDNS_API', 'ACTIVE', nowS, null, clock);
  restore(db, projectId, 'NEXTDNS_API_UNREACHABLE', nowS, 'NextDNS API reachable again.', clock);

  const silentFor = (q: string | null | undefined) => (q ? now.diff(iso(q), 'minutes').minutes : Infinity);

  // HOME-ROUTER: shared network, recorded but never attributed to the participant.
  if (lastQuery.has('HOME-ROUTER')) {
    const q = lastQuery.get('HOME-ROUTER') ?? null;
    const silent = silentFor(q) > HOME_ROUTER_SILENT_MINUTES;
    setCheck(db, projectId, 'HOME_ROUTER_DNS', silent ? 'SILENT' : 'REPORTING', q, null, clock);
    if (silent) {
      raise(db, projectId, 'HOME_ROUTER_SILENT', {
        lastVerifiedAt: q,
        detectedAt: nowS,
        detail: `No DNS activity from the home network for over ${HOME_ROUTER_SILENT_MINUTES} minutes (router DNS changed, internet outage, or power loss). Not attributable to the participant.`,
      }, clock);
    } else {
      restore(db, projectId, 'HOME_ROUTER_SILENT', nowS, 'Home network DNS activity resumed.', clock);
    }
  }

  // RAY-PIXEL: cross-check the phone's self-report against what NextDNS actually sees.
  if (lastQuery.has('RAY-PIXEL')) {
    const q = lastQuery.get('RAY-PIXEL') ?? null;
    setCheck(db, projectId, 'RAY_PIXEL_DNS', silentFor(q) > DNS_MISMATCH_MINUTES ? 'SILENT' : 'REPORTING', q, null, clock);
    const latest = db
      .prepare(`SELECT * FROM device_heartbeats WHERE projectId = ? ORDER BY serverReceivedAt DESC LIMIT 1`)
      .get(projectId) as { serverReceivedAt: string; privateDnsState: string; network: string } | undefined;
    const heartbeatFresh = !!latest && now.diff(iso(latest.serverReceivedAt), 'minutes').minutes <= HEARTBEAT_STALE_MINUTES;
    const claimsCompliantOnline = heartbeatFresh && latest!.privateDnsState === 'CONFIRMED' && latest!.network !== 'NONE';
    const dnsSilentBeforeHeartbeat =
      !q || iso(latest?.serverReceivedAt ?? nowS).diff(iso(q), 'minutes').minutes > DNS_MISMATCH_MINUTES;
    if (claimsCompliantOnline && dnsSilentBeforeHeartbeat) {
      raise(db, projectId, 'DNS_HEARTBEAT_MISMATCH', {
        lastVerifiedAt: q,
        detectedAt: nowS,
        detail: `Phone reports Private DNS active and network ${latest!.network}, but NextDNS has logged no RAY-PIXEL query for over ${DNS_MISMATCH_MINUTES} minutes. Possible causes: NextDNS logging disabled, a different resolver in use, or an inaccurate heartbeat.`,
      }, clock);
    } else if (!dnsSilentBeforeHeartbeat || silentFor(q) <= DNS_MISMATCH_MINUTES) {
      restore(db, projectId, 'DNS_HEARTBEAT_MISMATCH', nowS, 'RAY-PIXEL DNS activity matches the phone heartbeat again.', clock);
    }
  }
}

// ---- participant explanation + AP review ------------------------------------------

function getIncident(db: DB, id: string): IncidentRow {
  const inc = db.prepare(`SELECT * FROM integrity_incidents WHERE id = ?`).get(id) as IncidentRow | undefined;
  if (!inc) throw new WebControlError('incident_not_found', 404);
  return inc;
}

/** One explanation per incident; it cannot be edited afterwards. */
export function explainIncident(
  db: DB,
  input: { incidentId: string; projectId: string; participantId: string; explanation: unknown },
  clock: Clock = systemClock,
): IncidentRow {
  const inc = getIncident(db, input.incidentId);
  if (inc.projectId !== input.projectId) throw new WebControlError('incident_not_found', 404);
  if (inc.participantExplanation) throw new WebControlError('explanation_already_submitted', 409);
  if (inc.status === 'REVIEWED') throw new WebControlError('incident_already_reviewed', 409);
  const text = typeof input.explanation === 'string' ? input.explanation.trim().slice(0, 2000) : '';
  if (!text) throw new ValidationError('explanation_required');
  db.transaction(() => {
    db.prepare(`UPDATE integrity_incidents SET participantExplanation = ?, participantExplainedAt = ? WHERE id = ?`).run(
      text,
      nowIso(clock),
      inc.id,
    );
    audit(db, clock, {
      projectId: inc.projectId,
      actorId: input.participantId,
      actorRole: 'PARTICIPANT',
      action: 'INTEGRITY_EXPLANATION_SUBMITTED',
      entityType: 'integrity_incident',
      entityId: inc.id,
      target: inc.type,
      reason: `Participant explanation: ${text}`,
    });
  })();
  return getIncident(db, inc.id);
}

/**
 * AP determination. Only restored incidents can be reviewed (an open one is
 * still happening). UNAUTHORIZED_INTERRUPTION does not auto-assess anything:
 * the AP uses the Violations workflow if a consequence is warranted.
 */
export function reviewIncident(
  db: DB,
  input: { incidentId: string; apId: string; determination: unknown; note: unknown },
  clock: Clock = systemClock,
): IncidentRow {
  const inc = getIncident(db, input.incidentId);
  if (inc.status === 'OPEN') throw new WebControlError('incident_still_open', 409);
  if (inc.status === 'REVIEWED') throw new WebControlError('incident_already_reviewed', 409);
  const determination = input.determination as Determination;
  if (!DETERMINATIONS.includes(determination)) throw new ValidationError('invalid_determination');
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 2000) : '';
  if (!note) throw new ValidationError('review_note_required');
  db.transaction(() => {
    db.prepare(
      `UPDATE integrity_incidents SET status = 'REVIEWED', determination = ?, reviewNote = ?, reviewedBy = ?, reviewedAt = ? WHERE id = ?`,
    ).run(determination, note, input.apId, nowIso(clock), inc.id);
    audit(db, clock, {
      projectId: inc.projectId,
      actorId: input.apId,
      actorRole: 'AP',
      action: 'INTEGRITY_INCIDENT_REVIEWED',
      entityType: 'integrity_incident',
      entityId: inc.id,
      target: inc.type,
      previousState: inc.status,
      newState: `REVIEWED:${determination}`,
      reason: `AP determination ${determination.replace(/_/g, ' ')}: ${note}`,
    });
  })();
  return getIncident(db, inc.id);
}

// ---- AP-authorized windows ----------------------------------------------------------

export function grantExemption(
  db: DB,
  input: { projectId: string; apId: string; component: unknown; minutes: unknown; reason: unknown },
  clock: Clock = systemClock,
): ExemptionRow {
  const component = input.component as ExemptionRow['component'];
  if (!['PRIVATE_DNS', 'PHONE_HEARTBEAT', 'ALL'].includes(component)) throw new ValidationError('invalid_component');
  const minutes = Number(input.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new ValidationError('minutes_must_be_1_to_1440');
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
  if (!reason) throw new ValidationError('reason_required');
  const row: ExemptionRow = {
    id: newId('exm'),
    projectId: input.projectId,
    component,
    startsAt: nowIso(clock),
    endsAt: clock.now().plus({ minutes }).toISO()!,
    reason,
    grantedBy: input.apId,
    revokedAt: null,
  };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO integrity_exemptions (id, projectId, component, startsAt, endsAt, reason, grantedBy)
       VALUES (@id, @projectId, @component, @startsAt, @endsAt, @reason, @grantedBy)`,
    ).run(row);
    audit(db, clock, {
      projectId: input.projectId,
      actorId: input.apId,
      actorRole: 'AP',
      action: 'INTEGRITY_EXEMPTION_GRANTED',
      entityType: 'integrity_exemption',
      entityId: row.id,
      target: component,
      newState: 'ACTIVE',
      reason: `AP authorized ${component.replace(/_/g, ' ')} to be interrupted for ${minutes} minute${minutes === 1 ? '' : 's'} (until ${localTime(db, input.projectId, row.endsAt)}). Reason: ${reason}`,
    });
  })();
  return row;
}

export function revokeExemption(db: DB, input: { exemptionId: string; apId: string }, clock: Clock = systemClock) {
  const ex = db.prepare(`SELECT * FROM integrity_exemptions WHERE id = ?`).get(input.exemptionId) as ExemptionRow | undefined;
  if (!ex) throw new WebControlError('exemption_not_found', 404);
  if (ex.revokedAt || ex.endsAt <= nowIso(clock)) throw new WebControlError('exemption_not_active', 409);
  db.transaction(() => {
    db.prepare(`UPDATE integrity_exemptions SET revokedAt = ?, revokedBy = ? WHERE id = ?`).run(nowIso(clock), input.apId, ex.id);
    audit(db, clock, {
      projectId: ex.projectId,
      actorId: input.apId,
      actorRole: 'AP',
      action: 'INTEGRITY_EXEMPTION_REVOKED',
      entityType: 'integrity_exemption',
      entityId: ex.id,
      target: ex.component,
      previousState: 'ACTIVE',
      newState: 'REVOKED',
      reason: `AP ended the ${ex.component.replace(/_/g, ' ')} authorized window early.`,
    });
  })();
}

// ---- reads ----------------------------------------------------------------------

function decorateIncident(db: DB, inc: IncidentRow, clock: Clock) {
  const rule = INCIDENT_RULES[inc.type];
  const end = inc.restoredAt ?? nowIso(clock);
  return {
    ...inc,
    title: rule.title,
    interruptionMinutes: minutesBetween(inc.detectedAt, end),
    /** Upper bound: from the last positive verification to restoration (or now). */
    maxWindowMinutes: inc.lastVerifiedAt ? minutesBetween(inc.lastVerifiedAt, end) : null,
    statusLabel:
      inc.status === 'OPEN'
        ? inc.severity
        : inc.status === 'AP_REVIEW_REQUIRED'
          ? 'AP REVIEW REQUIRED'
          : inc.status === 'REVIEWED'
            ? `REVIEWED — ${(inc.determination ?? '').replace(/_/g, ' ')}`
            : 'CLOSED',
  };
}

export function listIncidents(db: DB, projectId: string, clock: Clock = systemClock, limit = 50) {
  return (
    db
      .prepare(
        `SELECT * FROM integrity_incidents WHERE projectId = ?
          ORDER BY CASE status WHEN 'OPEN' THEN 0 WHEN 'AP_REVIEW_REQUIRED' THEN 1 ELSE 2 END, detectedAt DESC LIMIT ?`,
      )
      .all(projectId, Math.min(Math.max(limit, 1), 500)) as IncidentRow[]
  ).map((i) => decorateIncident(db, i, clock));
}

const GOOD = new Set(['ACTIVE', 'LIVE', 'SIMULATED', 'REPORTING', 'ONLINE', 'CONFIRMED', 'READY', 'IN_SYNC']);

/** getIntegrityStatus(): the AP's ACCOUNTABILITY SYSTEM dashboard. */
export async function getIntegrityStatus(db: DB, gw: NextDnsGateway | null, projectId: string, clock: Clock = systemClock) {
  const status = await getNextDnsStatus(db, gw, projectId, clock);
  const check = (c: Component) => getCheck(db, projectId, c);
  const now = clock.now();

  const hb = check('PHONE_HEARTBEAT');
  const hbState = !hb ? 'NEVER_SEEN' : hb.lastVerifiedAt && now.diff(iso(hb.lastVerifiedAt), 'minutes').minutes <= HEARTBEAT_STALE_MINUTES ? 'ONLINE' : 'STALE';
  const reachable = status.profiles.some((p) => p.status === 'REPORTING' || p.status === 'NO_RECENT_ACTIVITY');
  const unsynced = db
    .prepare(
      `SELECT id, displayName, target, state, syncStatus, lastSyncError, lastSyncAt FROM web_controls
        WHERE projectId = ? AND syncStatus != 'IN_SYNC'`,
    )
    .all(projectId) as { syncStatus: string }[];

  const components = [
    {
      component: 'NextDNS',
      status: status.integration !== 'LIVE' ? status.integration : reachable ? 'ACTIVE' : 'UNVERIFIED',
      lastVerifiedAt: check('NEXTDNS_API')?.lastVerifiedAt ?? null,
    },
    ...status.profiles.map((p) => ({ component: `${p.label} profile`, status: p.status, lastVerifiedAt: p.lastQueryAt })),
    { component: 'Phone heartbeat', status: hbState, lastVerifiedAt: hb?.lastVerifiedAt ?? null },
    {
      component: 'Pixel Private DNS',
      status: hbState === 'ONLINE' ? (check('PRIVATE_DNS')?.state ?? 'UNKNOWN') : 'UNKNOWN',
      lastVerifiedAt: check('PRIVATE_DNS')?.lastVerifiedAt ?? null,
    },
    {
      component: 'Recording Assistant',
      status: check('RECORDING_ASSISTANT')?.state ?? 'UNKNOWN',
      lastVerifiedAt: check('RECORDING_ASSISTANT')?.lastVerifiedAt ?? null,
    },
    {
      component: 'Policy sync',
      status: unsynced.some((u) => u.syncStatus === 'SYNC_FAILED') ? 'SYNC_FAILED' : unsynced.length ? 'PENDING' : 'IN_SYNC',
      lastVerifiedAt: null,
    },
  ];

  const incidents = listIncidents(db, projectId, clock, 30);
  const open = incidents.filter((i) => i.status === 'OPEN');
  const review = incidents.filter((i) => i.status === 'AP_REVIEW_REQUIRED');
  const interrupted = open.find((i) => i.severity === 'INTERRUPTED');

  const overall: IntegrityStatus = interrupted
    ? 'INTERRUPTED'
    : !gw
      ? 'NOT_CONFIGURED'
      : open.length || components.some((c) => !GOOD.has(c.status))
        ? 'DEGRADED'
        : review.length
          ? 'RESTORED'
          : 'ACTIVE';

  const summary =
    overall === 'INTERRUPTED'
      ? interrupted!.title
      : overall === 'NOT_CONFIGURED'
        ? 'INTEGRITY: NEXTDNS NOT CONFIGURED'
        : overall === 'DEGRADED'
          ? 'INTEGRITY: DEGRADED — SEE COMPONENTS'
          : overall === 'RESTORED'
            ? 'INTEGRITY: RESTORED — AP REVIEW REQUIRED'
            : 'INTEGRITY: ALL SYSTEMS REPORTING';

  const activeExemptions = db
    .prepare(
      `SELECT * FROM integrity_exemptions WHERE projectId = ? AND revokedAt IS NULL AND endsAt > ? ORDER BY endsAt`,
    )
    .all(projectId, nowIso(clock));

  return {
    checkedAt: status.checkedAt,
    overall,
    summary: status.integration === 'SIMULATED' ? `${summary} (SIMULATED NEXTDNS — NOT REAL ENFORCEMENT)` : summary,
    components,
    reviewRequired: review.length,
    incidents,
    activeExemptions,
    unsyncedControls: unsynced,
  };
}

/** What the participant sees: own monitoring state and incidents to explain. */
export function getParticipantIntegrity(db: DB, projectId: string, clock: Clock = systemClock) {
  const hb = getCheck(db, projectId, 'PHONE_HEARTBEAT');
  const pd = getCheck(db, projectId, 'PRIVATE_DNS');
  return {
    serverTime: nowIso(clock),
    heartbeat: { state: hb?.state ?? 'NEVER_SEEN', lastReceivedAt: hb?.lastVerifiedAt ?? null },
    privateDns: { state: pd?.state ?? 'UNKNOWN', lastConfirmedAt: pd?.lastVerifiedAt ?? null },
    incidents: listIncidents(db, projectId, clock, 30)
      .filter((i) => ['PRIVATE_DNS_DISABLED', 'DNS_HEARTBEAT_MISMATCH', 'PHONE_HEARTBEAT_LOST'].includes(i.type))
      .map((i) => ({
        id: i.id,
        title: i.title,
        type: i.type,
        status: i.status,
        statusLabel: i.statusLabel,
        lastVerifiedAt: i.lastVerifiedAt,
        detectedAt: i.detectedAt,
        restoredAt: i.restoredAt,
        interruptionMinutes: i.interruptionMinutes,
        detail: i.detail,
        participantExplanation: i.participantExplanation,
        determination: i.determination,
        reviewNote: i.reviewNote,
      })),
  };
}
