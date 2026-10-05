/**
 * Monitoring integrity — the accountability infrastructure monitors itself.
 *
 * Status vocabulary (per component):
 *   ACTIVE       confirmed working
 *   DEGRADED     insufficient information, or a component not reporting
 *   INTERRUPTED  monitoring confirmed unavailable or disabled
 *   RESTORED     reporting resumed after an interruption; AP review pending
 *   UNKNOWN      not configured / never verified
 *
 * Interpretation rules:
 *   - Missing DNS traffic alone is never treated as confirmed bypass. A quiet
 *     phone is DEGRADED, not INTERRUPTED. INTERRUPTED requires positive
 *     evidence: the phone itself reports Private DNS off or pointed elsewhere,
 *     test.nextdns.io reports a different/no profile, repeated server-verified
 *     canary lookups never reach RAY-PIXEL, or NextDNS rejects the AP's key.
 *   - No incident is labeled misconduct. Incidents are referred to the AP.
 *   - Restoration never erases an incident: detection facts are immutable at
 *     the database level, and every incident needs an AP review to close.
 *   - Incidents are only opened for a component that has been verified active
 *     at least once ("armed"), so initial setup does not create noise.
 */
import { audit, auditStatement, SYSTEM_ACTOR, type Actor } from './audit.js';
import type { Ctx, ProfileCode } from './context.js';
import { reconcileProfiles, type EntryChange, type ReconcileResult } from './controls.js';
import { getInternal, getSettings, setInternal, type Settings } from './settings.js';
import { addMinutes, HttpError, iso, minutesBetween, newId, randomString, sha256Hex, timingSafeEqual } from './util.js';

export const ACCOUNTABILITY_RULE =
  'Accountability controls must remain enabled and configured as directed by the Accountability Partner. Micheal may not disable, replace, circumvent, or materially alter an active accountability control without prior AP approval, except when reasonably necessary for safety, emergency access, or essential device recovery.';
export const MONITORING_LOSS_RULE =
  'Loss of monitoring does not suspend the underlying accountability requirement. Interruptions are preserved and referred to the AP for review.';

export type ComponentCode =
  | 'NEXTDNS_API'
  | 'DNS_RAY_PIXEL'
  | 'DNS_HOME_ROUTER'
  | 'PHONE_HEARTBEAT'
  | 'POLICY_ENFORCEMENT'
  | 'RECORDING_ASSISTANT';
export type ComponentStatus = 'ACTIVE' | 'DEGRADED' | 'INTERRUPTED' | 'RESTORED' | 'UNKNOWN';
export type IncidentKind = 'INTERRUPTION' | 'REPORTING_GAP' | 'CONFIGURATION_DRIFT' | 'ENFORCEMENT_FAILURE';

export const REVIEW_DISPOSITIONS = [
  'TECHNICAL_NO_ACTION', // legitimate technical cause (outage, phone off, router reboot)
  'AUTHORIZED', // interruption was approved or reasonably necessary (safety/emergency/recovery)
  'ACKNOWLEDGED', // noted; no further action
  'REFERRED_FOR_VIOLATION_REVIEW', // AP will assess under the project rules
] as const;
export type ReviewDisposition = (typeof REVIEW_DISPOSITIONS)[number];

interface ComponentRow {
  code: ComponentCode;
  label: string;
  status: ComponentStatus;
  detail: string | null;
  lastVerifiedActiveAt: string | null;
  statusSince: string | null;
  lastCheckedAt: string | null;
}

export interface HeartbeatRow {
  id: string;
  deviceId: string;
  receivedAt: string;
  deviceTime: string | null;
  network: 'WIFI' | 'CELLULAR' | 'OTHER' | 'NONE';
  privateDnsActive: number | null;
  privateDnsServer: string | null;
  nextdnsTestStatus: string | null;
  nextdnsTestProfile: string | null;
  canaryNonce: string | null;
  canaryStatus: 'PENDING' | 'VERIFIED' | 'NOT_FOUND' | 'SKIPPED';
  canaryCheckedAt: string | null;
  recordingAssistant: string | null;
  appVersion: string | null;
}

/** Which incident kinds each component may open; absent = informational only. */
const INCIDENT_POLICY: Partial<Record<ComponentCode, { interrupted: IncidentKind; degraded: IncidentKind; title: string }>> = {
  NEXTDNS_API: { interrupted: 'INTERRUPTION', degraded: 'REPORTING_GAP', title: 'NEXTDNS ADMINISTRATION INTERRUPTED' },
  POLICY_ENFORCEMENT: { interrupted: 'ENFORCEMENT_FAILURE', degraded: 'ENFORCEMENT_FAILURE', title: 'POLICY ENFORCEMENT FAILURE' },
  DNS_RAY_PIXEL: { interrupted: 'INTERRUPTION', degraded: 'REPORTING_GAP', title: 'DNS ACCOUNTABILITY INTERRUPTED — RAY-PIXEL' },
  DNS_HOME_ROUTER: { interrupted: 'INTERRUPTION', degraded: 'REPORTING_GAP', title: 'HOME NETWORK DNS NOT REPORTING' },
};

// ---------------------------------------------------------------------------
// Devices + heartbeat
// ---------------------------------------------------------------------------

export async function issueDeviceToken(
  ctx: Ctx,
  actor: Actor,
  input: { label: string; profileCode?: ProfileCode },
): Promise<{ deviceId: string; token: string }> {
  const label = input.label?.trim();
  if (!label || label.length > 60) throw new HttpError(400, 'invalid_label');
  const profileCode = input.profileCode ?? 'RAY-PIXEL';
  const token = `mrbd_${randomString(40)}`;
  const deviceId = newId('dev');
  await ctx.db.batch([
    ctx.db
      .prepare(`INSERT INTO devices (id, label, profileCode, tokenHash, createdAt, createdBy) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(deviceId, label, profileCode, await sha256Hex(token), iso(ctx.clock.now()), actor.id),
    auditStatement(ctx.db, ctx.clock, {
      actor,
      automatic: false,
      action: 'device.registered',
      targetType: 'device',
      targetId: deviceId,
      targetLabel: label,
      profileCode,
      newState: { profileCode },
      summary: `${actor.type} issued a heartbeat token for ${label}`,
    }),
  ]);
  // The raw token is returned exactly once; only its hash is stored.
  return { deviceId, token };
}

export async function revokeDevice(ctx: Ctx, actor: Actor, id: string, reason?: string | null) {
  const row = await ctx.db.prepare(`SELECT label FROM devices WHERE id = ? AND revokedAt IS NULL`).bind(id).first<{ label: string }>();
  if (!row) throw new HttpError(404, 'not_found');
  const now = iso(ctx.clock.now());
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE devices SET revokedAt = ?, revokedBy = ? WHERE id = ?`).bind(now, actor.id, id),
    auditStatement(ctx.db, ctx.clock, {
      actor,
      automatic: false,
      action: 'device.revoked',
      targetType: 'device',
      targetId: id,
      targetLabel: row.label,
      previousState: { revoked: false },
      newState: { revoked: true },
      summary: `${actor.type} revoked the heartbeat token for ${row.label}`,
      reason,
    }),
  ]);
}

export async function listDevices(ctx: Ctx) {
  const { results } = await ctx.db
    .prepare(
      `SELECT d.id, d.label, d.profileCode, d.createdAt, d.createdBy, d.revokedAt,
              (SELECT MAX(receivedAt) FROM heartbeats h WHERE h.deviceId = d.id) AS lastHeartbeatAt
         FROM devices d ORDER BY d.createdAt DESC`,
    )
    .all();
  return results;
}

export interface DeviceRow {
  id: string;
  label: string;
  profileCode: ProfileCode;
  tokenHash: string;
}

export async function authenticateDevice(ctx: Ctx, authorization: string | null): Promise<DeviceRow | null> {
  if (!authorization?.startsWith('Bearer mrbd_')) return null;
  const hash = await sha256Hex(authorization.slice(7));
  const row = await ctx.db
    .prepare(`SELECT id, label, profileCode, tokenHash FROM devices WHERE tokenHash = ? AND revokedAt IS NULL`)
    .bind(hash)
    .first<DeviceRow>();
  return row && timingSafeEqual(row.tokenHash, hash) ? row : null;
}

const CHALLENGE_TTL_MIN = 10;

export async function issueChallenge(ctx: Ctx, device: DeviceRow) {
  const suffix = ctx.env.CANARY_SUFFIX?.trim().replace(/^\.+|\.+$/g, '');
  if (!suffix) return { nonce: null, canaryHost: null, expiresAt: null };
  const nonce = `hb${randomString(22)}`;
  const now = ctx.clock.now();
  const expiresAt = iso(addMinutes(now, CHALLENGE_TTL_MIN));
  await ctx.db
    .prepare(`INSERT INTO heartbeat_challenges (nonce, deviceId, issuedAt, expiresAt) VALUES (?, ?, ?, ?)`)
    .bind(nonce, device.id, iso(now), expiresAt)
    .run();
  return { nonce, canaryHost: `${nonce}.${suffix}`, expiresAt };
}

export interface HeartbeatInput {
  deviceTime?: string;
  network: 'WIFI' | 'CELLULAR' | 'OTHER' | 'NONE';
  privateDnsActive?: boolean | null;
  privateDnsServer?: string | null;
  nextdnsTest?: { status?: string | null; profile?: string | null } | null;
  canaryNonce?: string | null;
  recordingAssistant?: string | null;
  appVersion?: string | null;
}

export async function recordHeartbeat(ctx: Ctx, device: DeviceRow, input: HeartbeatInput) {
  const now = iso(ctx.clock.now());
  let canaryStatus: HeartbeatRow['canaryStatus'] = 'SKIPPED';
  if (input.canaryNonce) {
    // A nonce is only usable once, by the device it was issued to, before expiry.
    const claim = await ctx.db
      .prepare(
        `UPDATE heartbeat_challenges SET usedAt = ? WHERE nonce = ? AND deviceId = ? AND usedAt IS NULL AND expiresAt > ?`,
      )
      .bind(now, input.canaryNonce, device.id, now)
      .run();
    if (!claim.meta.changes) throw new HttpError(400, 'invalid_challenge');
    canaryStatus = 'PENDING';
  }
  const id = newId('hb');
  await ctx.db
    .prepare(
      `INSERT INTO heartbeats (id, deviceId, receivedAt, deviceTime, network, privateDnsActive, privateDnsServer,
         nextdnsTestStatus, nextdnsTestProfile, canaryNonce, canaryStatus, recordingAssistant, appVersion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      device.id,
      now,
      input.deviceTime ?? null,
      input.network,
      input.privateDnsActive === undefined || input.privateDnsActive === null ? null : input.privateDnsActive ? 1 : 0,
      input.privateDnsServer?.toLowerCase() ?? null,
      input.nextdnsTest?.status ?? null,
      input.nextdnsTest?.profile ?? null,
      input.canaryNonce ?? null,
      canaryStatus,
      input.recordingAssistant ?? null,
      input.appVersion ?? null,
    )
    .run();
  return { id, receivedAt: now, canaryStatus };
}

/**
 * Server-side proof that the phone's DNS actually goes through RAY-PIXEL: the
 * phone resolved a one-time hostname; look for it in RAY-PIXEL's NextDNS logs.
 */
export async function verifyCanaries(ctx: Ctx): Promise<{ verified: number; notFound: number }> {
  const profileId = ctx.profileId('RAY-PIXEL');
  if (!profileId || !ctx.nextdns.configured) return { verified: 0, notFound: 0 };
  const now = ctx.clock.now();
  const { results } = await ctx.db
    .prepare(
      `SELECT h.* FROM heartbeats h JOIN devices d ON d.id = h.deviceId
        WHERE h.canaryStatus = 'PENDING' AND d.profileCode = 'RAY-PIXEL' AND h.receivedAt <= ?
        ORDER BY h.receivedAt ASC LIMIT 10`,
    )
    .bind(iso(addMinutes(now, -1)))
    .all<HeartbeatRow>();
  let verified = 0;
  let notFound = 0;
  for (const h of results) {
    try {
      const page = await ctx.nextdns.getLogs(profileId, {
        search: h.canaryNonce!,
        from: iso(addMinutes(new Date(h.receivedAt), -15)),
        limit: 10,
      });
      const hit = page.data.some((e) => e.domain?.toLowerCase().startsWith(h.canaryNonce!.toLowerCase()));
      if (hit) {
        await ctx.db.prepare(`UPDATE heartbeats SET canaryStatus = 'VERIFIED', canaryCheckedAt = ? WHERE id = ?`).bind(iso(now), h.id).run();
        verified++;
      } else if (minutesBetween(h.receivedAt, now) >= 10) {
        // Allow for NextDNS log latency before concluding.
        await ctx.db.prepare(`UPDATE heartbeats SET canaryStatus = 'NOT_FOUND', canaryCheckedAt = ? WHERE id = ?`).bind(iso(now), h.id).run();
        notFound++;
      }
    } catch {
      // Leave PENDING; NEXTDNS_API health reflects the failure.
    }
  }
  return { verified, notFound };
}

// ---------------------------------------------------------------------------
// Observation + evaluation
// ---------------------------------------------------------------------------

export interface Observations {
  now: Date;
  api: { configured: boolean; ok: boolean; authFailure: boolean; error: string | null };
  reconcile: { errors: string[] };
  restoreFailures: number;
  profiles: Record<ProfileCode, { configured: boolean; probeOk: boolean; lastDnsAt: string | null }>;
  expectedPixelProfileId: string | null;
  deviceRegistered: boolean;
  lastHeartbeat: HeartbeatRow | null;
  /** Most recent canaries that reached a verdict, newest first. */
  recentCanaries: Pick<HeartbeatRow, 'canaryStatus' | 'receivedAt'>[];
}

export interface Evaluation {
  status: Exclude<ComponentStatus, 'RESTORED'>;
  detail: string;
  /** When positive evidence of working order was observed, if status is ACTIVE. */
  verifiedAt?: string;
}

const within = (ts: string | null, now: Date, minutes: number) => !!ts && minutesBetween(ts, now) <= minutes;
const latest = (...ts: (string | null | undefined)[]) =>
  ts.filter((t): t is string => !!t).sort().at(-1) ?? null;

/** Pure function: observations -> component statuses. Unit-tested directly. */
export function evaluateComponents(obs: Observations, t: Settings['thresholds']): Record<ComponentCode, Evaluation> {
  const { now } = obs;
  const hb = obs.lastHeartbeat;
  const hbFresh = !!hb && within(hb.receivedAt, now, t.heartbeatStaleMinutes);

  const api: Evaluation = !obs.api.configured
    ? { status: 'UNKNOWN', detail: 'NextDNS API key or profile ids are not configured' }
    : obs.api.authFailure
      ? { status: 'INTERRUPTED', detail: 'NextDNS rejected the AP API key — AP administration is unavailable' }
      : !obs.api.ok
        ? { status: 'DEGRADED', detail: `NextDNS API error: ${obs.api.error ?? 'unknown'}` }
        : { status: 'ACTIVE', detail: 'AP-administered NextDNS is reachable', verifiedAt: iso(now) };

  const enforcement: Evaluation = !obs.api.configured
    ? { status: 'UNKNOWN', detail: 'Not configured' }
    : obs.restoreFailures > 0
      ? {
          status: 'INTERRUPTED',
          detail: `${obs.restoreFailures} restriction(s) could not be restored in NextDNS — retrying every minute`,
        }
      : obs.reconcile.errors.length
        ? { status: 'DEGRADED', detail: `Some policy could not be applied: ${obs.reconcile.errors.slice(0, 3).join('; ')}` }
        : obs.api.ok
          ? { status: 'ACTIVE', detail: 'NextDNS matches AP policy', verifiedAt: iso(now) }
          : { status: 'DEGRADED', detail: 'Policy could not be verified (NextDNS unreachable)' };

  const home = obs.profiles['HOME-ROUTER'];
  const homeEval: Evaluation = !home.configured
    ? { status: 'UNKNOWN', detail: 'HOME-ROUTER profile id not configured' }
    : within(home.lastDnsAt, now, t.homeDnsStaleMinutes)
      ? { status: 'ACTIVE', detail: 'Home network DNS is reaching HOME-ROUTER', verifiedAt: home.lastDnsAt! }
      : {
          status: 'DEGRADED',
          detail: home.probeOk
            ? `No home-network DNS seen ${home.lastDnsAt ? `since ${home.lastDnsAt}` : 'yet'}. Possible causes: router DNS changed, linked IP changed, internet outage, or no activity.`
            : 'Could not read HOME-ROUTER logs from NextDNS',
        };

  const heartbeat: Evaluation = !obs.deviceRegistered
    ? { status: 'UNKNOWN', detail: 'No phone registered for heartbeats' }
    : hbFresh
      ? { status: 'ACTIVE', detail: `ONLINE (${hb!.network.toLowerCase()})`, verifiedAt: hb!.receivedAt }
      : {
          status: 'DEGRADED',
          detail: `No heartbeat ${hb ? `since ${hb.receivedAt}` : 'yet'} — phone may be off, asleep, offline, or the app restricted`,
        };

  const pixel = obs.profiles['RAY-PIXEL'];
  let pixelEval: Evaluation;
  if (!pixel.configured) {
    pixelEval = { status: 'UNKNOWN', detail: 'RAY-PIXEL profile id not configured' };
  } else {
    const lastCanaryOk = obs.recentCanaries.find((c) => c.canaryStatus === 'VERIFIED')?.receivedAt ?? null;
    const goodAt = latest(
      within(pixel.lastDnsAt, now, t.pixelDnsStaleMinutes) ? pixel.lastDnsAt : null,
      within(lastCanaryOk, now, t.heartbeatStaleMinutes) ? lastCanaryOk : null,
    );
    const bad = hbFresh && hb!.network !== 'NONE' ? confirmedBypass(hb!, obs) : null;
    // Positive bypass evidence wins unless DNS was verified *after* that report.
    if (bad && (!goodAt || hb!.receivedAt >= goodAt)) pixelEval = { status: 'INTERRUPTED', detail: bad };
    else if (goodAt) pixelEval = { status: 'ACTIVE', detail: 'Pixel DNS is reaching RAY-PIXEL', verifiedAt: goodAt };
    else
      pixelEval = {
        status: 'DEGRADED',
        detail: `Insufficient information: no recent RAY-PIXEL DNS${pixel.lastDnsAt ? ` (last ${pixel.lastDnsAt})` : ''} and no recent verified heartbeat. The phone may be asleep or offline.`,
      };
  }

  const ra = hb?.recordingAssistant ?? null;
  const recording: Evaluation = !ra
    ? { status: 'UNKNOWN', detail: 'Not reporting (not yet integrated)' }
    : !hbFresh
      ? { status: 'DEGRADED', detail: `Last reported ${ra} at ${hb!.receivedAt}` }
      : ra === 'READY'
        ? { status: 'ACTIVE', detail: 'READY', verifiedAt: hb!.receivedAt }
        : { status: 'DEGRADED', detail: ra };

  return {
    NEXTDNS_API: api,
    POLICY_ENFORCEMENT: enforcement,
    DNS_RAY_PIXEL: pixelEval,
    DNS_HOME_ROUTER: homeEval,
    PHONE_HEARTBEAT: heartbeat,
    RECORDING_ASSISTANT: recording,
  };
}

function confirmedBypass(hb: HeartbeatRow, obs: Observations): string | null {
  const expected = obs.expectedPixelProfileId?.toLowerCase() ?? null;
  if (hb.privateDnsActive === 0) return 'Phone reports Android Private DNS is OFF';
  if (hb.privateDnsServer && expected && !hb.privateDnsServer.includes(expected))
    return `Phone Private DNS points to ${hb.privateDnsServer}, not the RAY-PIXEL profile`;
  if (hb.nextdnsTestStatus && hb.nextdnsTestStatus !== 'ok')
    return `test.nextdns.io reports "${hb.nextdnsTestStatus}" — phone is not using NextDNS`;
  if (hb.nextdnsTestProfile && expected && hb.nextdnsTestProfile.toLowerCase() !== expected)
    return `test.nextdns.io reports profile ${hb.nextdnsTestProfile}, not RAY-PIXEL`;
  const [a, b] = obs.recentCanaries;
  if (a?.canaryStatus === 'NOT_FOUND' && b?.canaryStatus === 'NOT_FOUND')
    return 'Two consecutive canary lookups from the phone never reached RAY-PIXEL';
  return null;
}

// ---------------------------------------------------------------------------
// Scheduled integrity run
// ---------------------------------------------------------------------------

export async function runIntegrityChecks(ctx: Ctx, force = false): Promise<{ ran: boolean }> {
  const settings = await getSettings(ctx);
  const now = ctx.clock.now();
  const last = await getInternal(ctx, 'lastIntegrityRunAt');
  if (!force && last && minutesBetween(last, now) < settings.thresholds.integrityIntervalMinutes) return { ran: false };
  await setInternal(ctx, 'lastIntegrityRunAt', iso(now));

  const configured = ctx.nextdns.configured && !!ctx.profileId('RAY-PIXEL') && !!ctx.profileId('HOME-ROUTER');

  // 1. Re-assert AP policy and detect drift (also our API health probe).
  const reconciles = configured ? await reconcileProfiles(ctx) : [];
  await recordDrift(ctx, reconciles);
  const authFailure = reconciles.some((r) => r.errors.some((e) => e.authFailure));
  const profileErrors = reconciles.flatMap((r) => r.errors.filter((e) => e.list === 'profile'));

  // 2. Last DNS activity per profile.
  const profiles = {} as Observations['profiles'];
  for (const code of ['RAY-PIXEL', 'HOME-ROUTER'] as const) {
    const id = ctx.profileId(code);
    let probeOk = false;
    if (id && ctx.nextdns.configured) {
      try {
        // Any query counts, including heartbeat canaries: each one is real DNS
        // that demonstrably passed through this profile.
        const page = await ctx.nextdns.getLogs(id, { limit: 10 });
        probeOk = true;
        const ts = page.data.map((e) => e.timestamp).filter(Boolean).sort().at(-1);
        if (ts)
          await ctx.db
            .prepare(`UPDATE profiles SET lastDnsAt = MAX(COALESCE(lastDnsAt, ''), ?), lastDnsCheckedAt = ? WHERE code = ?`)
            .bind(new Date(ts).toISOString(), iso(now), code)
            .run();
        else await ctx.db.prepare(`UPDATE profiles SET lastDnsCheckedAt = ? WHERE code = ?`).bind(iso(now), code).run();
      } catch {
        probeOk = false;
      }
    }
    const row = await ctx.db.prepare(`SELECT lastDnsAt FROM profiles WHERE code = ?`).bind(code).first<{ lastDnsAt: string | null }>();
    profiles[code] = { configured: !!id, probeOk, lastDnsAt: row?.lastDnsAt ?? null };
  }

  // 3. Canary verification.
  if (configured) await verifyCanaries(ctx);

  const obs = await gatherObservations(ctx, {
    api: {
      configured,
      ok: configured && profileErrors.length === 0,
      authFailure,
      error: profileErrors[0]?.message ?? null,
    },
    reconcileErrors: reconciles.flatMap((r) => r.errors.filter((e) => e.list !== 'profile').map((e) => `${e.id}: ${e.message}`)),
    profiles,
  });
  await applyEvaluations(ctx, evaluateComponents(obs, settings.thresholds), settings);
  return { ran: true };
}

async function gatherObservations(
  ctx: Ctx,
  part: { api: Observations['api']; reconcileErrors: string[]; profiles: Observations['profiles'] },
): Promise<Observations> {
  const failures = await ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM access_grants WHERE restoreStatus = 'FAILED'`)
    .first<{ n: number }>();
  const device = await ctx.db
    .prepare(`SELECT id FROM devices WHERE revokedAt IS NULL AND profileCode = 'RAY-PIXEL' LIMIT 1`)
    .first();
  const lastHeartbeat = await ctx.db
    .prepare(
      `SELECT h.* FROM heartbeats h JOIN devices d ON d.id = h.deviceId
        WHERE d.revokedAt IS NULL AND d.profileCode = 'RAY-PIXEL' ORDER BY h.receivedAt DESC LIMIT 1`,
    )
    .first<HeartbeatRow>();
  const { results: canaries } = await ctx.db
    .prepare(
      `SELECT h.canaryStatus, h.receivedAt FROM heartbeats h JOIN devices d ON d.id = h.deviceId
        WHERE d.revokedAt IS NULL AND h.canaryStatus IN ('VERIFIED', 'NOT_FOUND') ORDER BY h.receivedAt DESC LIMIT 5`,
    )
    .all<Pick<HeartbeatRow, 'canaryStatus' | 'receivedAt'>>();
  return {
    now: ctx.clock.now(),
    api: part.api,
    reconcile: { errors: part.reconcileErrors },
    restoreFailures: failures?.n ?? 0,
    profiles: part.profiles,
    expectedPixelProfileId: ctx.profileId('RAY-PIXEL'),
    deviceRegistered: !!device,
    lastHeartbeat: lastHeartbeat ?? null,
    recentCanaries: canaries,
  };
}

async function recordDrift(ctx: Ctx, results: ReconcileResult[]) {
  const drifted = results.filter((r) => r.drift.length);
  if (!drifted.length) return;
  const now = iso(ctx.clock.now());
  const corrected = drifted.every((r) => r.ok);
  const evidence = drifted.map((r) => ({ profile: r.profileCode, drift: r.drift, corrected: r.ok }));
  const describe = (d: EntryChange) => `${d.list}:${d.id} (${String(d.from)} → ${String(d.to)})`;
  const id = newId('inc');
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO integrity_incidents (id, componentCode, kind, title, lastVerifiedActiveAt, detectedAt, restoredAt, interruptionMinutes, status, evidence)
         VALUES (?, 'POLICY_ENFORCEMENT', 'CONFIGURATION_DRIFT', ?, NULL, ?, ?, NULL, ?, ?)`,
      )
      .bind(
        id,
        'NEXTDNS CONFIGURATION CHANGED OUTSIDE THE AP PORTAL',
        now,
        corrected ? now : null,
        corrected ? 'RESTORED' : 'OPEN',
        JSON.stringify(evidence),
      ),
    auditStatement(ctx.db, ctx.clock, {
      actor: SYSTEM_ACTOR,
      automatic: true,
      action: 'integrity.drift_detected',
      targetType: 'integrity_incident',
      targetId: id,
      targetLabel: 'NextDNS configuration drift',
      previousState: evidence.map((e) => ({ profile: e.profile, live: e.drift.map((d) => ({ id: d.id, value: d.from })) })),
      newState: { corrected },
      summary: `Managed NextDNS entries were changed outside the portal: ${drifted
        .flatMap((r) => r.drift.map((d) => `${r.profileCode} ${describe(d)}`))
        .join(', ')}. ${corrected ? 'AP policy re-applied.' : 'Re-apply FAILED.'} AP review required.`,
    }),
  ]);
  await ctx.alert({
    kind: 'drift',
    title: 'NEXTDNS CONFIGURATION DRIFT',
    text: `Managed entries changed outside the AP Portal. ${corrected ? 'Policy re-applied.' : 'Re-apply failed.'} Review in WEB CONTROLS.`,
  });
}

async function applyEvaluations(ctx: Ctx, evals: Record<ComponentCode, Evaluation>, settings: Settings) {
  const now = ctx.clock.now();
  const nowIso = iso(now);
  const { results: rows } = await ctx.db.prepare(`SELECT * FROM integrity_components`).all<ComponentRow>();
  for (const row of rows) {
    const e = evals[row.code];
    if (!e) continue;
    const policy = INCIDENT_POLICY[row.code];
    const wasGood = row.status === 'ACTIVE' || row.status === 'RESTORED';

    if (e.status === 'ACTIVE') {
      const { results: open } = await ctx.db
        .prepare(`SELECT * FROM integrity_incidents WHERE componentCode = ? AND status = 'OPEN'`)
        .bind(row.code)
        .all<{ id: string; title: string; detectedAt: string }>();
      for (const inc of open) {
        const minutes = Math.max(0, minutesBetween(inc.detectedAt, now));
        await ctx.db.batch([
          ctx.db
            .prepare(`UPDATE integrity_incidents SET status = 'RESTORED', restoredAt = ?, interruptionMinutes = ? WHERE id = ? AND status = 'OPEN'`)
            .bind(nowIso, minutes, inc.id),
          auditStatement(ctx.db, ctx.clock, {
            actor: SYSTEM_ACTOR,
            automatic: true,
            action: 'integrity.restored',
            targetType: 'integrity_incident',
            targetId: inc.id,
            targetLabel: inc.title,
            previousState: { status: 'OPEN' },
            newState: { status: 'RESTORED', interruptionMinutes: minutes },
            summary: `${row.label} reporting restored after ${minutes} minutes. Interruption preserved; AP review required.`,
          }),
        ]);
        await ctx.alert({
          kind: 'integrity_restored',
          title: `RESTORED — ${inc.title}`,
          text: `Interruption: ${minutes} minutes. Status: AP REVIEW REQUIRED.`,
        });
      }
      const unreviewed = await ctx.db
        .prepare(`SELECT COUNT(*) AS n FROM integrity_incidents WHERE componentCode = ? AND status = 'RESTORED'`)
        .bind(row.code)
        .first<{ n: number }>();
      const status: ComponentStatus = unreviewed?.n ? 'RESTORED' : 'ACTIVE';
      await updateComponent(ctx, row, status, e.detail, latest(row.lastVerifiedActiveAt, e.verifiedAt ?? nowIso), wasGood ? row.statusSince : nowIso);
      continue;
    }

    const changed = e.status !== row.status;
    const statusSince = changed ? nowIso : (row.statusSince ?? nowIso);
    await updateComponent(ctx, row, e.status, e.detail, row.lastVerifiedActiveAt, statusSince);

    const armed = !!row.lastVerifiedActiveAt;
    if (!policy || !armed) continue;
    const open = await ctx.db
      .prepare(`SELECT kind FROM integrity_incidents WHERE componentCode = ? AND status = 'OPEN' AND kind != 'CONFIGURATION_DRIFT'`)
      .bind(row.code)
      .all<{ kind: IncidentKind }>();
    const openKinds = new Set(open.results.map((r) => r.kind));

    if (e.status === 'INTERRUPTED' && !openKinds.has(policy.interrupted)) {
      await openIncident(ctx, row, policy.interrupted, policy.title, nowIso, e.detail);
    } else if (e.status === 'DEGRADED' && openKinds.size === 0) {
      const gapMin =
        row.code === 'DNS_RAY_PIXEL'
          ? settings.thresholds.pixelGapIncidentMinutes
          : row.code === 'DNS_HOME_ROUTER'
            ? settings.thresholds.homeGapIncidentMinutes
            : 30;
      if (minutesBetween(statusSince, now) >= gapMin) {
        const title = policy.degraded === 'REPORTING_GAP' ? `${row.label.toUpperCase()} NOT REPORTING` : policy.title;
        await openIncident(ctx, row, policy.degraded, title, statusSince, e.detail);
      }
    }
  }
}

async function updateComponent(
  ctx: Ctx,
  row: ComponentRow,
  status: ComponentStatus,
  detail: string,
  lastVerifiedActiveAt: string | null,
  statusSince: string | null,
) {
  const nowIso = iso(ctx.clock.now());
  const stmts = [
    ctx.db
      .prepare(
        `UPDATE integrity_components SET status = ?, detail = ?, lastVerifiedActiveAt = ?, statusSince = ?, lastCheckedAt = ? WHERE code = ?`,
      )
      .bind(status, detail, lastVerifiedActiveAt, statusSince, nowIso, row.code),
  ];
  // Phone heartbeat / recording assistant flap with normal sleep; their state
  // is covered by DNS_RAY_PIXEL, so only accountability components are audited.
  if (status !== row.status && INCIDENT_POLICY[row.code])
    stmts.push(
      auditStatement(ctx.db, ctx.clock, {
        actor: SYSTEM_ACTOR,
        automatic: true,
        action: 'integrity.status_changed',
        targetType: 'integrity_component',
        targetId: row.code,
        targetLabel: row.label,
        previousState: { status: row.status },
        newState: { status },
        summary: `${row.label}: ${row.status} → ${status}`,
        reason: detail,
      }),
    );
  await ctx.db.batch(stmts);
}

async function openIncident(
  ctx: Ctx,
  row: ComponentRow,
  kind: IncidentKind,
  title: string,
  detectedAt: string,
  detail: string,
) {
  const id = newId('inc');
  const evidence = { detail, rule: MONITORING_LOSS_RULE };
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO integrity_incidents (id, componentCode, kind, title, lastVerifiedActiveAt, detectedAt, status, evidence)
         VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
      )
      .bind(id, row.code, kind, title, row.lastVerifiedActiveAt, detectedAt, JSON.stringify(evidence)),
    auditStatement(ctx.db, ctx.clock, {
      actor: SYSTEM_ACTOR,
      automatic: true,
      action: 'integrity.incident_opened',
      targetType: 'integrity_incident',
      targetId: id,
      targetLabel: title,
      newState: { kind, lastVerifiedActiveAt: row.lastVerifiedActiveAt, detectedAt },
      summary: `${title}. Last verified active: ${row.lastVerifiedActiveAt ?? 'never'}. Referred to AP for review.`,
      reason: detail,
    }),
  ]);
  await ctx.alert({
    kind: 'integrity_incident',
    title,
    text: `Last verified active: ${row.lastVerifiedActiveAt ?? 'never'}. Detected: ${detectedAt}. ${detail}`,
  });
}

// ---------------------------------------------------------------------------
// AP review + reads
// ---------------------------------------------------------------------------

export async function reviewIncident(
  ctx: Ctx,
  actor: Actor,
  id: string,
  input: { disposition: ReviewDisposition; note: string },
) {
  const inc = await ctx.db
    .prepare(`SELECT * FROM integrity_incidents WHERE id = ?`)
    .bind(id)
    .first<{ id: string; status: string; title: string; componentCode: ComponentCode }>();
  if (!inc) throw new HttpError(404, 'not_found');
  if (inc.status === 'OPEN') throw new HttpError(409, 'still_open', 'The interruption is ongoing; it can be reviewed once restored');
  if (inc.status === 'REVIEWED') throw new HttpError(409, 'already_reviewed');
  if (!REVIEW_DISPOSITIONS.includes(input.disposition)) throw new HttpError(400, 'invalid_disposition');
  const note = input.note?.trim();
  if (!note) throw new HttpError(400, 'note_required');
  const now = iso(ctx.clock.now());
  await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE integrity_incidents SET status = 'REVIEWED', reviewDisposition = ?, reviewNote = ?, reviewedBy = ?, reviewedAt = ?
          WHERE id = ? AND status = 'RESTORED'`,
      )
      .bind(input.disposition, note, actor.id, now, id),
    auditStatement(ctx.db, ctx.clock, {
      actor,
      automatic: false,
      action: 'integrity.reviewed',
      targetType: 'integrity_incident',
      targetId: id,
      targetLabel: inc.title,
      previousState: { status: 'RESTORED' },
      newState: { status: 'REVIEWED', disposition: input.disposition },
      summary: `AP reviewed "${inc.title}": ${input.disposition.replace(/_/g, ' ').toLowerCase()}`,
      reason: note,
    }),
  ]);
  // Clear the component's RESTORED badge once nothing is awaiting review.
  const pending = await ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM integrity_incidents WHERE componentCode = ? AND status = 'RESTORED'`)
    .bind(inc.componentCode)
    .first<{ n: number }>();
  if (!pending?.n)
    await ctx.db
      .prepare(`UPDATE integrity_components SET status = 'ACTIVE' WHERE code = ? AND status = 'RESTORED'`)
      .bind(inc.componentCode)
      .run();
}

export async function listIncidents(ctx: Ctx, opts: { status?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { results } = await ctx.db
    .prepare(`SELECT * FROM integrity_incidents ${opts.status ? 'WHERE status = ?' : ''} ORDER BY detectedAt DESC LIMIT ${limit}`)
    .bind(...(opts.status ? [opts.status] : []))
    .all<Record<string, unknown> & { evidence: string; restoredAt: string | null; detectedAt: string }>();
  return results.map((r) => ({
    ...r,
    evidence: JSON.parse(r.evidence),
    ongoingMinutes: r.restoredAt ? null : Math.max(0, minutesBetween(r.detectedAt, ctx.clock.now())),
  }));
}

export async function getIntegrityStatus(ctx: Ctx) {
  const { results } = await ctx.db.prepare(`SELECT * FROM integrity_components`).all<ComponentRow>();
  const order: ComponentCode[] = ['NEXTDNS_API', 'DNS_RAY_PIXEL', 'DNS_HOME_ROUTER', 'PHONE_HEARTBEAT', 'POLICY_ENFORCEMENT', 'RECORDING_ASSISTANT'];
  const components = order.map((c) => results.find((r) => r.code === c)!).filter(Boolean);
  const core = components.filter((c) => c.code !== 'RECORDING_ASSISTANT' || c.status !== 'UNKNOWN');
  const has = (s: ComponentStatus) => core.some((c) => c.status === s);
  const overall: ComponentStatus = has('INTERRUPTED')
    ? 'INTERRUPTED'
    : has('DEGRADED') || has('UNKNOWN')
      ? 'DEGRADED'
      : has('RESTORED')
        ? 'RESTORED'
        : 'ACTIVE';
  const headline = {
    INTERRUPTED: 'INTEGRITY: MONITORING INTERRUPTED — AP REVIEW REQUIRED',
    DEGRADED: 'INTEGRITY: DEGRADED — NOT ALL COMPONENTS REPORTING',
    RESTORED: 'INTEGRITY: REPORTING RESTORED — AP REVIEW REQUIRED',
    ACTIVE: 'INTEGRITY: ALL SYSTEMS REPORTING',
    UNKNOWN: 'INTEGRITY: NOT YET VERIFIED',
  }[overall];
  const counts = await ctx.db
    .prepare(
      `SELECT SUM(status = 'OPEN') AS open, SUM(status = 'RESTORED') AS awaitingReview FROM integrity_incidents`,
    )
    .first<{ open: number | null; awaitingReview: number | null }>();
  return {
    overall,
    headline,
    components,
    openIncidents: counts?.open ?? 0,
    awaitingReview: counts?.awaitingReview ?? 0,
    lastRunAt: await getInternal(ctx, 'lastIntegrityRunAt'),
    rules: { accountability: ACCOUNTABILITY_RULE, monitoringLoss: MONITORING_LOSS_RULE },
  };
}

export { audit };
